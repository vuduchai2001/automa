import { defineStore } from 'pinia';
import browser from 'webextension-polyfill';
import { isAuthenticated } from '@/utils/auth';
import {
  fetchPackages,
  createPackage,
  updatePackageConfig,
  deletePackage as apiDeletePackage,
} from '@/utils/packageApi';

const defaultPackage = {
  id: '',
  name: '',
  icon: 'mdiPackageVariantClosed',
  isExtenal: false,
  content: null,
  inputs: [],
  outputs: [],
  variable: [],
  settings: {
    asBlock: false,
  },
  data: {
    edges: [],
    nodes: [],
  },
};

export const usePackageStore = defineStore('packages', {
  storageMap: {
    packages: 'savedBlocks',
  },
  state: () => ({
    packages: [],
    sharedPkgs: [],
    retrieved: false,
    sharedRetrieved: false,
  }),
  getters: {
    getById: (state) => (pkgId) => {
      return state.packages.find((pkg) => pkg.id === pkgId);
    },
    isShared: (state) => (pkgId) => {
      return state.sharedPkgs.some((pkg) => pkg.id === pkgId);
    },
  },
  actions: {
    async insert(data, newId = true) {
      const packageData = {
        ...defaultPackage,
        ...data,
        createdAt: Date.now(),
      };
      if (newId) delete packageData.id;

      const created = await createPackage(packageData);
      const finalPackage = { ...packageData, ...created };

      this.packages.push(finalPackage);
      await this.saveToStorage('packages');
    },
    async update({ id, data, changelog = '' }) {
      const index = this.packages.findIndex((pkg) => pkg.id === id);
      if (index === -1) return null;

      // Optimistic update
      Object.assign(this.packages[index], data);
      await this.saveToStorage('packages');

      try {
        await updatePackageConfig(id, {
          workflow_config: data.workflow_config || data,
          changelog: changelog || 'Update package config',
        });
      } catch (error) {
        console.error('[PackageStore] API update failed:', error);
      }

      return this.packages[index];
    },
    async delete(id) {
      const index = this.packages.findIndex((pkg) => pkg.id === id);
      if (index === -1) return null;

      const data = this.packages[index];

      await apiDeletePackage(id);
      this.packages.splice(index, 1);
      await this.saveToStorage('packages');

      return data;
    },
    deleteShared(id) {
      const index = this.sharedPkgs.findIndex((item) => item.id === id);
      if (index !== -1) this.sharedPkgs.splice(index, 1);
    },
    insertShared(id) {
      this.sharedPkgs.push({ id });
    },
    async loadData(force = false) {
      if (this.retrieved && !force) return this.packages;

      try {
        // 1. Load from local cache first
        const { savedBlocks } =
          await browser.storage.local.get('savedBlocks');
        this.packages = savedBlocks || [];
        this.retrieved = true;

        // 2. Fetch from backend if authenticated
        const authenticated = await isAuthenticated();
        if (!authenticated) return this.packages;

        const apiPackages = await fetchPackages();
        if (Array.isArray(apiPackages) && apiPackages.length > 0) {
          this.packages = apiPackages;
          await this.saveToStorage('packages');
        }

        return this.packages;
      } catch (error) {
        console.error(
          '[PackageStore] Failed to load from API, using cache:',
          error
        );
        this.retrieved = true;
        return this.packages;
      }
    },
    async loadShared() {
      // Shared packages endpoint not available in new API
      this.sharedRetrieved = true;
    },
  },
});
