import { isAuthenticated } from '@/utils/auth';
import firstWorkflows from '@/utils/firstWorkflows';
import { tasks } from '@/utils/shared';
import {
  fetchWorkflows as apiFetchWorkflows,
  createWorkflow as apiCreateWorkflow,
  updateWorkflow as apiUpdateWorkflow,
  deleteWorkflow as apiDeleteWorkflow,
} from '@/utils/workflowApi';
import {
  cleanWorkflowTriggers,
  registerWorkflowTrigger,
} from '@/utils/workflowTrigger';
import dayjs from 'dayjs';
import defu from 'defu';
import deepmerge from 'lodash.merge';
import { nanoid } from 'nanoid';
import { defineStore } from 'pinia';
import browser from 'webextension-polyfill';
// import { useUserStore } from './user'; // Hosted/backup features disabled

const defaultWorkflow = (data = null, options = {}) => {
  let workflowData = {
    id: nanoid(),
    name: '',
    icon: 'riGlobalLine',
    folderId: null,
    content: null,
    connectedTable: null,
    drawflow: {
      edges: [],
      zoom: 1.3,
      nodes: [
        {
          position: {
            x: 100,
            y: window.innerHeight / 2,
          },
          id: nanoid(),
          label: 'trigger',
          data: tasks.trigger.data,
          type: tasks.trigger.component,
        },
      ],
    },
    table: [],
    dataColumns: [],
    description: '',
    trigger: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isDisabled: false,
    settings: {
      publicId: '',
      aipowerToken: '',
      blockDelay: 0,
      saveLog: true,
      debugMode: false,
      restartTimes: 3,
      notification: true,
      execContext: 'popup',
      reuseLastState: false,
      inputAutocomplete: true,
      onError: 'stop-workflow',
      executedBlockOnWeb: false,
      insertDefaultColumn: false,
      defaultColumnName: 'column',
    },
    version: browser.runtime.getManifest().version,
    globalData: '{\n\t"key": "value"\n}',
  };

  if (data) {
    if (options.duplicateId && data.id) {
      delete workflowData.id;
    }

    if (data.drawflow?.nodes?.length > 0) {
      workflowData.drawflow.nodes = [];
    }

    workflowData = defu(data, workflowData);
  }

  return workflowData;
};

function convertWorkflowsToObject(workflows) {
  if (Array.isArray(workflows)) {
    return workflows.reduce((acc, workflow) => {
      acc[workflow.id] = workflow;

      return acc;
    }, {});
  }

  return workflows;
}

export const useWorkflowStore = defineStore('workflow', {
  storageMap: {
    workflows: 'workflows',
  },
  state: () => ({
    states: [],
    workflows: {},
    popupStates: [],
    retrieved: false,
    isFirstTime: false,
  }),
  getters: {
    getAllStates: (state) => [...state.popupStates, ...state.states],
    getById: (state) => (id) => state.workflows[id],
    getWorkflows: (state) => Object.values(state.workflows),
    getWorkflowStates: (state) => (id) =>
      [...state.states, ...state.popupStates].filter(
        ({ workflowId }) => workflowId === id
      ),
  },
  actions: {
    async loadData() {
      try {
        // 1. Load from local cache first for immediate display
        const { workflows: cachedWorkflows, isFirstTime } =
          await browser.storage.local.get(['workflows', 'isFirstTime']);

        let localWorkflows = cachedWorkflows || {};

        if (isFirstTime) {
          localWorkflows = firstWorkflows.map((workflow) =>
            defaultWorkflow(workflow)
          );
          await browser.storage.local.set({
            isFirstTime: false,
            workflows: localWorkflows,
          });
        }

        this.isFirstTime = isFirstTime;
        this.workflows = convertWorkflowsToObject(localWorkflows);
        this.retrieved = true;

        // 2. Fetch from backend API if authenticated
        const authenticated = await isAuthenticated();
        if (!authenticated) return;

        const apiWorkflows = await apiFetchWorkflows();
        const workflowsObj = {};

        apiWorkflows.forEach((apiWf) => {
          // Map API response (ActionWorkflowResponse/ListItem) to client format
          const config = apiWf.workflow_config || {};
          const workflow = {
            id: apiWf.id,
            name: apiWf.name,
            code: apiWf.code,
            platform_code: apiWf.platform_code,
            description: apiWf.description || '',
            icon: config.icon || 'riGlobalLine',
            folderId: config.folderId || null,
            drawflow: config.drawflow || { edges: [], zoom: 1.3, nodes: [] },
            settings: config.settings || {},
            globalData: config.globalData || '{\n\t"key": "value"\n}',
            table: config.table || [],
            dataColumns: config.dataColumns || [],
            trigger: config.trigger || null,
            isDisabled: config.isDisabled || false,
            content: config.content || null,
            connectedTable: config.connectedTable || null,
            version: apiWf.version || '',
            status: apiWf.status || 'draft',
            createdAt: apiWf.created_at
              ? new Date(apiWf.created_at).getTime()
              : Date.now(),
            updatedAt: apiWf.updated_at
              ? new Date(apiWf.updated_at).getTime()
              : Date.now(),
          };

          if (typeof workflow.drawflow === 'string') {
            try {
              workflow.drawflow = JSON.parse(workflow.drawflow);
            } catch {
              // keep as-is if parse fails
            }
          }
          workflowsObj[workflow.id] = workflow;
        });

        this.workflows = workflowsObj;

        // Update local cache
        await browser.storage.local.set({ workflows: workflowsObj });
      } catch (error) {
        console.error(
          '[WorkflowStore] Failed to load from API, using cache:',
          error
        );
        this.retrieved = true;
      }
    },
    updateStates(newStates) {
      this.states = newStates;
    },
    async insert(data = {}, options = {}) {
      const insertedWorkflows = {};

      const insertSingle = async (item) => {
        if (!options.duplicateId) {
          delete item.id;
        }

        const workflow = defaultWorkflow(item, options);

        // Build API payload matching ActionWorkflowCreateSchema
        const { name, code, platform_code, description, ...automaConfig } =
          workflow;
        const apiPayload = {
          name: name || 'Untitled',
          code: code || `wf_${Date.now()}`,
          platform_code: platform_code || 'default',
          description: description || null,
          workflow_config: {
            drawflow: automaConfig.drawflow,
            settings: automaConfig.settings,
            globalData: automaConfig.globalData,
            table: automaConfig.table,
            dataColumns: automaConfig.dataColumns,
          },
        };

        // Create on backend API first
        const created = await apiCreateWorkflow(apiPayload);
        const finalWorkflow = { ...workflow, id: created.id, ...created };

        this.workflows[finalWorkflow.id] = finalWorkflow;
        insertedWorkflows[finalWorkflow.id] = finalWorkflow;
      };

      if (Array.isArray(data)) {
        for (const item of data) {
          await insertSingle(item);
        }
      } else {
        await insertSingle(data);
      }

      // Update local cache
      await this.saveToStorage('workflows');

      return insertedWorkflows;
    },
    async update({ id, data = {}, deep = false }) {
      const isFunction = typeof id === 'function';
      if (!isFunction && !this.workflows[id]) return null;

      const updatedWorkflows = {};
      const updateData = { ...data, updatedAt: Date.now() };

      const workflowUpdater = async (workflowId) => {
        // Optimistic update: update local state immediately
        if (deep) {
          this.workflows[workflowId] = deepmerge(
            this.workflows[workflowId],
            updateData
          );
        } else {
          Object.assign(this.workflows[workflowId], updateData);
        }

        this.workflows[workflowId].updatedAt = Date.now();
        updatedWorkflows[workflowId] = this.workflows[workflowId];

        if ('isDisabled' in data) {
          if (data.isDisabled) {
            cleanWorkflowTriggers(workflowId);
          } else {
            const triggerBlock = this.workflows[
              workflowId
            ].drawflow.nodes?.find((node) => node.label === 'trigger');
            if (triggerBlock) {
              registerWorkflowTrigger(workflowId, triggerBlock);
            }
          }
        }

        // Push update to backend API
        // API expects UpdateWorkflowConfigRequest: { workflow_config, changelog, update_type }
        try {
          const wf = this.workflows[workflowId];
          const apiPayload = {
            workflow_config: {
              drawflow: wf.drawflow,
              settings: wf.settings,
              globalData: wf.globalData,
              table: wf.table,
              dataColumns: wf.dataColumns,
              name: wf.name,
              description: wf.description,
              icon: wf.icon,
              trigger: wf.trigger,
              isDisabled: wf.isDisabled,
            },
            changelog: data.changelog || 'Updated from extension',
            update_type: 'auto',
          };
          await apiUpdateWorkflow(workflowId, apiPayload);
        } catch (error) {
          console.error('[WorkflowStore] API update failed:', error);
        }
      };

      if (isFunction) {
        for (const workflow of this.getWorkflows) {
          const isMatch = id(workflow) ?? false;
          if (isMatch) await workflowUpdater(workflow.id);
        }
      } else {
        await workflowUpdater(id);
      }

      // Update local cache
      await this.saveToStorage('workflows');

      return updatedWorkflows;
    },
    async insertOrUpdate(
      data = [],
      { checkUpdateDate = false, duplicateId = false } = {}
    ) {
      const insertedData = {};

      for (const item of data) {
        const currentWorkflow = this.workflows[item.id];

        if (currentWorkflow) {
          let insert = true;
          if (checkUpdateDate && currentWorkflow.createdAt && item.updatedAt) {
            insert = dayjs(currentWorkflow.updatedAt).isBefore(item.updatedAt);
          }

          if (insert) {
            const mergedData = deepmerge(this.workflows[item.id], item);

            this.workflows[item.id] = mergedData;
            insertedData[item.id] = mergedData;

            try {
              const wf = mergedData;
              await apiUpdateWorkflow(item.id, {
                workflow_config: {
                  drawflow: wf.drawflow,
                  settings: wf.settings,
                  globalData: wf.globalData,
                  table: wf.table,
                  dataColumns: wf.dataColumns,
                  name: wf.name,
                  description: wf.description,
                  icon: wf.icon,
                  trigger: wf.trigger,
                  isDisabled: wf.isDisabled,
                },
                changelog: 'Sync from extension',
                update_type: 'auto',
              });
            } catch (error) {
              console.error('[WorkflowStore] API upsert-update failed:', error);
            }
          }
        } else {
          const workflow = defaultWorkflow(item, { duplicateId });
          this.workflows[workflow.id] = workflow;
          insertedData[workflow.id] = workflow;

          try {
            const { name, code, platform_code, description, ...automaConfig } =
              workflow;
            await apiCreateWorkflow({
              name: name || 'Untitled',
              code: code || `wf_${Date.now()}`,
              platform_code: platform_code || 'default',
              description: description || null,
              workflow_config: {
                drawflow: automaConfig.drawflow,
                settings: automaConfig.settings,
                globalData: automaConfig.globalData,
                table: automaConfig.table,
                dataColumns: automaConfig.dataColumns,
              },
            });
          } catch (error) {
            console.error('[WorkflowStore] API upsert-create failed:', error);
          }
        }
      }

      await this.saveToStorage('workflows');

      return insertedData;
    },
    async delete(id) {
      const ids = Array.isArray(id) ? id : [id];

      // Delete from backend API
      for (const workflowId of ids) {
        try {
          await apiDeleteWorkflow(workflowId);
        } catch (error) {
          console.error('[WorkflowStore] API delete failed:', error);
        }

        delete this.workflows[workflowId];
      }

      await cleanWorkflowTriggers(id);

      // Old hosted/backup cleanup disabled — feature not active
      // const userStore = useUserStore();
      // const hostedWorkflow = userStore.hostedWorkflows[id];
      // const backupIndex = userStore.backupIds.indexOf(id);

      // Clean up local storage artifacts
      const storageKeysToRemove = ids.flatMap((wfId) => [
        `state:${wfId}`,
        `draft:${wfId}`,
        `draft-team:${wfId}`,
      ]);
      await browser.storage.local.remove(storageKeysToRemove);
      await this.saveToStorage('workflows');

      const { pinnedWorkflows } = await browser.storage.local.get(
        'pinnedWorkflows'
      );
      if (pinnedWorkflows) {
        const filtered = pinnedWorkflows.filter((pId) => !ids.includes(pId));
        if (filtered.length !== pinnedWorkflows.length) {
          await browser.storage.local.set({ pinnedWorkflows: filtered });
        }
      }

      return id;
    },
  },
});
