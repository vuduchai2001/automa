import { fetchApi } from './api';

const BASE = '/api/v1/control/workflow-folders';

export async function fetchFolders() {
  const response = await fetchApi(`${BASE}/list`, {
    auth: true,
    method: 'POST',
    body: JSON.stringify({ skip: 0, limit: 1000 }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to fetch folders');
  }
  const result = await response.json();
  return result.data || result;
}

export async function fetchFolderById(id) {
  const response = await fetchApi(`${BASE}/${id}`, { auth: true });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to fetch folder');
  }
  const result = await response.json();
  return result.data || result;
}

export async function createFolder(data) {
  const response = await fetchApi(BASE, {
    auth: true,
    method: 'POST',
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to create folder');
  }
  const result = await response.json();
  return result.data || result;
}

export async function updateFolder(id, data) {
  const response = await fetchApi(`${BASE}/${id}`, {
    auth: true,
    method: 'PATCH',
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to update folder');
  }
  const result = await response.json();
  return result.data || result;
}

export async function deleteFolder(id) {
  const response = await fetchApi(`${BASE}/${id}`, {
    auth: true,
    method: 'DELETE',
  });
  if (!response.ok && response.status !== 204) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to delete folder');
  }
}

export async function moveWorkflowsToFolder(workflowIds, folderId = null) {
  const response = await fetchApi(`${BASE}/move-workflows`, {
    auth: true,
    method: 'POST',
    body: JSON.stringify({
      workflow_ids: workflowIds,
      folder_id: folderId,
    }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to move workflows');
  }
  const result = await response.json();
  return result.data || result;
}
