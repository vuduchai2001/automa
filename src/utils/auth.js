import browser from 'webextension-polyfill';
import secrets from 'secrets';
import { authTrace, summarizeSession } from './authTrace';

const AUTH_STORAGE_KEY = 'session';
const IAM_BASE = '/api/v1/iam';
const TOKEN_REFRESH_BUFFER_MS = 2000;

function createAuthError(message, status) {
  const error = new Error(message);
  error.status = status;

  return error;
}

function normalizeAuthPayload(payload) {
  const normalizedPayload =
    payload?.data && typeof payload.data === 'object' ? payload.data : payload;

  return normalizedPayload && typeof normalizedPayload === 'object'
    ? normalizedPayload
    : {};
}

function buildUser(data, fallbackUser = null) {
  if (data.user && typeof data.user === 'object') {
    return data.user;
  }

  const hasTenantId = Object.prototype.hasOwnProperty.call(data, 'tenant_id');

  if (!data.user_id && !data.email && !hasTenantId) {
    return fallbackUser;
  }

  return {
    ...(fallbackUser || {}),
    ...(data.user_id ? { id: data.user_id } : {}),
    ...(data.email ? { email: data.email } : {}),
    ...(hasTenantId ? { tenant_id: data.tenant_id } : {}),
  };
}

function buildSession(data, fallbackSession = {}) {
  const normalizedData = normalizeAuthPayload(data);
  const expiresAt =
    Number(normalizedData.expires_at) ||
    Math.floor(Date.now() / 1000) + (Number(normalizedData.expires_in) || 3600);

  return {
    access_token:
      normalizedData.access_token || fallbackSession.access_token || null,
    refresh_token:
      normalizedData.refresh_token || fallbackSession.refresh_token || null,
    expires_at: expiresAt,
    session_id: normalizedData.session_id || fallbackSession.session_id || null,
    user: buildUser(normalizedData, fallbackSession.user || null),
  };
}

function isSessionExpired(session) {
  if (!session?.expires_at) return true;

  return Date.now() >= session.expires_at * 1000 - TOKEN_REFRESH_BUFFER_MS;
}

async function getStoredSession(storage = browser.storage.local) {
  const result = await storage.get(AUTH_STORAGE_KEY);

  return result?.[AUTH_STORAGE_KEY] || null;
}

async function persistSession(session, storage = browser.storage.local) {
  const payload = {
    [AUTH_STORAGE_KEY]: session,
  };

  if (session?.user) payload.user = session.user;

  await storage.set(payload);

  return session;
}

async function clearSession(storage = browser.storage.local) {
  await storage.remove([AUTH_STORAGE_KEY, 'user']);
}

let refreshTokenPromise = null;

function sessionKey(session) {
  return (
    session?.refresh_token ||
    session?.session_id ||
    session?.access_token ||
    null
  );
}

function isDifferentSession(left, right) {
  const leftKey = sessionKey(left);
  const rightKey = sessionKey(right);

  return !!leftKey && !!rightKey && leftKey !== rightKey;
}

function hasUsableSession(session) {
  return !!session?.access_token && !!session?.refresh_token;
}

/**
 * Login with email and password
 * @param {string} email
 * @param {string} password
 * @returns {Promise<Object>} Session data { access_token, refresh_token, expires_at, user }
 */
export async function login(email, password) {
  authTrace('login:start', { email });
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
  const data = normalizeAuthPayload(result);

  if (!response.ok) {
    throw new Error(result.message || 'Login failed');
  }

  const session = buildSession(data);
  if (!session.access_token || !session.refresh_token) {
    throw new Error('Login response missing tokens');
  }

  await persistSession(session);
  authTrace('login:success', {
    email,
    session: summarizeSession(session),
  });

  return session;
}

/**
 * Logout - clear session and user data
 */
export async function logout() {
  authTrace('logout:start');
  await clearSession();
  authTrace('logout:cleared');

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
export async function refreshToken(storage = browser.storage.local) {
  if (refreshTokenPromise) return refreshTokenPromise;

  let sourceSession = null;

  refreshTokenPromise = (async () => {
    const session = await getStoredSession(storage);
    if (!session?.refresh_token) throw new Error('No refresh token');
    sourceSession = session;
    const initialSessionKey = sessionKey(session);
    authTrace('refresh:start', {
      session: summarizeSession(session),
    });

    const response = await fetch(
      `${secrets.iamApiUrl}${IAM_BASE}/auth/rotate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      }
    );
    const result = await response.json();
    const refreshedSession = buildSession(result, session);

    if (!response.ok) {
      authTrace('refresh:http-error', {
        status: response.status,
        message: result.message || 'Token refresh failed',
        session: summarizeSession(session),
      });
      throw createAuthError(
        result.message || 'Token refresh failed',
        response.status
      );
    }

    if (!refreshedSession.access_token || !refreshedSession.refresh_token) {
      throw createAuthError('Token refresh response missing tokens');
    }

    const latestSession = await getStoredSession(storage);
    if (isDifferentSession(latestSession, session)) {
      authTrace('refresh:use-latest-session', {
        sourceSession: summarizeSession(session),
        latestSession: summarizeSession(latestSession),
      });
      return latestSession;
    }

    if (sessionKey(latestSession) !== initialSessionKey) {
      authTrace('refresh:session-key-changed', {
        sourceSession: summarizeSession(session),
        latestSession: summarizeSession(latestSession),
      });
      return latestSession;
    }

    const persisted = await persistSession(refreshedSession, storage);
    authTrace('refresh:success', {
      before: summarizeSession(session),
      after: summarizeSession(persisted),
    });

    return persisted;
  })();

  try {
    return await refreshTokenPromise;
  } catch (error) {
    const latestSession = await getStoredSession(storage);
    if (
      hasUsableSession(latestSession) &&
      isDifferentSession(latestSession, sourceSession)
    ) {
      authTrace('refresh:recover-with-latest-session', {
        error: error.message,
        sourceSession: summarizeSession(sourceSession),
        latestSession: summarizeSession(latestSession),
      });
      return latestSession;
    }

    if (
      (error.status === 400 || error.status === 401) &&
      sessionKey(latestSession) === sessionKey(sourceSession)
    ) {
      authTrace('refresh:clear-session', {
        status: error.status,
        error: error.message,
        session: summarizeSession(sourceSession),
      });
      await clearSession(storage);
    }

    authTrace('refresh:failed', {
      status: error.status || null,
      error: error.message,
      sourceSession: summarizeSession(sourceSession),
      latestSession: summarizeSession(latestSession),
    });
    throw error;
  } finally {
    refreshTokenPromise = null;
  }
}

export async function getSession(storage = browser.storage.local) {
  const session = await getStoredSession(storage);
  if (!session?.access_token) {
    authTrace('session:missing');
    return null;
  }

  if (isSessionExpired(session)) {
    authTrace('session:expired', {
      session: summarizeSession(session),
      now: Date.now(),
    });
    return refreshToken(storage);
  }

  authTrace('session:usable', {
    session: summarizeSession(session),
  });
  return session;
}

/**
 * Check if user is authenticated (has valid token)
 * @returns {Promise<boolean>}
 */
export async function isAuthenticated(storage = browser.storage.local) {
  try {
    const session = await getSession(storage);
    authTrace('auth:check', {
      authenticated: !!session?.access_token,
      session: summarizeSession(session),
    });

    return !!session?.access_token;
  } catch {
    authTrace('auth:check-failed');
    return false;
  }
}

/**
 * Get current access token, refreshing if needed
 * @returns {Promise<string|null>}
 */
export async function getAccessToken(storage = browser.storage.local) {
  const session = await getSession(storage);
  authTrace('token:get', {
    hasToken: !!session?.access_token,
    session: summarizeSession(session),
  });

  return session?.access_token || null;
}
