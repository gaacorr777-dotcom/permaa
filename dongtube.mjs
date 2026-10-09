import { config } from './config.mjs';

export class DongtubePaymentError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function isDongtubePaymentConfigured() {
  return Boolean(config.payment.apiKey);
}

async function requestGateway(path) {
  if (!isDongtubePaymentConfigured()) {
    throw new DongtubePaymentError('Payment QRIS belum dikonfigurasi.', 503);
  }

  let response;
  try {
    response = await fetch(new URL(path, config.payment.apiUrl), {
      headers: { 'X-API-Key': config.payment.apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(config.payment.timeoutMs),
    });
  } catch {
    throw new DongtubePaymentError('Payment gateway tidak dapat dihubungi. Coba lagi sebentar.');
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new DongtubePaymentError('Respons payment gateway tidak valid.');
  }
  if (!response.ok || result.success === false) {
    throw new DongtubePaymentError(result.message || result.error || 'Payment gateway menolak permintaan.');
  }
  return result;
}

export async function createDongtubeInvoice(amount) {
  const query = new URLSearchParams({ amount: String(amount) });
  const result = await requestGateway(`/api/v1/invoice?${query}`);
  if (typeof result.invoice_id !== 'string' || !result.invoice_id || typeof result.qris_image !== 'string') {
    throw new DongtubePaymentError('Data invoice QRIS dari payment gateway tidak lengkap.');
  }
  const invoiceAmount = Number(result.amount);
  const total = Number(result.total);
  if (!Number.isSafeInteger(invoiceAmount) || invoiceAmount !== amount || !Number.isSafeInteger(total) || total < amount) {
    throw new DongtubePaymentError('Nominal invoice dari payment gateway tidak valid.');
  }

  let imageUrl;
  try {
    imageUrl = new URL(result.qris_image, config.payment.apiUrl);
  } catch {
    throw new DongtubePaymentError('Alamat QRIS dari payment gateway tidak valid.');
  }
  if (imageUrl.protocol !== 'https:' || imageUrl.origin !== config.payment.apiUrl) {
    throw new DongtubePaymentError('Alamat QRIS dari payment gateway tidak tepercaya.');
  }

  const expiryTimestamp = typeof result.expired_at === 'string' ? Date.parse(result.expired_at) : NaN;
  return {
    invoiceId: result.invoice_id,
    paymentTotal: total,
    qrisImage: imageUrl.toString(),
    expiresAt: Number.isFinite(expiryTimestamp) ? new Date(expiryTimestamp).toISOString() : null,
  };
}

export async function getDongtubeInvoiceStatus(invoiceId, expectedAmount) {
  const query = new URLSearchParams({ invoice_id: invoiceId });
  const result = await requestGateway(`/api/v1/invoice/status?${query}`);
  if (result.invoice_id !== invoiceId || typeof result.status !== 'string') {
    throw new DongtubePaymentError('Status invoice dari payment gateway tidak valid.');
  }
  const status = result.status.toLowerCase();
  if (!['pending', 'paid', 'expired'].includes(status)) {
    throw new DongtubePaymentError('Status invoice dari payment gateway tidak dikenali.');
  }
  const amount = Number(result.amount);
  if (!Number.isSafeInteger(amount) || amount !== expectedAmount) {
    throw new DongtubePaymentError('Nominal status invoice dari payment gateway tidak valid.');
  }
  return { status };
}