<template>
  <div class="flex min-h-screen items-center justify-center">
    <ui-card padding="p-8" class="w-full max-w-md">
      <div class="mb-6 text-center">
        <img src="@/assets/svg/logo.svg" class="mx-auto h-12 w-12" />
        <h1 class="mt-4 text-2xl font-semibold">Automa</h1>
        <p class="mt-2 text-gray-600 dark:text-gray-300">
          {{ t('auth.signIn') }}
        </p>
      </div>

      <div
        v-if="state.error"
        class="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400"
      >
        {{ state.error }}
      </div>

      <form @submit.prevent="handleLogin">
        <label class="mb-1 block text-sm text-gray-600 dark:text-gray-300">
          Email
        </label>
        <ui-input
          v-model="state.email"
          type="email"
          placeholder="email@example.com"
          autocomplete="email"
          class="mb-4 w-full"
          autofocus
        />
        <label class="mb-1 block text-sm text-gray-600 dark:text-gray-300">
          {{ t('auth.password') }}
        </label>
        <ui-input
          v-model="state.password"
          type="password"
          placeholder="Password"
          autocomplete="current-password"
          class="mb-4 w-full"
        />
        <label class="flex items-center gap-2 mb-6 cursor-pointer">
          <input
            v-model="state.rememberMe"
            type="checkbox"
            class="h-4 w-4 rounded border-gray-300 text-accent focus:ring-accent"
          />
          <span class="text-sm text-gray-600 dark:text-gray-300">
            {{ t('auth.rememberMe') }}
          </span>
        </label>
        <ui-button variant="accent" class="w-full" :loading="state.loading">
          {{ t('auth.signIn') }}
        </ui-button>
      </form>
    </ui-card>
  </div>
</template>
<script setup>
import { onMounted, reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import browser from 'webextension-polyfill';
import { login } from '@/utils/auth';
import { useUserStore } from '@/stores/user';
import { useWorkflowStore } from '@/stores/workflow';

const SAVED_CREDENTIALS_KEY = 'savedCredentials';

const { t } = useI18n();
const router = useRouter();
const userStore = useUserStore();
const workflowStore = useWorkflowStore();

const state = reactive({
  email: '',
  password: '',
  error: '',
  loading: false,
  rememberMe: false,
});

onMounted(async () => {
  const { [SAVED_CREDENTIALS_KEY]: saved } = await browser.storage.local.get(
    SAVED_CREDENTIALS_KEY
  );
  if (saved) {
    state.email = saved.email || '';
    state.password = saved.password || '';
    state.rememberMe = true;
  }
});

async function handleLogin() {
  state.loading = true;
  state.error = '';

  // Step 1: Login
  let session;
  try {
    session = await login(state.email, state.password);
  } catch (error) {
    console.error('[Login] Step 1 FAILED:', error);
    state.error = error.message || t('auth.loginFailed');
    state.loading = false;
    return;
  }

  // Step 2: Save credentials (non-critical)
  try {
    if (state.rememberMe) {
      await browser.storage.local.set({
        [SAVED_CREDENTIALS_KEY]: {
          email: state.email,
          password: state.password,
        },
      });
    } else {
      await browser.storage.local.remove(SAVED_CREDENTIALS_KEY);
    }
  } catch (e) {
    console.error('[Login] Step 2 FAILED:', e);
  }

  // Step 3: Set user in store for immediate UI update
  if (session.user) {
    userStore.user = session.user;
  }

  // Step 4: Redirect immediately
  router.replace('/workflows');
  state.loading = false;

  // Step 5: Load full data in background (after redirect)
  Promise.allSettled([userStore.loadUser(false), workflowStore.loadData()]);
}
</script>
