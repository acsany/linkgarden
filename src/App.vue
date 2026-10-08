<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, state, refreshSession, notify } from './state';
import { installWebMcp } from './webmcp';
import InstallButton from './components/InstallButton.vue';
import { pwaState, refreshPwa } from './pwa';
const route = useRoute(),
  router = useRouter();
const isAdmin = computed(() => route.path === '/admin' || route.path.startsWith('/admin/'));
watch(isAdmin, (v) => (state.adminContext = v), { immediate: true });
const email = ref(''),
  password = ref(''),
  error = ref(''),
  busy = ref(false);
onMounted(async () => {
  try {
    await refreshSession();
    installWebMcp();
  } catch (e) {
    error.value = (e as Error).message;
  }
});
async function signIn() {
  busy.value = true;
  error.value = '';
  try {
    const s = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: email.value, password: password.value }),
    });
    Object.assign(state, s, { authenticated: true });
    password.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
    state.authenticated = false;
    state.csrfToken = '';
    router.push('/admin');
  } catch (e) {
    notify((e as Error).message);
  }
}
</script>
<template>
  <div v-if="!isAdmin"><RouterView /></div>
  <div v-else-if="!state.ready" class="loading">
    <Fa icon="spinner" spin /> Loading your workspace…
  </div>
  <main v-else-if="!state.authenticated" class="login-wrap">
    <div class="login-card">
      <div class="brand">
        <span class="brand-icon"><Fa icon="leaf" /></span> linkgarden
      </div>
      <h1>Your links, in one place.</h1>
      <p class="muted">Sign in to your private workspace.</p>
      <div v-if="!state.configured" class="info">
        <Fa icon="shield-halved" /> Set up your admin account locally with
        <code>npm run admin:setup</code>, then restart the app. On Render, set the admin environment
        variables described in the README.
      </div>
      <form v-else @submit.prevent="signIn">
        <label
          >Email<input
            v-model="email"
            type="email"
            required
            autocomplete="username"
            placeholder="you@example.com" /></label
        ><label
          >Password<input
            v-model="password"
            type="password"
            required
            autocomplete="current-password"
        /></label>
        <p v-if="error" role="alert" class="error">{{ error }}</p>
        <button class="primary full" :disabled="busy">
          <Fa v-if="busy" icon="spinner" spin /> Sign in <Fa icon="arrow-right" />
        </button>
      </form>
      <p class="login-foot">
        <Fa icon="shield-halved" /> Private admin · authenticated agent access
      </p>
      <InstallButton />
    </div>
  </main>
  <div v-else class="shell">
    <aside class="sidebar">
      <div class="brand-row">
        <RouterLink to="/admin" class="brand"
          ><span class="brand-icon"><Fa icon="leaf" /></span> linkgarden</RouterLink
        >
        <div class="mobile-account">
          <InstallButton /><button
            class="icon-button"
            aria-label="Sign out"
            title="Sign out"
            @click="logout"
          >
            <Fa icon="arrow-right-from-bracket" />
          </button>
        </div>
      </div>
      <div class="workspace-label">YOUR WORKSPACE</div>
      <nav>
        <RouterLink
          to="/admin"
          :class="{ selected: route.path === '/admin' || route.path.includes('/sites/') }"
          ><Fa icon="link" /> Pages</RouterLink
        ><RouterLink
          to="/admin/campaigns"
          :class="{ selected: route.path.startsWith('/admin/campaigns') }"
          ><Fa icon="paper-plane" /> Campaigns</RouterLink
        ><RouterLink to="/admin/archived" :class="{ selected: route.path === '/admin/archived' }"
          ><Fa icon="box-archive" /> Archived</RouterLink
        ><RouterLink
          to="/admin/icon-rules"
          :class="{ selected: route.path === '/admin/icon-rules' }"
          ><Fa icon="icons" /> Icon rules</RouterLink
        ><RouterLink to="/admin/agents" :class="{ selected: route.path === '/admin/agents' }"
          ><Fa icon="robot" /> Agent access</RouterLink
        >
      </nav>
      <div class="sidebar-bottom">
        <div class="agent-indicator">
          <span :class="['dot', { green: state.webmcpStatus === 'connected' }]"></span
          >{{
            state.webmcpStatus === 'connected' ? 'Browser tools connected' : 'Private workspace'
          }}
        </div>
        <div class="account">
          <span class="avatar">{{ state.email.charAt(0).toUpperCase() }}</span
          ><span class="account-email">{{ state.email }}</span
          ><button class="icon-button" aria-label="Sign out" title="Sign out" @click="logout">
            <Fa icon="arrow-right-from-bracket" />
          </button>
        </div>
      </div>
    </aside>
    <main class="main">
      <div class="topbar">
        <span
          >WORKSPACE <span class="topbar-divider">/</span>
          <span class="topbar-current">{{
            route.path.includes('agents')
              ? 'Agent access'
              : route.path.includes('icon-rules')
                ? 'Icon rules'
                : route.path.startsWith('/admin/campaigns')
                  ? 'Campaigns'
                  : route.path.includes('analytics')
                    ? 'Analytics'
                    : route.path.includes('archived')
                      ? 'Archived'
                      : 'Pages'
          }}</span></span
        >
        <div class="topbar-tools">
          <InstallButton /><span class="private-tag"><Fa icon="shield-halved" /> Only you</span>
        </div>
      </div>
      <div v-if="!pwaState.online" class="connection-banner" role="status">
        <Fa icon="globe" /> You're offline. Reconnect to load pages and save changes.
      </div>
      <div v-if="pwaState.updateAvailable" class="connection-banner update-banner" role="status">
        <span
          ><Fa icon="rotate" /> A new version is ready. Save your changes before refreshing.</span
        ><button :disabled="!pwaState.online" @click="refreshPwa">Refresh app</button>
      </div>
      <RouterView :key="route.path" />
    </main>
  </div>
  <div v-if="state.notice" class="toast" role="status">
    <Fa icon="circle-check" /> {{ state.notice
    }}<button class="icon-button" @click="state.notice = ''" aria-label="Dismiss">
      <Fa icon="xmark" />
    </button>
  </div>
</template>
