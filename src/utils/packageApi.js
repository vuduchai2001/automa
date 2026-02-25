import { fetchApi } from './api';

export async function fetchPackages() {
  const response = await fetchApi('/packages', { auth: true });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to fetch packages');
  }
  return response.json();
}

export async function createPackage(data) {
  const response = await fetchApi('/packages', {
    auth: true,
    method: 'POST',
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to create package');
  }
  return response.json();
}

export async function updatePackage(id, data) {
  const response = await fetchApi(`/packages/${id}`, {
    auth: true,
    method: 'PUT',
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to update package');
  }
  return response.json();
}

export async function deletePackage(id) {
  const response = await fetchApi(`/packages/${id}`, {
    auth: true,
    method: 'DELETE',
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to delete package');
  }
}
