import { config } from './config.mjs';

const google = config.auth.google;

export class GoogleAuthError extends Error {}

export function isGoogleAuthConfigured() {
  return Boolean(google.clientId && google.clientSecret);
}

export function googleAuthorizationUrl(state, codeChallenge) {
  const url = new URL(google.authorizationUrl);
  url.search = new URLSearchParams({
    client_id: google.clientId,
    redirect_uri: google.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return url.toString();
}

export async function getGoogleIdentity(code, codeVerifier) {
  let tokenResponse;
  try {
    tokenResponse = await fetch(google.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      redirect: 'error',
      body: new URLSearchParams({
        code,
        client_id: google.clientId,
        client_secret: google.clientSecret,
        redirect_uri: google.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
      }),
      signal: AbortSignal.timeout(google.timeoutMs),
    });
  } catch {
    throw new GoogleAuthError('Tidak dapat menghubungi layanan login Google.');
  }

  if (!tokenResponse.ok) throw new GoogleAuthError('Google menolak proses login.');
  let tokenData;
  try {
    tokenData = await tokenResponse.json();
  } catch {
    throw new GoogleAuthError('Respons login Google tidak valid.');
  }
  if (typeof tokenData.access_token !== 'string' || !tokenData.access_token) {
    throw new GoogleAuthError('Google tidak mengembalikan token akses.');
  }

  let profileResponse;
  try {
    profileResponse = await fetch(google.userInfoUrl, {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(google.timeoutMs),
    });
  } catch {
    throw new GoogleAuthError('Tidak dapat mengambil profil Google.');
  }
  if (!profileResponse.ok) throw new GoogleAuthError('Google tidak dapat memverifikasi profil akun.');

  let profile;
  try {
    profile = await profileResponse.json();
  } catch {
    throw new GoogleAuthError('Profil Google tidak valid.');
  }
  const email = typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : '';
  if (
    typeof profile.sub !== 'string'
    || !profile.sub
    || email.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    || profile.email_verified !== true
  ) {
    throw new GoogleAuthError('Akun Google harus memiliki email terverifikasi.');
  }

  return {
    subject: profile.sub,
    email,
    name: typeof profile.name === 'string' ? profile.name.trim() : '',
  };
}