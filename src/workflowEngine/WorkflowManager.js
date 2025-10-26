import dayjs from '@/lib/dayjs';
import BrowserAPIService from '@/service/browser-api/BrowserAPIService';
import { fetchApi } from '@/utils/api';
import convertWorkflowData from '@/utils/convertWorkflowData';
import getBlockMessage from '@/utils/getBlockMessage';
import blocksHandler from './blocksHandler';
import WorkflowEngine from './WorkflowEngine';
import WorkflowEvent from './workflowEvent';
import WorkflowLogger from './WorkflowLogger';
import WorkflowState from './WorkflowState';

const workflowStateStorage = {
  get() {
    return BrowserAPIService.storage.local
      .get('workflowStates')
      .then(({ workflowStates }) => workflowStates || []);
  },
  set(key, value) {
    const states = Object.values(value);

    return BrowserAPIService.storage.local.set({ workflowStates: states });
  },
};

class WorkflowManager {
  /** @type {WorkflowManager} */
  static #_instance;

  /**
   * WorkflowManager singleton
   * @type {WorkflowManager}
   */
  static get instance() {
    if (!this.#_instance) this.#_instance = new WorkflowManager();

    return this.#_instance;
  }

  /** @type {WorkflowState} */
  #state;

  /** @type {WorkflowLogger} */
  #logger;

  constructor() {
    this.#logger = new WorkflowLogger();
    this.#state = new WorkflowState({ storage: workflowStateStorage });
  }

  execute(workflowData, options) {
    if (workflowData.testingMode) {
      for (const value of this.#state.states.values()) {
        if (value.workflowId === workflowData.id) return null;
      }
    }

    const convertedWorkflow = convertWorkflowData(workflowData);
    const engine = new WorkflowEngine(convertedWorkflow, {
      options,
      states: this.#state,
      logger: this.#logger,
      blocksHandler: blocksHandler(),
    });

    engine.init();
    engine.on('destroyed', ({ id, status, history, blockDetail, ...rest }) => {
      if (status !== 'stopped') {
        BrowserAPIService.permissions
          .contains({ permissions: ['notifications'] })
          .then((hasPermission) => {
            if (!hasPermission || !workflowData.settings.notification) return;

            const name = workflowData.name.slice(0, 32);

            BrowserAPIService.notifications.create(`logs:${id}`, {
              type: 'basic',
              iconUrl: BrowserAPIService.runtime.getURL('icon-128.png'),
              title: status === 'success' ? 'Success' : 'Error',
              message: `${
                status === 'success' ? 'Successfully' : 'Failed'
              } ran the "${name}" workflow`,
            });
          });
      }

      const workflowHistory = history.map((item) => {
        delete item.logId;
        delete item.prevBlockData;
        delete item.workerId;
        item.description = item.description || '';
        return item;
      });
      const workflowRefData = {
        status,
        startedAt: rest.startedTimestamp,
        endedAt: rest.endedTimestamp
          ? rest.endedTimestamp - rest.startedTimestamp
          : null,
        logs: workflowHistory,
        errorMessage: status === 'error' ? getBlockMessage(blockDetail) : null,
      };

      if (convertedWorkflow.settings?.events) {
        convertedWorkflow.settings.events.forEach((event) => {
          if (status === 'success' && !event.events.includes('finish:success'))
            return;
          if (status === 'error' && !event.events.includes('finish:failed'))
            return;

          WorkflowEvent.handle(event.action, {
            workflow: workflowRefData,
            variables: { ...engine.referenceData.variables },
            globalData: { ...engine.referenceData.globalData },
          });
        });
      }

      console.log(engine.referenceData.table);

      // Send workflow data to backend
      this.sendWorkflowDataToBackend({
        workflowRefData,
        variables: { ...engine.referenceData.variables },
        globalData: { ...engine.referenceData.globalData },
        tableData: { ...engine.referenceData.table },
        workflowId: id,
        status,
        timestamp: Date.now(),
      });
    });

    BrowserAPIService.storage.local
      .get('checkStatus')
      .then((res) => {
        const { checkStatus } = res || { checkStatus: null };
        const isSameDay = checkStatus
          ? dayjs().isSame(checkStatus, 'day')
          : false;
        if (!isSameDay || !checkStatus) {
          fetchApi('/status')
            .then((response) => response.json())
            .then(() => {
              BrowserAPIService.storage.local.set({
                checkStatus: new Date().toString(),
              });
            })
            .catch((error) => {
              console.error('Failed to check status:', error);
            });
        }
      })
      .catch((error) => {
        console.error('Failed to get checkStatus:', error);
      });

    return engine;
  }

  /**
   * Stop workflow execution
   * @param {string} stateId
   * @returns {Promise<void>}
   */
  stopExecution(stateId) {
    return this.#state.stop(stateId);
  }

  /**
   * Resume workflow execution
   * @param {string} id
   * @param {object} nextBlock
   * @returns {Promise<void>}
   */
  resumeExecution(id, nextBlock) {
    return this.#state.resume(id, nextBlock);
  }

  /**
   * Resume workflow execution
   * @param {string} id
   * @param {object} stateData
   * @returns {Promise<void>}
   */
  updateExecution(id, stateData) {
    return this.#state.update(id, stateData);
  }

  /**
   * Send workflow data to backend for logging
   * @param {object} data - Workflow execution data
   */
  async sendWorkflowDataToBackend(data) {
    try {
      console.log('📤 [WorkflowManager] Sending workflow data to backend:', {
        workflowId: data.workflowId,
        status: data.status,
        timestamp: data.timestamp,
      });

      // Get WebSocket config to determine backend URL
      const { wsConfig } = await BrowserAPIService.storage.local.get(
        'wsConfig'
      );
      if (!wsConfig || !wsConfig.url) {
        console.warn(
          '[WorkflowManager] No WebSocket config found, skipping backend log'
        );
        return;
      }

      // Extract base URL from WebSocket URL
      const baseUrl = wsConfig.url
        .replace('ws://', 'http://')
        .replace('wss://', 'https://');
      const apiUrl = `${baseUrl}/api/workflow-log`;

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workflowId: data.workflowId,
          status: data.status,
          timestamp: data.timestamp,
          workflowRefData: data.workflowRefData,
          tableData: data.tableData,
          variables: data.variables,
          globalData: data.globalData,
        }),
      });

      if (response.ok) {
        console.log(
          '✅ [WorkflowManager] Workflow data sent to backend successfully'
        );
      } else {
        console.error(
          '❌ [WorkflowManager] Failed to send workflow data to backend:',
          response.status
        );
      }
    } catch (error) {
      console.error(
        '❌ [WorkflowManager] Error sending workflow data to backend:',
        error
      );
    }
  }
}

export default WorkflowManager;
