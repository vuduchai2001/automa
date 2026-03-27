import browser from 'webextension-polyfill';

const WORKER_MODE_STORAGE_KEYS = [
  'workerMode',
  'profileId',
  'profile_id',
  'internalApiPort',
  'internal_api_port',
  'wsConfig',
  'wsUrl',
  'ws_url',
];

export function urlHasToken(url = '') {
  if (!url) return false;

  try {
    return new URL(url).searchParams.has('token');
  } catch (error) {
    return /[?&]token=/.test(url);
  }
}

export function isWorkerModePayload(payload = {}) {
  const wsUrl =
    payload.wsConfig?.url || payload.wsUrl || payload.ws_url || payload.url;
  const profileId = payload.profileId || payload.profile_id;
  const wsPort = payload.wsPort || payload.ws_port;
  const hasWsUrl = Boolean(wsUrl && /^wss?:\/\//.test(wsUrl));
  const hasWsPort = Boolean(wsPort);
  const hasWorkerBootstrap =
    (hasWsUrl || hasWsPort) &&
    (Boolean(profileId) ||
      Boolean(payload.internalApiPort || payload.internal_api_port) ||
      urlHasToken(wsUrl));

  return Boolean(hasWorkerBootstrap);
}

export async function isWorkerMode() {
  const stored = await browser.storage.local.get(WORKER_MODE_STORAGE_KEYS);
  const localBootstrap =
    typeof localStorage !== 'undefined'
      ? {
          profileId: localStorage.getItem('profileId'),
          internalApiPort: localStorage.getItem('internalApiPort'),
          wsUrl: localStorage.getItem('wsUrl'),
        }
      : {};

  return isWorkerModePayload({
    ...stored,
    ...localBootstrap,
    profileId: stored.profileId || localBootstrap.profileId,
  });
}
