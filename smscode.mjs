import { OtpTimeoutError, OrderTerminalError, SmscodeClient, SmscodeError } from '@smscode/sdk';
import { config } from './config.mjs';

const client = config.smscode.token
  ? new SmscodeClient({
      token: config.smscode.token,
      baseUrl: config.smscode.apiUrl,
      timeoutMs: config.smscode.timeoutMs,
    })
  : null;

export class SmsCodeOrderError extends Error {
  constructor(message, { uncertain = false } = {}) {
    super(message);
    this.name = 'SmsCodeOrderError';
    this.uncertain = uncertain;
  }
}

export function isSmsCodeConfigured() {
  return Boolean(client);
}

export async function getSmsCodeProducts() {
  if (!client) return [];

  const page = await client.v1.catalog.products({
    country_id: config.smscode.countryId,
    limit: 10000,
    page: 1,
  });
  if (!Array.isArray(page.products)) {
    throw new SmsCodeOrderError('Format katalog produk SMSCode tidak valid.');
  }

  return page.products
    .filter((product) =>
      product.active
      && product.available > 0
      && Number.isSafeInteger(product.id)
      && Number.isSafeInteger(product.catalog_product_id)
      && Number.isSafeInteger(product.price)
      && product.price > 0
      && typeof product.name === 'string'
      && product.name.trim(),
    )
    .map((product) => {
      const price = Math.ceil(product.price * (1 + config.smscode.markupPercent / 100));
      if (!Number.isSafeInteger(price)) {
        throw new SmsCodeOrderError(`Harga produk SMSCode "${product.name}" tidak aman untuk diproses.`);
      }
      return {
        id: `smscode-${product.id}`,
        type: 'number',
        name: product.name,
        description: `Nomor OTP sementara • Stok tersedia: ${product.available}`,
        price,
        providerPrice: product.price,
        providerProductId: product.id,
        providerCatalogProductId: product.catalog_product_id,
        providerOperatorId: Number.isSafeInteger(product.operator_id) ? product.operator_id : null,
        available: product.available,
      };
    });
}

export async function createSmsCodeOrder(product, idempotencyKey) {
  if (!client) throw new SmsCodeOrderError('Token API SMSCode belum dikonfigurasi.');

  try {
    const result = await client.v1.orders.create({
      catalog_product_id: product.providerCatalogProductId,
      max_price: product.providerPrice,
      ...(product.providerOperatorId === null ? {} : { operator_id: product.providerOperatorId }),
      quantity: 1,
    }, { idempotencyKey });

    const order = result.orders[0];
    if (!order || result.failed_count > 0) {
      throw new SmsCodeOrderError('SMSCode tidak berhasil menyediakan nomor untuk produk ini.');
    }
    return order;
  } catch (error) {
    if (error instanceof SmsCodeOrderError) throw error;
    if (error instanceof SmscodeError && error.httpStatus >= 400 && error.httpStatus < 500) {
      throw new SmsCodeOrderError(`SMSCode menolak pesanan: ${error.message}`);
    }
    throw new SmsCodeOrderError(
      error instanceof Error ? error.message : 'Status pesanan SMSCode belum dapat dipastikan.',
      { uncertain: true },
    );
  }
}

function smsCodeOrderId(orderId) {
  const id = Number(orderId);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new SmsCodeOrderError('ID pesanan SMSCode tidak valid.');
  }
  return id;
}

export async function getSmsCodeOrder(orderId) {
  if (!client) throw new SmsCodeOrderError('Token API SMSCode belum dikonfigurasi.');
  return client.v1.orders.get(smsCodeOrderId(orderId));
}

export async function waitForSmsCodeOtp(orderId, {
  timeoutMs = 8000,
  afterCode,
  afterRevision,
} = {}) {
  if (!client) throw new SmsCodeOrderError('Token API SMSCode belum dikonfigurasi.');
  try {
    return await client.v1.orders.waitForOtp(smsCodeOrderId(orderId), {
      timeoutMs,
      afterCode,
      afterRevision,
    });
  } catch (error) {
    if (!(error instanceof OtpTimeoutError) && !(error instanceof OrderTerminalError)) throw error;
    return { otpCode: null, order: await getSmsCodeOrder(orderId) };
  }
}

export async function cancelSmsCodeOrder(orderId) {
  if (!client) throw new SmsCodeOrderError('Token API SMSCode belum dikonfigurasi.');
  return client.v1.orders.cancel(smsCodeOrderId(orderId));
}

export async function resendSmsCodeOrder(orderId) {
  if (!client) throw new SmsCodeOrderError('Token API SMSCode belum dikonfigurasi.');
  return client.v1.orders.resend(smsCodeOrderId(orderId));
}

export async function finishSmsCodeOrder(orderId) {
  if (!client) throw new SmsCodeOrderError('Token API SMSCode belum dikonfigurasi.');
  return client.v1.orders.finish(smsCodeOrderId(orderId));
}
