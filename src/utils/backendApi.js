import BrowserAPIService from '@/service/browser-api/BrowserAPIService';

/**
 * Backend API utility class for managing all backend communication
 */
class BackendAPI {
  /**
   * Get backend base URL from WebSocket configuration
   * @returns {Promise<string|null>} Base URL or null if not configured
   */
  static async getBackendBaseUrl() {
    try {
      const { wsConfig } = await BrowserAPIService.storage.local.get(
        'wsConfig'
      );

      if (!wsConfig || !wsConfig.url) {
        // eslint-disable-next-line no-console
        console.warn('⚠️ [BackendAPI] No WebSocket config found');
        return null;
      }

      // Extract base URL from WebSocket URL
      const baseUrl = wsConfig.url
        .replace('ws://', 'http://')
        .replace('wss://', 'https://');

      return baseUrl;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('❌ [BackendAPI] Error getting backend URL:', error);
      return null;
    }
  }

  /**
   * Send workflow execution data to backend for logging
   * @param {object} data - Workflow execution data
   * @returns {Promise<object>} Response data or error
   */
  async sendWorkflowLog(data) {
    try {
      const baseUrl = await this.constructor.getBackendBaseUrl();
      if (!baseUrl) {
        throw new Error('Backend URL not configured');
      }

      const apiUrl = `${baseUrl}/api/workflow-log`;

      const payload = {
        workflowId: data.workflowId,
        status: data.status,
        timestamp: data.timestamp,
        workflowRefData: data.workflowRefData,
        tableData: data.tableData,
        variables: data.variables,
        globalData: data.globalData,
      };

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const result = await response.json();
        return { success: true, data: result };
      }
      const errorText = await response.text();
      // eslint-disable-next-line no-console
      console.error(
        '❌ [BackendAPI] Failed to send workflow log:',
        response.status,
        errorText
      );
      return {
        success: false,
        error: `HTTP ${response.status}: ${errorText}`,
        status: response.status,
      };
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        '❌ [BackendAPI] Error sending workflow log:',
        error.message,
        error
      );

      // Enhanced error context
      if (
        error.name === 'TypeError' &&
        error.message.includes('Failed to fetch')
      ) {
        // eslint-disable-next-line no-console
        console.error(
          '🔍 [BackendAPI] Network error - Backend server may not be running or reachable'
        );
        return {
          success: false,
          error: 'Network error - Backend server unreachable',
          type: 'network',
        };
      }

      return {
        success: false,
        error: error.message,
        type: 'unknown',
      };
    }
  }

  /**
   * Execute workflow via backend API
   * @param {object} workflowData - Workflow data
   * @param {object} parameters - Workflow parameters
   * @param {string} extensionId - Extension ID
   * @returns {Promise<object>} Response data or error
   */
  async executeWorkflow(workflowData, parameters, extensionId) {
    try {
      // eslint-disable-next-line no-console
      console.log('🚀 [BackendAPI] Executing workflow:', {
        workflowName: workflowData.name,
        extensionId,
        parametersCount: Object.keys(parameters).length,
      });

      const baseUrl = await this.constructor.getBackendBaseUrl();
      if (!baseUrl) {
        throw new Error('Backend URL not configured');
      }

      const apiUrl = `${baseUrl}/api/execute-workflow`;
      // eslint-disable-next-line no-console
      console.log('🔗 [BackendAPI] Execute URL:', apiUrl);

      const payload = {
        workflowData,
        parameters,
        extensionId,
        timestamp: Date.now(),
      };

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const result = await response.json();
        // eslint-disable-next-line no-console
        console.log('✅ [BackendAPI] Workflow executed successfully:', result);
        return { success: true, data: result };
      }
      const errorText = await response.text();
      // eslint-disable-next-line no-console
      console.error(
        '❌ [BackendAPI] Failed to execute workflow:',
        response.status,
        errorText
      );
      return {
        success: false,
        error: `HTTP ${response.status}: ${errorText}`,
        status: response.status,
      };
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        '❌ [BackendAPI] Error executing workflow:',
        error.message,
        error
      );

      if (
        error.name === 'TypeError' &&
        error.message.includes('Failed to fetch')
      ) {
        // eslint-disable-next-line no-console
        console.error(
          '🔍 [BackendAPI] Network error - Backend server may not be running or reachable'
        );
        return {
          success: false,
          error: 'Network error - Backend server unreachable',
          type: 'network',
        };
      }

      return {
        success: false,
        error: error.message,
        type: 'unknown',
      };
    }
  }

  /**
   * Get workflow execution status
   * @param {string} executionId - Execution ID
   * @returns {Promise<object>} Status data or error
   */
  async getWorkflowStatus(executionId) {
    try {
      // eslint-disable-next-line no-console
      console.log('📊 [BackendAPI] Getting workflow status:', executionId);

      const baseUrl = await this.constructor.getBackendBaseUrl();
      if (!baseUrl) {
        throw new Error('Backend URL not configured');
      }

      const apiUrl = `${baseUrl}/api/workflow-status/${executionId}`;
      // eslint-disable-next-line no-console
      console.log('🔗 [BackendAPI] Status URL:', apiUrl);

      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const result = await response.json();
        // eslint-disable-next-line no-console
        console.log('✅ [BackendAPI] Status retrieved successfully:', result);
        return { success: true, data: result };
      }
      const errorText = await response.text();
      // eslint-disable-next-line no-console
      console.error(
        '❌ [BackendAPI] Failed to get status:',
        response.status,
        errorText
      );
      return {
        success: false,
        error: `HTTP ${response.status}: ${errorText}`,
        status: response.status,
      };
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        '❌ [BackendAPI] Error getting status:',
        error.message,
        error
      );

      if (
        error.name === 'TypeError' &&
        error.message.includes('Failed to fetch')
      ) {
        return {
          success: false,
          error: 'Network error - Backend server unreachable',
          type: 'network',
        };
      }

      return {
        success: false,
        error: error.message,
        type: 'unknown',
      };
    }
  }

  /**
   * Get workflow logs from backend
   * @param {string} workflowId - Workflow ID
   * @param {object} options - Query options (limit, offset, etc.)
   * @returns {Promise<object>} Logs data or error
   */
  async getWorkflowLogs(workflowId, options = {}) {
    try {
      const baseUrl = await this.constructor.getBackendBaseUrl();
      if (!baseUrl) {
        throw new Error('Backend URL not configured');
      }

      const queryParams = new URLSearchParams({
        workflowId,
        ...options,
      });
      const apiUrl = `${baseUrl}/api/workflow-logs?${queryParams}`;

      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const result = await response.json();
        return { success: true, data: result };
      }
      const errorText = await response.text();
      // eslint-disable-next-line no-console
      console.error(
        '❌ [BackendAPI] Failed to get logs:',
        response.status,
        errorText
      );
      return {
        success: false,
        error: `HTTP ${response.status}: ${errorText}`,
        status: response.status,
      };
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        '❌ [BackendAPI] Error getting logs:',
        error.message,
        error
      );

      if (
        error.name === 'TypeError' &&
        error.message.includes('Failed to fetch')
      ) {
        return {
          success: false,
          error: 'Network error - Backend server unreachable',
          type: 'network',
        };
      }

      return {
        success: false,
        error: error.message,
        type: 'unknown',
      };
    }
  }

  /**
   * Send screenshot to backend
   * @param {object} data - Screenshot data
   * @returns {Promise<object>} Response data or error
   */
  async sendScreenshot(data) {
    try {
      const baseUrl = await this.constructor.getBackendBaseUrl();
      if (!baseUrl) {
        throw new Error('Backend URL not configured');
      }

      const apiUrl = `${baseUrl}/api/screenshot`;
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });

      if (response.ok) {
        const result = await response.json();
        return { success: true, data: result };
      }
      const errorText = await response.text();
      // eslint-disable-next-line no-console
      console.error(
        '❌ [BackendAPI] Failed to send screenshot:',
        response.status,
        errorText
      );
      return {
        success: false,
        error: `HTTP ${response.status}: ${errorText}`,
        status: response.status,
      };
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        '❌ [BackendAPI] Error sending screenshot:',
        error.message,
        error
      );

      if (
        error.name === 'TypeError' &&
        error.message.includes('Failed to fetch')
      ) {
        // eslint-disable-next-line no-console
        console.error(
          '🔍 [BackendAPI] Network error - Backend server may not be running or reachable'
        );
        return {
          success: false,
          error: 'Network error - Backend server unreachable',
          type: 'network',
        };
      }

      return {
        success: false,
        error: error.message,
        type: 'unknown',
      };
    }
  }

  /**
   * Test backend connectivity
   * @returns {Promise<object>} Test result
   */
  async testConnection() {
    try {
      // eslint-disable-next-line no-console
      console.log('🔍 [BackendAPI] Testing backend connection');

      const baseUrl = await this.constructor.getBackendBaseUrl();
      if (!baseUrl) {
        return {
          success: false,
          error: 'Backend URL not configured',
          type: 'config',
        };
      }

      const apiUrl = `${baseUrl}/api/health`;
      // eslint-disable-next-line no-console
      console.log('🔗 [BackendAPI] Health check URL:', apiUrl);

      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const result = await response.json();
        return { success: true, data: result };
      }
      const errorText = await response.text();
      // eslint-disable-next-line no-console
      console.error(
        '❌ [BackendAPI] Backend connection test failed:',
        response.status,
        errorText
      );
      return {
        success: false,
        error: `HTTP ${response.status}: ${errorText}`,
        status: response.status,
      };
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        '❌ [BackendAPI] Backend connection test error:',
        error.message,
        error
      );

      if (
        error.name === 'TypeError' &&
        error.message.includes('Failed to fetch')
      ) {
        return {
          success: false,
          error: 'Backend server unreachable',
          type: 'network',
        };
      }

      return {
        success: false,
        error: error.message,
        type: 'unknown',
      };
    }
  }
}

// Export singleton instance
export default new BackendAPI();
