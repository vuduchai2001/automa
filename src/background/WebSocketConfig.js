/**
 * WebSocket Configuration for Production
 *
 * This file contains the default WebSocket settings that will be used
 * when the extension starts up and no configuration is found.
 */

export const DEFAULT_WEBSOCKET_CONFIG = {
  enabled: true,
  url: 'ws://localhost:8000', // Change this to your production backend URL
  authToken: 'test-token-12345', // Change this to your production auth token
};

/**
 * Production WebSocket Configuration
 *
 * Uncomment and modify these settings for production deployment:
 */
export const PRODUCTION_WEBSOCKET_CONFIG = {
  enabled: true,
  url: 'wss://your-backend-domain.com/ws', // Production WebSocket URL
  authToken: 'your-production-auth-token', // Production auth token
};

/**
 * Get WebSocket configuration based on environment
 *
 * @returns {Object} WebSocket configuration object
 */
export function getWebSocketConfig() {
  // Check if we're in development mode
  const isDevelopment =
    process.env.NODE_ENV === 'development' ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1';

  if (isDevelopment) {
    return DEFAULT_WEBSOCKET_CONFIG;
  }

  // For production, you can:
  // 1. Use environment variables
  // 2. Use a config file
  // 3. Use hardcoded production values

  return PRODUCTION_WEBSOCKET_CONFIG;
}

/**
 * Environment-specific WebSocket URLs
 */
export const WEBSOCKET_URLS = {
  development: 'ws://localhost:8000',
  staging: 'wss://staging-backend.yourdomain.com/ws',
  production: 'wss://api.yourdomain.com/ws',
};

/**
 * Environment-specific auth tokens
 */
export const AUTH_TOKENS = {
  development: 'test-token-12345',
  staging: 'staging-token-xyz789',
  production: 'prod-token-abc123',
};

export default {
  DEFAULT_WEBSOCKET_CONFIG,
  PRODUCTION_WEBSOCKET_CONFIG,
  getWebSocketConfig,
  WEBSOCKET_URLS,
  AUTH_TOKENS,
};
