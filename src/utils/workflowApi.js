import { fetchApi } from './api';

const CONTROL_BASE = '/api/v1/control/workflows';

/**
 * Fetch all workflows from backend (paginated list endpoint)
 * @returns {Promise<Array>} Array of workflow objects
 */
export async function fetchWorkflows() {
  const response = await fetchApi(`${CONTROL_BASE}/list`, {
    auth: true,
    method: 'POST',
    body: JSON.stringify({ skip: 0, limit: 1000 }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to fetch workflows');
  }
  const result = await response.json();
  return result.data || result;
}

/**
 * Fetch single workflow by ID
 * @param {string} id
 * @returns {Promise<Object>} Workflow object
 */
export async function fetchWorkflowById(id) {
  const response = await fetchApi(`${CONTROL_BASE}/${id}`, { auth: true });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to fetch workflow');
  }
  const result = await response.json();
  return result.data || result;
}

/**
 * Create a new workflow on the backend
 * @param {Object} workflowData
 * @returns {Promise<Object>} Created workflow (with server-assigned ID)
 */
export async function createWorkflow(workflowData) {
  const response = await fetchApi(CONTROL_BASE, {
    auth: true,
    method: 'POST',
    body: JSON.stringify(workflowData),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to create workflow');
  }
  const result = await response.json();
  return result.data || result;
}

/**
 * Update an existing workflow on the backend
 * @param {string} id
 * @param {Object} data - Partial workflow data to update
 * @returns {Promise<Object>} Updated workflow
 */
export async function updateWorkflow(id, data) {
  const response = await fetchApi(`${CONTROL_BASE}/${id}`, {
    auth: true,
    method: 'PATCH',
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to update workflow');
  }
  const result = await response.json();
  return result.data || result;
}

/**
 * Delete a workflow from the backend
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteWorkflow(id) {
  const response = await fetchApi(`${CONTROL_BASE}/${id}`, {
    auth: true,
    method: 'DELETE',
  });
  if (!response.ok && response.status !== 204) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to delete workflow');
  }
}

/**
 * Approve a workflow (draft → approved)
 * @param {string} workflowId
 * @returns {Promise<Object>}
 */
export async function approveWorkflow(workflowId) {
  const response = await fetchApi(`${CONTROL_BASE}/${workflowId}/approve`, {
    auth: true,
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to approve workflow');
  }
  const result = await response.json();
  return result.data || result;
}

/**
 * Deprecate a workflow
 * @param {string} workflowId
 * @returns {Promise<Object>}
 */
export async function deprecateWorkflow(workflowId) {
  const response = await fetchApi(`${CONTROL_BASE}/${workflowId}/deprecate`, {
    auth: true,
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to deprecate workflow');
  }
  const result = await response.json();
  return result.data || result;
}

/**
 * Fetch version history for a workflow
 * @param {string} workflowId
 * @returns {Promise<Array>} Array of ActionWorkflowVersionSummary
 */
export async function fetchWorkflowVersions(workflowId) {
  const response = await fetchApi(`${CONTROL_BASE}/${workflowId}/versions`, {
    auth: true,
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to fetch workflow versions');
  }
  const result = await response.json();
  return result.data || result;
}

/**
 * Rollback a workflow to a specific version
 * @param {string} workflowId
 * @param {string} targetVersionId
 * @param {string} reason
 * @returns {Promise<Object>} ActionWorkflowRollbackResult
 */
export async function rollbackWorkflow(workflowId, targetVersionId, reason) {
  const response = await fetchApi(`${CONTROL_BASE}/${workflowId}/rollback`, {
    auth: true,
    method: 'POST',
    body: JSON.stringify({
      target_version_id: targetVersionId,
      reason,
    }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to rollback workflow');
  }
  const result = await response.json();
  return result.data || result;
}
