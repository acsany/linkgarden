<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, state, count, date, notify } from '../state';
import type { Site } from '../types';
import CopyButton from './CopyButton.vue';
import CopyMenu from './CopyMenu.vue';
const route = useRoute(),
  router = useRouter();
const archived = computed(() => route.path === '/admin/archived');
const pdfRedirect = (s: Site) => s.mode === 'redirect' && !!s.fileCount;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
function itemsLabel(s: Site) {
  if (s.mode === 'redirect') return pdfRedirect(s) ? 'PDF download' : 'Redirect';
  const files = s.fileCount || 0,
    links = (s.linkCount || 0) - files;
  return [links || !files ? plural(links, 'link') : '', files ? plural(files, 'PDF') : '']
    .filter(Boolean)
    .join(' · ');
}
// The base URL (unless the page is campaign-only) and one URL per active campaign.
const urls = (s: Site) => [
  ...(s.campaignOnly ? [] : [{ label: 'Base URL', url: state.origin + '/' + s.slug }]),
  ...s.campaigns.filter((c) => c.status === 'active').map((c) => ({ label: c.name, url: c.url })),
];
const sites = ref<Site[]>([]),
  loading = ref(true),
  error = ref(''),
  query = ref(''),
  filter = ref('all'),
  busy = ref('');
const noteSite = ref<Site | null>(null),
  note = ref('');
const shown = computed(() =>
  sites.value.filter(
    (s) =>
      (archived.value ? s.status === 'archived' : s.status !== 'archived') &&
      (filter.value === 'all' || s.status === filter.value) &&
      [s.title, s.slug, s.note].some((v) => v.toLowerCase().includes(query.value.toLowerCase())),
  ),
);
const mainSites = computed(() => sites.value.filter((s) => s.status !== 'archived'));
const totals = computed(() => ({
  visits: sites.value.reduce((n, s) => n + s.visits, 0),
  agentVisits: sites.value.reduce((n, s) => n + s.agentVisits, 0),
  clicks: sites.value.reduce((n, s) => n + s.clicks, 0),
  active: sites.value.filter((s) => s.status === 'active').length,
}));
async function load() {
  error.value = '';
  try {
    sites.value = await api('/api/admin/sites');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(() => {
  load();
  window.addEventListener('linkgarden:changed', load);
});
onUnmounted(() => window.removeEventListener('linkgarden:changed', load));
async function setStatus(s: Site, status: Site['status']) {
  busy.value = s.id;
  try {
    await api('/api/admin/sites/' + s.id + '/status', {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    notify(
      status === 'active'
        ? 'Page activated.'
        : status === 'archived'
          ? 'Page archived.'
          : 'Page deactivated.',
    );
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = '';
  }
}
async function duplicate(s: Site) {
  busy.value = s.id;
  try {
    const copy = await api<Site>('/api/admin/sites/' + s.id + '/duplicate', {
      method: 'POST',
      body: '{}',
    });
    notify('Created an inactive copy with fresh analytics.');
    router.push('/admin/sites/' + copy.id + '/edit');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = '';
  }
}
function editNote(s: Site) {
  noteSite.value = s;
  note.value = s.note;
}
async function saveNote() {
  if (!noteSite.value) return;
  busy.value = noteSite.value.id;
  try {
    await api('/api/admin/sites/' + noteSite.value.id + '/note', {
      method: 'PATCH',
      body: JSON.stringify({ note: note.value }),
    });
    noteSite.value = null;
    notify('Private note saved.');
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = '';
  }
}
</script>
<template>
  <section class="content">
    <div class="page-heading">
      <div>
        <div class="eyebrow">
          {{ archived ? 'SAVED FOR LATER' : 'A LITTLE HOME FOR EVERY LINK' }}
        </div>
        <h1>
          {{ archived ? 'Archived pages' : 'Your pages'
          }}<span class="heading-count">{{
            archived ? sites.filter((s) => s.status === 'archived').length : mainSites.length
          }}</span>
        </h1>
        <p class="muted">
          {{
            archived
              ? 'Everything stays here. Restore a page whenever you need it.'
              : 'Short links, link collections, and a clear view of how they’re doing.'
          }}
        </p>
      </div>
      <RouterLink to="/admin/sites/new" class="button primary"
        ><Fa icon="plus" /> New page</RouterLink
      >
    </div>
    <div v-if="!archived" class="stats-grid">
      <article class="stat-card">
        <div class="stat-label">
          Total visits <span class="stat-icon purple"><Fa icon="eye" /></span>
        </div>
        <div class="stat-value">{{ count(totals.visits) }}</div>
        <span class="stat-foot">{{
          totals.agentVisits
            ? `Including ${count(totals.agentVisits)} agent ${totals.agentVisits === 1 ? 'read' : 'reads'}`
            : 'Across all your pages'
        }}</span>
      </article>
      <article class="stat-card">
        <div class="stat-label">
          Link clicks <span class="stat-icon blue"><Fa icon="arrow-up-right-from-square" /></span>
        </div>
        <div class="stat-value">{{ count(totals.clicks) }}</div>
        <span class="stat-foot">A step beyond the page</span>
      </article>
      <article class="stat-card">
        <div class="stat-label">
          Active pages <span class="stat-icon green-bg"><Fa icon="circle-check" /></span>
        </div>
        <div class="stat-value">{{ count(totals.active) }}</div>
        <span class="stat-foot">Live and ready to share</span>
      </article>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="pages-panel">
      <div class="panel-toolbar">
        <div class="tabs" v-if="!archived">
          <button :class="{ active: filter === 'all' }" @click="filter = 'all'">All pages</button
          ><button :class="{ active: filter === 'active' }" @click="filter = 'active'">
            Active</button
          ><button :class="{ active: filter === 'inactive' }" @click="filter = 'inactive'">
            Inactive
          </button>
        </div>
        <span v-else class="panel-title">Your archive</span
        ><label class="search"
          ><Fa icon="magnifying-glass" /><input
            v-model="query"
            placeholder="Search pages or notes"
            aria-label="Search pages or notes"
        /></label>
      </div>
      <div v-if="loading" class="empty">
        <Fa icon="spinner" spin />
        <p>Loading your pages…</p>
      </div>
      <div v-else-if="!shown.length" class="empty">
        <span class="empty-icon"><Fa :icon="archived ? 'box-archive' : 'link'" /></span>
        <h2>
          {{
            query
              ? 'No matching pages'
              : archived
                ? 'Your archive is empty'
                : 'Your first link starts here'
          }}
        </h2>
        <p class="muted">
          {{
            query
              ? 'Try a different title, short URL, or private note.'
              : archived
                ? 'Archived pages keep their links, notes, and analytics.'
                : 'Create a quick redirect or gather your favorite links on one page.'
          }}
        </p>
        <RouterLink v-if="!query && !archived" to="/admin/sites/new" class="button primary"
          ><Fa icon="plus" /> Create a page</RouterLink
        >
      </div>
      <div v-else class="table-scroll page-list-scroll">
        <table class="pages-table">
          <thead>
            <tr>
              <th>Page</th>
              <th>Status</th>
              <th>Visits</th>
              <th>Clicks</th>
              <th><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in shown" :key="s.id">
              <td class="page-cell">
                <div class="page-symbol">
                  <Fa
                    :icon="
                      pdfRedirect(s)
                        ? 'file-pdf'
                        : s.mode === 'redirect'
                          ? 'arrow-up-right-from-square'
                          : 'link'
                    "
                  />
                </div>
                <div class="page-info">
                  <RouterLink :to="'/admin/sites/' + s.id + '/edit'" class="page-title">{{
                    s.title
                  }}</RouterLink>
                  <div class="short-url">
                    <span>/{{ s.slug }}</span
                    ><span
                      v-if="s.campaignOnly"
                      class="campaign-only"
                      title="The base URL is private; only campaign links work."
                      ><Fa icon="lock" /> Campaign links only</span
                    ><CopyMenu :urls="urls(s)" /><span class="mode-label">{{ itemsLabel(s) }}</span>
                  </div>
                  <button class="note-preview" @click="editNote(s)">
                    <Fa icon="note-sticky" /> {{ s.note || 'Add a private note' }}
                  </button>
                </div>
              </td>
              <td class="status-cell" data-label="Status">
                <span :class="['badge', s.status]"><span class="dot"></span>{{ s.status }}</span>
              </td>
              <td class="metric" data-label="Visits">
                <RouterLink :to="'/admin/sites/' + s.id + '/analytics'">{{
                  count(s.visits)
                }}</RouterLink>
                <div
                  v-if="s.agentVisits"
                  class="agent-visits"
                  :title="'Agent reads (Markdown) included in ' + count(s.visits) + ' visits'"
                >
                  <Fa icon="robot" /> {{ count(s.agentVisits) }}
                </div>
              </td>
              <td class="metric" data-label="Clicks">{{ count(s.clicks) }}</td>
              <td class="actions">
                <RouterLink
                  :to="'/admin/sites/' + s.id + '/analytics'"
                  class="icon-button"
                  title="View analytics"
                  aria-label="View analytics"
                  ><Fa icon="chart-simple" /><span class="mobile-action-label"
                    >Analytics</span
                  ></RouterLink
                ><RouterLink
                  :to="'/admin/sites/' + s.id + '/edit'"
                  class="icon-button"
                  title="Edit page"
                  aria-label="Edit page"
                  ><Fa icon="pen" /><span class="mobile-action-label">Edit</span></RouterLink
                >
                <details class="action-menu">
                  <summary class="icon-button" aria-label="More actions">
                    <Fa icon="ellipsis" />
                  </summary>
                  <div class="menu">
                    <a
                      v-if="s.status === 'active' && !s.campaignOnly"
                      :href="'/' + s.slug"
                      target="_blank"
                      rel="noopener"
                      ><Fa icon="arrow-up-right-from-square" /> Open page</a
                    ><CopyButton v-if="!s.campaignOnly" :url="state.origin + '/' + s.slug" /><button
                      :disabled="busy === s.id"
                      @click="duplicate(s)"
                    >
                      <Fa icon="copy" /> Duplicate page</button
                    ><button
                      :disabled="busy === s.id"
                      @click="setStatus(s, s.status === 'active' ? 'inactive' : 'active')"
                    >
                      <Fa :icon="s.status === 'active' ? 'circle-pause' : 'circle-check'" />
                      {{ s.status === 'active' ? 'Deactivate' : 'Activate / restore' }}</button
                    ><button
                      v-if="s.status !== 'archived'"
                      :disabled="busy === s.id"
                      @click="setStatus(s, 'archived')"
                    >
                      <Fa icon="box-archive" /> Archive</button
                    ><button @click="editNote(s)">
                      <Fa icon="note-sticky" /> Edit private note
                    </button>
                  </div>
                </details>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="panel-footer">
        <span>{{ shown.length }} {{ shown.length === 1 ? 'page' : 'pages' }}</span
        ><span><Fa icon="shield-halved" /> Notes are always private</span>
      </div>
    </div>
    <p class="subtle-help">
      <Fa icon="robot" /> Your agents can help keep things organized.
      <RouterLink to="/admin/agents">Connect an agent <Fa icon="arrow-right" /></RouterLink>
    </p>
    <div v-if="noteSite" class="modal-backdrop" @click.self="noteSite = null">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="note-title">
        <div class="modal-heading">
          <h2 id="note-title">Private note</h2>
          <button class="icon-button" @click="noteSite = null" aria-label="Close">
            <Fa icon="xmark" />
          </button>
        </div>
        <p class="muted">Only visible in your admin area and authenticated agent tools.</p>
        <label
          >{{ noteSite.title
          }}<textarea v-model="note" rows="6" maxlength="10000" autofocus></textarea>
        </label>
        <div class="form-actions">
          <button @click="noteSite = null">Cancel</button
          ><button class="primary" :disabled="!!busy" @click="saveNote">Save note</button>
        </div>
      </section>
    </div>
  </section>
</template>
