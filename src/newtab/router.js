import { createRouter, createWebHashHistory } from 'vue-router';
import { isAuthenticated } from '@/utils/auth';
import Welcome from './pages/Welcome.vue';
import Login from './pages/Login.vue';
import Packages from './pages/Packages.vue';
import Workflows from './pages/workflows/index.vue';
import WorkflowContainer from './pages/Workflows.vue';
import WorkflowHost from './pages/workflows/Host.vue';
import WorkflowDetails from './pages/workflows/[id].vue';
import WorkflowShared from './pages/workflows/Shared.vue';
import ScheduledWorkflow from './pages/ScheduledWorkflow.vue';
import Storage from './pages/Storage.vue';
import StorageTables from './pages/storage/Tables.vue';
import LogsDetails from './pages/logs/[id].vue';
import Recording from './pages/Recording.vue';
import Settings from './pages/Settings.vue';
import SettingsIndex from './pages/settings/SettingsIndex.vue';
import SettingsAbout from './pages/settings/SettingsAbout.vue';
import SettingsShortcuts from './pages/settings/SettingsShortcuts.vue';
import SettingsBackup from './pages/settings/SettingsBackup.vue';
import SettingsEditor from './pages/settings/SettingsEditor.vue';

const routes = [
  {
    name: 'home',
    path: '/',
    redirect: '/workflows',
    component: Workflows,
  },
  {
    name: 'login',
    path: '/login',
    component: Login,
    meta: { requiresAuth: false },
  },
  {
    name: 'welcome',
    path: '/welcome',
    component: Welcome,
    meta: { requiresAuth: false },
  },
  {
    name: 'packages',
    path: '/packages',
    component: Packages,
  },
  {
    name: 'recording',
    path: '/recording',
    component: Recording,
    meta: { requiresAuth: false },
  },
  {
    name: 'packages-details',
    path: '/packages/:id',
    component: WorkflowDetails,
  },
  {
    path: '/workflows',
    component: WorkflowContainer,
    children: [
      {
        path: '',
        name: 'workflows',
        component: Workflows,
      },
      {
        path: ':id',
        name: 'workflows-details',
        component: WorkflowDetails,
      },
      {
        name: 'team-workflows',
        path: '/teams/:teamId/workflows/:id',
        component: WorkflowDetails,
      },
      {
        name: 'workflow-host',
        path: '/workflows/:id/host',
        component: WorkflowHost,
      },
      // {
      //   name: 'workflow-shared',
      //   path: '/workflows/:id/shared',
      //   component: WorkflowShared,
      // },
    ],
  },
  {
    name: 'schedule',
    path: '/schedule',
    component: ScheduledWorkflow,
  },
  {
    name: 'storage',
    path: '/storage',
    component: Storage,
  },
  {
    name: 'storage-tables',
    path: '/storage/tables/:id',
    component: StorageTables,
  },
  {
    name: 'logs-details',
    path: '/logs/:id?',
    component: LogsDetails,
  },
  {
    path: '/settings',
    component: Settings,
    children: [
      { path: '', component: SettingsIndex },
      { path: '/about', component: SettingsAbout },
      // { path: '/backup', component: SettingsBackup }, // disabled: backup feature hidden
      { path: '/editor', component: SettingsEditor },
      { path: '/shortcuts', component: SettingsShortcuts },
    ],
  },
];

const router = createRouter({
  routes,
  history: createWebHashHistory(),
});

router.beforeEach(async (to, from, next) => {
  // Routes that don't require auth
  if (to.meta.requiresAuth === false) {
    if (to.name === 'login') {
      const authed = await isAuthenticated();
      if (authed) {
        next('/workflows');
        return;
      }
    }
    next();
    return;
  }

  // All other routes require auth
  const authed = await isAuthenticated();
  if (!authed) {
    next('/login');
    return;
  }

  next();
});

export default router;
