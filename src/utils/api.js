import BrowserAPIService from '@/service/browser-api/BrowserAPIService';
import secrets from 'secrets';
import { isObject, parseJSON } from './helper';

export async function fetchApi(path, options = {}) {
  const urlPath = path.startsWith('/') ? path : `/${path}`;
  const baseUrl = options.baseUrl || secrets.controlApiUrl;
  delete options.baseUrl;

  // Always clean up auth flag so it doesn't leak into fetch()
  const needsAuth = !!options.auth;
  delete options.auth;

  const headers = {
    'Content-Type': 'application/json',
    ...(options?.headers || {}),
  };

  const { session } = (await BrowserAPIService.storage.local.get(
    'session'
  )) || { session: null };
  if (session && needsAuth) {
    let token = session.access_token;

    if (Date.now() > (session.expires_at - 2000) * 1000) {
      const response = await fetch(
        `${secrets.iamApiUrl}/api/v1/iam/auth/rotate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: session.refresh_token }),
        }
      );
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.message);
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
      await BrowserAPIService.storage.local.set({ session: newSession });
      token = newSession.access_token;
    }

    headers.Authorization = `Bearer ${token}`;
  }

  const url = `${baseUrl}${urlPath}`;

  const response = await fetch(url, {
    ...options,
    headers,
  });

  // Handle 401: token refresh already failed — clear session to force re-login
  if (response.status === 401 && headers.Authorization) {
    await BrowserAPIService.storage.local.remove('session');
  }

  return response;
}

export async function cacheApi(key, callback, useCache = true) {
  const isBoolOpts = typeof useCache === 'boolean';
  const options = {
    ttl: 10000 * 10,
    storage: sessionStorage,
    useCache: isBoolOpts ? useCache : true,
  };
  if (!isBoolOpts && isObject(useCache)) {
    Object.assign(options, useCache);
  }

  const timeToLive = options.ttl;
  const currentTime = Date.now() - timeToLive;

  const timerKey = `cache-time:${key}`;
  const cacheResult = parseJSON(options.storage.getItem(key), null);
  const cacheTime = +options.storage.getItem(timerKey) || Date.now();

  if (options.useCache && cacheResult && currentTime < cacheTime) {
    return cacheResult;
  }

  const result = await callback();
  let cacheData = result;

  if (result?.cacheData) {
    cacheData = result?.cacheData;
  }

  options.storage.setItem(timerKey, Date.now());
  options.storage.setItem(key, JSON.stringify(cacheData));

  return result;
}
