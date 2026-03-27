/* eslint-disable no-console */
import browser from 'webextension-polyfill';
import { nanoid } from 'nanoid';
import dbLogs from '@/db/logs';
import { getAccessToken } from '@/utils/auth';
import convertWorkflowData from '@/utils/convertWorkflowData';
import { isWorkerModePayload, urlHasToken } from '@/utils/workerMode';
import BackgroundWorkflowUtils from './BackgroundWorkflowUtils';
import { getWebSocketConfig } from './WebSocketConfig';

/**
 * WebSocket Service for receiving workflow execution requests from external backend
 */
class BackgroundWebSocket {
  /** @type {BackgroundWebSocket} */
  static #_instance;

  /**
   * BackgroundWebSocket singleton
   * @type {BackgroundWebSocket}
   */
  static get instance() {
    if (!this.#_instance) this.#_instance = new BackgroundWebSocket();
    return this.#_instance;
  }

  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
    this.reconnectDelay = 10000; // 10 seconds
    this.reconnectTimer = null;

    // Track active executions
    this.activeExecutions = new Map();

    // Message queue for when disconnected
    this.messageQueue = [];

    // Installation ID (unique per installation)
    this.installationId = null;
    this.profileId = null;
    this.internalApiPort = 9091;
    this.internalApiSecret = null;
    this.workerMode = false;
    this._skipNextReconnect = false;
  }

  /**
   * Initialize WebSocket connection
   */
  async init() {
    // Prevent multiple simultaneous initializations
    if (this._initializing) {
      return;
    }

    // Already connected — nothing to do
    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this._initializing = true;

    try {
      const { wsConfig } = await this.bootstrapRuntimeConfig();

      // Clean up stale connection if any
      if (this.ws) {
        try {
          this._skipNextReconnect = true;
          this.ws.close();
        } catch (e) {
          /* ignore */
        }
        this.ws = null;
        this.isConnected = false;
      }

      // Reset reconnect state for fresh attempt
      this.reconnectAttempts = 0;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      // Get or create installation ID
      const { installationId } = await browser.storage.local.get(
        'installationId'
      );
      if (!installationId) {
        this.installationId = nanoid();
        await browser.storage.local.set({
          installationId: this.installationId,
        });
      } else {
        this.installationId = installationId;
      }

      // Setup default config if not configured
      if (!wsConfig) {
        await BackgroundWebSocket.setupConfig();
        const { wsConfig: newConfig } = await browser.storage.local.get(
          'wsConfig'
        );
        if (newConfig && newConfig.enabled && newConfig.url) {
          this.connect(newConfig.url);
        }
        return;
      }

      if (!wsConfig.enabled || !wsConfig.url) {
        return;
      }

      this.connect(wsConfig.url);
    } catch (error) {
      console.error('[WebSocket] Failed to initialize:', error);
    } finally {
      this._initializing = false;
    }
  }

  /**
   * Setup default WebSocket configuration
   * @returns {Promise<void>}
   */
  static async setupDefaultConfig() {
    const defaultConfig = getWebSocketConfig();
    await browser.storage.local.set({ wsConfig: defaultConfig });
  }

  /**
   * Save default config to storage (no recursive init call)
   * @returns {Promise<void>}
   */
  static async setupConfig() {
    const defaultConfig = getWebSocketConfig();
    await browser.storage.local.set({ wsConfig: defaultConfig });
  }

  /**
   * Connect to WebSocket server
   */
  async connect(url) {
    try {
      let wsUrl = url;

      if (
        this.profileId &&
        !BackgroundWebSocket.hasQueryParam(wsUrl, 'profile_id')
      ) {
        wsUrl = BackgroundWebSocket.setUrlQueryParam(
          wsUrl,
          'profile_id',
          this.profileId
        );
      }

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('socket conenction');
        this.onOpen().catch((e) =>
          console.error('[WebSocket] onOpen error:', e)
        );
      };
      this.ws.onmessage = (event) => {
        this.onMessage(event).catch((e) =>
          console.error('[WebSocket] onMessage error:', e)
        );
      };
      this.ws.onerror = (error) => BackgroundWebSocket.onError(error);
      this.ws.onclose = () => this.onClose();
    } catch (error) {
      console.error('[WebSocket] Connection error:', error);
      this.scheduleReconnect();
    }
  }

  /**
   * Handle connection opened
   */
  async onOpen() {
    try {
      this.isConnected = true;
      // Don't reset reconnectAttempts here — wait until server confirms
      // with 'welcome' message. Otherwise, if the server accepts TCP but
      // rejects auth (closes connection), we'd loop forever.

      // Get fresh token for identify message
      const token =
        BackgroundWebSocket.getTokenFromUrl(this.ws?.url) ||
        (await getAccessToken().catch(() => null));

      // Send identification message with auth token and profileId
      this.send({
        type: 'identify',
        data: {
          extensionId: browser.runtime.id,
          installationId: this.installationId,
          profileId: this.profileId,
          version: browser.runtime.getManifest().version,
          token: token || null,
        },
      });

      // Send queued messages
      this.flushMessageQueue();

      // Update badge (non-blocking, don't let badge errors affect connection)
      const browserAction = browser.action || browser.browserAction;
      if (browserAction) {
        browserAction
          .setBadgeBackgroundColor({ color: '#10B981' })
          .catch(() => {});
        browserAction.setBadgeText({ text: '●' }).catch(() => {});
      }
    } catch (error) {
      console.error('[WebSocket] Error in onOpen:', error);
    }
  }

  /**
   * Handle incoming messages
   */
  async onMessage(event) {
    try {
      const message = JSON.parse(event.data);

      switch (message?.command) {
        case 'welcome':
          // Connection confirmed by server — safe to reset reconnect counter
          this.reconnectAttempts = 0;
          break;

        case 'executeAction':
          await this.handleExecuteWorkflow(message);
          break;

        case 'stop_workflow':
          await this.handleStopWorkflow(message);
          break;

        case 'get_status':
          await this.handleGetStatus(message);
          break;

        case 'ping':
          this.send({ type: 'pong', requestId: message.requestId });
          break;

        default:
          console.warn('[WebSocket] Unknown message type:', message.type);
      }
    } catch (error) {
      console.error('[WebSocket] Error handling message:', error);
      this.send({
        type: 'error',
        error: {
          message: error.message,
          stack: error.stack,
        },
      });
    }
  }

  /**
   * Handle execute workflow request
   */
  async handleExecuteWorkflow(message) {
    console.log('recive workflow', message);
    const { request_id: executionId, params } = message;

    const { workflow_config: workflow, options, params: inputs } = params || {};

    if (!executionId) {
      this.send({
        type: 'error',
        error: { message: 'executionId is required' },
      });
      return;
    }

    if (!workflow) {
      this.send({
        type: 'error',
        executionId,
        error: { message: 'workflow is required' },
      });
      return;
    }

    try {
      const workflowData = convertWorkflowData({
        ...workflow,
        id: workflow.id || `ws-${executionId || nanoid()}`,
        name: workflow.name || 'WebSocket Workflow',
      });

      if (!workflowData.drawflow?.nodes) {
        throw new Error('Invalid workflow structure');
      }

      // Parse parameters from trigger block
      const parsedVariables = BackgroundWebSocket.parseWorkflowParameters(
        workflowData,
        inputs
      );

      // Prepare execution options
      const execOptions = {
        ...options,
        checkParams: false, // Skip params prompt
        data: {
          variables: parsedVariables,
        },
        workerContext: {
          jobId: executionId,
          actionId: params.action_id || null,
          actionIndex:
            typeof params.action_index === 'number' ? params.action_index : 0,
          internalApiPort:
            params.internal_api_port || this.internalApiPort || 9091,
          internalApiSecret:
            params.internal_api_secret || this.internalApiSecret || null,
        },
      };

      // Track execution
      this.activeExecutions.set(executionId, {
        workflowId: workflowData.id,
        startedAt: Date.now(),
        status: 'running',
      });

      // Send acknowledgment
      this.send({
        command: 'workflow_started',
        executionId,
        workflowId: workflowData.id,
        timestamp: Date.now(),
      });

      // Execute workflow
      await BackgroundWorkflowUtils.instance.executeWorkflow(
        workflowData,
        execOptions
      );

      // Monitor workflow completion
      // this.monitorWorkflowExecution(executionId, workflowData.id);
    } catch (error) {
      console.error('[WebSocket] ❌ Error executing workflow:', error);

      this.activeExecutions.delete(executionId);

      this.send({
        type: 'workflow_failed',
        executionId,
        error: {
          message: error.message,
          stack: error.stack,
        },
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Parse workflow parameters from trigger block and inputs
   * @param {Object} workflow - Workflow data
   * @param {Object} inputs - Input parameters
   * @returns {Object} Parsed variables
   */
  static parseWorkflowParameters(workflow, inputs = {}) {
    try {
      // Find trigger block
      const triggerBlock = workflow.drawflow.nodes.find(
        (node) => node.label === 'trigger'
      );

      if (!triggerBlock || !triggerBlock.data.parameters) {
        return inputs;
      }

      const { parameters } = triggerBlock.data;
      const parsedVariables = {};

      // Parse each parameter
      parameters.forEach((param) => {
        const paramName = param.name;
        const paramType = param.type;
        const { defaultValue } = param;

        // Get value from inputs or use default
        const value =
          inputs[paramName] !== undefined ? inputs[paramName] : defaultValue;

        // Parse value based on type
        switch (paramType) {
          case 'string':
            parsedVariables[paramName] = String(value || '');
            break;
          case 'number':
            parsedVariables[paramName] = Number(value) || 0;
            break;
          case 'json':
            try {
              parsedVariables[paramName] =
                typeof value === 'string' ? JSON.parse(value) : value;
            } catch (e) {
              console.warn(
                `[WebSocket] Failed to parse JSON for parameter ${paramName}:`,
                e
              );
              parsedVariables[paramName] = value;
            }
            break;
          case 'checkbox':
            parsedVariables[paramName] = Boolean(value);
            break;
          default:
            parsedVariables[paramName] = value;
        }
      });

      return parsedVariables;
    } catch (error) {
      console.error('[WebSocket] Error parsing parameters:', error);
      return inputs; // Fallback to original inputs
    }
  }

  /**
   * Monitor workflow execution status
   */
  async monitorWorkflowExecution(executionId, workflowId) {
    const checkInterval = 1000; // Check every 1 second
    const maxChecks = 300; // Max 5 minutes
    let checks = 0;

    const checkStatus = async () => {
      if (checks >= maxChecks) {
        this.activeExecutions.delete(executionId);

        // Send timeout notification
        this.send({
          type: 'workflow_timeout',
          executionId,
          workflowId,
          message: 'Workflow execution timeout after 5 minutes',
          timestamp: Date.now(),
        });

        return;
      }

      checks += 1;

      const { workflowStates } = await browser.storage.local.get(
        'workflowStates'
      );
      const state = (workflowStates || []).find(
        (s) => s.workflowId === workflowId
      );

      if (!state) {
        // Workflow completed or not found
        const execution = this.activeExecutions.get(executionId);

        if (execution) {
          // Fetch execution results from logs
          const results = await BackgroundWebSocket.getWorkflowResults(
            workflowId
          );

          const response = {
            type: 'workflow_result',
            executionId,
            workflowId,
            status: results.status || 'success',
            message: results.message || 'Workflow completed successfully',
            duration: Date.now() - execution.startedAt,
            timestamp: Date.now(),
            data: results.data,
            logs: results.logs,
          };

          this.send(response);
          this.activeExecutions.delete(executionId);
        }

        return;
      }

      // Check again after interval
      setTimeout(checkStatus, checkInterval);
    };

    checkStatus();
  }

  /**
   * Get workflow execution results from logs
   * @param {string} workflowId - Workflow ID
   * @returns {Promise<Object>} Workflow results
   */
  static async getWorkflowResults(workflowId) {
    try {
      // Find the most recent log for this workflow
      const logItems = await dbLogs.items
        .where('workflowId')
        .equals(workflowId)
        .reverse()
        .limit(1)
        .toArray();

      if (logItems.length === 0) {
        console.warn('[WebSocket] No logs found for workflow:', workflowId);
        return {
          status: 'success',
          message: 'Workflow completed but no logs found',
          data: {
            table: [],
            variables: {},
          },
          logs: [],
        };
      }

      const logItem = logItems[0];
      const logId = logItem.id;

      // Fetch associated data
      const [logsData, histories] = await Promise.all([
        dbLogs.logsData.where('logId').equals(logId).first(),
        dbLogs.histories.where('logId').equals(logId).first(),
      ]);

      // Extract results
      const results = {
        status: logItem.status,
        message: logItem.message || `Workflow ${logItem.status}`,
        data: {
          table: logsData?.data?.table || [],
          variables: logsData?.data?.variables || {},
        },
        logs: histories?.data || [],
      };

      // Add sample extracted data if table is empty
      if (results.data.table.length === 0 && results.logs.length > 0) {
        results.data.extractedData = BackgroundWebSocket.extractSampleData(
          results.logs
        );
      }

      return results;
    } catch (error) {
      console.error('[WebSocket] Error fetching workflow results:', error);
      return {
        status: 'error',
        message: `Failed to fetch results: ${error.message}`,
        data: {
          table: [],
          variables: {},
        },
        logs: [],
      };
    }
  }

  /**
   * Extract sample data from logs (for demonstration)
   * @param {Array} logs - Log entries
   * @returns {Object} Extracted data
   */
  static extractSampleData(logs) {
    const extracted = {
      blocksExecuted: logs.length,
      blockTypes: {},
      executionTime: 0,
      errors: [],
    };

    logs.forEach((log) => {
      // Count block types
      if (log.name) {
        extracted.blockTypes[log.name] =
          (extracted.blockTypes[log.name] || 0) + 1;
      }

      // Sum execution time
      if (log.duration) {
        extracted.executionTime += log.duration;
      }

      // Collect errors
      if (log.type === 'error') {
        extracted.errors.push({
          blockId: log.blockId,
          blockName: log.name,
          message: log.message,
          timestamp: log.timestamp,
        });
      }
    });

    return extracted;
  }

  /**
   * Handle stop workflow request
   */
  async handleStopWorkflow(message) {
    const { executionId } = message.data;
    const execution = this.activeExecutions.get(executionId);

    if (!execution) {
      this.send({
        type: 'error',
        executionId,
        error: { message: 'Execution not found' },
      });
      return;
    }

    try {
      const stateId =
        execution.stateId ||
        (await BackgroundWebSocket.findStateIdByExecution(execution));
      if (!stateId) {
        throw new Error('Execution state not found');
      }

      await BackgroundWorkflowUtils.instance.stopExecution(stateId);

      this.activeExecutions.delete(executionId);

      this.send({
        type: 'workflow_stopped',
        executionId,
        workflowId: execution.workflowId,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('[WebSocket] Error stopping workflow:', error);
      this.send({
        type: 'error',
        executionId,
        error: { message: error.message },
      });
    }
  }

  /**
   * Handle get status request
   */
  async handleGetStatus(message) {
    const { requestId } = message;
    const { workflowStates } = await browser.storage.local.get(
      'workflowStates'
    );

    this.send({
      type: 'status_response',
      requestId,
      data: {
        connected: this.isConnected,
        activeExecutions: Array.from(this.activeExecutions.entries()).map(
          ([executionId, execution]) => ({
            executionId,
            ...execution,
          })
        ),
        runningWorkflows: Object.values(workflowStates || {}).length,
      },
    });
  }

  /**
   * Handle connection error
   */
  static onError(error) {
    console.error('[WebSocket] ❌ Error:', error);
    // Don't call onClose here — the WebSocket 'close' event will fire
    // automatically after 'error', so onClose will be called by the event.
  }

  /**
   * Handle connection closed
   */
  onClose() {
    this.isConnected = false;
    console.info('socket disconnected');
    // Update badge (non-blocking)
    try {
      const browserAction = browser.action || browser.browserAction;
      if (browserAction) {
        browserAction
          .setBadgeBackgroundColor({ color: '#EF4444' })
          .catch(() => {});
        browserAction.setBadgeText({ text: '○' }).catch(() => {});
      }
    } catch (e) {
      // ignore badge errors
    }

    if (this._skipNextReconnect) {
      this._skipNextReconnect = false;
      return;
    }

    // Schedule reconnection
    this.scheduleReconnect();
  }

  /**
   * Schedule reconnection
   */
  async scheduleReconnect() {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WebSocket] Max reconnection attempts reached');
      return;
    }

    const delay = this.reconnectDelay * 1.5 ** this.reconnectAttempts;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;

      this.reconnectAttempts += 1;

      const { wsConfig } = await this.bootstrapRuntimeConfig();
      if (wsConfig && wsConfig.enabled) {
        this.connect(wsConfig.url);
      }
    }, delay);
  }

  /**
   * Send message to server
   */
  send(message) {
    if (!this.isConnected || !this.ws) {
      console.warn(
        '[WebSocket] Not connected, queueing message:',
        message.type
      );
      this.messageQueue.push(message);
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      console.error('[WebSocket] Error sending message:', error);
      this.messageQueue.push(message);
    }
  }

  /**
   * Flush queued messages
   */
  flushMessageQueue() {
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      this.send(message);
    }
  }

  /**
   * Disconnect WebSocket
   */
  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this._skipNextReconnect = true;
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
  }

  /**
   * Reconnect WebSocket
   */
  async reconnect() {
    this.disconnect();
    this.reconnectAttempts = 0;
    await this.init();
  }

  static hasQueryParam(url, key) {
    try {
      return new URL(url).searchParams.has(key);
    } catch (error) {
      return new RegExp(`[?&]${key}=`).test(url);
    }
  }

  static setUrlQueryParam(url, key, value) {
    try {
      const parsed = new URL(url);
      parsed.searchParams.set(key, value);
      return parsed.toString();
    } catch (error) {
      const separator = url.includes('?') ? '&' : '?';
      return `${url}${separator}${key}=${encodeURIComponent(value)}`;
    }
  }

  static getTokenFromUrl(url = '') {
    if (!urlHasToken(url)) return null;

    try {
      return new URL(url).searchParams.get('token');
    } catch (error) {
      const match = url.match(/[?&]token=([^&]+)/);
      return match ? decodeURIComponent(match[1]) : null;
    }
  }

  static resolveWebSocketUrl(config = {}) {
    const directUrl =
      config.wsUrl || config.ws_url || config.wsConfig?.url || null;
    const wsPort = Number(config.wsPort || config.ws_port || 0);

    if (directUrl) {
      const token =
        config.token ||
        config.wsToken ||
        config.ws_token ||
        BackgroundWebSocket.getTokenFromUrl(directUrl);

      if (token && !urlHasToken(directUrl)) {
        return BackgroundWebSocket.setUrlQueryParam(directUrl, 'token', token);
      }

      return directUrl;
    }

    if (!wsPort) return null;

    const wsHost = config.wsHost || config.ws_host || '127.0.0.1';
    const wsPath = config.wsPath || config.ws_path || '/ws';
    let resolvedUrl = `ws://${wsHost}:${wsPort}${wsPath}`;

    if (config.token || config.wsToken || config.ws_token) {
      resolvedUrl = BackgroundWebSocket.setUrlQueryParam(
        resolvedUrl,
        'token',
        config.token || config.wsToken || config.ws_token
      );
    }

    return resolvedUrl;
  }

  static async getInitTabConfig() {
    try {
      const tabs = await browser.tabs.query({});
      const initTab = [...tabs]
        .reverse()
        .find((tab) => tab.url && /\/automa-init(?:\?|$)/.test(tab.url));

      if (!initTab?.url) return {};

      const params = new URL(initTab.url).searchParams;

      return {
        profileId: params.get('profile_id') || params.get('profileId'),
        wsPort: params.get('ws_port') || params.get('wsPort'),
        wsHost: params.get('ws_host') || params.get('wsHost'),
        wsUrl: params.get('ws_url') || params.get('wsUrl'),
        token: params.get('token'),
        internalApiPort:
          params.get('internal_api_port') || params.get('internalApiPort'),
        internalApiSecret:
          params.get('internal_api_secret') || params.get('internalApiSecret'),
      };
    } catch (error) {
      console.warn('[WebSocket] Failed to inspect init tab:', error);
      return {};
    }
  }

  async bootstrapRuntimeConfig() {
    const stored = await browser.storage.local.get([
      'profileId',
      'profile_id',
      'internalApiPort',
      'internal_api_port',
      'internalApiSecret',
      'internal_api_secret',
      'workerMode',
      'wsConfig',
      'wsUrl',
      'ws_url',
      'wsPort',
      'ws_port',
      'wsHost',
      'ws_host',
      'token',
      'wsToken',
      'ws_token',
    ]);
    const initTabConfig = await BackgroundWebSocket.getInitTabConfig();
    const merged = { ...stored, ...initTabConfig };
    const internalApiPort = Number(
      merged.internalApiPort || merged.internal_api_port || 9091
    );

    this.profileId = merged.profileId || merged.profile_id || null;
    this.internalApiPort = Number.isFinite(internalApiPort)
      ? internalApiPort
      : 9091;
    this.internalApiSecret =
      merged.internalApiSecret || merged.internal_api_secret || null;

    const resolvedUrl = BackgroundWebSocket.resolveWebSocketUrl(merged);
    const currentConfig = stored.wsConfig || null;
    const nextWsConfig =
      resolvedUrl || currentConfig?.url
        ? {
            // eslint-disable-next-line no-nested-ternary
            enabled: resolvedUrl
              ? true
              : typeof currentConfig?.enabled === 'boolean'
              ? currentConfig.enabled
              : true,
            url: resolvedUrl || currentConfig?.url || '',
          }
        : null;

    this.workerMode = isWorkerModePayload({
      ...merged,
      profileId: this.profileId,
      internalApiPort: this.internalApiPort,
      wsConfig: nextWsConfig,
    });

    const updates = {};

    if (this.profileId && stored.profileId !== this.profileId) {
      updates.profileId = this.profileId;
    }

    if (
      Number(stored.internalApiPort || stored.internal_api_port || 9091) !==
      this.internalApiPort
    ) {
      updates.internalApiPort = this.internalApiPort;
    }

    if (
      this.internalApiSecret &&
      stored.internalApiSecret !== this.internalApiSecret
    ) {
      updates.internalApiSecret = this.internalApiSecret;
    }

    if (
      nextWsConfig &&
      (currentConfig?.url !== nextWsConfig.url ||
        currentConfig?.enabled !== nextWsConfig.enabled)
    ) {
      updates.wsConfig = nextWsConfig;
    }

    if (stored.workerMode !== this.workerMode) {
      updates.workerMode = this.workerMode;
    }

    if (Object.keys(updates).length > 0) {
      await browser.storage.local.set(updates);
    }

    return {
      wsConfig: updates.wsConfig || nextWsConfig,
      workerMode: this.workerMode,
    };
  }

  static async findStateIdByExecution(execution) {
    const { workflowStates } = await browser.storage.local.get(
      'workflowStates'
    );
    const states = Object.values(workflowStates || {});

    const matchingState =
      states.find(
        (state) =>
          state.workflowId === execution.workflowId &&
          state.startedAt === execution.startedAt
      ) ||
      [...states]
        .reverse()
        .find((state) => state.workflowId === execution.workflowId);

    if (matchingState?.id) {
      execution.stateId = matchingState.id;
      return matchingState.id;
    }

    return null;
  }
}

export default BackgroundWebSocket;
