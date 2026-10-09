import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const localConfigUrl = new URL('./config.json', import.meta.url);
let localConfig = {};

try {
  localConfig = JSON.parse(readFileSync(localConfigUrl, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw new Error(`config.json tidak dapat dibaca: ${error.message}`);
  }
}

function section(name) {
  const value = localConfig[name] ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Bagian "${name}" di config.json harus berupa objek.`);
  }
  return value;
}

function stringValue(envValue, fileValue, fallback, name) {
  const value = envValue ?? fileValue ?? fallback;
  if (typeof value !== 'string') throw new Error(`Konfigurasi ${name} harus berupa teks.`);
  return value.trim();
}

function numberValue(envValue, fileValue, fallback, name, min, max, integer = false) {
  const rawValue = envValue ?? fileValue ?? fallback;
  const value = typeof rawValue === 'number' ? rawValue : Number(rawValue);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`Konfigurasi ${name} harus berupa angka ${integer ? 'bulat ' : ''}antara ${min} dan ${max}.`);
  }
  return value;
}

function httpsBaseUrl(envValue, fileValue, fallback, name) {
  const value = stringValue(envValue, fileValue, fallback, name);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Konfigurasi ${name} harus berupa URL HTTPS yang valid.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Konfigurasi ${name} harus berupa origin HTTPS tanpa path atau kredensial.`);
  }
  return url.origin;
}

function secureUrl(value, name, allowLocalHttp = false) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Konfigurasi ${name} harus berupa URL yang valid.`);
  }
  const localHttp = allowLocalHttp && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.hash) {
    throw new Error(`Konfigurasi ${name} harus menggunakan HTTPS${allowLocalHttp ? ' (atau HTTP localhost)' : ''} tanpa kredensial.`);
  }
  return url.toString();
}

function publicUrl(value, name) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Konfigurasi ${name} harus berupa URL HTTPS atau path lokal.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`Konfigurasi ${name} harus menggunakan HTTPS tanpa kredensial.`);
  }
  return url.toString();
}

function boundedString(value, fallback, name, maxLength) {
  const result = stringValue(undefined, value, fallback, name);
  if (result.length > maxLength) throw new Error(`Konfigurasi ${name} maksimal ${maxLength} karakter.`);
  return result;
}

const serverConfig = section('server');
const adminConfig = section('admin');
const providerConfig = section('provider');
const storageConfig = section('storage');
const paymentConfig = section('payment');
const smsCodeConfig = section('smscode');
const siteConfig = section('site');
const contactConfig = siteConfig.contact ?? {};
const socialConfig = siteConfig.social ?? {};
for (const [value, name] of [[contactConfig, 'site.contact'], [socialConfig, 'site.social']]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Bagian "${name}" di config.json harus berupa objek.`);
  }
}
const authConfig = section('auth');
const googleConfig = authConfig.google ?? {};
if (!googleConfig || typeof googleConfig !== 'object' || Array.isArray(googleConfig)) {
  throw new Error('Konfigurasi auth.google harus berupa objek.');
}
const googleClientId = stringValue(process.env.GOOGLE_CLIENT_ID, googleConfig.clientId, '', 'auth.google.clientId');
const googleClientSecret = stringValue(process.env.GOOGLE_CLIENT_SECRET, googleConfig.clientSecret, '', 'auth.google.clientSecret');
if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
  throw new Error('auth.google.clientId dan auth.google.clientSecret harus diisi bersama-sama.');
}
const apiUrl = stringValue(process.env.PUSAT_PANEL_API_URL, providerConfig.apiUrl, 'https://pusatpanelsmm.com/api/json.php', 'provider.apiUrl');
const apiKey = stringValue(process.env.PUSAT_PANEL_API_KEY, providerConfig.apiKey, '', 'provider.apiKey');
const secretKey = stringValue(process.env.PUSAT_PANEL_SECRET_KEY, providerConfig.secretKey, '', 'provider.secretKey');
const whatsappNumber = stringValue(undefined, contactConfig.whatsappNumber, '', 'site.contact.whatsappNumber').replace(/\D/g, '');
const themeColor = boundedString(siteConfig.themeColor, '#e8e4ff', 'site.themeColor', 7);
const accentColor = boundedString(siteConfig.accentColor, '#ffdc43', 'site.accentColor', 7);

if (whatsappNumber && (whatsappNumber.length < 8 || whatsappNumber.length > 15)) {
  throw new Error('site.contact.whatsappNumber harus berisi 8–15 digit internasional.');
}
if (!/^#[0-9a-f]{6}$/i.test(themeColor) || !/^#[0-9a-f]{6}$/i.test(accentColor)) {
  throw new Error('site.themeColor dan site.accentColor harus berupa warna hex 6 digit.');
}
const supportEmail = stringValue(undefined, contactConfig.email, '', 'site.contact.email');
if (supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)) {
  throw new Error('site.contact.email tidak valid.');
}

  if (new URL(apiUrl).protocol !== 'https:') {
  throw new Error('provider.apiUrl harus menggunakan HTTPS.');
}
if (Boolean(apiKey) !== Boolean(secretKey)) {
  throw new Error('provider.apiKey dan provider.secretKey harus diisi bersama-sama.');
}

export const config = Object.freeze({
  server: Object.freeze({
    host: stringValue(process.env.HOST, serverConfig.host, '127.0.0.1', 'server.host'),
    port: numberValue(process.env.PORT, serverConfig.port, 8000, 'server.port', 1, 65535, true),
    nodeEnv: stringValue(process.env.NODE_ENV, serverConfig.nodeEnv, 'development', 'server.nodeEnv'),
  }),
  admin: Object.freeze({
    topupKey: stringValue(process.env.TOPUP_ADMIN_KEY, adminConfig.topupKey, '', 'admin.topupKey'),
  }),
  provider: Object.freeze({
    apiUrl,
    apiKey,
    secretKey,
    timeoutMs: numberValue(process.env.PUSAT_PANEL_TIMEOUT_MS, providerConfig.timeoutMs, 20000, 'provider.timeoutMs', 1000, 120000, true),
    markupPercent: numberValue(process.env.SMM_MARKUP_PERCENT, providerConfig.markupPercent, 0, 'provider.markupPercent', 0, 10000),
  }),
  smscode: Object.freeze({
    token: stringValue(process.env.SMSCODE_TOKEN, undefined, '', 'smscode.token'),
    apiUrl: httpsBaseUrl(process.env.SMSCODE_API_URL, smsCodeConfig.apiUrl, 'https://api.smscode.gg', 'smscode.apiUrl'),
    timeoutMs: numberValue(process.env.SMSCODE_TIMEOUT_MS, smsCodeConfig.timeoutMs, 15000, 'smscode.timeoutMs', 1000, 45000, true),
    countryId: numberValue(process.env.SMSCODE_COUNTRY_ID, smsCodeConfig.countryId, 7, 'smscode.countryId', 1, 2147483647, true),
    markupPercent: numberValue(process.env.SMSCODE_MARKUP_PERCENT, smsCodeConfig.markupPercent, 0, 'smscode.markupPercent', 0, 10000),
  }),
  payment: Object.freeze({
    apiUrl: httpsBaseUrl(process.env.DONGTUBE_API_URL, paymentConfig.apiUrl, 'https://payment.dongtube.cyou', 'payment.apiUrl'),
    apiKey: stringValue(process.env.DONGTUBE_API_KEY, paymentConfig.apiKey, '', 'payment.apiKey'),
    timeoutMs: numberValue(process.env.DONGTUBE_TIMEOUT_MS, paymentConfig.timeoutMs, 15000, 'payment.timeoutMs', 1000, 45000, true),
  }),
  site: Object.freeze({
    name: boundedString(siteConfig.name, 'PERMADEVV', 'site.name', 80),
    tagline: boundedString(siteConfig.tagline, 'digital store', 'site.tagline', 80),
    description: boundedString(siteConfig.description, 'Toko layanan digital dan produk pilihan.', 'site.description', 300),
    logoUrl: publicUrl(siteConfig.logoUrl, 'site.logoUrl'),
    faviconUrl: publicUrl(siteConfig.faviconUrl, 'site.faviconUrl'),
    logoAlt: boundedString(siteConfig.logoAlt, '', 'site.logoAlt', 120),
    themeColor,
    accentColor,
    heroEyebrow: boundedString(siteConfig.heroEyebrow, 'TOKO DIGITAL', 'site.heroEyebrow', 80),
    heroTitle: boundedString(siteConfig.heroTitle, 'Temukan sesuatu yang terasa pas.', 'site.heroTitle', 120),
    heroDescription: boundedString(siteConfig.heroDescription, 'Layanan digital pilihan untuk kebutuhanmu.', 'site.heroDescription', 300),
    contact: Object.freeze({
      whatsappNumber,
      whatsappMessage: boundedString(contactConfig.whatsappMessage, 'Halo, saya perlu bantuan terkait pesanan.', 'site.contact.whatsappMessage', 240),
      email: supportEmail,
      supportMessage: boundedString(contactConfig.supportMessage, 'Hubungi kami melalui kontak resmi berikut.', 'site.contact.supportMessage', 240),
    }),
    social: Object.freeze({
      tiktokUrl: publicUrl(socialConfig.tiktokUrl, 'site.social.tiktokUrl'),
      instagramUrl: publicUrl(socialConfig.instagramUrl, 'site.social.instagramUrl'),
      facebookUrl: publicUrl(socialConfig.facebookUrl, 'site.social.facebookUrl'),
    }),
  }),
  auth: Object.freeze({
    google: Object.freeze({
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      redirectUri: secureUrl(
        stringValue(process.env.GOOGLE_REDIRECT_URI, googleConfig.redirectUri, 'http://localhost:8000/api/auth/google/callback', 'auth.google.redirectUri'),
        'auth.google.redirectUri',
        true,
      ),
      authorizationUrl: secureUrl(googleConfig.authorizationUrl ?? 'https://accounts.google.com/o/oauth2/v2/auth', 'auth.google.authorizationUrl'),
      tokenUrl: secureUrl(googleConfig.tokenUrl ?? 'https://oauth2.googleapis.com/token', 'auth.google.tokenUrl'),
      userInfoUrl: secureUrl(googleConfig.userInfoUrl ?? 'https://openidconnect.googleapis.com/v1/userinfo', 'auth.google.userInfoUrl'),
      timeoutMs: numberValue(process.env.GOOGLE_TIMEOUT_MS, googleConfig.timeoutMs, 15000, 'auth.google.timeoutMs', 1000, 45000, true),
    }),
  }),
  storage: Object.freeze({
    directory: stringValue(undefined, storageConfig.directory, 'data', 'storage.directory'),
  }),
});

export const projectDirectory = fileURLToPath(new URL('.', import.meta.url));
