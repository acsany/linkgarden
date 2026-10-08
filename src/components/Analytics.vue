<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api, count, date, state } from '../state';
import CopyButton from './CopyButton.vue';
import type { Analytics } from '../types';
const route = useRoute(),
  data = ref<Analytics | null>(null),
  days = ref(30),
  campaign = ref(''),
  offset = ref(0),
  loading = ref(true),
  resetting = ref(false),
  error = ref('');
async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await api(
      '/api/admin/sites/' +
        route.params.id +
        '/analytics?days=' +
        days.value +
        '&offset=' +
        offset.value +
        (campaign.value ? '&campaign=' + campaign.value : ''),
    );
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
watch([days, campaign], () => {
  offset.value = 0;
  load();
});
const totals = computed(() => ({
  visits: data.value?.daily.reduce((n, d) => n + d.visits, 0) || 0,
  clicks: data.value?.daily.reduce((n, d) => n + d.clicks, 0) || 0,
}));
const series = computed(() => {
  const today = new Date();
  return Array.from({ length: days.value }, (_, i) => {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - days.value + 1 + i);
    const day = d.toISOString().slice(0, 10);
    return data.value?.daily.find((v) => v.day === day) || { day, visits: 0, clicks: 0 };
  });
});
// Lifetime totals of the whole page or, when filtered, of the chosen campaign on it.
const lifetime = computed(() =>
  campaign.value ? data.value?.campaigns.find((c) => c.id === campaign.value) : data.value?.site,
);
const max = computed(() => Math.max(1, ...series.value.flatMap((d) => [d.visits, d.clicks])));
// For a fresh start before sending a page out, e.g. after checking it in a private window.
async function reset() {
  if (!data.value) return;
  if (
    !window.confirm(
      `Reset all analytics for “${data.value.site.title}”? Visits, clicks, and events are deleted, including this page's campaign totals. This cannot be undone.`,
    )
  )
    return;
  resetting.value = true;
  error.value = '';
  try {
    await api('/api/admin/sites/' + route.params.id + '/reset-stats', {
      method: 'POST',
      body: '{}',
    });
    offset.value = 0;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    resetting.value = false;
  }
}
async function page(delta: number) {
  offset.value = Math.max(0, offset.value + delta * 100);
  await load();
}
</script>
<template>
  <section class="content">
    <RouterLink to="/admin" class="back-link"><Fa icon="arrow-left" /> Back to pages</RouterLink>
    <div class="page-heading">
      <div>
        <div class="eyebrow">FOLLOW THE LITTLE DETAILS</div>
        <h1>{{ data?.site.title || 'Page analytics' }}</h1>
        <p class="muted">
          /{{ data?.site.slug }} <span class="separator">·</span> Visits and clicks, in UTC.
          <template v-if="data?.site.statsResetAt">
            Counting since {{ date(data.site.statsResetAt) }}.</template
          >
        </p>
      </div>
      <div class="heading-actions">
        <CopyButton
          v-if="data && !data.site.campaignOnly"
          :url="state.origin + '/' + data.site.slug"
        />
        <select v-if="data?.campaigns.length" v-model="campaign" aria-label="Campaign">
          <option value="">All traffic</option>
          <option v-for="c in data.campaigns" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <select v-model.number="days" aria-label="Analytics period">
          <option :value="7">Last 7 days</option>
          <option :value="30">Last 30 days</option>
          <option :value="90">Last 90 days</option>
          <option :value="365">Last year</option></select
        ><a class="button" :href="'/api/admin/sites/' + route.params.id + '/events.csv'"
          ><Fa icon="download" /> Export CSV</a
        ><button v-if="data" class="danger-button" :disabled="resetting" @click="reset">
          <Fa icon="rotate" /> Reset counts
        </button>
      </div>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div v-if="loading && !data" class="empty"><Fa icon="spinner" spin /> Loading analytics…</div>
    <template v-if="data"
      ><div class="stats-grid">
        <article class="stat-card">
          <div class="stat-label">
            Visits in this period <span class="stat-icon purple"><Fa icon="eye" /></span>
          </div>
          <div class="stat-value">{{ count(totals.visits) }}</div>
          <span class="stat-foot"
            ><template v-if="data.agentVisits">{{ count(data.agentVisits) }} by agents · </template>
            {{ count(lifetime?.visits || 0) }} all time</span
          >
        </article>
        <article class="stat-card">
          <div class="stat-label">
            Clicks in this period
            <span class="stat-icon blue"><Fa icon="arrow-up-right-from-square" /></span>
          </div>
          <div class="stat-value">{{ count(totals.clicks) }}</div>
          <span class="stat-foot">{{ count(lifetime?.clicks || 0) }} all time</span>
        </article>
        <article class="stat-card">
          <div class="stat-label">
            Clicks per visit <span class="stat-icon green-bg"><Fa icon="chart-simple" /></span>
          </div>
          <div class="stat-value">
            {{ totals.visits ? (totals.clicks / totals.visits).toFixed(2) : '—' }}
          </div>
          <span class="stat-foot">Multiple clicks per visit are possible</span>
        </article>
      </div>
      <section class="form-panel">
        <div class="section-heading">
          <h2>Activity over time</h2>
          <div class="chart-legend">
            <span><i class="legend-dot visits"></i> Visits</span
            ><span><i class="legend-dot clicks"></i> Clicks</span>
          </div>
        </div>
        <div
          :class="['chart', { dense: days > 90 }]"
          role="img"
          :aria-label="'Daily visits and clicks for the last ' + days + ' days'"
        >
          <div
            v-for="d in series"
            :key="d.day"
            class="chart-day"
            :title="d.day + ': ' + d.visits + ' visits, ' + d.clicks + ' clicks'"
          >
            <div class="bar visits" :style="{ height: (d.visits / max) * 100 + '%' }"></div>
            <div class="bar clicks" :style="{ height: (d.clicks / max) * 100 + '%' }"></div>
          </div>
          <span v-if="!totals.visits && !totals.clicks" class="chart-empty"
            >Activity will appear here when someone visits.</span
          >
        </div>
        <div class="chart-axis">
          <span>{{ series[0]?.day }}</span
          ><span>{{ series.at(-1)?.day }}</span>
        </div>
        <details class="daily-details">
          <summary>View daily totals</summary>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Date (UTC)</th>
                  <th>Visits</th>
                  <th>Clicks</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="d in series.slice().reverse()" :key="d.day">
                  <td>{{ d.day }}</td>
                  <td>{{ count(d.visits) }}</td>
                  <td>{{ count(d.clicks) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </details>
      </section>
      <section v-if="data.campaigns.length" class="pages-panel">
        <div class="panel-toolbar">
          <h2 class="panel-title">By campaign</h2>
          <span class="muted small">Lifetime totals</span>
        </div>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Visits</th>
                <th>Clicks</th>
                <th>Last visit (UTC)</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in data.campaigns" :key="c.id">
                <td>
                  <RouterLink :to="'/admin/campaigns/' + c.id"
                    ><strong>{{ c.name }}</strong></RouterLink
                  >
                  <div class="muted small url-break">
                    /{{ data.site.slug }}/{{ c.code }}
                    <template v-if="!c.assigned"> · removed</template
                    ><template v-else-if="c.status !== 'active'"> · {{ c.status }}</template>
                  </div>
                </td>
                <td class="metric">{{ count(c.visits) }}</td>
                <td class="metric">{{ count(c.clicks) }}</td>
                <td class="small nowrap">{{ c.lastVisitAt ? date(c.lastVisitAt) : '—' }}</td>
              </tr>
              <tr>
                <td>
                  <strong>Unattributed</strong>
                  <div class="muted small url-break">
                    {{
                      data.site.campaignOnly
                        ? 'Before the page became campaign-only'
                        : '/' + data.site.slug + ' and unknown or disabled codes'
                    }}
                  </div>
                </td>
                <td class="metric">{{ count(data.unattributed.visits) }}</td>
                <td class="metric">{{ count(data.unattributed.clicks) }}</td>
                <td class="small nowrap">
                  {{ data.unattributed.lastVisitAt ? date(data.unattributed.lastVisitAt) : '—' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section class="pages-panel">
        <div class="panel-toolbar">
          <h2 class="panel-title">Clicks by link</h2>
          <span class="muted small">Lifetime totals</span>
        </div>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Link</th>
                <th>Clicks</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in data.site.links.filter((l) => l.kind !== 'section')" :key="l.id">
                <td>
                  <strong>{{ l.title || l.file?.filename || l.url }}</strong>
                  <div v-if="l.file" class="muted small url-break">
                    <Fa icon="file-pdf" /> {{ l.file.filename }} · downloads
                  </div>
                  <div v-else class="muted small url-break">{{ l.url }}</div>
                </td>
                <td class="metric">{{ count(l.clicks || 0) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section class="pages-panel">
        <div class="panel-toolbar">
          <h2 class="panel-title">Recent activity</h2>
          <span class="muted small">{{ count(data.totalEvents) }} events in this period</span>
        </div>
        <div v-if="!data.events.length" class="empty compact">
          <Fa icon="chart-simple" />
          <p class="muted">No visits or clicks in this period yet.</p>
        </div>
        <div v-else class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>When (UTC)</th>
                <th>Event</th>
                <th>Link / action</th>
                <th v-if="data.campaigns.length">Campaign</th>
                <th>Referrer</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in data.events" :key="e.id">
                <td class="small nowrap">{{ date(e.at) }}</td>
                <td>
                  <span :class="['event-badge', e.kind]"
                    ><Fa
                      :icon="
                        e.target === 'markdown'
                          ? 'robot'
                          : e.kind === 'visit'
                            ? 'eye'
                            : 'arrow-up-right-from-square'
                      "
                    />
                    {{ e.kind }}</span
                  >
                </td>
                <td>
                  {{
                    e.target === 'markdown'
                      ? 'Agent read (Markdown)'
                      : e.kind === 'visit'
                        ? 'Page visit'
                        : e.title || 'Removed link'
                  }}<span v-if="e.kind === 'click'" class="muted small"> · {{ e.target }}</span>
                </td>
                <td v-if="data.campaigns.length" class="small">
                  {{ e.campaign?.name || '—' }}
                </td>
                <td class="muted small">{{ e.referrer || 'Direct / unknown' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="panel-footer">
          <span>Detailed events are kept for 365 days.</span>
          <div class="pagination">
            <button :disabled="offset === 0 || loading" @click="page(-1)">Previous</button
            ><span
              >{{ data.totalEvents ? offset + 1 : 0 }}–{{
                Math.min(offset + data.events.length, data.totalEvents)
              }}</span
            ><button :disabled="offset + 100 >= data.totalEvents || loading" @click="page(1)">
              Next
            </button>
          </div>
        </div>
      </section>
      <p class="subtle-help">
        Visits count page loads, including agents reading the page as Markdown (/{{
          data.site.slug
        }}.md); agents follow links directly, so their clicks are not counted. Video load clicks
        count as link clicks; playback time is not tracked. Known bots, HEAD requests, and your own
        visits while signed in are excluded. No IP addresses or visitor cookies are stored.
      </p>
    </template>
  </section>
</template>
