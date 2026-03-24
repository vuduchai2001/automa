import { fetchApi } from './api';

const BASE = '/api/v1/control/workflow-packages';

export async function fetchPackages() {
  const response = await fetchApi(`${BASE}/list`, {
    auth: true,
    method: 'POST',
    body: JSON.stringify({ skip: 0, limit: 1000 }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to fetch packages');
  }
  const result = await response.json();
  return result.data || result;
}

export async function fetchPackageById(id) {
  const response = await fetchApi(`${BASE}/${id}`, { auth: true });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to fetch package');
  }
  const result = await response.json();
  return result.data || result;
}

export async function createPackage(data) {
  const response = await fetchApi(BASE, {
    auth: true,
    method: 'POST',
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to create package');
  }
  const result = await response.json();
  return result.data || result;
}

export async function updatePackageConfig(id, data) {
  const response = await fetchApi(`${BASE}/${id}`, {
    auth: true,
    method: 'PATCH',
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to update package');
  }
  const result = await response.json();
  return result.data || result;
}

export async function deletePackage(id) {
  const response = await fetchApi(`${BASE}/${id}`, {
    auth: true,
    method: 'DELETE',
  });
  if (!response.ok && response.status !== 204) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to delete package');
  }
}

export async function clonePackage(id, { newName, newDescription }) {
  const response = await fetchApi(`${BASE}/${id}/clone`, {
    auth: true,
    method: 'POST',
    body: JSON.stringify({
      new_name: newName,
      new_description: newDescription,
    }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to clone package');
  }
  const result = await response.json();
  return result.data || result;
}

export async function fetchPackageVersions(id) {
  const response = await fetchApi(`${BASE}/${id}/versions`, { auth: true });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to fetch package versions');
  }
  return response.json();
}

export async function fetchPackageVersionDetail(packageId, versionId) {
  const response = await fetchApi(
    `${BASE}/${packageId}/versions/${versionId}`,
    { auth: true }
  );
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to fetch version detail');
  }
  return response.json();
}

export async function rollbackPackage(id, targetVersionId, reason) {
  const response = await fetchApi(`${BASE}/${id}/rollback`, {
    auth: true,
    method: 'POST',
    body: JSON.stringify({
      target_version_id: targetVersionId,
      reason,
    }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to rollback package');
  }
  const result = await response.json();
  return result.data || result;
}
