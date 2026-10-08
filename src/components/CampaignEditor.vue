<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, state, notify, count, date } from '../state';
import type { Campaign, CampaignAnalytics, Site } from '../types';
import CopyButton from './CopyButton.vue';
import { pwaState } from '../pwa';
const route = useRoute(),
  router = useRouter();
const isNew = computed(() => route.params.id === undefined);
const form = reactive({
  name: '',
  code: '',
  note: '',
  status: 'active' as Campaign['status'],
  sites: [] as string[],
});
const campaign = ref<Campaign | null>(null),
  stats = ref<CampaignAnalytics | null>(null),
  sites = ref<Site[]>([]),
  addSite = ref(''),
  days = ref(30),
  offset = ref(0),
  error = ref(''),
  loading = ref(!isNew.value),
  saving = ref(false);
const initial = ref('');
const changed = computed(() => initial.value !== JSON.stringify(form));
const originalCode = computed(() => campaign.value?.code || '');
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function regenerate() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  form.code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
const siteById = computed(() => new Map(sites.value.map((s) => [s.id, s])));
const assigned = computed(() => form.sites.flatMap((id) => siteById.value.get(id) ?? []));
const available = computed(() =>
  sites.value.filter((s) => !form.sites.includes(s.id) && s.status !== 'archived'),
);
// Lifetime numbers per page, including pages the campaign was removed from.
const pageStats = computed(() => new Map(campaign.value?.pages.map((p) => [p.id, p]) ?? []));
// Campaign URLs exist only for saved assignments.
const saved = (id: string) => !!pageStats.value.get(id)?.assigned;
const url = (slug: string) => `${state.origin}/${slug}/${originalCode.value}`;
function fill(c: Campaign) {
  campaign.value = c;
  Object.assign(form, {
    name: c.name,
    code: c.code,
    note: c.note,
    status: c.status,
    sites: c.pages.filter((p) => p.assigned).map((p) => p.id),
  });
  initial.value = JSON.stringify(form);
}
async function loadStats() {
  if (isNew.value) return;
  try {
    stats.value = await api(
      `/api/admin/campaigns/${route.params.id}/analytics?days=${days.value}&offset=${offset.value}`,
    );
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function load() {
  error.value = '';
  try {
    sites.value = await api('/api/admin/sites');
    if (isNew.value) {
      initial.value = JSON.stringify(form);
      return;
    }
    fill(await api<Campaign>('/api/admin/campaigns/' + route.params.id));
    await loadStats();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
async function refresh() {
  if (isNew.value || changed.value) return;
  fill(await api<Campaign>('/api/admin/campaigns/' + route.params.id));
  await loadStats();
}
function beforeUnload(e: BeforeUnloadEvent) {
  if (changed.value) {
    e.preventDefault();
    e.returnValue = '';
  }
}
onMounted(() => {
  load();
  window.addEventListener('beforeunload', beforeUnload);
  window.addEventListener('linkgarden:changed', refresh);
});
onUnmounted(() => {
  window.removeEventListener('beforeunload', beforeUnload);
  window.removeEventListener('linkgarden:changed', refresh);
});
watch(days, () => {
  offset.value = 0;
  loadStats();
});
async function page(delta: number) {
  offset.value = Math.max(0, offset.value + delta * 100);
  await loadStats();
}
function assign() {
  if (addSite.value && !form.sites.includes(addSite.value)) form.sites.push(addSite.value);
  addSite.value = '';
}
async function save() {
  error.value = '';
  saving.value = true;
  try {
    const payload = { ...form, code: form.code.trim() || undefined };
    const c = await api<Campaign>(
      isNew.value ? '/api/admin/campaigns' : '/api/admin/campaigns/' + route.params.id,
      { method: isNew.value ? 'POST' : 'PATCH', body: JSON.stringify(payload) },
    );
    fill(c);
    notify(isNew.value ? 'Your campaign is ready.' : 'Campaign saved.');
    if (isNew.value) router.replace('/admin/campaigns/' + c.id);
    else await loadStats();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <section class="content editor-content">
    <RouterLink to="/admin/campaigns" class="back-link"
      ><Fa icon="arrow-left" /> Back to campaigns</RouterLink
    >
    <div class="page-heading">
      <div>
        <div class="eyebrow">{{ isNew ? 'A URL FOR EVERY RECIPIENT' : 'CAMPAIGN' }}</div>
        <h1>{{ isNew ? 'Create a campaign' : campaign?.name || 'Campaign' }}</h1>
        <p class="muted">
          Assign pages to give this recipient their own URL for each. Name and note stay private.
        </p>
      </div>
    </div>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <div v-if="loading" class="empty"><Fa icon="spinner" spin /> Loading campaign…</div>
    <template v-else>
      <form @submit.prevent="save" class="editor-form">
        <section class="form-panel">
          <h2><Fa icon="paper-plane" /> Campaign details</h2>
          <label
            >Name<input
              v-model="form.name"
              required
              maxlength="200"
              placeholder="e.g. Example Company"
          /></label>
          <p class="field-help">Only you and your agents see the name.</p>
          <label
            >Code
            <div class="url-field">
              <span>{{ state.origin.replace(/^https?:\/\//, '') }}/&lt;page&gt;/</span
              ><input
                v-model="form.code"
                maxlength="64"
                pattern="[A-Za-z0-9_-]+"
                placeholder="Auto-generated"
                aria-label="Campaign code"
              /></div
          ></label>
          <div class="code-actions">
            <p class="field-help">
              Leave blank for 5 random, case-sensitive letters and digits. The code is visible in
              the URL.
            </p>
            <button type="button" @click="regenerate"><Fa icon="rotate" /> Regenerate</button>
          </div>
          <p v-if="originalCode && form.code !== originalCode" class="info small">
            <Fa icon="link" /> URLs you already shared with …/{{ originalCode }} will stop working
            when you save.
          </p>
          <label
            >Private note<textarea
              v-model="form.note"
              rows="3"
              maxlength="10000"
              placeholder="Role, contact person, date sent…"
            ></textarea>
          </label>
          <label
            >Status<select v-model="form.status" aria-label="Status">
              <option value="active">Active — campaign URLs work</option>
              <option value="inactive">Inactive — campaign URLs disabled</option>
              <option value="archived">Archived — disabled and moved to archive</option>
            </select></label
          >
          <p class="field-help">
            Disabled campaign URLs show the page without attribution, or “Page unavailable” on pages
            that are only reachable through campaign links.
          </p>
        </section>
        <section class="form-panel">
          <div class="section-heading">
            <h2><Fa icon="link" /> Pages</h2>
            <span class="muted small">{{ form.sites.length }} assigned</span>
          </div>
          <p v-if="!assigned.length" class="muted small">Assign a page to get its campaign URL.</p>
          <ul class="campaign-pages">
            <li v-for="s in assigned" :key="s.id">
              <div class="campaign-page-info">
                <RouterLink :to="'/admin/sites/' + s.id + '/edit'" class="page-title">{{
                  s.title
                }}</RouterLink>
                <span v-if="saved(s.id)" class="url-break small">{{ url(s.slug) }}</span
                ><span v-else class="muted small">URL available after saving</span>
                <span class="muted small"
                  ><span :class="['badge', s.status]">{{ s.status }}</span>
                  <template v-if="s.campaignOnly">
                    · <Fa icon="lock" /> campaign links only</template
                  >
                  <template v-if="pageStats.get(s.id)">
                    · {{ count(pageStats.get(s.id)!.visits) }} visits ·
                    {{ count(pageStats.get(s.id)!.clicks) }} clicks</template
                  ></span
                >
              </div>
              <div class="row-actions">
                <CopyButton v-if="saved(s.id)" :url="url(s.slug)" compact /><button
                  type="button"
                  class="icon-button"
                  :aria-label="'Remove ' + s.title"
                  @click="form.sites = form.sites.filter((id) => id !== s.id)"
                >
                  <Fa icon="trash" />
                </button>
              </div>
            </li>
          </ul>
          <div class="add-page">
            <select v-model="addSite" aria-label="Page to assign" @change="assign">
              <option value="">Assign a page…</option>
              <option v-for="s in available" :key="s.id" :value="s.id">
                {{ s.title }} (/{{ s.slug }})
              </option>
            </select>
          </div>
          <p
            v-if="campaign?.pages.some((p) => p.assigned && !form.sites.includes(p.id))"
            class="info small"
          >
            Removed pages stop accepting this campaign's URL when you save. Their analytics stay.
          </p>
        </section>
        <div class="form-actions sticky-actions">
          <RouterLink to="/admin/campaigns" class="button">Cancel</RouterLink
          ><button class="primary" :disabled="saving || !pwaState.online">
            <Fa v-if="saving" icon="spinner" spin /><Fa v-else icon="check" />
            {{ saving ? 'Saving…' : isNew ? 'Create campaign' : 'Save changes' }}
          </button>
        </div>
      </form>
      <template v-if="campaign && stats">
        <div class="section-heading campaign-stats-heading">
          <h2>Analytics</h2>
          <select v-model.number="days" aria-label="Analytics period">
            <option :value="7">Last 7 days</option>
            <option :value="30">Last 30 days</option>
            <option :value="90">Last 90 days</option>
            <option :value="365">Last year</option>
          </select>
        </div>
        <div class="stats-grid">
          <article class="stat-card">
            <div class="stat-label">
              Visits <span class="stat-icon purple"><Fa icon="eye" /></span>
            </div>
            <div class="stat-value">{{ count(campaign.visits) }}</div>
            <span class="stat-foot">All time, across pages</span>
          </article>
          <article class="stat-card">
            <div class="stat-label">
              Clicks <span class="stat-icon blue"><Fa icon="arrow-up-right-from-square" /></span>
            </div>
            <div class="stat-value">{{ count(campaign.clicks) }}</div>
            <span class="stat-foot">Links, PDFs, and videos</span>
          </article>
          <article class="stat-card">
            <div class="stat-label">
              Last visit <span class="stat-icon green-bg"><Fa icon="chart-simple" /></span>
            </div>
            <div class="stat-value stat-date">
              {{ campaign.lastVisitAt ? date(campaign.lastVisitAt) : '—' }}
            </div>
            <span class="stat-foot">Mail scanners may open links right after sending</span>
          </article>
        </div>
        <section class="pages-panel">
          <div class="panel-toolbar">
            <h2 class="panel-title">By page</h2>
            <span class="muted small">Lifetime totals</span>
          </div>
          <div v-if="!campaign.pages.length" class="empty compact">
            <p class="muted">No pages yet.</p>
          </div>
          <div v-else class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Page</th>
                  <th>Visits</th>
                  <th>Clicks</th>
                  <th>Last visit (UTC)</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in campaign.pages" :key="p.id">
                  <td>
                    <strong>{{ p.title }}</strong>
                    <span v-if="!p.assigned" class="muted small"> · removed</span>
                    <details v-if="p.links.length > 1" class="link-breakdown">
                      <summary class="muted small">Clicks by link</summary>
                      <div v-for="l in p.links" :key="l.id" class="small">
                        <Fa :icon="l.kind === 'file' ? 'file-pdf' : 'link'" /> {{ l.title }}:
                        {{ count(l.clicks) }}
                      </div>
                    </details>
                  </td>
                  <td class="metric">{{ count(p.visits) }}</td>
                  <td class="metric">{{ count(p.clicks) }}</td>
                  <td class="small nowrap">{{ p.lastVisitAt ? date(p.lastVisitAt) : '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <section class="pages-panel">
          <div class="panel-toolbar">
            <h2 class="panel-title">Recent activity</h2>
            <span class="muted small">{{ count(stats.totalEvents) }} events in this period</span>
          </div>
          <div v-if="!stats.events.length" class="empty compact">
            <Fa icon="chart-simple" />
            <p class="muted">No visits or clicks in this period yet.</p>
          </div>
          <div v-else class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When (UTC)</th>
                  <th>Event</th>
                  <th>Page</th>
                  <th>Link / action</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="e in stats.events" :key="e.id">
                  <td class="small nowrap">{{ date(e.at) }}</td>
                  <td>
                    <span :class="['event-badge', e.kind]"
                      ><Fa :icon="e.kind === 'visit' ? 'eye' : 'arrow-up-right-from-square'" />
                      {{ e.kind }}</span
                    >
                  </td>
                  <td>{{ e.siteTitle }}</td>
                  <td>
                    {{ e.kind === 'visit' ? 'Page visit' : e.title || 'Removed link'
                    }}<span v-if="e.kind === 'click'" class="muted small"> · {{ e.target }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="panel-footer">
            <span>Detailed events are kept for 365 days.</span>
            <div class="pagination">
              <button :disabled="offset === 0" @click="page(-1)">Previous</button
              ><span
                >{{ stats.totalEvents ? offset + 1 : 0 }}–{{
                  Math.min(offset + stats.events.length, stats.totalEvents)
                }}</span
              ><button :disabled="offset + 100 >= stats.totalEvents" @click="page(1)">Next</button>
            </div>
          </div>
        </section>
      </template>
    </template>
  </section>
</template>
