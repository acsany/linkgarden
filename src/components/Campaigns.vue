<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api, count, date, notify } from '../state';
import type { Campaign, Status } from '../types';
const campaigns = ref<Campaign[]>([]),
  loading = ref(true),
  error = ref(''),
  query = ref(''),
  filter = ref<'all' | Status>('all'),
  busy = ref('');
const shown = computed(() =>
  campaigns.value.filter(
    (c) =>
      (filter.value === 'all' ? c.status !== 'archived' : c.status === filter.value) &&
      [c.name, c.code, c.note].some((v) => v.toLowerCase().includes(query.value.toLowerCase())),
  ),
);
const totals = computed(() => ({
  visits: campaigns.value.reduce((n, c) => n + c.visits, 0),
  clicks: campaigns.value.reduce((n, c) => n + c.clicks, 0),
  active: campaigns.value.filter((c) => c.status === 'active').length,
}));
async function load() {
  error.value = '';
  try {
    campaigns.value = await api('/api/admin/campaigns');
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
async function setStatus(c: Campaign, status: Status) {
  busy.value = c.id;
  try {
    await api('/api/admin/campaigns/' + c.id + '/status', {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    notify(
      status === 'active'
        ? 'Campaign activated.'
        : status === 'archived'
          ? 'Campaign archived.'
          : 'Campaign deactivated.',
    );
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
        <div class="eyebrow">ONE PAGE, MANY RECIPIENTS</div>
        <h1>
          Campaigns<span class="heading-count">{{
            campaigns.filter((c) => c.status !== 'archived').length
          }}</span>
        </h1>
        <p class="muted">
          Give every recipient their own URL for a page and see who opened it, without copying the
          page.
        </p>
      </div>
      <RouterLink to="/admin/campaigns/new" class="button primary"
        ><Fa icon="plus" /> New campaign</RouterLink
      >
    </div>
    <div class="stats-grid">
      <article class="stat-card">
        <div class="stat-label">
          Campaign visits <span class="stat-icon purple"><Fa icon="eye" /></span>
        </div>
        <div class="stat-value">{{ count(totals.visits) }}</div>
        <span class="stat-foot">Also counted in page totals</span>
      </article>
      <article class="stat-card">
        <div class="stat-label">
          Campaign clicks
          <span class="stat-icon blue"><Fa icon="arrow-up-right-from-square" /></span>
        </div>
        <div class="stat-value">{{ count(totals.clicks) }}</div>
        <span class="stat-foot">Links, PDFs, and videos</span>
      </article>
      <article class="stat-card">
        <div class="stat-label">
          Active campaigns <span class="stat-icon green-bg"><Fa icon="circle-check" /></span>
        </div>
        <div class="stat-value">{{ count(totals.active) }}</div>
        <span class="stat-foot">Their URLs work</span>
      </article>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="pages-panel">
      <div class="panel-toolbar">
        <div class="tabs">
          <button :class="{ active: filter === 'all' }" @click="filter = 'all'">All</button
          ><button :class="{ active: filter === 'active' }" @click="filter = 'active'">
            Active</button
          ><button :class="{ active: filter === 'inactive' }" @click="filter = 'inactive'">
            Inactive</button
          ><button :class="{ active: filter === 'archived' }" @click="filter = 'archived'">
            Archived
          </button>
        </div>
        <label class="search"
          ><Fa icon="magnifying-glass" /><input
            v-model="query"
            placeholder="Search campaigns or notes"
            aria-label="Search campaigns or notes"
        /></label>
      </div>
      <div v-if="loading" class="empty">
        <Fa icon="spinner" spin />
        <p>Loading your campaigns…</p>
      </div>
      <div v-else-if="!shown.length" class="empty">
        <span class="empty-icon"
          ><Fa :icon="filter === 'archived' ? 'box-archive' : 'paper-plane'"
        /></span>
        <h2>
          {{
            query
              ? 'No matching campaigns'
              : filter === 'archived'
                ? 'No archived campaigns'
                : 'Track who opens your pages'
          }}
        </h2>
        <p class="muted">
          {{
            query
              ? 'Try a different name, code, or private note.'
              : filter === 'archived'
                ? 'Archived campaigns keep their analytics and can be restored.'
                : 'Create a campaign per recipient, like a company you apply to, and assign your pages.'
          }}
        </p>
        <RouterLink
          v-if="!query && filter !== 'archived'"
          to="/admin/campaigns/new"
          class="button primary"
          ><Fa icon="plus" /> Create a campaign</RouterLink
        >
      </div>
      <div v-else class="table-scroll page-list-scroll">
        <table class="pages-table">
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Status</th>
              <th>Visits</th>
              <th>Clicks</th>
              <th><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in shown" :key="c.id">
              <td class="page-cell">
                <div class="page-symbol"><Fa icon="paper-plane" /></div>
                <div class="page-info">
                  <RouterLink :to="'/admin/campaigns/' + c.id" class="page-title">{{
                    c.name
                  }}</RouterLink>
                  <div class="short-url">
                    <span>/{{ c.pages.length === 1 ? c.pages[0].slug : '…' }}/{{ c.code }}</span
                    ><span class="mode-label">{{
                      c.pages.length === 1 ? '1 page' : c.pages.length + ' pages'
                    }}</span
                    ><span v-if="c.lastVisitAt" class="mode-label"
                      >Last visit {{ date(c.lastVisitAt) }}</span
                    >
                  </div>
                  <p v-if="c.note" class="note-preview"><Fa icon="note-sticky" /> {{ c.note }}</p>
                </div>
              </td>
              <td class="status-cell" data-label="Status">
                <span :class="['badge', c.status]"><span class="dot"></span>{{ c.status }}</span>
              </td>
              <td class="metric" data-label="Visits">{{ count(c.visits) }}</td>
              <td class="metric" data-label="Clicks">{{ count(c.clicks) }}</td>
              <td class="actions">
                <RouterLink
                  :to="'/admin/campaigns/' + c.id"
                  class="icon-button"
                  title="Edit campaign"
                  aria-label="Edit campaign"
                  ><Fa icon="pen" /><span class="mobile-action-label"
                    >Edit & stats</span
                  ></RouterLink
                >
                <details class="action-menu">
                  <summary class="icon-button" aria-label="More actions">
                    <Fa icon="ellipsis" />
                  </summary>
                  <div class="menu">
                    <button
                      :disabled="busy === c.id"
                      @click="setStatus(c, c.status === 'active' ? 'inactive' : 'active')"
                    >
                      <Fa :icon="c.status === 'active' ? 'circle-pause' : 'circle-check'" />
                      {{ c.status === 'active' ? 'Deactivate' : 'Activate / restore' }}</button
                    ><button
                      v-if="c.status !== 'archived'"
                      :disabled="busy === c.id"
                      @click="setStatus(c, 'archived')"
                    >
                      <Fa icon="box-archive" /> Archive
                    </button>
                  </div>
                </details>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="panel-footer">
        <span>{{ shown.length }} {{ shown.length === 1 ? 'campaign' : 'campaigns' }}</span
        ><span><Fa icon="shield-halved" /> Names and notes are private; only codes are public</span>
      </div>
    </div>
  </section>
</template>
