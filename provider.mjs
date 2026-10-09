import { config } from './config.mjs';

export class ProviderError extends Error {
  constructor(message, { uncertain = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.uncertain = uncertain;
  }
}

export function isProviderConfigured() {
  return Boolean(config.provider.apiKey && config.provider.secretKey);
}

function credentials() {
  const { apiKey, secretKey } = config.provider;
  if (!apiKey || !secretKey) {
    throw new ProviderError('Kredensial API Pusat Panel SMM belum dikonfigurasi.');
  }
  return { api_key: apiKey, secret_key: secretKey };
}

function markupPercent() {
  return config.provider.markupPercent;
}

async function callProvider(action, parameters = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.provider.timeoutMs);
  const body = new URLSearchParams({
    ...credentials(),
    action,
    ...Object.fromEntries(Object.entries(parameters).filter(([, value]) => value !== undefined && value !== null && value !== '')),
  });

  let response;
  try {
    response = await fetch(config.provider.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    throw new ProviderError(
      error.name === 'AbortError'
        ? 'API provider melewati batas waktu. Status pesanan perlu diperiksa sebelum mencoba ulang.'
        : 'Tidak dapat terhubung ke API provider. Status pesanan perlu diperiksa sebelum mencoba ulang.',
      { uncertain: true },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new ProviderError(`API provider merespons HTTP ${response.status}. Status pesanan perlu diperiksa.`, { uncertain: true });
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new ProviderError('Respons API provider bukan JSON yang valid. Status pesanan perlu diperiksa.', { uncertain: true });
  }

  if (result?.status !== true) {
    const message = typeof result?.data?.msg === 'string' ? result.data.msg : 'Provider menolak permintaan.';
    throw new ProviderError(message);
  }

  return result.data;
}

function normalizeService(service) {
  if (!service || (typeof service.id !== 'string' && typeof service.id !== 'number')) return null;
  if (typeof service.name !== 'string' || !Number.isFinite(Number(service.price))) return null;

  const min = Number(service.min);
  const max = Number(service.max);
  if (!Number.isSafeInteger(min) || min < 1 || !Number.isSafeInteger(max) || max < min) return null;

  const providerServiceId = String(service.id);
  const rate = Number(service.price);
  if (rate < 0) return null;
  const pricePerThousand = Math.ceil(rate * (1 + markupPercent() / 100));
  if (!Number.isSafeInteger(pricePerThousand)) return null;

  return {
    id: `smm-${providerServiceId}`,
    type: 'smm',
    name: service.name,
    description: typeof service.note === 'string' && service.note.trim()
      ? service.note.trim()
      : `${service.category || 'Layanan SMM'} dari Pusat Panel SMM.`,
    category: typeof service.category === 'string' ? service.category : 'Layanan SMM',
    pricePerThousand,
    price: Math.ceil((pricePerThousand * min) / 1000),
    min,
    max,
    providerServiceId,
  };
}

export async function getProviderServices() {
  const data = await callProvider('services');
  if (!Array.isArray(data)) throw new ProviderError('Format katalog layanan dari provider tidak valid.');
  const services = data.map(normalizeService).filter(Boolean);
  if (data.length > 0 && services.length === 0) {
    throw new ProviderError('Katalog provider tidak berisi layanan dengan format yang dikenali.');
  }
  return services;
}

export async function placeProviderOrder({ service, target, quantity, comments, username }) {
  const data = await callProvider('order', {
    service: service.providerServiceId,
    data: target,
    quantity,
    komen: comments,
    username,
  });
  const providerOrderId = data && (data.id ?? data.order);
  if (providerOrderId === undefined || providerOrderId === null) {
    throw new ProviderError('Provider tidak mengembalikan ID pesanan yang valid.', { uncertain: true });
  }
  return { orderId: String(providerOrderId) };
}

export async function getProviderOrderStatus(providerOrderId) {
  const data = await callProvider('status', { id: providerOrderId });
  if (!data || typeof data.status !== 'string') {
    throw new ProviderError('Format status pesanan dari provider tidak valid.', { uncertain: true });
  }
  return {
    status: data.status,
    startCount: data.start_count ?? null,
    remains: data.remains ?? null,
  };
}
