import { createHash, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.mjs';
import {
  createDongtubeInvoice,
  getDongtubeInvoiceStatus,
  isDongtubePaymentConfigured,
} from '../dongtube.mjs';
import {
  getProviderOrderStatus,
  getProviderServices,
  isProviderConfigured,
  placeProviderOrder,
  ProviderError,
} from '../provider.mjs';
import {
  cancelSmsCodeOrder,
  createSmsCodeOrder,
  finishSmsCodeOrder,
  getSmsCodeOrder,
  getSmsCodeProducts,
  isSmsCodeConfigured,
  resendSmsCodeOrder,
  SmsCodeOrderError,
  waitForSmsCodeOtp,
} from '../smscode.mjs';
import { ensureSchema, sql } from '../lib/database.mjs';
import {
  getGoogleIdentity,
  googleAuthorizationUrl,
  isGoogleAuthConfigured,
} from '../google-auth.mjs';

const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const passwordIterations = 210000;
const pbkdf2Async = promisify(pbkdf2);
const serviceCacheTtlMs = 5 * 60 * 1000;
let serviceCache = { expiresAt: 0, services: [] };
let smsCodeCache = { expiresAt: 0, products: [] };

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function sendJson(response, statusCode, body, headers = {}) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  return response.end(JSON.stringify(body));
}

async function readJson(request) {
  if (!request.headers['content-type']?.includes('application/json')) {
    throw httpError(415, 'Content-Type harus application/json.');
  }
  let value = request.body;
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    if (Buffer.byteLength(value) > 12 * 1024) throw httpError(413, 'Ukuran data terlalu besar.');
    try {
      value = JSON.parse(value.toString());
    } catch {
      throw httpError(400, 'Format JSON tidak valid.');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(400, 'Format JSON tidak valid.');
  }
  return value;
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((entry) => {
    const separator = entry.indexOf('=');
    if (separator < 0) return ['', ''];
    try {
      return [entry.slice(0, separator).trim(), decodeURIComponent(entry.slice(separator + 1).trim())];
    } catch {
      return ['', ''];
    }
  }).filter(([key]) => key));
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function epoch(value) {
  return value ? new Date(value).getTime() : null;
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    balance: Number(row.balance),
    createdAt: epoch(row.created_at),
  };
}

function mapOrder(row) {
  return {
    id: row.id,
    userId: row.user_id,
    productId: row.product_id,
    productName: row.product_name,
    productType: row.product_type,
    amount: Number(row.amount),
    target: row.target,
    quantity: row.quantity,
    comments: row.comments,
    username: row.username,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    clientRequestId: row.client_request_id,
    status: row.status,
    providerOrderId: row.provider_order_id,
    providerStatus: row.provider_status,
    providerStartCount: row.provider_start_count,
    providerRemains: row.provider_remains,
    providerError: row.provider_error,
    createdAt: epoch(row.created_at),
    providerSubmittedAt: epoch(row.provider_submitted_at),
    completedAt: epoch(row.completed_at),
    reviewedAt: epoch(row.reviewed_at),
  };
}

function sessionCookie(token, maxAge) {
  const secure = config.server.nodeEnv === 'production' || process.env.VERCEL === '1' ? '; Secure' : '';
  return `permadevv_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function googleCookie(name, value, maxAge) {
  const secure = config.server.nodeEnv === 'production' || process.env.VERCEL === '1' ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/api/auth/google/callback; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function redirect(response, location, cookies = []) {
  response.statusCode = 302;
  response.setHeader('Location', location);
  response.setHeader('Cache-Control', 'no-store');
  if (cookies.length) response.setHeader('Set-Cookie', cookies);
  return response.end();
}

function googleStateMatches(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

async function currentUser(request) {
  const token = parseCookies(request.headers.cookie).permadevv_session;
  if (!token) return null;
  const rows = await sql`
    SELECT users.*
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ${hashToken(token)} AND sessions.expires_at > NOW()
    LIMIT 1
  `;
  return mapUser(rows[0]);
}

function requireUser(user) {
  if (!user) throw httpError(401, 'Silakan masuk ke akun terlebih dahulu.');
  return user;
}

function requireAdmin(request) {
  const expected = Buffer.from(config.admin.topupKey);
  const suppliedKey = request.headers['x-admin-key'];
  if (!expected.length || typeof suppliedKey !== 'string') {
    throw httpError(503, 'Verifikasi admin belum dikonfigurasi.');
  }
  const supplied = Buffer.from(suppliedKey);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw httpError(403, 'Kunci admin tidak valid.');
  }
}

function ensureSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw httpError(403, 'Origin tidak valid.');
  }
  if (originHost !== request.headers.host) throw httpError(403, 'Permintaan lintas situs ditolak.');
}

async function checkAuthRateLimit(request) {
  const address = request.headers['x-real-ip'] || request.socket?.remoteAddress || 'unknown';
  const ipHash = createHash('sha256').update(address).digest('hex');
  const rows = await sql`
    INSERT INTO auth_attempts (ip_hash, attempts)
    VALUES (${ipHash}, ARRAY[NOW()])
    ON CONFLICT (ip_hash) DO UPDATE
    SET attempts = array_append(
      ARRAY(
        SELECT recent.attempt
        FROM unnest(auth_attempts.attempts) AS recent(attempt)
        WHERE recent.attempt > NOW() - INTERVAL '15 minutes'
      ),
      NOW()
    )
    RETURNING cardinality(attempts) AS count
  `;
  if (Number(rows[0].count) > 10) {
    throw httpError(429, 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.');
  }
}

async function makePassword(password) {
  const salt = randomBytes(16);
  const derived = await pbkdf2Async(password, salt, passwordIterations, 64, 'sha512');
  return { salt: salt.toString('hex'), hash: Buffer.from(derived).toString('hex') };
}

async function verifyPassword(password, user) {
  const derived = await pbkdf2Async(password, Buffer.from(user.password_salt, 'hex'), passwordIterations, 64, 'sha512');
  const actual = Buffer.from(derived);
  const expected = Buffer.from(user.password_hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  await sql`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (${hashToken(token)}, ${userId}, ${new Date(Date.now() + sessionLifetimeMs)})
  `;
  return token;
}

async function linkGoogleIdentity(user, identity) {
  if (user.google_sub && user.google_sub !== identity.subject) {
    throw httpError(409, 'Email Google sudah terhubung ke akun lain.');
  }
  const rows = await sql`
    UPDATE users SET google_sub = ${identity.subject}
    WHERE id = ${user.id} AND (google_sub IS NULL OR google_sub = ${identity.subject})
    RETURNING *
  `;
  if (!rows[0]) throw httpError(409, 'Akun Google sedang terhubung ke akun lain.');
  return mapUser(rows[0]);
}

async function getOrCreateGoogleUser(identity) {
  let rows = await sql`SELECT * FROM users WHERE google_sub = ${identity.subject} LIMIT 1`;
  if (rows[0]) return mapUser(rows[0]);

  rows = await sql`SELECT * FROM users WHERE email = ${identity.email} LIMIT 1`;
  if (rows[0]) return linkGoogleIdentity(rows[0], identity);

  const displayName = identity.name.slice(0, 80);
  const userId = randomBytes(16).toString('hex');
  try {
    rows = await sql`
      INSERT INTO users (id, name, email, balance, password_salt, password_hash, google_sub)
      VALUES (
        ${userId}, ${displayName.length >= 2 ? displayName : 'Google User'}, ${identity.email}, 0,
        ${randomBytes(16).toString('hex')}, ${randomBytes(64).toString('hex')}, ${identity.subject}
      )
      RETURNING *
    `;
    return mapUser(rows[0]);
  } catch (error) {
    if (error.code !== '23505') throw error;
    rows = await sql`SELECT * FROM users WHERE google_sub = ${identity.subject} LIMIT 1`;
    if (rows[0]) return mapUser(rows[0]);
    rows = await sql`SELECT * FROM users WHERE email = ${identity.email} LIMIT 1`;
    if (rows[0]) return linkGoogleIdentity(rows[0], identity);
    throw httpError(409, 'Akun Google tidak dapat ditautkan. Silakan coba lagi.');
  }
}

function clearGoogleCookies() {
  return [
    googleCookie('permadevv_google_state', '', 0),
    googleCookie('permadevv_google_verifier', '', 0),
  ];
}

async function googleCallback(request, response) {
  const callbackUrl = new URL(request.url, `https://${request.headers.host || 'localhost'}`);
  const cookies = parseCookies(request.headers.cookie);
  const stateIsValid = googleStateMatches(cookies.permadevv_google_state, callbackUrl.searchParams.get('state'));
  const code = callbackUrl.searchParams.get('code');
  const verifier = cookies.permadevv_google_verifier;

  if (!isGoogleAuthConfigured() || !stateIsValid || !code || !verifier || callbackUrl.searchParams.has('error')) {
    return redirect(response, '/?auth_error=google', clearGoogleCookies());
  }

  try {
    const identity = await getGoogleIdentity(code, verifier);
    const user = await getOrCreateGoogleUser(identity);
    const token = await createSession(user.id);
    return redirect(response, '/?google=success', [
      sessionCookie(token, sessionLifetimeMs / 1000),
      ...clearGoogleCookies(),
    ]);
  } catch (error) {
    console.error('Google login failed:', error.name);
    return redirect(response, '/?auth_error=google', clearGoogleCookies());
  }
}

async function catalogProducts() {
  const loadSmsCode = isSmsCodeConfigured() && smsCodeCache.expiresAt <= Date.now();
  const loadSmm = isProviderConfigured() && serviceCache.expiresAt <= Date.now();
  const [smsProducts, services] = await Promise.all([
    loadSmsCode ? getSmsCodeProducts() : Promise.resolve(smsCodeCache.products),
    loadSmm ? getProviderServices() : Promise.resolve(serviceCache.services),
  ]);
  if (loadSmsCode) {
    smsCodeCache = { products: smsProducts, expiresAt: Date.now() + serviceCacheTtlMs };
  }
  if (loadSmm) {
    serviceCache = {
      services,
      expiresAt: Date.now() + serviceCacheTtlMs,
    };
  }
  const products = [...smsCodeCache.products, ...serviceCache.services];
  return {
    products: products.map(({
      providerPrice,
      providerProductId,
      providerCatalogProductId,
      providerOperatorId,
      ...product
    }) => product),
    providerConfigured: isProviderConfigured(),
    smsCodeConfigured: isSmsCodeConfigured(),
  };
}

async function refundSmsCodeOrder(orderId, providerError = null, providerStatus = 'CANCELED') {
  await sql`
    WITH refunded AS (
      UPDATE orders
      SET status = 'refunded', provider_status = ${providerStatus},
          provider_error = ${providerError}, reviewed_at = NOW()
      WHERE id = ${orderId} AND product_type = 'number' AND status <> 'refunded'
      RETURNING user_id, amount, id
    ), credited AS (
      UPDATE users SET balance = users.balance + refunded.amount
      FROM refunded
      WHERE users.id = refunded.user_id
      RETURNING users.id AS user_id, users.balance, refunded.amount, refunded.id AS order_id
    )
    INSERT INTO ledger (id, user_id, type, amount, order_id, balance_after)
    SELECT ${randomBytes(12).toString('hex')}, user_id, 'refund', amount, order_id, balance
    FROM credited
  `;
  const rows = await sql`SELECT * FROM orders WHERE id = ${orderId} LIMIT 1`;
  if (!rows[0]) throw httpError(404, 'Pesanan tidak ditemukan.');
  return mapOrder(rows[0]);
}

function validateOrder(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'Data pesanan harus berupa objek JSON.');
  const productId = typeof input.productId === 'string' ? input.productId : '';
  let product = smsCodeCache.products.find((item) => item.id === productId);
  if (!product && productId.startsWith('smm-')) {
    product = serviceCache.services.find((item) => item.id === productId);
  }
  if (!product) throw httpError(400, 'Produk tidak ditemukan.');
  if (typeof input.customerName !== 'string' || input.customerName.trim().length < 2 || input.customerName.length > 80) {
    throw httpError(400, 'Nama harus diisi (2–80 karakter).');
  }
  if (typeof input.customerPhone !== 'string' || !/^[+0-9][0-9 -]{7,18}$/.test(input.customerPhone.trim())) {
    throw httpError(400, 'Nomor WhatsApp tidak valid.');
  }
  let target;
  let quantity;
  let comments;
  let username;
  if (product.type === 'smm') {
    try {
      target = new URL(input.target);
    } catch {
      throw httpError(400, 'Tautan target wajib diisi dengan URL yang valid.');
    }
    if (target.protocol !== 'https:') throw httpError(400, 'Tautan target harus menggunakan HTTPS.');
    quantity = Number(input.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < product.min || quantity > product.max) {
      throw httpError(400, `Jumlah harus antara ${product.min} dan ${product.max}.`);
    }
    comments = typeof input.comments === 'string' ? input.comments.trim() : '';
    username = typeof input.username === 'string' ? input.username.trim() : '';
    if (comments.length > 5000 || username.length > 100) throw httpError(400, 'Komentar atau username terlalu panjang.');
  }
  const total = product.type === 'smm'
    ? Math.ceil((product.pricePerThousand * quantity) / 1000)
    : product.price;
  const clientRequestId = typeof input.clientRequestId === 'string' ? input.clientRequestId : '';
  if (clientRequestId && !/^[a-f0-9-]{36}$/i.test(clientRequestId)) {
    throw httpError(400, 'ID permintaan pesanan tidak valid.');
  }
  return {
    product,
    customerName: input.customerName.trim(),
    customerPhone: input.customerPhone.trim(),
    target: target?.toString() || null,
    quantity: quantity || null,
    comments: comments || null,
    username: username || null,
    total,
    clientRequestId: clientRequestId || null,
  };
}

async function accountData(user) {
  const [topups, orders, transactions] = await Promise.all([
    sql`
      SELECT id, user_id, amount, status, created_at, reviewed_at
      FROM topups WHERE user_id = ${user.id} ORDER BY created_at DESC
    `,
    sql`SELECT * FROM orders WHERE user_id = ${user.id} ORDER BY created_at DESC`,
    sql`
      SELECT id, user_id, type, amount, order_id, topup_id, balance_after, created_at
      FROM ledger WHERE user_id = ${user.id} ORDER BY created_at DESC
    `,
  ]);
  return {
    user,
    topups: topups.map((item) => ({
      id: item.id,
      userId: item.user_id,
      amount: Number(item.amount),
      status: item.status,
      createdAt: epoch(item.created_at),
      reviewedAt: epoch(item.reviewed_at),
    })),
    orders: orders.map(mapOrder),
    transactions: transactions.map((item) => ({
      id: item.id,
      userId: item.user_id,
      type: item.type,
      amount: Number(item.amount),
      orderId: item.order_id,
      topupId: item.topup_id,
      balanceAfter: Number(item.balance_after),
      createdAt: epoch(item.created_at),
    })),
  };
}

async function api(request, response, pathname) {
  if (request.method === 'GET' && pathname === '/api/health') {
    await ensureSchema();
    return sendJson(response, 200, {
      status: 'ok',
      platform: 'vercel',
      database: 'neon',
      providerConfigured: isProviderConfigured(),
      smsCodeConfigured: isSmsCodeConfigured(),
      qrisPaymentConfigured: isDongtubePaymentConfigured(),
      googleAuthConfigured: isGoogleAuthConfigured(),
    });
  }
  await ensureSchema();

  if (request.method === 'GET' && pathname === '/api/settings') {
    return sendJson(response, 200, { site: config.site });
  }

  if (request.method === 'GET' && pathname === '/api/auth/google') {
    if (!isGoogleAuthConfigured()) return redirect(response, '/?auth_error=google_config');
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return redirect(response, googleAuthorizationUrl(state, challenge), [
      googleCookie('permadevv_google_state', state, 600),
      googleCookie('permadevv_google_verifier', verifier, 600),
    ]);
  }
  if (request.method === 'GET' && pathname === '/api/auth/google/callback') {
    return googleCallback(request, response);
  }

  if (request.method === 'GET' && pathname === '/api/products') {
    return sendJson(response, 200, await catalogProducts());
  }

  if (request.method === 'GET' && pathname === '/api/session') {
    const user = await currentUser(request);
    if (!user) return sendJson(response, 200, { authenticated: false });
    return sendJson(response, 200, { authenticated: true, ...(await accountData(user)) });
  }

  if (request.method === 'POST' && ['/api/register', '/api/login', '/api/logout'].includes(pathname)) {
    ensureSameOrigin(request);
    if (pathname !== '/api/logout') await checkAuthRateLimit(request);

    if (pathname === '/api/register') {
      const input = await readJson(request);
      if (typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.trim().length > 80) {
        throw httpError(400, 'Nama harus diisi (2–80 karakter).');
      }
      const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw httpError(400, 'Format email tidak valid.');
      if (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128) {
        throw httpError(400, 'Kata sandi harus terdiri dari 8–128 karakter.');
      }
      const password = await makePassword(input.password);
      const userId = randomBytes(16).toString('hex');
      const token = randomBytes(32).toString('base64url');
      let rows;
      try {
        rows = await sql`
          WITH new_user AS (
            INSERT INTO users (id, name, email, balance, password_salt, password_hash)
            VALUES (${userId}, ${input.name.trim()}, ${email}, 0, ${password.salt}, ${password.hash})
            RETURNING *
          ), new_session AS (
            INSERT INTO sessions (token_hash, user_id, expires_at)
            SELECT ${hashToken(token)}, id, ${new Date(Date.now() + sessionLifetimeMs)} FROM new_user
            RETURNING user_id
          )
          SELECT new_user.* FROM new_user JOIN new_session ON new_session.user_id = new_user.id
        `;
      } catch (error) {
        if (error.code === '23505') throw httpError(409, 'Email sudah terdaftar.');
        throw error;
      }
      const user = mapUser(rows[0]);
      return sendJson(response, 201, { authenticated: true, user }, {
        'Set-Cookie': sessionCookie(token, sessionLifetimeMs / 1000),
      });
    }

    if (pathname === '/api/login') {
      const input = await readJson(request);
      const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
      const rows = await sql`SELECT * FROM users WHERE email = ${email} LIMIT 1`;
      const user = rows[0];
      const passwordValid = user && typeof input.password === 'string' && await verifyPassword(input.password, user);
      if (!passwordValid) throw httpError(401, 'Email atau kata sandi salah.');
      const token = await createSession(user.id);
      return sendJson(response, 200, { authenticated: true, user: mapUser(user) }, {
        'Set-Cookie': sessionCookie(token, sessionLifetimeMs / 1000),
      });
    }

    const token = parseCookies(request.headers.cookie).permadevv_session;
    if (token) await sql`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`;
    return sendJson(response, 200, { authenticated: false }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  if (request.method === 'GET' && pathname === '/api/account') {
    const user = requireUser(await currentUser(request));
    return sendJson(response, 200, await accountData(user));
  }

  if (request.method === 'GET' && ['/api/admin/topups', '/api/admin/orders'].includes(pathname)) {
    ensureSameOrigin(request);
    requireAdmin(request);
    if (pathname.endsWith('/topups')) {
      const topups = await sql`
        SELECT topups.*, users.name AS customer_name, users.email AS customer_email
        FROM topups JOIN users ON users.id = topups.user_id
        WHERE topups.status = 'pending' ORDER BY topups.created_at
      `;
      return sendJson(response, 200, {
        topups: topups.map((item) => ({
          id: item.id,
          userId: item.user_id,
          amount: Number(item.amount),
          status: item.status,
          createdAt: epoch(item.created_at),
          customer: { id: item.user_id, name: item.customer_name, email: item.customer_email },
        })),
      });
    }
    await sql`
      UPDATE orders
      SET status = 'provider_unknown',
          provider_error = 'Function berhenti sebelum status pengiriman tersimpan; periksa pesanan di panel provider.'
      WHERE status = 'provider_submitting'
        AND created_at < NOW() - INTERVAL '5 minutes'
    `;
    const orders = await sql`
      SELECT orders.*, users.name AS customer_name, users.email AS customer_email
      FROM orders JOIN users ON users.id = orders.user_id
      WHERE orders.status IN ('pending_fulfillment', 'provider_submitting', 'provider_processing', 'provider_unknown', 'provider_expired')
      ORDER BY orders.created_at
    `;
    return sendJson(response, 200, {
      orders: orders.map((item) => ({
        ...mapOrder(item),
        customer: { id: item.user_id, name: item.customer_name, email: item.customer_email },
      })),
    });
  }

  if (request.method === 'POST' && pathname === '/api/topups') {
    ensureSameOrigin(request);
    const user = requireUser(await currentUser(request));
    const input = await readJson(request);
    if (!Number.isSafeInteger(input.amount) || input.amount < 10000 || input.amount > 10000000) {
      throw httpError(400, 'Nominal isi saldo harus Rp10.000–Rp10.000.000.');
    }
    const invoice = await createDongtubeInvoice(input.amount);
    const id = randomBytes(12).toString('hex');
    const rows = await sql`
      INSERT INTO topups (
        id, user_id, amount, status, payment_method, gateway_invoice_id,
        payment_total, qris_image, expires_at
      )
      VALUES (
        ${id}, ${user.id}, ${input.amount}, 'pending_payment', 'qris',
        ${invoice.invoiceId}, ${invoice.paymentTotal}, ${invoice.qrisImage},
        ${invoice.expiresAt ? new Date(invoice.expiresAt) : null}
      )
      RETURNING *
    `;
    const topup = rows[0];
    return sendJson(response, 201, {
      topup: {
        id: topup.id,
        userId: topup.user_id,
        amount: Number(topup.amount),
        status: topup.status,
        paymentMethod: topup.payment_method,
        gatewayInvoiceId: topup.gateway_invoice_id,
        paymentTotal: Number(topup.payment_total),
        qrisImage: topup.qris_image,
        expiresAt: epoch(topup.expires_at),
        createdAt: epoch(topup.created_at),
      },
      message: 'Invoice QRIS berhasil dibuat. Selesaikan pembayaran sebelum kedaluwarsa.',
    });
  }

  const topupPaymentMatch = pathname.match(/^\/api\/topups\/([a-f0-9]+)\/status$/);
  if (request.method === 'GET' && topupPaymentMatch) {
    const user = requireUser(await currentUser(request));
    const rows = await sql`
      SELECT * FROM topups WHERE id = ${topupPaymentMatch[1]} AND user_id = ${user.id} LIMIT 1
    `;
    const existing = rows[0];
    if (!existing) throw httpError(404, 'Invoice isi saldo tidak ditemukan.');
    if (existing.payment_method !== 'qris') throw httpError(400, 'Permintaan ini bukan pembayaran QRIS.');

    const gatewayStatus = existing.status === 'pending_payment'
      ? await getDongtubeInvoiceStatus(existing.gateway_invoice_id, Number(existing.amount))
      : { status: existing.status === 'paid' ? 'paid' : existing.status === 'expired' ? 'expired' : existing.status };

    if (existing.status === 'pending_payment' && gatewayStatus.status === 'expired') {
      await sql`
        UPDATE topups SET status = 'expired', reviewed_at = NOW()
        WHERE id = ${existing.id} AND user_id = ${user.id} AND status = 'pending_payment'
      `;
    }
    if (existing.status === 'pending_payment' && gatewayStatus.status === 'paid') {
      await sql`
        WITH paid AS (
          UPDATE topups SET status = 'paid', reviewed_at = NOW()
          WHERE id = ${existing.id} AND user_id = ${user.id} AND status = 'pending_payment'
          RETURNING *
        ), credited AS (
          UPDATE users SET balance = users.balance + paid.amount
          FROM paid WHERE users.id = paid.user_id
          RETURNING users.id AS user_id, users.balance, paid.amount, paid.id AS topup_id
        ), logged AS (
          INSERT INTO ledger (id, user_id, type, amount, topup_id, balance_after)
          SELECT ${randomBytes(12).toString('hex')}, user_id, 'topup', amount, topup_id, balance
          FROM credited
          RETURNING id
        )
        SELECT paid.id FROM paid JOIN logged ON TRUE
      `;
    }

    const finalRows = await sql`SELECT * FROM topups WHERE id = ${existing.id} LIMIT 1`;
    const topup = finalRows[0];
    return sendJson(response, 200, {
      topup: {
        id: topup.id,
        userId: topup.user_id,
        amount: Number(topup.amount),
        status: topup.status,
        paymentMethod: topup.payment_method,
        gatewayInvoiceId: topup.gateway_invoice_id,
        paymentTotal: Number(topup.payment_total),
        qrisImage: topup.qris_image,
        expiresAt: epoch(topup.expires_at),
        createdAt: epoch(topup.created_at),
      },
      gatewayStatus: topup.status === 'paid' ? 'paid' : topup.status === 'expired' ? 'expired' : 'pending',
      message: topup.status === 'paid'
        ? 'Pembayaran diterima dan saldo sudah ditambahkan.'
        : topup.status === 'expired' ? 'Invoice QRIS sudah kedaluwarsa.' : 'Pembayaran belum terdeteksi.',
    });
  }

  if (request.method === 'POST' && pathname === '/api/orders') {
    ensureSameOrigin(request);
    const user = requireUser(await currentUser(request));
    await catalogProducts();
    const validated = validateOrder(await readJson(request));
    if (validated.clientRequestId) {
      const previousRows = await sql`
        SELECT * FROM orders
        WHERE user_id = ${user.id} AND client_request_id = ${validated.clientRequestId}
        LIMIT 1
      `;
      if (previousRows[0]) {
        const previous = mapOrder(previousRows[0]);
        const sameRequest = previous.productId === validated.product.id
          && previous.customerName === validated.customerName
          && previous.customerPhone === validated.customerPhone
          && previous.target === validated.target
          && previous.quantity === validated.quantity
          && previous.comments === validated.comments
          && previous.username === validated.username;
        if (!sameRequest) {
          throw httpError(409, 'ID pesanan ini sudah digunakan untuk data pesanan yang berbeda. Buka checkout kembali.');
        }
        return sendJson(response, previous.status === 'provider_unknown' ? 202 : 200, {
          orderId: previous.id,
          status: previous.status,
          total: previous.amount,
          message: previous.status === 'provider_unknown'
            ? 'Status pesanan sebelumnya belum dapat dipastikan. Jangan kirim ulang; hubungi admin untuk pemeriksaan.'
            : 'Permintaan ini sudah pernah diproses.',
        });
      }
    }

    const orderId = randomBytes(12).toString('hex');
    const ledgerId = randomBytes(12).toString('hex');
    let createdRows;
    try {
      createdRows = await sql`
        WITH debited AS (
          UPDATE users
          SET balance = balance - ${validated.total}
          WHERE id = ${user.id} AND balance >= ${validated.total}
            AND NOT EXISTS (
              SELECT 1 FROM orders
              WHERE user_id = ${user.id} AND client_request_id = ${validated.clientRequestId}
            )
          RETURNING id, balance
        ), created AS (
          INSERT INTO orders (
            id, user_id, product_id, product_name, product_type, amount, target,
            quantity, comments, username, customer_name, customer_phone,
            client_request_id, status, provider_catalog_product_id, provider_max_price,
            provider_operator_id
          )
          SELECT
            ${orderId}, debited.id, ${validated.product.id}, ${validated.product.name},
            ${validated.product.type}, ${validated.total}, ${validated.target},
            ${validated.quantity}, ${validated.comments}, ${validated.username},
            ${validated.customerName}, ${validated.customerPhone},
            ${validated.clientRequestId},
            ${['smm', 'number'].includes(validated.product.type) ? 'provider_submitting' : 'pending_fulfillment'},
            ${validated.product.type === 'number' ? validated.product.providerCatalogProductId : null},
            ${validated.product.type === 'number' ? validated.product.providerPrice : null},
            ${validated.product.type === 'number' ? validated.product.providerOperatorId : null}
          FROM debited
          RETURNING *
        ), logged AS (
          INSERT INTO ledger (id, user_id, type, amount, order_id, balance_after)
          SELECT ${ledgerId}, created.user_id, 'purchase', -created.amount, created.id, debited.balance
          FROM created JOIN debited ON debited.id = created.user_id
          RETURNING id
        )
        SELECT created.*, debited.balance
        FROM created JOIN debited ON debited.id = created.user_id
        JOIN logged ON TRUE
      `;
    } catch (error) {
      if (error.code === '23505' && validated.clientRequestId) {
        const previousRows = await sql`
          SELECT * FROM orders WHERE user_id = ${user.id}
            AND client_request_id = ${validated.clientRequestId} LIMIT 1
        `;
        if (previousRows[0]) {
          const previous = mapOrder(previousRows[0]);
          return sendJson(response, previous.status === 'provider_unknown' ? 202 : 200, {
            orderId: previous.id,
            status: previous.status,
            total: previous.amount,
            message: 'Permintaan ini sudah pernah diproses.',
          });
        }
      }
      throw error;
    }
    if (!createdRows[0]) {
      const balanceRows = await sql`SELECT balance FROM users WHERE id = ${user.id}`;
      if (!balanceRows[0]) throw httpError(401, 'Akun tidak ditemukan. Silakan masuk kembali.');
      if (Number(balanceRows[0].balance) < validated.total) {
        throw httpError(402, 'Saldo tidak mencukupi. Ajukan isi saldo dari menu Profil.');
      }
      throw httpError(409, 'Pesanan ini sedang diproses. Periksa riwayat sebelum mengirim ulang.');
    }
    const order = mapOrder(createdRows[0]);
    const balance = Number(createdRows[0].balance);

    if (order.productType === 'smm') {
      let providerOrderId = null;
      try {
        const providerResult = await placeProviderOrder({
          service: validated.product,
          target: validated.target,
          quantity: validated.quantity,
          comments: validated.comments,
          username: validated.username,
        });
        providerOrderId = providerResult.orderId;
        await sql`
          UPDATE orders
          SET provider_order_id = ${providerOrderId}, provider_status = 'Pending',
              status = 'provider_processing', provider_submitted_at = NOW()
          WHERE id = ${order.id}
        `;
        return sendJson(response, 201, {
          orderId: order.id,
          status: 'provider_processing',
          total: order.amount,
          balance,
          message: `Pesanan berhasil dikirim ke provider. ID provider: ${providerOrderId}.`,
        });
      } catch (error) {
        const uncertain = !(error instanceof ProviderError) || error.uncertain;
        if (uncertain) {
          await sql`
            UPDATE orders SET status = 'provider_unknown', provider_error = ${error.message},
              provider_order_id = COALESCE(${providerOrderId}, provider_order_id)
            WHERE id = ${order.id}
          `;
          return sendJson(response, 202, {
            orderId: order.id,
            status: 'provider_unknown',
            total: order.amount,
            balance,
            message: 'Status pengiriman ke provider belum dapat dipastikan. Jangan buat pesanan ulang; hubungi admin untuk pemeriksaan.',
          });
        }

        await sql`
          WITH refunded AS (
            UPDATE orders SET status = 'refunded', provider_error = ${error.message}, reviewed_at = NOW()
            WHERE id = ${order.id} AND status = 'provider_submitting'
            RETURNING user_id, amount, id
          ), credited AS (
            UPDATE users SET balance = users.balance + refunded.amount
            FROM refunded WHERE users.id = refunded.user_id
            RETURNING users.id, users.balance, refunded.id AS order_id, refunded.amount
          )
          INSERT INTO ledger (id, user_id, type, amount, order_id, balance_after)
          SELECT ${randomBytes(12).toString('hex')}, id, 'refund', amount, order_id, balance FROM credited
        `;
        return sendJson(response, 502, {
          error: 'provider_rejected',
          orderId: order.id,
          message: `Provider menolak pesanan. Saldo telah dikembalikan. ${error.message}`,
        });
      }
    }

    if (order.productType === 'number') {
      try {
        const providerOrder = await createSmsCodeOrder(
          validated.product,
          order.clientRequestId || order.id,
        );
        const updatedRows = await sql`
          UPDATE orders
          SET provider_order_id = ${String(providerOrder.id)},
              provider_status = ${providerOrder.status},
              target = ${providerOrder.phone_number || null},
              status = ${providerOrder.status === 'COMPLETED' ? 'completed' : 'provider_processing'},
              provider_submitted_at = NOW(),
              completed_at = CASE WHEN ${providerOrder.status === 'COMPLETED'} THEN NOW() ELSE completed_at END
          WHERE id = ${order.id}
          RETURNING *
        `;
        const updated = mapOrder(updatedRows[0]);
        return sendJson(response, 201, {
          orderId: order.id,
          status: updated.status,
          total: order.amount,
          balance,
          phoneNumber: updated.target,
          providerStatus: updated.providerStatus,
          message: updated.target
            ? `Nomor berhasil disewa: ${updated.target}. Tekan “Cek OTP” pada riwayat pesanan untuk menunggu kode.`
            : 'Nomor berhasil dipesan. Tekan “Cek OTP” pada riwayat pesanan untuk melihat nomor dan kode.',
        });
      } catch (error) {
        const uncertain = !(error instanceof SmsCodeOrderError) || error.uncertain;
        if (uncertain) {
          await sql`
            UPDATE orders SET status = 'provider_unknown', provider_error = ${error.message}
            WHERE id = ${order.id}
          `;
          return sendJson(response, 202, {
            orderId: order.id,
            status: 'provider_unknown',
            total: order.amount,
            balance,
            message: 'Status pembuatan nomor belum dapat dipastikan. Tekan “Cek OTP” untuk mencoba kembali dengan kunci transaksi yang sama.',
          });
        }

        await refundSmsCodeOrder(order.id, error.message);
        return sendJson(response, 502, {
          error: 'smscode_rejected',
          orderId: order.id,
          message: `SMSCode menolak pesanan. Saldo telah dikembalikan. ${error.message}`,
        });
      }
    }

    return sendJson(response, 201, {
      orderId: order.id,
      status: order.status,
      total: order.amount,
      balance,
      message: 'Pesanan berhasil dibuat.',
    });
  }

  const orderStatusMatch = pathname.match(/^\/api\/orders\/([a-f0-9]+)\/status$/);
  if (request.method === 'GET' && orderStatusMatch) {
    const user = requireUser(await currentUser(request));
    let rows = await sql`
      SELECT * FROM orders WHERE id = ${orderStatusMatch[1]} AND user_id = ${user.id} LIMIT 1
    `;
    if (!rows[0]) throw httpError(404, 'Pesanan tidak ditemukan.');
    let order = mapOrder(rows[0]);
    if (order.productType === 'number') {
      if (!order.providerOrderId && order.status === 'provider_unknown') {
        await catalogProducts();
        const product = smsCodeCache.products.find((item) => item.id === order.productId) || {
          id: order.productId,
          providerCatalogProductId: rows[0].provider_catalog_product_id,
          providerPrice: Number(rows[0].provider_max_price),
          providerOperatorId: rows[0].provider_operator_id,
        };
        if (!Number.isSafeInteger(product.providerCatalogProductId)
          || !Number.isSafeInteger(product.providerPrice)
          || product.providerPrice <= 0) {
          throw httpError(409, 'Data produk SMSCode tidak tersedia untuk pemulihan transaksi ini.');
        }
        try {
          const created = await createSmsCodeOrder(product, order.clientRequestId || order.id);
          rows = await sql`
            UPDATE orders
            SET provider_order_id = ${String(created.id)},
                provider_status = ${created.status},
                target = ${created.phone_number || null},
                status = ${created.status === 'COMPLETED' ? 'completed' : 'provider_processing'},
                provider_submitted_at = NOW(),
                completed_at = CASE WHEN ${created.status === 'COMPLETED'} THEN NOW() ELSE completed_at END
            WHERE id = ${order.id} AND user_id = ${user.id}
            RETURNING *
          `;
          order = mapOrder(rows[0]);
        } catch (error) {
          if (error instanceof SmsCodeOrderError && !error.uncertain) {
            order = await refundSmsCodeOrder(order.id, error.message, 'REJECTED');
            return sendJson(response, 502, {
              order,
              message: `SMSCode menolak pesanan. Saldo telah dikembalikan. ${error.message}`,
            });
          }
          await sql`UPDATE orders SET provider_error = ${error.message} WHERE id = ${order.id}`;
          return sendJson(response, 202, {
            order,
            message: 'Nomor belum terkonfirmasi. Coba cek kembali sebentar lagi; pesanan memakai ID transaksi yang sama.',
          });
        }
      }
      if (!order.providerOrderId || order.status === 'refunded') {
        return sendJson(response, 200, { order, providerStatus: order.providerStatus || null });
      }
      const wait = new URL(request.url, 'http://localhost').searchParams.get('wait') === 'true';
      const afterCode = typeof request.headers['x-otp-after-code'] === 'string'
        && request.headers['x-otp-after-code'].length <= 256
        ? request.headers['x-otp-after-code']
        : undefined;
      const afterRevisionValue = Number(request.headers['x-otp-after-revision']);
      const afterRevision = Number.isSafeInteger(afterRevisionValue) && afterRevisionValue >= 0
        ? afterRevisionValue
        : undefined;
      const providerOrder = wait
        ? (await waitForSmsCodeOtp(order.providerOrderId, { afterCode, afterRevision })).order
        : await getSmsCodeOrder(order.providerOrderId);
      if (providerOrder.status === 'CANCELED') {
        order = await refundSmsCodeOrder(order.id);
      } else {
        rows = await sql`
          UPDATE orders
          SET provider_status = ${providerOrder.status},
              target = COALESCE(${providerOrder.phone_number || null}, target),
              status = CASE
                WHEN ${providerOrder.status} = 'COMPLETED' THEN 'completed'
                WHEN ${providerOrder.status} = 'EXPIRED' THEN 'provider_expired'
                ELSE 'provider_processing'
              END,
              completed_at = CASE WHEN ${providerOrder.status} = 'COMPLETED' THEN COALESCE(completed_at, NOW()) ELSE completed_at END
          WHERE id = ${order.id} AND user_id = ${user.id}
          RETURNING *
        `;
        order = mapOrder(rows[0]);
      }
      return sendJson(response, 200, {
        order,
        providerStatus: providerOrder.status,
        smsCode: {
          phoneNumber: providerOrder.phone_number || order.target,
          otpCode: providerOrder.otp_code || null,
          otpMessage: providerOrder.otp_message || null,
          smsRevision: providerOrder.sms_revision ?? null,
          canCancel: providerOrder.can_cancel === true,
          canFinish: providerOrder.can_finish === true,
          canResend: providerOrder.can_resend === true,
          expiresAt: providerOrder.expires_at || null,
          failedReason: providerOrder.failed_reason || null,
        },
      });
    }

    if (!order.providerOrderId || !['provider_processing', 'provider_unknown'].includes(order.status)) {
      return sendJson(response, 200, { order, providerStatus: order.providerStatus || null });
    }
    const providerStatus = await getProviderOrderStatus(order.providerOrderId);
    const completed = /^(completed|complete|success|sukses)$/i.test(providerStatus.status);
    const updatedRows = await sql`
      UPDATE orders
      SET provider_status = ${providerStatus.status},
          provider_start_count = ${providerStatus.startCount === null ? null : String(providerStatus.startCount)},
          provider_remains = ${providerStatus.remains === null ? null : String(providerStatus.remains)},
          status = ${completed ? 'completed' : 'provider_processing'},
          completed_at = CASE WHEN ${completed} THEN NOW() ELSE completed_at END
      WHERE id = ${order.id} AND user_id = ${user.id}
      RETURNING *
    `;
    return sendJson(response, 200, { order: mapOrder(updatedRows[0]), providerStatus });
  }

  const smsCodeActionMatch = pathname.match(/^\/api\/orders\/([a-f0-9]+)\/(cancel|finish|resend)$/);
  if (request.method === 'POST' && smsCodeActionMatch) {
    ensureSameOrigin(request);
    const user = requireUser(await currentUser(request));
    const rows = await sql`
      SELECT * FROM orders WHERE id = ${smsCodeActionMatch[1]} AND user_id = ${user.id} LIMIT 1
    `;
    if (!rows[0]) throw httpError(404, 'Pesanan tidak ditemukan.');
    const order = mapOrder(rows[0]);
    if (order.productType !== 'number' || !order.providerOrderId) {
      throw httpError(409, 'Pesanan ini bukan sewa nomor SMSCode yang aktif.');
    }

    const action = smsCodeActionMatch[2];
    const providerOrder = await getSmsCodeOrder(order.providerOrderId);
    if (action === 'resend') {
      if (!providerOrder.can_resend) {
        throw httpError(409, 'SMSCode belum mengizinkan pengiriman ulang OTP untuk nomor ini.');
      }
      const result = await resendSmsCodeOrder(order.providerOrderId);
      return sendJson(response, 200, {
        order,
        otpBaseline: {
          afterCode: providerOrder.otp_code || '',
          afterRevision: providerOrder.sms_revision,
        },
        message: result.resent ? 'Permintaan pengiriman ulang OTP diterima.' : 'SMSCode belum mengirim ulang OTP.',
      });
    }
    if (action === 'cancel') {
      if (providerOrder.status === 'CANCELED') {
        const refunded = await refundSmsCodeOrder(order.id);
        return sendJson(response, 200, { order: refunded, message: 'Nomor dibatalkan dan saldo dikembalikan.' });
      }
      if (!providerOrder.can_cancel) {
        throw httpError(409, 'Nomor belum dapat dibatalkan. SMSCode hanya mengizinkan pembatalan sebelum SMS diterima.');
      }
      try {
        await cancelSmsCodeOrder(order.providerOrderId);
      } catch (error) {
        const latest = await getSmsCodeOrder(order.providerOrderId);
        if (latest.status !== 'CANCELED') {
          throw httpError(502, `Pembatalan belum dapat dipastikan. Periksa kembali status nomor sebelum mencoba lagi. ${error.message}`);
        }
      }
      const refunded = await refundSmsCodeOrder(order.id);
      return sendJson(response, 200, { order: refunded, message: 'Nomor dibatalkan dan saldo dikembalikan.' });
    }

    if (providerOrder.status === 'COMPLETED') {
      return sendJson(response, 200, { order, message: 'Nomor sudah ditandai selesai.' });
    }
    if (!providerOrder.can_finish) {
      throw httpError(409, 'Nomor belum menerima SMS dan belum dapat diselesaikan.');
    }
    try {
      await finishSmsCodeOrder(order.providerOrderId);
    } catch (error) {
      const latest = await getSmsCodeOrder(order.providerOrderId);
      if (latest.status !== 'COMPLETED') {
        throw httpError(502, `Penyelesaian belum dapat dipastikan. Periksa kembali status nomor sebelum mencoba lagi. ${error.message}`);
      }
    }
    const updatedRows = await sql`
      UPDATE orders
      SET provider_status = 'COMPLETED', status = 'completed',
          completed_at = COALESCE(completed_at, NOW())
      WHERE id = ${order.id} AND user_id = ${user.id}
      RETURNING *
    `;
    return sendJson(response, 200, {
      order: mapOrder(updatedRows[0]),
      message: 'Nomor berhasil ditandai selesai.',
    });
  }

  const adminTopupMatch = pathname.match(/^\/api\/admin\/topups\/([a-f0-9]+)$/);
  if (request.method === 'POST' && adminTopupMatch) {
    ensureSameOrigin(request);
    requireAdmin(request);
    const input = await readJson(request);
    if (!['approve', 'reject'].includes(input.action)) throw httpError(400, 'Aksi harus approve atau reject.');
    let rows;
    if (input.action === 'approve') {
      rows = await sql`
        WITH reviewed AS (
          UPDATE topups SET status = 'approved', reviewed_at = NOW()
          WHERE id = ${adminTopupMatch[1]} AND status = 'pending'
          RETURNING *
        ), credited AS (
          UPDATE users SET balance = users.balance + reviewed.amount
          FROM reviewed WHERE users.id = reviewed.user_id
          RETURNING users.balance, users.id AS user_id, reviewed.id AS topup_id, reviewed.amount, reviewed.created_at
        ), logged AS (
          INSERT INTO ledger (id, user_id, type, amount, topup_id, balance_after)
          SELECT ${randomBytes(12).toString('hex')}, user_id, 'topup', amount, topup_id, balance FROM credited
          RETURNING id
        )
        SELECT reviewed.* FROM reviewed JOIN logged ON TRUE
      `;
    } else {
      rows = await sql`
        UPDATE topups SET status = 'rejected', reviewed_at = NOW()
        WHERE id = ${adminTopupMatch[1]} AND status = 'pending'
        RETURNING *
      `;
    }
    if (!rows[0]) {
      const existing = await sql`SELECT id FROM topups WHERE id = ${adminTopupMatch[1]} LIMIT 1`;
      if (!existing[0]) throw httpError(404, 'Permintaan isi saldo tidak ditemukan.');
      throw httpError(409, 'Permintaan isi saldo sudah diproses.');
    }
    const item = rows[0];
    const topup = {
      id: item.id,
      userId: item.user_id,
      amount: Number(item.amount),
      status: item.status,
      createdAt: epoch(item.created_at),
      reviewedAt: epoch(item.reviewed_at),
    };
    return sendJson(response, 200, {
      topup,
      message: `Permintaan berhasil ${topup.status === 'approved' ? 'disetujui' : 'ditolak'}.`,
    });
  }

  const adminOrderMatch = pathname.match(/^\/api\/admin\/orders\/([a-f0-9]+)$/);
  if (request.method === 'POST' && adminOrderMatch) {
    ensureSameOrigin(request);
    requireAdmin(request);
    const input = await readJson(request);
    if (!['complete', 'refund'].includes(input.action)) throw httpError(400, 'Aksi harus complete atau refund.');
    let rows;
    if (input.action === 'refund') {
      rows = await sql`
        WITH refunded AS (
          UPDATE orders SET status = 'refunded', reviewed_at = NOW()
          WHERE id = ${adminOrderMatch[1]}
            AND status IN ('pending_fulfillment', 'provider_processing', 'provider_unknown', 'provider_expired')
          RETURNING *
        ), credited AS (
          UPDATE users SET balance = users.balance + refunded.amount
          FROM refunded WHERE users.id = refunded.user_id
          RETURNING users.balance, users.id AS user_id, refunded.id AS order_id, refunded.amount
        ), logged AS (
          INSERT INTO ledger (id, user_id, type, amount, order_id, balance_after)
          SELECT ${randomBytes(12).toString('hex')}, user_id, 'refund', amount, order_id, balance FROM credited
          RETURNING id
        )
        SELECT refunded.* FROM refunded JOIN logged ON TRUE
      `;
    } else {
      rows = await sql`
        UPDATE orders SET status = 'completed', reviewed_at = NOW()
        WHERE id = ${adminOrderMatch[1]}
          AND status IN ('pending_fulfillment', 'provider_processing', 'provider_unknown', 'provider_expired')
        RETURNING *
      `;
    }
    if (!rows[0]) {
      const existing = await sql`SELECT id FROM orders WHERE id = ${adminOrderMatch[1]} LIMIT 1`;
      if (!existing[0]) throw httpError(404, 'Pesanan tidak ditemukan.');
      throw httpError(409, 'Pesanan sudah diproses.');
    }
    const order = mapOrder(rows[0]);
    return sendJson(response, 200, {
      order,
      message: order.status === 'completed'
        ? 'Pesanan ditandai selesai. Pastikan layanan sudah dipenuhi sebelum melakukan aksi ini.'
        : 'Pesanan dibatalkan dan saldo dikembalikan.',
    });
  }

  return sendJson(response, 404, { error: 'not_found', message: 'Endpoint tidak ditemukan.' });
}

export default async function handler(request, response) {
  const pathname = new URL(request.url, `https://${request.headers.host || 'localhost'}`).pathname;
  try {
    await api(request, response, pathname);
  } catch (error) {
    if (!error.statusCode) console.error('Vercel API request failed:', error.message);
    const statusCode = error.statusCode || (error instanceof ProviderError ? 502 : 500);
    return sendJson(response, statusCode, {
      error: error.statusCode ? 'request_error' : error instanceof ProviderError ? 'provider_error' : 'server_error',
      message: error.statusCode || error instanceof ProviderError ? error.message : 'Terjadi kesalahan pada server.',
    });
  }
}
