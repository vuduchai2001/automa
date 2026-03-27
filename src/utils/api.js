import BrowserAPIService from '@/service/browser-api/BrowserAPIService';
import secrets from 'secrets';
import { getAccessToken, refreshToken } from './auth';
import { authTrace, summarizeSession } from './authTrace';
import { isObject, parseJSON } from './helper';

export async function fetchApi(path, options = {}) {
  const urlPath = path.startsWith('/') ? path : `/${path}`;
  const baseUrl = options.baseUrl || secrets.controlApiUrl;
  delete options.baseUrl;
  const retryAuth = options.retryAuth !== false;
  delete options.retryAuth;

  // Always clean up auth flag so it doesn't leak into fetch()
  const needsAuth = !!options.auth;
  delete options.auth;

  const headers = {
    'Content-Type': 'application/json',
    ...(options?.headers || {}),
  };

  let token = null;
  if (needsAuth) {
    token = await getAccessToken(BrowserAPIService.storage.local);

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  authTrace('fetch:start', {
    path: urlPath,
    baseUrl,
    needsAuth,
    hasAuthorization: !!headers.Authorization,
    retryAuth,
  });

  const url = `${baseUrl}${urlPath}`;

  const response = await fetch(url, {
    ...options,
    headers,
  });

  authTrace('fetch:response', {
    path: urlPath,
    status: response.status,
    needsAuth,
    hasAuthorization: !!headers.Authorization,
    retryAuth,
  });

  if (response.status === 401 && headers.Authorization) {
    authTrace('fetch:401', {
      path: urlPath,
      retryAuth,
    });

    if (retryAuth) {
      try {
        const refreshedSession = await refreshToken(
          BrowserAPIService.storage.local
        );
        const refreshedToken = refreshedSession?.access_token;
        authTrace('fetch:retry-after-refresh', {
          path: urlPath,
          tokenChanged: !!refreshedToken && refreshedToken !== token,
          refreshedSession: summarizeSession(refreshedSession),
        });

        if (refreshedToken && refreshedToken !== token) {
          return fetchApi(path, {
            ...options,
            baseUrl,
            auth: needsAuth,
            retryAuth: false,
            headers: {
              ...headers,
              Authorization: `Bearer ${refreshedToken}`,
            },
          });
        }
      } catch (error) {
        authTrace('fetch:retry-failed', {
          path: urlPath,
          error: error.message,
          status: error.status || null,
        });
      }
    }

    const { session } = await BrowserAPIService.storage.local.get('session');
    if (!session || session.access_token === token) {
      authTrace('fetch:clear-session', {
        path: urlPath,
        session: summarizeSession(session),
      });
      await BrowserAPIService.storage.local.remove(['session', 'user']);
    } else {
      authTrace('fetch:keep-newer-session', {
        path: urlPath,
        session: summarizeSession(session),
      });
    }
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
