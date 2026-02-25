/**
 * WebSocket Configuration
 *
 * URL is loaded from environment variable WS_URL (set in .env file).
 * Falls back to ws://localhost:8000 if not configured.
 */

export const DEFAULT_WEBSOCKET_CONFIG = {
  enabled: !!process.env.WS_URL,
  url: process.env.WS_URL || '',
};

/**
 * Get WebSocket configuration
 *
 * @returns {Object} WebSocket configuration object
 */
export function getWebSocketConfig() {
  return DEFAULT_WEBSOCKET_CONFIG;
}

export default {
  DEFAULT_WEBSOCKET_CONFIG,
  getWebSocketConfig,
};
