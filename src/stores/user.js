import { cacheApi, fetchApi } from '@/utils/api';
import { logout as authLogout, isAuthenticated } from '@/utils/auth';
import { defineStore } from 'pinia';
import browser from 'webextension-polyfill';

export const useUserStore = defineStore('user', {
  state: () => ({
    user: null,
    backupIds: [],
    retrieved: false,
    hostedWorkflows: {},
    sharedPackages: [],
  }),
  getters: {
    getHostedWorkflows: (state) => Object.values(state.hostedWorkflows),
    validateTeamAccess:
      (state) =>
      (teamId, access = []) => {
        const currentTeam = state.user?.teams?.find(
          ({ id }) => teamId === id || +teamId === id
        );
        if (!currentTeam) return false;

        return access.some((item) => currentTeam.access.includes(item));
      },
  },
  actions: {
    async logout() {
      await authLogout();
      this.user = null;
      this.backupIds = [];
      this.hostedWorkflows = {};
      this.sharedPackages = [];
      this.retrieved = false;
    },
    async loadUser(options = false) {
      try {
        const user = await cacheApi(
          'user-profile',
          async () => {
            try {
              const authed = await isAuthenticated();
              if (!authed) return null;

              const response = await fetchApi('/api/v1/iam/users/me', {
                auth: true,
              });
              const result = await response.json();

              if (!response.ok) throw new Error(response.message);

              return result;
            } catch (error) {
              console.error(error);
              return null;
            }
          },
          options
        );

        const username = localStorage.getItem('username');
        if (!user || username !== user.username) {
          sessionStorage.removeItem('shared-workflows');
          sessionStorage.removeItem('user-workflows');
          sessionStorage.removeItem('backup-workflows');

          await browser.storage.local.remove([
            'backupIds',
            'lastSync',
            'lastBackup',
          ]);

          if (!user) {
            this.retrieved = true;
            return;
          }
        }

        localStorage.setItem('username', user?.username);

        const { backupIds } = await browser.storage.local.get('backupIds');
        this.backupIds = backupIds || [];

        this.user = user;
        this.retrieved = true;

        if (user) {
          await browser.storage.local.set({ user });
        } else {
          await browser.storage.local.remove('user');
        }
      } catch (error) {
        this.retrieved = true;
        console.error(error);
      }
    },
  },
});
