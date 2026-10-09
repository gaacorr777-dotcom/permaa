import { createServer } from 'node:http';
import { createHash, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { config, projectDirectory } from './config.mjs';
import {
  createDongtubeInvoice,
  getDongtubeInvoiceStatus,
  isDongtubePaymentConfigured,
} from './dongtube.mjs';
import {
  getProviderOrderStatus,
  getProviderServices,
  isProviderConfigured,
  placeProviderOrder,
  ProviderError,
} from './provider.mjs';
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
} from './smscode.mjs';
import {
  getGoogleIdentity,
  googleAuthorizationUrl,
  isGoogleAuthConfigured,
} from './google-auth.mjs';

const { host, port } = config.server;
const dataDirectory = resolve(projectDirectory, config.storage.directory);
const dataFile = resolve(dataDirectory, 'store.json');
const maxBodyLength = 12 * 1024;
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const passwordIterations = 210000;
const pbkdf2Async = promisify(pbkdf2);
let mutationQueue = Promise.resolve();
const authAttempts = new Map();

const serviceCacheTtlMs = 5 * 60 * 1000;
let serviceCache = { expiresAt: 0, services: [] };
let smsCodeCache = { expiresAt: 0, products: [] };

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/script.js', ['script.js', 'text/javascript; charset=utf-8']],
]);

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function sendJson(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  if (!request.headers['content-type']?.includes('application/json')) {
    throw httpError(415, 'Content-Type harus application/json.');
  }

  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, 'utf8') > maxBodyLength) {
      throw httpError(413, 'Ukuran data terlalu besar.');
    }
  }

  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw httpError(400, 'Format JSON tidak valid.');
  }
}

async function readStore() {
  try {
    return JSON.parse(await readFile(dataFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { users: [], sessions: [], topups: [], orders: [], ledger: [] };
    }
    throw error;
  }
}

async function writeStore(store) {
  await mkdir(dataDirectory, { recursive: true });
  const temporaryFile = `${dataFile}.${process.pid}.tmp`;
  await writeFile(temporaryFile, JSON.stringify(store, null, 2), { mode: 0o600 });
  await rename(temporaryFile, dataFile);
}

function mutateStore(mutator) {
  const operation = mutationQueue.then(async () => {
    const store = await readStore();
    const result = await mutator(store);
    await writeStore(store);
    return result;
  });
  mutationQueue = operation.catch(() => {});
  return operation;
}

function storeSnapshot() {
  return mutationQueue.then(readStore);
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((entry) => {
    const separator = entry.indexOf('=');
    if (separator < 0) return ['', ''];
    return [entry.slice(0, separator).trim(), decodeURIComponent(entry.slice(separator + 1).trim())];
  }).filter(([key]) => key));
}

function sessionCookie(token, maxAge) {
  const secure = config.server.nodeEnv === 'production' ? '; Secure' : '';
  return `permadevv_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function googleCookie(name, value, maxAge) {
  const secure = config.server.nodeEnv === 'production' ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/api/auth/google/callback; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function redirect(response, location, cookies = []) {
  const headers = { Location: location, 'Cache-Control': 'no-store' };
  if (cookies.length) headers['Set-Cookie'] = cookies;
  response.writeHead(302, headers);
  response.end();
}

function googleStateMatches(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, balance: user.balance, createdAt: user.createdAt };
}

async function currentUser(request) {
  const token = parseCookies(request.headers.cookie).permadevv_session;
  if (!token) return null;
  const store = await storeSnapshot();
  const session = store.sessions.find((item) => item.tokenHash === hashToken(token) && item.expiresAt > Date.now());
  return session ? store.users.find((item) => item.id === session.userId) || null : null;
}

function requireUser(user) {
  if (!user) throw httpError(401, 'Silakan masuk ke akun terlebih dahulu.');
  return user;
}

function requireAdmin(request) {
  const configuredKey = config.admin.topupKey;
  const suppliedKey = request.headers['x-admin-key'];
  if (!configuredKey || typeof suppliedKey !== 'string') throw httpError(503, 'Verifikasi admin belum dikonfigurasi.');
  const expected = Buffer.from(configuredKey);
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

function checkAuthRateLimit(request) {
  const ip = request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (authAttempts.get(ip) || []).filter((time) => now - time < 15 * 60 * 1000);
  if (recent.length >= 10) throw httpError(429, 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.');
  recent.push(now);
  authAttempts.set(ip, recent);
}

function validateOrder(order) {
  if (!order || typeof order !== 'object' || Array.isArray(order)) throw httpError(400, 'Data pesanan harus berupa objek JSON.');
  const productId = typeof order.productId === 'string' ? order.productId : '';
  let product = smsCodeCache.products.find((item) => item.id === productId);
  if (!product && productId.startsWith('smm-')) {
    product = serviceCache.services.find((item) => item.id === productId);
  }
  if (!product) throw httpError(400, 'Produk tidak ditemukan.');
  if (typeof order.customerName !== 'string' || order.customerName.trim().length < 2 || order.customerName.length > 80) {
    throw httpError(400, 'Nama harus diisi (2–80 karakter).');
  }
  if (typeof order.customerPhone !== 'string' || !/^[+0-9][0-9 -]{7,18}$/.test(order.customerPhone.trim())) {
    throw httpError(400, 'Nomor WhatsApp tidak valid.');
  }
  let target;
  let quantity;
  let comments;
  let username;
  if (product.type === 'smm') {
    try {
      target = new URL(order.target);
    } catch {
      throw httpError(400, 'Tautan target wajib diisi dengan URL yang valid.');
    }
    if (target.protocol !== 'https:') throw httpError(400, 'Tautan target harus menggunakan HTTPS.');
    quantity = Number(order.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < product.min || quantity > product.max) {
      throw httpError(400, `Jumlah harus antara ${product.min} dan ${product.max}.`);
    }
    comments = typeof order.comments === 'string' ? order.comments.trim() : '';
    username = typeof order.username === 'string' ? order.username.trim() : '';
    if (comments.length > 5000 || username.length > 100) throw httpError(400, 'Komentar atau username terlalu panjang.');
  }
  const total = product.type === 'smm'
    ? Math.ceil((product.pricePerThousand * quantity) / 1000)
    : product.price;
  const clientRequestId = typeof order.clientRequestId === 'string' ? order.clientRequestId : '';
  if (clientRequestId && !/^[a-f0-9-]{36}$/i.test(clientRequestId)) {
    throw httpError(400, 'ID permintaan pesanan tidak valid.');
  }
  return {
    product,
    customerName: order.customerName.trim(),
    customerPhone: order.customerPhone.trim(),
    target: target?.toString(),
    quantity,
    comments,
    username,
    total,
    clientRequestId,
  };
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

function buildAccountData(store, user) {
  return {
    user: publicUser(user),
    topups: store.topups.filter((item) => item.userId === user.id).sort((a, b) => b.createdAt - a.createdAt),
    orders: store.orders
      .filter((item) => item.userId === user.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ providerCatalogProductId, providerMaxPrice, providerOperatorId, ...item }) => item),
    transactions: store.ledger.filter((item) => item.userId === user.id).sort((a, b) => b.createdAt - a.createdAt),
  };
}

async function refundSmsCodeOrder(orderId, providerError = null) {
  return mutateStore((store) => {
    const item = store.orders.find((entry) => entry.id === orderId);
    if (!item) throw httpError(404, 'Pesanan tidak ditemukan.');
    if (item.status === 'refunded') return item;
    const account = store.users.find((entry) => entry.id === item.userId);
    if (!account) throw httpError(404, 'Akun pemilik pesanan tidak ditemukan saat pengembalian saldo.');
    item.status = 'refunded';
    item.providerStatus = 'CANCELED';
    item.providerError = providerError;
    item.reviewedAt = Date.now();
    account.balance += item.amount;
    store.ledger.push({
      id: randomBytes(12).toString('hex'),
      userId: item.userId,
      type: 'refund',
      amount: item.amount,
      orderId: item.id,
      balanceAfter: account.balance,
      createdAt: item.reviewedAt,
    });
    return item;
  });
}

async function makePassword(password) {
  const salt = randomBytes(16);
  const derived = await pbkdf2Async(password, salt, passwordIterations, 64, 'sha512');
  return { salt: salt.toString('hex'), hash: Buffer.from(derived).toString('hex') };
}

async function verifyPassword(password, user) {
  const derived = Buffer.from(await pbkdf2Async(password, Buffer.from(user.passwordSalt, 'hex'), passwordIterations, 64, 'sha512'));
  const expected = Buffer.from(user.passwordHash, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

async function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  await mutateStore((store) => {
    const now = Date.now();
    store.sessions = store.sessions.filter((item) => item.expiresAt > now);
    store.sessions.push({ tokenHash: hashToken(token), userId, expiresAt: now + sessionLifetimeMs });
  });
  return token;
}

async function getOrCreateGoogleUser(identity) {
  return mutateStore((store) => {
    const linkedUser = store.users.find((item) => item.googleSub === identity.subject);
    if (linkedUser) return linkedUser;

    const existingUser = store.users.find((item) => item.email === identity.email);
    if (existingUser) {
      if (existingUser.googleSub && existingUser.googleSub !== identity.subject) {
        throw httpError(409, 'Email Google sudah terhubung ke akun lain.');
      }
      existingUser.googleSub = identity.subject;
      return existingUser;
    }

    const displayName = identity.name.slice(0, 80);
    const user = {
      id: randomBytes(16).toString('hex'),
      name: displayName.length >= 2 ? displayName : 'Google User',
      email: identity.email,
      balance: 0,
      passwordSalt: randomBytes(16).toString('hex'),
      passwordHash: randomBytes(64).toString('hex'),
      googleSub: identity.subject,
      createdAt: Date.now(),
    };
    store.users.push(user);
    return user;
  });
}

function clearGoogleCookies() {
  return [
    googleCookie('permadevv_google_state', '', 0),
    googleCookie('permadevv_google_verifier', '', 0),
  ];
}

async function googleCallback(request, response) {
  const callbackUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
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

async function routeApi(request, response, pathname) {
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

  if (request.method === 'GET' && pathname === '/api/health') {
    return sendJson(response, 200, {
      status: 'ok',
      authentication: true,
      topupsRequireManualApproval: false,
      smsCodeConfigured: isSmsCodeConfigured(),
      qrisPaymentConfigured: isDongtubePaymentConfigured(),
      googleAuthConfigured: isGoogleAuthConfigured(),
    });
  }
  if (request.method === 'GET' && pathname === '/api/products') {
    const catalog = await catalogProducts();
    return sendJson(response, 200, catalog);
  }
  if (request.method === 'GET' && pathname === '/api/session') {
    const user = await currentUser(request);
    if (!user) return sendJson(response, 200, { authenticated: false });
    const store = await storeSnapshot();
    return sendJson(response, 200, { authenticated: true, ...buildAccountData(store, user) });
  }

  if (request.method === 'POST' && ['/api/register', '/api/login', '/api/logout'].includes(pathname)) {
    ensureSameOrigin(request);
    if (pathname !== '/api/logout') checkAuthRateLimit(request);

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
      const credentials = await makePassword(input.password);
      const user = await mutateStore((store) => {
        if (store.users.some((item) => item.email === email)) throw httpError(409, 'Email sudah terdaftar.');
        const created = {
          id: randomBytes(16).toString('hex'),
          name: input.name.trim(),
          email,
          balance: 0,
          passwordSalt: credentials.salt,
          passwordHash: credentials.hash,
          createdAt: Date.now(),
        };
        store.users.push(created);
        return created;
      });
      const token = await createSession(user.id);
      return sendJson(response, 201, { authenticated: true, user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token, sessionLifetimeMs / 1000) });
    }

    if (pathname === '/api/login') {
      const input = await readJson(request);
      const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
      const store = await storeSnapshot();
      const user = store.users.find((item) => item.email === email);
      const passwordValid = user && typeof input.password === 'string' && await verifyPassword(input.password, user);
      if (!passwordValid) throw httpError(401, 'Email atau kata sandi salah.');
      const token = await createSession(user.id);
      return sendJson(response, 200, { authenticated: true, user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token, sessionLifetimeMs / 1000) });
    }

    const token = parseCookies(request.headers.cookie).permadevv_session;
    if (token) {
      const tokenHash = hashToken(token);
      await mutateStore((store) => {
        store.sessions = store.sessions.filter((item) => item.tokenHash !== tokenHash);
      });
    }
    return sendJson(response, 200, { authenticated: false }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  if (request.method === 'GET' && pathname === '/api/account') {
    const user = requireUser(await currentUser(request));
    const store = await storeSnapshot();
    return sendJson(response, 200, buildAccountData(store, user));
  }

  if (request.method === 'GET' && ['/api/admin/topups', '/api/admin/orders'].includes(pathname)) {
    ensureSameOrigin(request);
    requireAdmin(request);
    const store = await storeSnapshot();
    const key = pathname.endsWith('/topups') ? 'topups' : 'orders';
    const pendingItems = store[key].filter((item) =>
      key === 'topups'
        ? item.status === 'pending'
        : ['pending_fulfillment', 'provider_submitting', 'provider_processing', 'provider_unknown', 'provider_expired'].includes(item.status));
    return sendJson(response, 200, {
      [key]: pendingItems.map((item) => ({
        ...item,
        customer: publicUser(store.users.find((user) => user.id === item.userId)),
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
    const topup = await mutateStore((store) => {
      const item = {
        id: randomBytes(12).toString('hex'),
        userId: user.id,
        amount: input.amount,
        status: 'pending_payment',
        paymentMethod: 'qris',
        gatewayInvoiceId: invoice.invoiceId,
        paymentTotal: invoice.paymentTotal,
        qrisImage: invoice.qrisImage,
        expiresAt: invoice.expiresAt ? Date.parse(invoice.expiresAt) : null,
        createdAt: Date.now(),
      };
      store.topups.push(item);
      return item;
    });
    return sendJson(response, 201, {
      topup,
      message: 'Invoice QRIS berhasil dibuat. Selesaikan pembayaran sebelum kedaluwarsa.',
    });
  }

  const topupPaymentMatch = pathname.match(/^\/api\/topups\/([a-f0-9]+)\/status$/);
  if (request.method === 'GET' && topupPaymentMatch) {
    const user = requireUser(await currentUser(request));
    const existing = (await storeSnapshot()).topups.find((item) => item.id === topupPaymentMatch[1] && item.userId === user.id);
    if (!existing) throw httpError(404, 'Invoice isi saldo tidak ditemukan.');
    if (existing.paymentMethod !== 'qris') throw httpError(400, 'Permintaan ini bukan pembayaran QRIS.');

    const gatewayStatus = existing.status === 'pending_payment'
      ? await getDongtubeInvoiceStatus(existing.gatewayInvoiceId, existing.amount)
      : { status: existing.status === 'paid' ? 'paid' : existing.status === 'expired' ? 'expired' : existing.status };
    const result = await mutateStore((store) => {
      const item = store.topups.find((entry) => entry.id === existing.id && entry.userId === user.id);
      if (!item) throw httpError(404, 'Invoice isi saldo tidak ditemukan.');
      if (item.status === 'pending_payment' && ['paid', 'expired'].includes(gatewayStatus.status)) {
        item.status = gatewayStatus.status;
        item.reviewedAt = Date.now();
        if (gatewayStatus.status === 'paid') {
          const account = store.users.find((entry) => entry.id === item.userId);
          if (!account) throw httpError(404, 'Akun pemilik invoice tidak ditemukan.');
          account.balance += item.amount;
          store.ledger.push({
            id: randomBytes(12).toString('hex'),
            userId: item.userId,
            type: 'topup',
            amount: item.amount,
            topupId: item.id,
            balanceAfter: account.balance,
            createdAt: item.reviewedAt,
          });
        }
      }
      return item;
    });
    return sendJson(response, 200, {
      topup: result,
      gatewayStatus: result.status === 'paid' ? 'paid' : result.status === 'expired' ? 'expired' : 'pending',
      message: result.status === 'paid'
        ? 'Pembayaran diterima dan saldo sudah ditambahkan.'
        : result.status === 'expired' ? 'Invoice QRIS sudah kedaluwarsa.' : 'Pembayaran belum terdeteksi.',
    });
  }

  if (request.method === 'POST' && pathname === '/api/orders') {
    ensureSameOrigin(request);
    const user = requireUser(await currentUser(request));
    await catalogProducts();
    const validated = validateOrder(await readJson(request));
    const order = await mutateStore((store) => {
      if (validated.clientRequestId) {
        const previous = store.orders.find((item) =>
          item.userId === user.id && item.clientRequestId === validated.clientRequestId);
        if (previous) {
          const sameRequest = previous.productId === validated.product.id
            && previous.customerName === validated.customerName
            && previous.customerPhone === validated.customerPhone
            && previous.target === (validated.target || null)
            && previous.quantity === (validated.quantity || null)
            && previous.comments === (validated.comments || null)
            && previous.username === (validated.username || null);
          if (!sameRequest) throw httpError(409, 'ID pesanan ini sudah digunakan untuk data pesanan yang berbeda. Buka checkout kembali.');
          return { ...previous, duplicateRequest: true };
        }
      }
      const account = store.users.find((item) => item.id === user.id);
      if (!account) throw httpError(401, 'Akun tidak ditemukan. Silakan masuk kembali.');
      if (account.balance < validated.total) throw httpError(402, 'Saldo tidak mencukupi. Ajukan isi saldo dari menu Profil.');
      const created = {
        id: randomBytes(12).toString('hex'),
        userId: user.id,
        productId: validated.product.id,
        productName: validated.product.name,
        productType: validated.product.type,
        amount: validated.total,
        target: validated.target || null,
        quantity: validated.quantity || null,
        comments: validated.comments || null,
        username: validated.username || null,
        customerName: validated.customerName,
        customerPhone: validated.customerPhone,
        clientRequestId: validated.clientRequestId || null,
        providerCatalogProductId: validated.product.type === 'number'
          ? validated.product.providerCatalogProductId
          : null,
        providerMaxPrice: validated.product.type === 'number' ? validated.product.providerPrice : null,
        providerOperatorId: validated.product.type === 'number'
          ? validated.product.providerOperatorId
          : null,
        status: ['smm', 'number'].includes(validated.product.type) ? 'provider_submitting' : 'pending_fulfillment',
        createdAt: Date.now(),
      };
      account.balance -= created.amount;
      store.orders.push(created);
      store.ledger.push({
        id: randomBytes(12).toString('hex'),
        userId: user.id,
        type: 'purchase',
        amount: -created.amount,
        orderId: created.id,
        balanceAfter: account.balance,
        createdAt: created.createdAt,
      });
      return { ...created, balance: account.balance };
    });

    if (order.duplicateRequest
      && (order.productType !== 'number' || order.providerOrderId || order.status !== 'provider_unknown')) {
      return sendJson(response, order.status === 'provider_unknown' ? 202 : 200, {
        orderId: order.id,
        status: order.status,
        total: order.amount,
        message: order.status === 'provider_unknown'
          ? 'Status pesanan sebelumnya belum dapat dipastikan. Jangan kirim ulang; hubungi admin untuk pemeriksaan.'
          : 'Permintaan ini sudah pernah diproses.',
      });
    }

    if (order.productType === 'smm') {
      let submittedProviderOrderId = null;
      try {
        const providerResult = await placeProviderOrder({
          service: validated.product,
          target: validated.target,
          quantity: validated.quantity,
          comments: validated.comments,
          username: validated.username,
        });
        submittedProviderOrderId = providerResult.orderId;
        await mutateStore((store) => {
          const item = store.orders.find((entry) => entry.id === order.id);
          if (!item) throw httpError(404, 'Pesanan tidak ditemukan setelah dikirim ke provider.');
          item.providerOrderId = submittedProviderOrderId;
          item.providerStatus = 'Pending';
          item.status = 'provider_processing';
          item.providerSubmittedAt = Date.now();
        });
        return sendJson(response, 201, {
          orderId: order.id,
          status: 'provider_processing',
          total: order.amount,
          balance: order.balance,
          message: `Pesanan berhasil dikirim ke provider. ID provider: ${providerResult.orderId}.`,
        });
      } catch (error) {
        const uncertain = !(error instanceof ProviderError) || error.uncertain;
        if (uncertain) {
          await mutateStore((store) => {
            const item = store.orders.find((entry) => entry.id === order.id);
            if (item) {
              item.status = 'provider_unknown';
              item.providerError = error.message;
              if (submittedProviderOrderId) item.providerOrderId = submittedProviderOrderId;
            }
          });
          return sendJson(response, 202, {
            orderId: order.id,
            status: 'provider_unknown',
            total: order.amount,
            balance: order.balance,
            message: 'Status pengiriman ke provider belum dapat dipastikan. Jangan buat pesanan ulang; hubungi admin untuk pemeriksaan.',
          });
        }

        await mutateStore((store) => {
          const item = store.orders.find((entry) => entry.id === order.id);
          if (!item || item.status !== 'provider_submitting') return;
          item.status = 'refunded';
          item.providerError = error.message;
          item.reviewedAt = Date.now();
          const account = store.users.find((entry) => entry.id === item.userId);
          if (!account) throw httpError(404, 'Akun pemilik pesanan tidak ditemukan saat pengembalian saldo.');
          account.balance += item.amount;
          store.ledger.push({
            id: randomBytes(12).toString('hex'),
            userId: item.userId,
            type: 'refund',
            amount: item.amount,
            orderId: item.id,
            balanceAfter: account.balance,
            createdAt: item.reviewedAt,
          });
        });
        return sendJson(response, 502, {
          error: 'provider_rejected',
          orderId: order.id,
          message: `Provider menolak pesanan. Saldo telah dikembalikan. ${error.message}`,
        });
      }
    }

    if (order.productType === 'number') {
      if (order.duplicateRequest && order.status === 'provider_submitting') {
        return sendJson(response, 202, {
          orderId: order.id,
          status: order.status,
          total: order.amount,
          message: 'Permintaan sewa nomor sedang diproses. Periksa kembali melalui riwayat pesanan.',
        });
      }

      try {
        const providerOrder = await createSmsCodeOrder(
          validated.product,
          order.clientRequestId || order.id,
        );
        const updated = await mutateStore((store) => {
          const item = store.orders.find((entry) => entry.id === order.id);
          if (!item) throw httpError(404, 'Pesanan tidak ditemukan setelah dibuat di SMSCode.');
          item.providerOrderId = String(providerOrder.id);
          item.providerStatus = providerOrder.status;
          item.target = providerOrder.phone_number || null;
          item.status = providerOrder.status === 'COMPLETED' ? 'completed' : 'provider_processing';
          item.providerSubmittedAt = Date.now();
          if (item.status === 'completed') item.completedAt = Date.now();
          return item;
        });
        return sendJson(response, 201, {
          orderId: order.id,
          status: updated.status,
          total: order.amount,
          balance: order.balance,
          phoneNumber: updated.target,
          providerStatus: updated.providerStatus,
          message: updated.target
            ? `Nomor berhasil disewa: ${updated.target}. Tekan “Cek OTP” pada riwayat pesanan untuk menunggu kode.`
            : 'Nomor berhasil dipesan. Tekan “Cek OTP” pada riwayat pesanan untuk melihat nomor dan kode.',
        });
      } catch (error) {
        const uncertain = !(error instanceof SmsCodeOrderError) || error.uncertain;
        if (uncertain) {
          await mutateStore((store) => {
            const item = store.orders.find((entry) => entry.id === order.id);
            if (item && item.status !== 'refunded') {
              item.status = 'provider_unknown';
              item.providerError = error.message;
            }
          });
          return sendJson(response, 202, {
            orderId: order.id,
            status: 'provider_unknown',
            total: order.amount,
            message: 'Status pembuatan nomor belum dapat dipastikan. Tekan “Cek OTP” untuk mencoba kembali dengan kunci transaksi yang sama.',
          });
        }

        await mutateStore((store) => {
          const item = store.orders.find((entry) => entry.id === order.id);
          if (!item || item.status === 'refunded') return;
          item.status = 'refunded';
          item.providerError = error.message;
          item.reviewedAt = Date.now();
          const account = store.users.find((entry) => entry.id === item.userId);
          if (!account) throw httpError(404, 'Akun pemilik pesanan tidak ditemukan saat pengembalian saldo.');
          account.balance += item.amount;
          store.ledger.push({
            id: randomBytes(12).toString('hex'),
            userId: item.userId,
            type: 'refund',
            amount: item.amount,
            orderId: item.id,
            balanceAfter: account.balance,
            createdAt: item.reviewedAt,
          });
        });
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
      balance: order.balance,
      message: 'Pesanan berhasil dibuat.',
    });
  }

  const orderStatusMatch = pathname.match(/^\/api\/orders\/([a-f0-9]+)\/status$/);
  if (request.method === 'GET' && orderStatusMatch) {
    const user = requireUser(await currentUser(request));
    let store = await storeSnapshot();
    let order = store.orders.find((item) => item.id === orderStatusMatch[1] && item.userId === user.id);
    if (!order) throw httpError(404, 'Pesanan tidak ditemukan.');
    if (order.productType === 'number') {
      if (!order.providerOrderId && order.status === 'provider_unknown') {
        await catalogProducts();
        const product = smsCodeCache.products.find((item) => item.id === order.productId) || {
          id: order.productId,
          providerCatalogProductId: order.providerCatalogProductId,
          providerPrice: order.providerMaxPrice,
          providerOperatorId: order.providerOperatorId,
        };
        if (!Number.isSafeInteger(product.providerCatalogProductId) || !Number.isSafeInteger(product.providerPrice)) {
          throw httpError(409, 'Data produk SMSCode tidak tersedia untuk pemulihan transaksi ini.');
        }
        try {
          const created = await createSmsCodeOrder(product, order.clientRequestId || order.id);
          order = await mutateStore((draft) => {
            const item = draft.orders.find((entry) => entry.id === order.id && entry.userId === user.id);
            if (!item) throw httpError(404, 'Pesanan tidak ditemukan.');
            item.providerOrderId = String(created.id);
            item.providerStatus = created.status;
            item.target = created.phone_number || null;
            item.status = created.status === 'COMPLETED' ? 'completed' : 'provider_processing';
            item.providerSubmittedAt = Date.now();
            if (item.status === 'completed') item.completedAt = Date.now();
            return item;
          });
        } catch (error) {
          if (error instanceof SmsCodeOrderError && !error.uncertain) {
            order = await refundSmsCodeOrder(order.id, error.message);
            return sendJson(response, 502, {
              order,
              message: `SMSCode menolak pesanan. Saldo telah dikembalikan. ${error.message}`,
            });
          }
          await mutateStore((draft) => {
            const item = draft.orders.find((entry) => entry.id === order.id && entry.userId === user.id);
            if (item) item.providerError = error.message;
          });
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
        order = await mutateStore((draft) => {
          const item = draft.orders.find((entry) => entry.id === order.id && entry.userId === user.id);
          if (!item) throw httpError(404, 'Pesanan tidak ditemukan.');
          item.providerStatus = providerOrder.status;
          item.target = providerOrder.phone_number || item.target;
          if (providerOrder.status === 'COMPLETED') {
            item.status = 'completed';
            item.completedAt = item.completedAt || Date.now();
          } else if (providerOrder.status === 'EXPIRED') {
            item.status = 'provider_expired';
          } else if (item.status !== 'refunded') {
            item.status = 'provider_processing';
          }
          return item;
        });
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
    const statusText = providerStatus.status;
    const completed = /^(completed|complete|success|sukses)$/i.test(statusText);
    const updated = await mutateStore((draft) => {
      const item = draft.orders.find((entry) => entry.id === order.id && entry.userId === user.id);
      if (!item) throw httpError(404, 'Pesanan tidak ditemukan.');
      item.providerStatus = statusText;
      item.providerStartCount = providerStatus.startCount;
      item.providerRemains = providerStatus.remains;
      item.status = completed ? 'completed' : 'provider_processing';
      if (completed) item.completedAt = Date.now();
      return item;
    });
    return sendJson(response, 200, { order: updated, providerStatus });
  }

  const smsCodeActionMatch = pathname.match(/^\/api\/orders\/([a-f0-9]+)\/(cancel|finish|resend)$/);
  if (request.method === 'POST' && smsCodeActionMatch) {
    ensureSameOrigin(request);
    const user = requireUser(await currentUser(request));
    const store = await storeSnapshot();
    const order = store.orders.find((item) => item.id === smsCodeActionMatch[1] && item.userId === user.id);
    if (!order) throw httpError(404, 'Pesanan tidak ditemukan.');
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
    await finishSmsCodeOrder(order.providerOrderId);
    const updated = await mutateStore((draft) => {
      const item = draft.orders.find((entry) => entry.id === order.id && entry.userId === user.id);
      if (!item) throw httpError(404, 'Pesanan tidak ditemukan.');
      item.providerStatus = 'COMPLETED';
      item.status = 'completed';
      item.completedAt = Date.now();
      return item;
    });
    return sendJson(response, 200, { order: updated, message: 'Nomor berhasil ditandai selesai.' });
  }

  const adminTopupMatch = pathname.match(/^\/api\/admin\/topups\/([a-f0-9]+)$/);
  if (request.method === 'POST' && adminTopupMatch) {
    ensureSameOrigin(request);
    requireAdmin(request);

    const input = await readJson(request);
    if (!['approve', 'reject'].includes(input.action)) throw httpError(400, 'Aksi harus approve atau reject.');
    const topup = await mutateStore((store) => {
      const item = store.topups.find((entry) => entry.id === adminTopupMatch[1]);
      if (!item) throw httpError(404, 'Permintaan isi saldo tidak ditemukan.');
      if (item.status !== 'pending') throw httpError(409, 'Permintaan isi saldo sudah diproses.');
      item.status = input.action === 'approve' ? 'approved' : 'rejected';
      item.reviewedAt = Date.now();
      if (item.status === 'approved') {
        const account = store.users.find((entry) => entry.id === item.userId);
        if (!account) throw httpError(404, 'Akun pemilik permintaan tidak ditemukan.');
        account.balance += item.amount;
        store.ledger.push({
          id: randomBytes(12).toString('hex'),
          userId: item.userId,
          type: 'topup',
          amount: item.amount,
          topupId: item.id,
          balanceAfter: account.balance,
          createdAt: item.reviewedAt,
        });
      }
      return item;
    });
    return sendJson(response, 200, { topup, message: `Permintaan berhasil ${topup.status === 'approved' ? 'disetujui' : 'ditolak'}.` });
  }

  const adminOrderMatch = pathname.match(/^\/api\/admin\/orders\/([a-f0-9]+)$/);
  if (request.method === 'POST' && adminOrderMatch) {
    ensureSameOrigin(request);
    requireAdmin(request);
    const input = await readJson(request);
    if (!['complete', 'refund'].includes(input.action)) throw httpError(400, 'Aksi harus complete atau refund.');
    const order = await mutateStore((store) => {
      const item = store.orders.find((entry) => entry.id === adminOrderMatch[1]);
      if (!item) throw httpError(404, 'Pesanan tidak ditemukan.');
      if (!['pending_fulfillment', 'provider_processing', 'provider_unknown', 'provider_expired'].includes(item.status)) {
        throw httpError(409, 'Pesanan sudah diproses.');
      }
      item.status = input.action === 'complete' ? 'completed' : 'refunded';
      item.reviewedAt = Date.now();
      if (item.status === 'refunded') {
        const account = store.users.find((entry) => entry.id === item.userId);
        if (!account) throw httpError(404, 'Akun pemilik pesanan tidak ditemukan.');
        account.balance += item.amount;
        store.ledger.push({
          id: randomBytes(12).toString('hex'),
          userId: item.userId,
          type: 'refund',
          amount: item.amount,
          orderId: item.id,
          balanceAfter: account.balance,
          createdAt: item.reviewedAt,
        });
      }
      return item;
    });
    return sendJson(response, 200, {
      order,
      message: order.status === 'completed'
        ? 'Pesanan ditandai selesai. Pastikan layanan sudah dipenuhi sebelum melakukan aksi ini.'
        : 'Pesanan dibatalkan dan saldo dikembalikan.',
    });
  }

  return sendJson(response, 404, { error: 'not_found', message: 'Endpoint tidak ditemukan.' });
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  try {
    if (pathname.startsWith('/api/')) return await routeApi(request, response, pathname);

    if (request.method === 'GET' && staticFiles.has(pathname)) {
      const [fileName, contentType] = staticFiles.get(pathname);
      const content = await readFile(new URL(`./${fileName}`, import.meta.url));
      response.writeHead(200, { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff' });
      return response.end(content);
    }

    return sendJson(response, 404, { error: 'not_found', message: 'Halaman tidak ditemukan.' });
  } catch (error) {
    if (!error.statusCode) console.error('Request gagal:', error.message);
    const statusCode = error.statusCode || (error instanceof ProviderError ? 502 : 500);
    return sendJson(response, statusCode, {
      error: error.statusCode ? 'request_error' : error instanceof ProviderError ? 'provider_error' : 'server_error',
      message: error.statusCode || error instanceof ProviderError
        ? error.message
        : 'Terjadi kesalahan pada server.',
    });
  }
});

await mutateStore((store) => {
  for (const order of store.orders) {
    if (order.status === 'provider_submitting') {
      order.status = 'provider_unknown';
      order.providerError = 'Server dimulai ulang saat pengiriman provider berlangsung; periksa status di panel provider.';
    }
  }
});

server.listen(port, host, () => {
  console.log(`Website berjalan di http://${host}:${port}`);
  if (!config.admin.topupKey) {
    console.warn('admin.topupKey belum diatur; admin belum dapat menyetujui top-up atau memproses pesanan.');
  }
});
