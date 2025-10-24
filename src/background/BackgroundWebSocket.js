import browser from 'webextension-polyfill';
import { nanoid } from 'nanoid';
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
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000; // 5 seconds
    this.reconnectTimer = null;

    // Track active executions
    this.activeExecutions = new Map();

    // Message queue for when disconnected
    this.messageQueue = [];

    // Installation ID (unique per installation)
    this.installationId = null;
  }

  /**
   * Initialize WebSocket connection
   */
  async init() {
    // Prevent multiple simultaneous initializations
    if (this._initializing) {
      return;
    }

    this._initializing = true;

    try {
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

      // Get WebSocket config from storage
      const { wsConfig } = await browser.storage.local.get('wsConfig');

      // Auto-enable WebSocket if not configured
      if (!wsConfig) {
        console.log(
          '[WebSocket] No config found, setting up default configuration'
        );
        await this.setupDefaultConfig();
        // Get config again after setup
        const { wsConfig: newConfig } = await browser.storage.local.get(
          'wsConfig'
        );
        if (newConfig && newConfig.enabled && newConfig.url) {
          this.connect(newConfig.url, newConfig.authToken);
        }
        return;
      }

      if (!wsConfig.enabled) {
        console.log('[WebSocket] WebSocket disabled in settings');
        return;
      }

      const { url, authToken } = wsConfig;
      if (!url) {
        console.error('[WebSocket] URL not configured');
        return;
      }

      console.log('[WebSocket] Auto-connecting to:', url);
      this.connect(url, authToken);
    } catch (error) {
      console.error('[WebSocket] Failed to initialize:', error);
    } finally {
      this._initializing = false;
    }
  }

  /**
   * Setup default WebSocket configuration
   */
  async setupDefaultConfig() {
    const defaultConfig = getWebSocketConfig();
    await browser.storage.local.set({ wsConfig: defaultConfig });
    console.log('[WebSocket] Default configuration set:', defaultConfig);
  }

  /**
   * Connect to WebSocket server
   */
  connect(url, authToken) {
    try {
      // Add auth token to URL if provided
      const wsUrl = authToken
        ? `${url}?token=${encodeURIComponent(authToken)}`
        : url;

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => this.onOpen();
      this.ws.onmessage = (event) => this.onMessage(event);
      this.ws.onerror = (error) => this.onError(error);
      this.ws.onclose = (event) => this.onClose(event);
    } catch (error) {
      console.error('[WebSocket] Connection error:', error);
      this.scheduleReconnect();
    }
  }

  /**
   * Handle connection opened
   */
  async onOpen() {
    this.isConnected = true;
    this.reconnectAttempts = 0;

    // Update badge to show connected status
    await browser.action.setBadgeBackgroundColor({ color: '#10B981' }); // Green
    await browser.action.setBadgeText({ text: '●' });

    // Send identification message
    this.send({
      type: 'identify',
      data: {
        extensionId: browser.runtime.id,
        installationId: this.installationId,
        version: browser.runtime.getManifest().version,
      },
    });

    // Send queued messages
    this.flushMessageQueue();
  }

  /**
   * Handle incoming messages
   */
  async onMessage(event) {
    try {
      const message = JSON.parse(event.data);

      switch (message.type) {
        case 'welcome':
          break;

        case 'execute_workflow':
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
    const { executionId, workflow, inputs, options } = message.data;

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
      // Validate workflow structure
      if (!workflow.drawflow || !workflow.drawflow.nodes) {
        throw new Error('Invalid workflow structure');
      }

      // Prepare workflow data
      const workflowData = {
        ...workflow,
        id: workflow.id || `ws-${nanoid()}`,
        name: workflow.name || 'WebSocket Workflow',
      };

      // Prepare execution options
      const execOptions = {
        ...options,
        checkParams: false, // Skip params prompt
        data: {
          variables: inputs || {},
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
        type: 'workflow_started',
        executionId,
        workflowId: workflowData.id,
        timestamp: Date.now(),
      });

      // Execute workflow
      BackgroundWorkflowUtils.instance.executeWorkflow(
        workflowData,
        execOptions
      );

      // Monitor workflow completion
      this.monitorWorkflowExecution(executionId, workflowData.id);
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
          const results = await this.getWorkflowResults(workflowId);

          this.send({
            type: 'workflow_result',
            executionId,
            workflowId,
            status: results.status || 'success',
            message: results.message || 'Workflow completed successfully',
            duration: Date.now() - execution.startedAt,
            timestamp: Date.now(),
            data: results.data,
            logs: results.logs,
          });

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
   */
  async getWorkflowResults(workflowId) {
    try {
      // Import dbLogs dynamically to avoid circular dependencies
      const dbLogs = (await import('@/db/logs')).default;

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

      // Add sample extracted data if table is empty (for demo purposes)
      if (results.data.table.length === 0 && results.logs.length > 0) {
        results.data.extractedData = this.extractSampleData(results.logs);
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
   */
  extractSampleData(logs) {
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
      // Stop workflow
      await BackgroundWorkflowUtils.instance.stopExecution(
        execution.workflowId
      );

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
        connected: true,
        activeExecutions: Array.from(this.activeExecutions.entries()).map(
          ([executionId, execution]) => ({
            executionId,
            ...execution,
          })
        ),
        runningWorkflows: (workflowStates || []).length,
      },
    });
  }

  /**
   * Handle connection error
   */
  onError(error) {
    console.error('[WebSocket] ❌ Error:', error);
    this.onClose();
  }

  /**
   * Handle connection closed
   */
  async onClose() {
    this.isConnected = false;

    // Update badge to show disconnected status
    await browser.action.setBadgeBackgroundColor({ color: '#EF4444' }); // Red
    await browser.action.setBadgeText({ text: '○' });

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

      const { wsConfig } = await browser.storage.local.get('wsConfig');
      if (wsConfig && wsConfig.enabled) {
        this.connect(wsConfig.url, wsConfig.authToken);
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
}

export default BackgroundWebSocket;
