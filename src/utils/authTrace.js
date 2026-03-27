function maskToken(token) {
  if (!token || typeof token !== 'string') return null;
  if (token.length <= 10) return token;

  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

export function summarizeSession(session) {
  if (!session) return null;

  return {
    accessToken: maskToken(session.access_token),
    refreshToken: maskToken(session.refresh_token),
    sessionId: session.session_id || null,
    userId: session.user?.id || null,
    expiresAt: session.expires_at || null,
  };
}

export function authTrace(event, data = {}) {
  console.info(`[AuthTrace] ${event}`, data);
}
