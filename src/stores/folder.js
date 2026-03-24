import { defineStore } from 'pinia';
import browser from 'webextension-polyfill';
import { isAuthenticated } from '@/utils/auth';
import {
  fetchFolders,
  createFolder,
  updateFolder as apiUpdateFolder,
  deleteFolder as apiDeleteFolder,
} from '@/utils/folderApi';

export const useFolderStore = defineStore('folder', {
  storageMap: {
    items: 'folders',
  },
  state: () => ({
    items: [],
    retrieved: false,
  }),
  actions: {
    async addFolder(data) {
      const payload = typeof data === 'string' ? { name: data } : data;
      const created = await createFolder(payload);
      this.items.push(created);
      await this.saveToStorage('items');
      return created;
    },
    async deleteFolder(id) {
      const index = this.items.findIndex((folder) => folder.id === id);
      if (index === -1) return null;

      await apiDeleteFolder(id);
      this.items.splice(index, 1);
      await this.saveToStorage('items');

      return index;
    },
    async updateFolder(id, data = {}) {
      const index = this.items.findIndex((folder) => folder.id === id);
      if (index === -1) return null;

      // Optimistic update
      Object.assign(this.items[index], data);
      await this.saveToStorage('items');

      try {
        await apiUpdateFolder(id, data);
      } catch (error) {
        console.error('[FolderStore] API update failed:', error);
      }

      return this.items[index];
    },
    async load() {
      try {
        // 1. Load from local cache first
        const { folders } = await browser.storage.local.get('folders');
        this.items = folders || [];
        this.retrieved = true;

        // 2. Fetch from backend if authenticated
        const authenticated = await isAuthenticated();
        if (!authenticated) return this.items;

        const apiFolders = await fetchFolders();
        if (Array.isArray(apiFolders) && apiFolders.length > 0) {
          this.items = apiFolders;
          await this.saveToStorage('items');
        }

        return this.items;
      } catch (error) {
        console.error(
          '[FolderStore] Failed to load from API, using cache:',
          error
        );
        this.retrieved = true;
        return this.items;
      }
    },
  },
});
