const menuToggle = document.getElementById('menuToggle');
const navMenu = document.getElementById('navMenu');
const year = document.getElementById('year');
const productGrid = document.getElementById('productGrid');
const orderDialog = document.getElementById('orderDialog');
const orderForm = document.getElementById('orderForm');
const orderProduct = document.getElementById('orderProduct');
const targetField = document.getElementById('targetField');
const orderTarget = document.getElementById('orderTarget');
const smmFields = document.getElementById('smmFields');
const orderQuantity = document.getElementById('orderQuantity');
const orderTotal = document.getElementById('orderTotal');
const orderStatus = document.getElementById('orderStatus');
const submitOrder = document.getElementById('submitOrder');
const catalogSearch = document.getElementById('catalogSearch');
const catalogNote = document.getElementById('catalogNote');
const menu = document.getElementById('navMenu');
const menuButton = document.getElementById('menuToggle');
const uploadFile = document.getElementById('uploadFile');
const uploadResult = document.getElementById('uploadResult');
const authDialog = document.getElementById('authDialog');
const authForm = document.getElementById('authForm');
const authNameField = document.getElementById('authNameField');
const authName = document.getElementById('authName');
const authPassword = document.getElementById('authPassword');
const authTitle = document.getElementById('authTitle');
const authSubmit = document.getElementById('authSubmit');
const authStatus = document.getElementById('authStatus');
const topupDialog = document.getElementById('topupDialog');
const topupForm = document.getElementById('topupForm');
const topupStatus = document.getElementById('topupStatus');
const topupSubmit = document.getElementById('topupSubmit');
const topupCreateFields = document.getElementById('topupCreateFields');
const topupPayment = document.getElementById('topupPayment');
const topupQrImage = document.getElementById('topupQrImage');
const topupPaymentTotal = document.getElementById('topupPaymentTotal');
const topupExpiry = document.getElementById('topupExpiry');
const topupCheck = document.getElementById('topupCheck');
const topupPaymentStatus = document.getElementById('topupPaymentStatus');
let products = [];
let activeCategory = 'all';
let usingDemoCatalog = false;
let providerConfigured = false;
let smsCodeConfigured = false;
let sessionUser = null;
let authMode = 'login';
let authReturnTo = 'profile';
let pendingCheckoutId = null;
let orderRequestId = null;
let orderRequestSubmitted = false;
let topupStatusTimer = null;
const smsCodeSnapshots = new Map();

if (year) {
  year.textContent = new Date().getFullYear();
}

if (menuToggle && navMenu) {
  menuToggle.addEventListener('click', () => {
    const isOpen = menu.classList.toggle('is-open');
    menuButton.setAttribute('aria-expanded', String(isOpen));
  });

  document.addEventListener('click', (event) => {
    if (!menu.contains(event.target) && !menuButton.contains(event.target)) {
      menu.classList.remove('is-open');
      menuButton.setAttribute('aria-expanded', 'false');
    }
  });
}

function switchView(viewName) {
  const targetView = document.querySelector(`[data-page="${viewName}"]`);
  if (!targetView) return;

  document.querySelectorAll('[data-page]').forEach((view) => {
    view.classList.toggle('is-active', view === targetView);
  });

  document.querySelectorAll('.bottom-nav-item').forEach((item) => {
    const isCurrent = item.dataset.viewLink === viewName;
    item.classList.toggle('is-current', isCurrent);
    if (isCurrent) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });

  menu.classList.remove('is-open');
  menuButton.setAttribute('aria-expanded', 'false');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function applySiteSettings(site) {
  document.title = site.tagline ? `${site.name} — ${site.tagline}` : site.name;
  document.getElementById('siteDescription').content = site.description;
  document.getElementById('siteThemeColor').content = site.themeColor;
  const favicon = document.getElementById('siteFavicon');
  if (site.faviconUrl) {
    favicon.href = site.faviconUrl;
    favicon.hidden = false;
  }
  document.documentElement.style.setProperty('--lavender', site.themeColor);
  document.documentElement.style.setProperty('--yellow', site.accentColor);
  document.getElementById('siteBrand').setAttribute('aria-label', `${site.name} Beranda`);
  document.getElementById('siteName').textContent = site.name;
  document.getElementById('siteTagline').textContent = site.tagline;
  document.getElementById('footerBrand').textContent = [site.name, site.tagline].filter(Boolean).join(' ');
  document.getElementById('footerCopyright').textContent = site.name;
  document.getElementById('authBrandName').textContent = site.name;
  document.getElementById('artBrandName').textContent = site.name;
  document.getElementById('heroEyebrow').textContent = site.heroEyebrow;
  document.getElementById('homeTitle').textContent = site.heroTitle;
  document.getElementById('heroDescription').textContent = site.heroDescription;

  const logo = document.getElementById('brandLogo');
  const fallback = document.getElementById('brandFallback');
  if (site.logoUrl) {
    logo.alt = site.logoAlt || site.name;
    logo.src = site.logoUrl;
    logo.hidden = false;
    fallback.hidden = true;
    logo.addEventListener('error', () => {
      logo.hidden = true;
      fallback.hidden = false;
    }, { once: true });
  }

  const whatsapp = document.getElementById('supportWhatsApp');
  const email = document.getElementById('supportEmail');
  const hasContact = Boolean(site.contact.whatsappNumber || site.contact.email);
  const hasSocial = Object.values(site.social).some(Boolean);
  document.getElementById('supportMessage').textContent = hasContact
    ? site.contact.supportMessage
    : hasSocial ? 'Kontak langsung belum tersedia. Hubungi kami melalui media sosial resmi.' : 'Kontak customer service belum tersedia.';

  if (site.contact.whatsappNumber) {
    const query = new URLSearchParams({ text: site.contact.whatsappMessage });
    whatsapp.href = `https://wa.me/${site.contact.whatsappNumber}?${query}`;
    whatsapp.hidden = false;
  }
  if (site.contact.email) {
    email.href = `mailto:${site.contact.email}`;
    email.hidden = false;
  }

  const socialLinks = [
    ['TikTok', site.social.tiktokUrl],
    ['Instagram', site.social.instagramUrl],
    ['Facebook', site.social.facebookUrl],
  ].filter(([, href]) => href);
  const socialContainer = document.getElementById('footerSocials');
  socialContainer.replaceChildren();
  socialLinks.forEach(([label, href]) => {
    const link = document.createElement('a');
    link.className = 'footer-pill';
    link.href = href;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = `${label} ↗`;
    socialContainer.append(link);
  });
  socialContainer.hidden = socialLinks.length === 0;
  document.getElementById('footerSocialLabel').hidden = socialLinks.length === 0;
}

async function loadSiteSettings() {
  if (window.location.protocol === 'file:') return;
  try {
    const result = await requestJson('/api/settings');
    applySiteSettings(result.site);
  } catch (error) {
    console.error('Gagal memuat konfigurasi situs:', error);
  }
}

function openAuthDialog(mode = 'login', returnTo = 'profile') {
  authMode = mode;
  authReturnTo = returnTo;
  authStatus.textContent = '';
  authNameField.hidden = mode !== 'register';
  authName.required = mode === 'register';
  authPassword.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  authTitle.textContent = mode === 'register' ? 'Buat akun' : 'Masuk';
  authSubmit.textContent = mode === 'register' ? 'Daftar' : 'Masuk';
  document.querySelectorAll('[data-auth-mode]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.authMode === mode);
  });
  authDialog.showModal();
}

function showCheckout(productId) {
  if (!sessionUser) {
    pendingCheckoutId = productId;
    openAuthDialog('login', 'shop');
    authStatus.textContent = 'Masuk atau daftar untuk membeli produk.';
    return;
  }
  orderProduct.value = productId;
  orderRequestId = makeRequestId();
  orderRequestSubmitted = false;
  orderStatus.textContent = '';
  updateOrderForm(true);
  orderDialog.showModal();
}

document.querySelectorAll('[data-close-dialog]').forEach((button) => {
  button.addEventListener('click', () => document.getElementById(button.dataset.closeDialog).close());
});

document.querySelectorAll('[data-auth-mode]').forEach((button) => {
  button.addEventListener('click', () => openAuthDialog(button.dataset.authMode, authReturnTo));
});

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  authStatus.textContent = '';
  authSubmit.disabled = true;
  authSubmit.textContent = authMode === 'register' ? 'Mendaftarkan...' : 'Memeriksa...';
  const formData = new FormData(authForm);
  const payload = {
    email: formData.get('email'),
    password: formData.get('password'),
  };
  if (authMode === 'register') payload.name = formData.get('name');

  try {
    const result = await requestJson(authMode === 'register' ? '/api/register' : '/api/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    sessionUser = result.user;
    authDialog.close();
    authForm.reset();
    await refreshAccount();

    if (pendingCheckoutId) {
      const productId = pendingCheckoutId;
      pendingCheckoutId = null;
      switchView('shop');
      showCheckout(productId);
    } else {
      switchView(authReturnTo);
    }
  } catch (error) {
    authStatus.textContent = error.message;
  } finally {
    authSubmit.disabled = false;
    authSubmit.textContent = authMode === 'register' ? 'Daftar' : 'Masuk';
  }
});

document.getElementById('logoutButton').addEventListener('click', async () => {
  try {
    await requestJson('/api/logout', { method: 'POST', body: '{}' });
    sessionUser = null;
    document.getElementById('profileAccount').hidden = true;
    document.getElementById('profileGuest').hidden = false;
    switchView('home');
  } catch (error) {
    authReturnTo = 'profile';
    openAuthDialog('login');
    authStatus.textContent = `Tidak dapat keluar: ${error.message}`;
  }
});

document.getElementById('openTopup').addEventListener('click', () => {
  clearInterval(topupStatusTimer);
  topupStatus.textContent = '';
  topupCreateFields.hidden = false;
  topupPayment.hidden = true;
  topupPaymentStatus.textContent = '';
  topupDialog.showModal();
});

topupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  topupStatus.textContent = '';
  topupSubmit.disabled = true;
  topupSubmit.textContent = 'Mengirim...';
  try {
    const amount = Number(new FormData(topupForm).get('amount'));
    const result = await requestJson('/api/topups', {
      method: 'POST',
      body: JSON.stringify({ amount }),
    });
    topupStatus.textContent = result.message;
    showTopupInvoice(result.topup, result.message);
    await refreshAccount();
  } catch (error) {
    topupStatus.textContent = error.message;
  } finally {
    topupSubmit.disabled = false;
    topupSubmit.textContent = 'Buat invoice QRIS';
  }
});

function showTopupInvoice(topup, message = '') {
  topupCreateFields.hidden = true;
  topupPayment.hidden = false;
  topupQrImage.src = topup.qrisImage;
  topupPaymentTotal.textContent = formatRupiah(topup.paymentTotal);
  topupExpiry.textContent = topup.expiresAt
    ? `Berlaku sampai ${new Date(topup.expiresAt).toLocaleString('id-ID')}`
    : 'Selesaikan pembayaran sebelum invoice kedaluwarsa.';
  topupPaymentStatus.textContent = message;
  topupCheck.dataset.topupId = topup.id;
  topupCheck.disabled = topup.status !== 'pending_payment';
  topupCheck.textContent = topup.status === 'paid' ? 'Pembayaran diterima' : 'Cek pembayaran';
  if (topupDialog.open && topup.status === 'pending_payment') startTopupStatusPolling();
  else clearInterval(topupStatusTimer);
}

function startTopupStatusPolling() {
  clearInterval(topupStatusTimer);
  topupStatusTimer = setInterval(() => {
    if (!topupCheck.disabled) topupCheck.click();
  }, 10000);
}

topupCheck.addEventListener('click', async () => {
  const topupId = topupCheck.dataset.topupId;
  if (!topupId) return;
  topupCheck.disabled = true;
  topupPaymentStatus.textContent = 'Memeriksa status pembayaran...';
  try {
    const result = await requestJson(`/api/topups/${encodeURIComponent(topupId)}/status`);
    showTopupInvoice(result.topup, result.message);
    await refreshAccount();
  } catch (error) {
    topupPaymentStatus.textContent = error.message;
    topupCheck.disabled = false;
  }
});

authDialog.addEventListener('click', (event) => {
  if (event.target === authDialog) authDialog.close();
});

topupDialog.addEventListener('click', (event) => {
  if (event.target === topupDialog) topupDialog.close();
});

topupDialog.addEventListener('close', () => clearInterval(topupStatusTimer));

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'Permintaan gagal.');
  return result;
}

function appendHistoryRow(container, title, detail, status, amount) {
  const row = document.createElement('article');
  row.className = 'history-row';
  const copy = document.createElement('div');
  const heading = document.createElement('strong');
  heading.textContent = title;
  const description = document.createElement('small');
  description.textContent = detail;
  copy.append(heading, description);
  const value = document.createElement('span');
  value.className = 'history-value';
  value.textContent = `${formatRupiah(Math.abs(amount))} • ${status}`;
  row.append(copy, value);
  container.append(row);
  return row;
}

function renderHistory(container, records, getFields, emptyMessage, getAction) {
  container.replaceChildren();
  if (!records.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = emptyMessage;
    container.append(empty);
    return;
  }
  records.forEach((record) => {
    const row = appendHistoryRow(container, ...getFields(record));
    const action = getAction?.(record);
    const actions = Array.isArray(action)
      ? action
      : action ? [{ label: action, action: 'status' }] : [];
    if (actions.length) {
      const actionGroup = document.createElement('div');
      actionGroup.className = 'history-actions';
      actions.forEach((item) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'history-check';
        if (container.id === 'topupHistory') {
          button.dataset.topupId = record.id;
          button.dataset.topupAction = item.action;
        } else {
          button.dataset.orderStatusId = record.id;
          button.dataset.orderType = record.productType || '';
          button.dataset.orderAction = item.action;
        }
        button.textContent = item.label;
        actionGroup.append(button);
      });
      row.append(actionGroup);
    }
  });
}

document.getElementById('topupHistory').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-topup-action]');
  if (!button) return;
  button.disabled = true;
  try {
    const result = await requestJson(`/api/topups/${encodeURIComponent(button.dataset.topupId)}/status`);
    showTopupInvoice(result.topup, result.message);
    topupDialog.showModal();
    if (result.topup.status === 'pending_payment') startTopupStatusPolling();
    await refreshAccount();
  } catch (error) {
    button.disabled = false;
    window.alert(error.message);
  }
});

function makeRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}

async function refreshAccount() {
  const account = await requestJson('/api/account');
  sessionUser = account.user;
  document.getElementById('profileGuest').hidden = true;
  document.getElementById('profileAccount').hidden = false;
  document.getElementById('profileName').textContent = account.user.name;
  document.getElementById('profileEmail').textContent = account.user.email;
  document.getElementById('profileAvatar').textContent = account.user.name.trim().charAt(0).toUpperCase();
  document.getElementById('walletBalance').textContent = formatRupiah(account.user.balance);
  document.getElementById('profileBalanceSummary').textContent = formatRupiah(account.user.balance);
  document.getElementById('profilePendingSummary').textContent = account.topups.filter((item) => item.status === 'pending').length;
  document.getElementById('profileOrderSummary').textContent = account.orders.length;
  renderHistory(
    document.getElementById('topupHistory'),
    account.topups,
    (item) => [`Isi saldo ${formatRupiah(item.amount)}`, new Date(item.createdAt).toLocaleString('id-ID'), ({ pending: 'Menunggu verifikasi', pending_payment: 'Menunggu pembayaran', approved: 'Disetujui', paid: 'Lunas', expired: 'Kedaluwarsa', rejected: 'Ditolak' }[item.status] || item.status), item.amount],
    'Belum ada permintaan isi saldo.',
    (item) => item.status === 'pending_payment' ? 'Buka QRIS' : '',
  );
  renderHistory(
    document.getElementById('orderHistory'),
    account.orders,
    (item) => [
      item.productName,
      item.productType === 'number' && item.target
        ? `Nomor ${item.target} • ${new Date(item.createdAt).toLocaleString('id-ID')}`
        : new Date(item.createdAt).toLocaleString('id-ID'),
      item.providerStatus || ({
        pending_fulfillment: 'Menunggu diproses admin',
        provider_submitting: 'Mengirim ke provider',
        provider_processing: 'Diproses provider',
        provider_unknown: 'Perlu pemeriksaan admin',
        provider_expired: 'Sewa kedaluwarsa',
        completed: 'Selesai',
        refunded: 'Saldo dikembalikan',
      }[item.status] || item.status),
      -item.amount,
    ],
    'Belum ada pesanan.',
    (item) => {
      if (item.productType === 'number') {
        if (item.status === 'refunded' || item.status === 'completed' || item.status === 'provider_expired') return [];
        const actions = [];
        if (item.providerOrderId || item.status === 'provider_unknown') {
          actions.push({ label: 'Tunggu OTP', action: 'status' });
        }
        if (item.providerOrderId && item.providerStatus === 'ACTIVE') {
          actions.push({ label: 'Batalkan', action: 'cancel' });
        }
        if (item.providerOrderId && item.providerStatus === 'OTP_RECEIVED') {
          actions.push({ label: 'Selesai', action: 'finish' });
          actions.push({ label: 'Kirim ulang OTP', action: 'resend' });
        }
        return actions;
      }
      return item.providerOrderId && ['provider_processing', 'provider_unknown'].includes(item.status) ? 'Cek status' : '';
    },
  );
  renderHistory(
    document.getElementById('walletHistory'),
    account.transactions,
    (item) => [item.type === 'topup' ? 'Saldo masuk' : item.type === 'refund' ? 'Pengembalian saldo' : 'Pembelian', new Date(item.createdAt).toLocaleString('id-ID'), item.amount < 0 ? 'Debit' : 'Kredit', item.amount],
    'Belum ada transaksi saldo.',
  );
}

async function loadSession() {
  if (window.location.protocol === 'file:') return;
  const query = new URLSearchParams(window.location.search);
  const googleSucceeded = query.get('google') === 'success';
  const googleError = query.get('auth_error');
  if (googleSucceeded || googleError) window.history.replaceState({}, '', window.location.pathname);

  try {
    const result = await requestJson('/api/session');
    if (result.authenticated) {
      await refreshAccount();
      if (googleSucceeded) switchView('profile');
    } else if (googleSucceeded) {
      openAuthDialog('login');
      authStatus.textContent = 'Login Google belum berhasil. Silakan coba lagi.';
    }
  } catch (error) {
    console.error('Gagal memeriksa sesi:', error);
  }

  if (googleError) {
    openAuthDialog('login');
    authStatus.textContent = googleError === 'google_config'
      ? 'Login Google belum dikonfigurasi di server.'
      : 'Login Google tidak berhasil. Pastikan akun memiliki email terverifikasi, lalu coba lagi.';
  }
}

document.addEventListener('click', (event) => {
  const authButton = event.target.closest('[data-open-auth]');
  if (authButton) {
    openAuthDialog(authButton.dataset.openAuth, 'profile');
    return;
  }

  const viewButton = event.target.closest('[data-view-link]');
  if (!viewButton) return;

  event.preventDefault();
  if (viewButton.dataset.viewLink === 'profile' && !sessionUser) {
    openAuthDialog('login', 'profile');
    return;
  }

  if (viewButton.dataset.categoryLink) {
    activeCategory = viewButton.dataset.categoryLink;
    document.querySelectorAll('.catalog-tab').forEach((tab) => {
      const isActive = tab.dataset.category === activeCategory;
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-pressed', String(isActive));
    });
    renderCatalog(products);
  }
  switchView(viewButton.dataset.viewLink);
});

const formatRupiah = (amount) =>
  new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(amount);

function renderCatalog(items) {
  products = items;
  const searchTerm = catalogSearch.value.trim().toLowerCase();
  const visibleProducts = items.filter((product) => {
    const matchesCategory = activeCategory === 'all' || product.type === activeCategory;
    const matchesSearch = `${product.name} ${product.description}`.toLowerCase().includes(searchTerm);
    return matchesCategory && matchesSearch;
  });

  productGrid.replaceChildren();
  if (orderProduct.options.length === 0 || orderProduct.dataset.catalog !== 'loaded') {
    orderProduct.replaceChildren();
    items.forEach((product) => {
      const option = document.createElement('option');
      option.value = product.id;
      option.textContent = product.type === 'smm'
        ? `${product.name} — mulai ${formatRupiah(product.price)}`
        : `${product.name} — ${formatRupiah(product.price)}`;
      orderProduct.append(option);
    });
    orderProduct.dataset.catalog = 'loaded';
  }

  visibleProducts.forEach((product, index) => {
    const card = document.createElement('article');
    card.className = `product-card${index === 0 ? ' featured' : ''}`;

    const art = document.createElement('div');
    art.className = `product-art ${product.type === 'smm' ? 'product-art-smm' : 'product-art-number'}`;
    art.setAttribute('aria-hidden', 'true');
    art.textContent = product.type === 'number' ? '☎' : '↗';

    const tag = document.createElement('div');
    tag.className = `tag${index === 0 ? '' : ' alt'}`;
    tag.textContent = product.type === 'number' ? 'Nomor Kosong' : 'Layanan SMM';

    const title = document.createElement('h3');
    title.textContent = product.name;

    const description = document.createElement('p');
    description.textContent = product.description;

    const meta = document.createElement('div');
    meta.className = 'product-meta';
    const metaText = document.createElement('span');
    metaText.textContent = product.type === 'number'
      ? `${product.available} nomor tersedia`
      : 'Layanan digital';
    const status = document.createElement('span');
    status.className = 'product-status';
    status.textContent = product.type === 'number' ? 'SMSCode' : 'Katalog';
    meta.append(metaText, status);

    const priceRow = document.createElement('div');
    priceRow.className = 'price-row';

    const price = document.createElement('strong');
    price.textContent = product.type === 'smm'
      ? `Mulai ${formatRupiah(product.price)}`
      : formatRupiah(product.price);

    const button = document.createElement('button');
    button.className = 'btn btn-primary order-link';
    button.type = 'button';
    button.dataset.productId = product.id;
    button.textContent = product.type === 'number' ? 'Sewa nomor' : 'Pesan sekarang';

    priceRow.append(price, button);
    card.append(art, tag, title, description, meta, priceRow);
    productGrid.append(card);
  });

  if (visibleProducts.length === 0) {
    const message = document.createElement('p');
    message.className = 'catalog-message';
    message.textContent = 'Produk tidak ditemukan. Coba kata kunci atau kategori lain.';
    productGrid.append(message);
  }

  catalogNote.textContent = usingDemoCatalog
    ? 'Jalankan backend untuk memuat katalog, mendaftar, login, dan berbelanja.'
    : `${visibleProducts.length} produk ditemukan.${smsCodeConfigured ? '' : ' Sewa nomor SMSCode belum dikonfigurasi.'}${providerConfigured ? '' : ' Layanan SMM tersedia setelah API provider dikonfigurasi di server.'}`;
}

function updateOrderForm(resetQuantity = false) {
  const product = products.find((item) => item.id === orderProduct.value);
  if (!product) return;

  const needsTarget = product.type === 'smm';
  targetField.hidden = !needsTarget;
  orderTarget.required = needsTarget;
  smmFields.hidden = !needsTarget;
  orderQuantity.required = needsTarget;
  orderQuantity.min = needsTarget ? product.min : '';
  orderQuantity.max = needsTarget ? product.max : '';
  if (needsTarget && (resetQuantity || !orderQuantity.value)) {
    orderQuantity.value = product.min;
  }
  const selectedQuantity = Number(orderQuantity.value);
  const total = needsTarget && Number.isSafeInteger(selectedQuantity) && selectedQuantity > 0
    ? Math.ceil((product.pricePerThousand * selectedQuantity) / 1000)
    : product.price;
  orderTotal.textContent = needsTarget
    ? `Total: ${formatRupiah(total)} • ${formatRupiah(product.pricePerThousand)} per 1.000 (min. ${product.min})`
    : `Total: ${formatRupiah(total)}`;
}

async function loadCatalog() {
  try {
    const response = await fetch('/api/products');
    if (!response.ok) throw new Error('Katalog tidak dapat dimuat.');

    const data = await response.json();
    if (!Array.isArray(data.products)) throw new Error('Format katalog dari server tidak valid.');

    providerConfigured = data.providerConfigured === true;
    smsCodeConfigured = data.smsCodeConfigured === true;
    renderCatalog(data.products);
  } catch (error) {
    usingDemoCatalog = true;
    renderCatalog([]);
    if (window.location.protocol !== 'file:') {
      console.error('Gagal memuat katalog:', error);
    }
  }
}

document.querySelectorAll('.catalog-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    activeCategory = tab.dataset.category;
    document.querySelectorAll('.catalog-tab').forEach((item) => {
      const isActive = item === tab;
      item.classList.toggle('active', isActive);
      item.setAttribute('aria-pressed', String(isActive));
    });
    renderCatalog(products);
  });
});

catalogSearch.addEventListener('input', () => renderCatalog(products));

uploadFile.addEventListener('change', () => {
  const [file] = uploadFile.files;
  if (!file) {
    uploadResult.textContent = 'Belum ada file dipilih.';
    return;
  }

  if (file.size > 10 * 1024 * 1024) {
    uploadFile.value = '';
    uploadResult.textContent = 'Ukuran file melebihi batas demo 10 MB.';
    return;
  }

  uploadResult.textContent = `${file.name} • ${(file.size / 1024 / 1024).toFixed(2)} MB • ${file.type || 'tipe file tidak diketahui'}`;
});

productGrid.addEventListener('click', (event) => {
  const button = event.target.closest('[data-product-id]');
  if (!button) return;

  showCheckout(button.dataset.productId);
});

orderProduct.addEventListener('change', () => updateOrderForm(true));
orderQuantity.addEventListener('input', updateOrderForm);
orderForm.addEventListener('input', () => {
  if (orderRequestSubmitted) {
    orderRequestId = makeRequestId();
    orderRequestSubmitted = false;
  }
});
orderForm.addEventListener('change', () => {
  if (orderRequestSubmitted) {
    orderRequestId = makeRequestId();
    orderRequestSubmitted = false;
  }
});

document.getElementById('orderHistory').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-order-action]');
  if (!button) return;
  button.disabled = true;
  try {
    const orderId = encodeURIComponent(button.dataset.orderStatusId);
    if (button.dataset.orderAction === 'status') {
      if (button.dataset.orderType === 'number') {
        const deadline = Date.now() + 120000;
        button.textContent = 'Menunggu OTP...';
        let latestResult;
        do {
          const snapshot = smsCodeSnapshots.get(button.dataset.orderStatusId) || {};
          latestResult = await requestJson(`/api/orders/${orderId}/status?wait=true`, {
            headers: {
              ...(snapshot.afterCode ? { 'x-otp-after-code': snapshot.afterCode } : {}),
              ...(Number.isSafeInteger(snapshot.afterRevision)
                ? { 'x-otp-after-revision': String(snapshot.afterRevision) }
                : {}),
            },
          });
          const smsCode = latestResult.smsCode;
          const hasBaseline = Boolean(snapshot.afterCode) || Number.isSafeInteger(snapshot.afterRevision);
          const newCode = Boolean(smsCode?.otpCode && smsCode.otpCode !== snapshot.afterCode);
          const newSms = Number.isSafeInteger(snapshot.afterRevision)
            && Number.isSafeInteger(smsCode?.smsRevision)
            && smsCode.smsRevision > snapshot.afterRevision;
          const firstSms = !hasBaseline && Boolean(smsCode?.otpCode || smsCode?.otpMessage);
          if (smsCode) {
            smsCodeSnapshots.set(button.dataset.orderStatusId, {
              afterCode: smsCode.otpCode || snapshot.afterCode || '',
              afterRevision: Number.isSafeInteger(smsCode.smsRevision)
                ? smsCode.smsRevision
                : snapshot.afterRevision,
            });
          }
          if (newCode || newSms || firstSms
            || ['COMPLETED', 'CANCELED', 'EXPIRED'].includes(latestResult.providerStatus)
            || latestResult.order.status === 'provider_unknown') break;
        } while (Date.now() < deadline);

        const status = latestResult.providerStatus || latestResult.order.providerStatus || latestResult.order.status;
        const smsCode = latestResult.smsCode;
        const messages = [`Status SMSCode: ${status}.`];
        if (smsCode?.phoneNumber) messages.push(`Nomor: ${smsCode.phoneNumber}.`);
        if (smsCode?.otpCode) messages.push(`Kode OTP: ${smsCode.otpCode}.`);
        else if (smsCode?.otpMessage) messages.push(`SMS: ${smsCode.otpMessage}`);
        else if (status === 'ACTIVE') messages.push('Belum ada SMS masuk. Nomor masih menunggu OTP.');
        if (smsCode?.failedReason) messages.push(`Keterangan: ${smsCode.failedReason}.`);
        document.getElementById('orderStatusMessage').textContent = messages.join(' ');
      } else {
        const result = await requestJson(`/api/orders/${orderId}/status`);
        document.getElementById('orderStatusMessage').textContent =
          `Status provider: ${result.providerStatus?.status || result.order.providerStatus || result.order.status}.`;
      }
      await refreshAccount();
      return;
    }

    if (button.dataset.orderAction === 'cancel' && !window.confirm('Batalkan sewa nomor ini? Jika SMS belum diterima dan SMSCode mengizinkan, saldo akan dikembalikan.')) {
      button.disabled = false;
      return;
    }
    const result = await requestJson(`/api/orders/${orderId}/${button.dataset.orderAction}`, {
      method: 'POST',
      body: '{}',
    });
    if (result.otpBaseline) {
      smsCodeSnapshots.set(button.dataset.orderStatusId, result.otpBaseline);
    }
    document.getElementById('orderStatusMessage').textContent = result.message;
    await refreshAccount();
  } catch (error) {
    document.getElementById('orderStatusMessage').textContent = error.message;
    button.disabled = false;
    button.textContent = 'Coba lagi';
  }
});

document.getElementById('closeOrder').addEventListener('click', () => {
  orderDialog.close();
});

orderDialog.addEventListener('click', (event) => {
  if (event.target === orderDialog) orderDialog.close();
});

orderForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  orderStatus.textContent = '';
  submitOrder.disabled = true;
  submitOrder.textContent = 'Mengirim...';
  orderRequestSubmitted = true;

  const formData = new FormData(orderForm);
  const order = {
    productId: formData.get('productId'),
    customerName: formData.get('customerName'),
    customerPhone: formData.get('customerPhone'),
    target: formData.get('target'),
    quantity: formData.get('quantity'),
    username: formData.get('username'),
    comments: formData.get('comments'),
    clientRequestId: orderRequestId || makeRequestId(),
  };

  try {
    const result = await requestJson('/api/orders', {
      method: 'POST',
      body: JSON.stringify(order),
    });
    orderStatus.textContent = `${result.message} ID: ${result.orderId}`;
    if (result.status !== 'provider_unknown') {
      orderRequestId = makeRequestId();
      orderRequestSubmitted = false;
    }
    orderForm.reset();
    updateOrderForm();
    await refreshAccount();
  } catch (error) {
    orderStatus.textContent = usingDemoCatalog
      ? 'Katalog contoh sedang ditampilkan. Jalankan backend untuk login dan memproses transaksi.'
      : error.message;
    try {
      await refreshAccount();
    } catch (refreshError) {
      console.error('Gagal memperbarui saldo setelah transaksi:', refreshError);
    }
  } finally {
    submitOrder.disabled = false;
    submitOrder.textContent = 'Kirim Pesanan';
  }
});

loadSiteSettings();
loadCatalog();
loadSession();
