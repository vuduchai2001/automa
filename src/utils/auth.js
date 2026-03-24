import browser from 'webextension-polyfill';
import secrets from 'secrets';

const AUTH_STORAGE_KEY = 'session';
const IAM_BASE = '/api/v1/iam';

/**
 * Login with email and password
 * @param {string} email
 * @param {string} password
 * @returns {Promise<Object>} Session data { access_token, refresh_token, expires_at, user }
 */
export async function login(email, password) {
  const response = await fetch(
    `${secrets.iamApiUrl}${IAM_BASE}/auth/login/password`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        captcha_token: 'dummy',
        tenant_id: null,
      }),
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.message || 'Login failed');
  }

  // Unwrap if response is wrapped in data field
  const data = result.data || result;

  // Normalize session data
  // API returns expires_in (seconds), convert to expires_at (unix timestamp in seconds)
  const expiresAt =
    data.expires_at ||
    Math.floor(Date.now() / 1000) + (data.expires_in || 3600);

  const user = {
    id: data.user_id,
    email: data.email,
    tenant_id: data.tenant_id,
  };

  const session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: expiresAt,
    session_id: data.session_id,
    user,
  };

  await browser.storage.local.set({
    [AUTH_STORAGE_KEY]: session,
    user,
  });

  return session;
}

/**
 * Logout - clear session and user data
 */
export async function logout() {
  await browser.storage.local.remove([AUTH_STORAGE_KEY, 'user']);

  try {
    sessionStorage.clear();
  } catch {
    // sessionStorage not available in background context
  }
}

/**
 * Refresh the access token using refresh_token
 * @returns {Promise<Object>} New session data
 */
export async function refreshToken() {
  const { [AUTH_STORAGE_KEY]: session } = await browser.storage.local.get(
    AUTH_STORAGE_KEY
  );
  if (!session?.refresh_token) throw new Error('No refresh token');

  const response = await fetch(`${secrets.iamApiUrl}${IAM_BASE}/auth/rotate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.message || 'Token refresh failed');
  }

  const expiresAt =
    result.expires_at ||
    Math.floor(Date.now() / 1000) + (result.expires_in || 3600);

  const newSession = {
    access_token: result.access_token,
    refresh_token: result.refresh_token,
    expires_at: expiresAt,
    session_id: result.session_id || session.session_id,
    user: session.user,
  };

  await browser.storage.local.set({ [AUTH_STORAGE_KEY]: newSession });
  return newSession;
}

/**
 * Check if user is authenticated (has valid token)
 * @returns {Promise<boolean>}
 */
export async function isAuthenticated() {
  const { [AUTH_STORAGE_KEY]: session } = await browser.storage.local.get(
    AUTH_STORAGE_KEY
  );
  if (!session?.access_token) {
    return false;
  }

  // Check if token is expired (with 2-second buffer, matching existing pattern in api.js)
  const expiryMs = (session.expires_at - 2000) * 1000;
  const now = Date.now();

  if (now > expiryMs) {
    try {
      await refreshToken();
      return true;
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * Get current access token, refreshing if needed
 * @returns {Promise<string|null>}
 */
export async function getAccessToken() {
  const { [AUTH_STORAGE_KEY]: session } = await browser.storage.local.get(
    AUTH_STORAGE_KEY
  );
  if (!session?.access_token) return null;

  if (Date.now() > (session.expires_at - 2000) * 1000) {
    const refreshed = await refreshToken();
    return refreshed.access_token;
  }

  return session.access_token;
}
