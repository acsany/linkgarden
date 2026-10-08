<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, state, date, notify } from '../state';
interface Token {
  id: string;
  name: string;
  scope: string;
  expiresAt: string;
  lastUsedAt: string | null;
}
const tokens = ref<Token[]>([]),
  name = ref(''),
  scope = ref('read'),
  days = ref(90),
  error = ref(''),
  busy = ref(false),
  newToken = ref('');
const endpoint = computed(() => state.origin + '/mcp');
async function load() {
  try {
    tokens.value = await api('/api/admin/tokens');
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(load);
async function create() {
  error.value = '';
  busy.value = true;
  newToken.value = '';
  try {
    const t = await api('/api/admin/tokens', {
      method: 'POST',
      body: JSON.stringify({ name: name.value, scope: scope.value, days: days.value }),
    });
    newToken.value = t.token;
    name.value = '';
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function revoke(t: Token) {
  try {
    await api('/api/admin/tokens/' + t.id, { method: 'DELETE' });
    newToken.value = '';
    notify('Agent token revoked.');
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function copy(v: string) {
  try {
    await navigator.clipboard.writeText(v);
    notify('Copied to clipboard.');
  } catch {
    error.value =
      'Your browser could not access the clipboard. Select and copy the value manually.';
  }
}
function toggle() {
  sessionStorage.setItem('browserTools', state.browserTools ? 'on' : 'off');
}
</script>
<template>
  <section class="content agents-content">
    <div class="page-heading">
      <div>
        <div class="eyebrow">A HELPING HAND, ON YOUR TERMS</div>
        <h1>Agent access</h1>
        <p class="muted">Let your agents manage links and read analytics securely.</p>
      </div>
      <span class="private-tag"><Fa icon="shield-halved" /> Admin only</span>
    </div>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <section class="form-panel">
      <div class="section-heading">
        <h2><Fa icon="robot" /> Browser WebMCP</h2>
        <span :class="['badge', state.webmcpStatus === 'connected' ? 'active' : 'inactive']">{{
          state.webmcpStatus
        }}</span>
      </div>
      <p class="muted">
        Browser agents use your signed-in admin session. Tools are exposed only while you’re in the
        admin area and disappear when you sign out.
      </p>
      <label class="checkbox-label"
        ><input type="checkbox" v-model="state.browserTools" @change="toggle" /> Enable browser
        agent tools in this tab</label
      >
      <p v-if="state.webmcpStatus === 'unavailable'" class="info small">
        Your browser does not expose WebMCP yet. Use a browser with WebMCP enabled, or connect
        through the remote MCP endpoint below.
      </p>
      <p class="field-help">
        Available actions: list, read, create, edit, duplicate, activate, archive, edit notes,
        manage icon rules, preview URLs, and read analytics.
      </p>
    </section>
    <section class="form-panel">
      <h2><Fa icon="globe" /> Remote MCP</h2>
      <p class="muted">
        Connect a client that supports Streamable HTTP and bearer tokens. The endpoint supports MCP
        2026-07-28 and compatible 2025 clients.
      </p>
      <label
        >Endpoint
        <div class="copy-field">
          <input :value="endpoint" readonly /><button
            @click="copy(endpoint)"
            aria-label="Copy MCP endpoint"
          >
            <Fa icon="copy" />
          </button></div
      ></label>
      <p class="field-help">
        Send <code>Authorization: Bearer &lt;your-token&gt;</code>. Tokens are independent of your
        login, expire automatically, and can be revoked below.
      </p>
      <div class="info small">
        <Fa icon="shield-halved" /> For local use, keep the default loopback binding and connect to
        <code>http://localhost:3000/mcp</code>. No agent tools are accessible without
        authentication.
      </div>
    </section>
    <section class="form-panel">
      <h2><Fa icon="key" /> Create an agent token</h2>
      <form @submit.prevent="create">
        <div class="token-form">
          <label
            >Name<input
              v-model="name"
              required
              maxlength="100"
              placeholder="e.g. My local assistant" /></label
          ><label
            >Access<select v-model="scope">
              <option value="read">Read only</option>
              <option value="write">Read and write</option>
            </select></label
          ><label
            >Expires in<select v-model.number="days">
              <option :value="7">7 days</option>
              <option :value="30">30 days</option>
              <option :value="90">90 days</option>
              <option :value="365">365 days</option>
            </select></label
          ><button class="primary" :disabled="busy"><Fa icon="plus" /> Create token</button>
        </div>
      </form>
      <div v-if="newToken" class="token-result" role="status">
        <strong>Copy this token now. It will only be shown once.</strong>
        <div class="copy-field">
          <input :value="newToken" readonly aria-label="New agent token" /><button
            @click="copy(newToken)"
            aria-label="Copy agent token"
          >
            <Fa icon="copy" />
          </button>
        </div>
        <button class="text-button" @click="newToken = ''">I’ve saved it — hide token</button>
      </div>
    </section>
    <section class="pages-panel">
      <div class="panel-toolbar">
        <h2 class="panel-title">Your agent tokens</h2>
        <span class="muted small">{{ tokens.length }} tokens</span>
      </div>
      <div v-if="!tokens.length" class="empty compact">
        <Fa icon="key" />
        <p class="muted">No tokens yet. Remote access is disabled until you create one.</p>
      </div>
      <div v-else class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Access</th>
              <th>Expires</th>
              <th>Last used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in tokens" :key="t.id">
              <td>
                <strong>{{ t.name }}</strong>
              </td>
              <td>{{ t.scope === 'read' ? 'Read only' : 'Read and write' }}</td>
              <td class="small nowrap">{{ date(t.expiresAt) }}</td>
              <td class="muted small">{{ t.lastUsedAt ? date(t.lastUsedAt) : 'Never' }}</td>
              <td>
                <button class="danger-button" @click="revoke(t)"><Fa icon="trash" /> Revoke</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </section>
</template>
