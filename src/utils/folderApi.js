import { fetchApi } from './api';

export async function fetchFolders() {
  const response = await fetchApi('/folders', { auth: true });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to fetch folders');
  }
  return response.json();
}

export async function createFolder(data) {
  const response = await fetchApi('/folders', {
    auth: true,
    method: 'POST',
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to create folder');
  }
  return response.json();
}

export async function updateFolder(id, data) {
  const response = await fetchApi(`/folders/${id}`, {
    auth: true,
    method: 'PUT',
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to update folder');
  }
  return response.json();
}

export async function deleteFolder(id) {
  const response = await fetchApi(`/folders/${id}`, {
    auth: true,
    method: 'DELETE',
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to delete folder');
  }
}
