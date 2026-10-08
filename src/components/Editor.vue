<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { api, state, notify, fileSize, linkText } from '../state';
import type { Site, Link, Campaign, CampaignRef } from '../types';
import { videoInfo } from '../../shared/video';
import { themes } from '../../shared/themes';
import {
  linkIcons,
  iconLabel,
  resolveIcon,
  ruleIcon,
  autoIcon,
  type IconRule,
} from '../../shared/icons';
import { faIcon } from '../linkIcon';
import LinkCollection from './LinkCollection.vue';
import IconGallery from './IconGallery.vue';
import ReorderList from './ReorderList.vue';
import CopyButton from './CopyButton.vue';
import { pwaState } from '../pwa';
const route = useRoute(),
  router = useRouter();
const isNew = computed(() => route.params.id === undefined);
const blankLink = (kind: Link['kind'] = 'link'): Link => ({
  kind,
  url: '',
  title: '',
  description: '',
  imageUrl: '',
  embed: false,
  icon: '',
  fullUrl: true,
});
// Links and PDFs are click targets; sections only head them.
const isTarget = (l: Link) => l.kind !== 'section';
const linkCount = computed(() => form.links.filter(isTarget).length);
// Links are numbered on their own so adding a section does not renumber them.
const linkNumber = (i: number) => form.links.slice(0, i + 1).filter(isTarget).length;
const form = reactive({
  slug: '',
  title: '',
  description: '',
  note: '',
  mode: 'aggregate' as Site['mode'],
  status: 'active' as Site['status'],
  theme: 'default' as Site['theme'],
  campaignOnly: false,
  campaignIds: [] as string[],
  links: [blankLink()],
});
// Campaign chips: everything known by ID, from the campaign list and the saved page.
const known = ref(new Map<string, Pick<CampaignRef, 'id' | 'code' | 'name' | 'status'>>()),
  campaignQuery = ref(''),
  campaignFocus = ref(false),
  creatingCampaign = ref(false),
  campaignError = ref('');
const chosen = computed(() => form.campaignIds.flatMap((id) => known.value.get(id) ?? []));
const suggestions = computed(() => {
  const q = campaignQuery.value.trim().toLowerCase();
  return [...known.value.values()]
    .filter(
      (c) =>
        !form.campaignIds.includes(c.id) &&
        c.status !== 'archived' &&
        (!q || c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q)),
    )
    .slice(0, 6);
});
const exactCampaign = computed(() => {
  const q = campaignQuery.value.trim().toLowerCase();
  return [...known.value.values()].find(
    (c) => c.name.toLowerCase() === q || c.code.toLowerCase() === q,
  );
});
function addCampaign(id: string) {
  if (!form.campaignIds.includes(id)) form.campaignIds.push(id);
  campaignQuery.value = '';
}
async function campaignEnter() {
  const q = campaignQuery.value.trim();
  if (!q) return;
  if (exactCampaign.value) return addCampaign(exactCampaign.value.id);
  await createCampaign(q);
}
// Creates the campaign right away with a random code; it is assigned when the page is saved.
async function createCampaign(name: string) {
  campaignError.value = '';
  creatingCampaign.value = true;
  try {
    const c = await api<Campaign>('/api/admin/campaigns', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    known.value.set(c.id, c);
    addCampaign(c.id);
  } catch (e) {
    campaignError.value = (e as Error).message;
  } finally {
    creatingCampaign.value = false;
  }
}
async function loadCampaigns() {
  try {
    for (const c of await api<Campaign[]>('/api/admin/campaigns')) known.value.set(c.id, c);
  } catch (e) {
    campaignError.value = (e as Error).message;
  }
}
const savedCampaigns = ref<CampaignRef[]>([]);
const originalSlug = ref(''),
  error = ref(''),
  loading = ref(!isNew.value),
  saving = ref(false),
  previewing = ref<number[]>([]),
  uploading = ref<number[]>([]),
  previewWarning = ref(''),
  uploadError = ref(''),
  showPreview = ref(false),
  // Compact list for moving many items or whole sections at once.
  reordering = ref(false);
const initial = ref('');
const changed = computed(() => initial.value !== JSON.stringify(form));
onBeforeRouteLeave(() => !changed.value || window.confirm('Discard unsaved page changes?'));
// Items are tracked by index while a request runs, so reordering waits for it.
const busy = computed(() => previewing.value.length > 0 || uploading.value.length > 0);
// Rules only drive the preview and the "Automatic" label; the server applies them publicly.
const iconRules = ref<IconRule[]>([]);
const automaticIcon = (l: Link) => ruleIcon(iconRules.value, l.url) || autoIcon(l.url);
async function loadIconRules() {
  try {
    iconRules.value = await api<IconRule[]>('/api/admin/icon-rules');
  } catch {
    /* the built-in guesses still work */
  }
}
async function load() {
  loadCampaigns();
  loadIconRules();
  if (isNew.value) {
    initial.value = JSON.stringify(form);
    return;
  }
  try {
    const s = await api<Site>('/api/admin/sites/' + route.params.id);
    Object.assign(form, {
      slug: s.slug,
      title: s.title,
      description: s.description,
      note: s.note,
      mode: s.mode,
      status: s.status,
      theme: s.theme,
      campaignOnly: s.campaignOnly,
      campaignIds: s.campaigns.map((c) => c.id),
      links: s.links,
    });
    for (const c of s.campaigns) known.value.set(c.id, c);
    savedCampaigns.value = s.campaigns;
    originalSlug.value = s.slug;
    initial.value = JSON.stringify(form);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
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
});
onUnmounted(() => window.removeEventListener('beforeunload', beforeUnload));
async function preview(index: number, force = false) {
  const l = form.links[index];
  if (!l?.url || previewing.value.includes(index)) return;
  try {
    new URL(l.url);
  } catch {
    return;
  }
  previewing.value.push(index);
  const url = l.url;
  try {
    const p = await api('/api/admin/metadata', { method: 'POST', body: JSON.stringify({ url }) });
    if (l.url !== url) return;
    if (force || !l.title) l.title = p.title;
    if (force || !l.description) l.description = p.description;
    if (force || !l.imageUrl) l.imageUrl = p.imageUrl;
    previewWarning.value = p.warning;
  } catch (e) {
    previewWarning.value = (e as Error).message;
  } finally {
    previewing.value = previewing.value.filter((i) => i !== index);
  }
}
function setKind(l: Link, kind: 'link' | 'file') {
  if (l.kind === kind) return;
  Object.assign(l, { kind, url: '', imageUrl: '', embed: false, icon: '' });
  delete l.fileId;
  delete l.file;
}
async function upload(index: number, e: Event) {
  const input = e.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = '';
  if (!file) return;
  uploadError.value = '';
  uploading.value.push(index);
  try {
    const f = await api<{ id: string; filename: string; size: number }>('/api/admin/files', {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(file.name) },
    });
    Object.assign(form.links[index], {
      fileId: f.id,
      file: { filename: f.filename, size: f.size },
    });
  } catch (err) {
    uploadError.value = (err as Error).message;
  } finally {
    uploading.value = uploading.value.filter((i) => i !== index);
  }
}
function move(i: number, delta: number) {
  const j = i + delta;
  if (j < 0 || j >= form.links.length) return;
  [form.links[i], form.links[j]] = [form.links[j], form.links[i]];
}
async function save() {
  error.value = '';
  saving.value = true;
  try {
    const payload = { ...form, slug: form.slug.trim() || undefined };
    const site = await api<Site & { warnings?: string[] }>(
      isNew.value ? '/api/admin/sites' : '/api/admin/sites/' + route.params.id,
      { method: isNew.value ? 'POST' : 'PUT', body: JSON.stringify(payload) },
    );
    initial.value = JSON.stringify(form);
    notify(
      [isNew.value ? 'Your page is ready.' : 'Page saved.', ...(site.warnings || [])].join(' '),
    );
    router.push('/admin');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}
const publicPreview = computed(() => ({
  title: form.title || 'Your page title',
  description: form.description,
  theme: form.theme,
  links: form.links.filter((l) =>
    l.kind === 'section' ? l.title : l.kind === 'file' ? l.fileId : l.url,
  ),
}));
</script>
<template>
  <section class="content editor-content">
    <RouterLink to="/admin" class="back-link"><Fa icon="arrow-left" /> Back to pages</RouterLink>
    <div class="page-heading">
      <div>
        <div class="eyebrow">{{ isNew ? 'MAKE ROOM FOR YOUR LINKS' : 'MAKE IT YOURS' }}</div>
        <h1>{{ isNew ? 'Create a page' : 'Edit page' }}</h1>
        <p class="muted">One destination or a collection. You decide.</p>
      </div>
      <button @click="showPreview = !showPreview" :disabled="loading">
        <Fa icon="eye" /> {{ showPreview ? 'Hide preview' : 'Preview' }}
      </button>
    </div>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <div v-if="loading" class="empty"><Fa icon="spinner" spin /> Loading page…</div>
    <div v-else :class="['editor-grid', { 'with-preview': showPreview }]">
      <form @submit.prevent="save" class="editor-form">
        <section class="form-panel">
          <h2><Fa icon="link" /> Page details</h2>
          <div v-if="originalSlug && !form.campaignOnly" class="saved-url">
            <div>
              <span class="field-help">Saved short URL</span
              ><a :href="'/' + originalSlug" target="_blank" rel="noopener"
                >{{ state.origin }}/{{ originalSlug }}</a
              >
            </div>
            <CopyButton :url="state.origin + '/' + originalSlug" />
          </div>
          <label
            >Title<input
              v-model="form.title"
              required
              maxlength="200"
              placeholder="e.g. My favorite things" /></label
          ><label
            >Short URL
            <div class="url-field">
              <span>{{ state.origin.replace(/^https?:\/\//, '') }}/</span
              ><input
                v-model="form.slug"
                maxlength="64"
                pattern="[A-Za-z0-9_-]+"
                placeholder="Auto-generated"
                aria-label="Short URL slug"
              /></div
          ></label>
          <p class="field-help">Leave blank for 5 random, case-sensitive letters and digits.</p>
          <p v-if="originalSlug && form.slug && originalSlug !== form.slug" class="info small">
            <Fa icon="link" /> /{{ originalSlug }}
            {{ savedCampaigns.length ? 'and its campaign URLs' : '' }} will stop working when you
            save. Duplicate the page to keep both URLs with separate metrics.
          </p>
          <label
            >Description<textarea
              v-model="form.description"
              rows="2"
              maxlength="2000"
              placeholder="A little context for your visitors (optional)"
            ></textarea>
          </label>
          <fieldset class="mode-options">
            <legend>Page type</legend>
            <label :class="['mode-option', { chosen: form.mode === 'aggregate' }]"
              ><input type="radio" v-model="form.mode" value="aggregate" /><Fa icon="link" /><span
                ><strong>Link collection</strong><small>A page with multiple links</small></span
              ><Fa v-if="form.mode === 'aggregate'" icon="circle-check" /></label
            ><label :class="['mode-option', { chosen: form.mode === 'redirect' }]"
              ><input type="radio" v-model="form.mode" value="redirect" /><Fa
                icon="arrow-up-right-from-square" /><span
                ><strong>Direct redirect</strong
                ><small>Send visitors straight to one URL or PDF</small></span
              ><Fa v-if="form.mode === 'redirect'" icon="circle-check"
            /></label>
          </fieldset>
          <template v-if="form.mode === 'aggregate'"
            ><fieldset class="mode-options">
              <legend>Theme</legend>
              <label
                v-for="t in themes"
                :key="t.id"
                :class="['mode-option', { chosen: form.theme === t.id }]"
                ><input type="radio" v-model="form.theme" :value="t.id" /><span
                  :class="['theme-swatch', 'theme-' + t.id]"
                  aria-hidden="true"
                  ><span>Aa</span></span
                ><span
                  ><strong>{{ t.label }}</strong
                  ><small>{{ t.description }}</small></span
                ><Fa v-if="form.theme === t.id" icon="circle-check"
              /></label>
            </fieldset>
            <p class="field-help">
              Every theme turns dark for visitors who use dark mode.
            </p></template
          >
          <p
            v-if="form.mode === 'redirect' && (form.links.length !== 1 || !isTarget(form.links[0]))"
            class="error"
          >
            A direct redirect needs exactly one link or PDF. Remove the extra items below.
          </p>
        </section>
        <section class="form-panel">
          <div class="section-heading">
            <h2>
              <Fa icon="arrow-up-right-from-square" />
              {{ form.mode === 'redirect' ? 'Destination' : 'Links' }}
            </h2>
            <div class="section-heading-tools">
              <span class="muted small">{{ form.links.length }} / 100</span
              ><button
                v-if="form.mode === 'aggregate' && (form.links.length > 1 || reordering)"
                type="button"
                :class="{ primary: reordering }"
                :disabled="busy"
                @click="reordering = !reordering"
              >
                <template v-if="reordering"><Fa icon="check" /> Done</template
                ><template v-else><Fa icon="grip-vertical" /> Reorder</template>
              </button>
            </div>
          </div>
          <ReorderList v-if="reordering" v-model:links="form.links" :rules="iconRules" />
          <template v-else>
            <p class="muted small">
              Images and titles are fetched automatically where available. You can edit them below.
            </p>
            <p v-if="previewWarning" class="info small">{{ previewWarning }}</p>
            <p v-if="uploadError" role="alert" class="error small">{{ uploadError }}</p>
            <article
              v-for="(link, i) in form.links"
              :key="link.id || i"
              :class="['link-editor', { 'section-editor': link.kind === 'section' }]"
            >
              <div class="link-editor-heading">
                <span v-if="link.kind === 'section'"><Fa icon="heading" /> Section</span
                ><span v-else
                  ><Fa :icon="link.kind === 'file' ? 'file-pdf' : 'grip-vertical'" />
                  {{ link.kind === 'file' ? 'PDF' : 'Link' }} {{ linkNumber(i) }}</span
                >
                <div class="row-actions">
                  <button
                    type="button"
                    class="icon-button"
                    :disabled="i === 0 || busy"
                    @click="move(i, -1)"
                    :aria-label="'Move ' + link.kind + ' up'"
                  >
                    <Fa icon="chevron-up" /></button
                  ><button
                    type="button"
                    class="icon-button"
                    :disabled="i === form.links.length - 1 || busy"
                    @click="move(i, 1)"
                    :aria-label="'Move ' + link.kind + ' down'"
                  >
                    <Fa icon="chevron-down" /></button
                  ><button
                    type="button"
                    class="icon-button"
                    :disabled="(isTarget(link) && linkCount === 1) || busy"
                    @click="form.links.splice(i, 1)"
                    :aria-label="'Remove ' + link.kind"
                  >
                    <Fa icon="trash" />
                  </button>
                </div>
              </div>
              <template v-if="link.kind === 'section'">
                <label
                  >Subheadline<input
                    v-model="link.title"
                    required
                    maxlength="200"
                    placeholder="e.g. Talks & videos"
                /></label>
                <label
                  >Section description<textarea
                    v-model="link.description"
                    rows="2"
                    maxlength="1000"
                    placeholder="Optional introduction for the links below"
                  ></textarea>
                </label>
                <label
                  >Section icon
                  <div class="icon-field">
                    <span class="icon-swatch" aria-hidden="true"
                      ><Fa :icon="faIcon(resolveIcon(link))"
                    /></span>
                    <select v-model="link.icon" aria-label="Section icon">
                      <option value="">Default · Section</option>
                      <option v-for="ic in linkIcons" :key="ic.id" :value="ic.id">
                        {{ ic.label }}
                      </option>
                    </select>
                  </div>
                </label>
                <IconGallery v-model="link.icon" :label="'Section icon ' + (i + 1)" />
              </template>
              <div v-else class="kind-switch" role="group" aria-label="Item type">
                <button
                  type="button"
                  :class="{ chosen: link.kind === 'link' }"
                  :aria-pressed="link.kind === 'link'"
                  :disabled="busy"
                  @click="setKind(link, 'link')"
                >
                  <Fa icon="link" /> URL</button
                ><button
                  type="button"
                  :class="{ chosen: link.kind === 'file' }"
                  :aria-pressed="link.kind === 'file'"
                  :disabled="busy"
                  @click="setKind(link, 'file')"
                >
                  <Fa icon="file-pdf" /> PDF
                </button>
              </div>
              <template v-if="link.kind === 'file'">
                <div class="file-field">
                  <span class="file-icon" aria-hidden="true"><Fa icon="file-pdf" /></span>
                  <span v-if="link.file" class="file-name"
                    ><a :href="'/api/admin/files/' + link.fileId" download>{{
                      link.file.filename
                    }}</a
                    ><small>{{ fileSize(link.file.size) }}</small></span
                  ><span v-else class="file-name muted">No PDF uploaded yet</span>
                  <label :class="['button', 'file-picker', { busy: uploading.includes(i) }]"
                    ><Fa
                      :icon="uploading.includes(i) ? 'spinner' : 'file-arrow-up'"
                      :spin="uploading.includes(i)" />
                    {{ uploading.includes(i) ? 'Uploading…' : link.file ? 'Replace' : 'Upload PDF'
                    }}<input
                      type="file"
                      accept="application/pdf,.pdf"
                      class="sr-only"
                      :disabled="busy"
                      @change="upload(i, $event)"
                  /></label>
                </div>
                <p class="field-help">Visitors download the file under its original name.</p>
                <label
                  >PDF title<input
                    v-model="link.title"
                    maxlength="200"
                    :placeholder="link.file?.filename || 'Uses the file name'"
                /></label>
                <label
                  >Description<textarea
                    v-model="link.description"
                    rows="2"
                    maxlength="1000"
                    placeholder="Optional PDF description"
                  ></textarea>
                </label>
              </template>
              <template v-else-if="link.kind === 'link'">
                <label
                  >Destination URL<input
                    v-model="link.url"
                    type="url"
                    required
                    placeholder="https://…"
                    @blur="preview(i)"
                /></label>
                <div class="two-columns">
                  <label
                    >Link title<input
                      v-model="link.title"
                      maxlength="200"
                      placeholder="Fetched from the URL"
                  /></label>
                  <div class="preview-fetch">
                    <button
                      type="button"
                      @click="preview(i, true)"
                      :disabled="!link.url || previewing.includes(i)"
                    >
                      <Fa
                        :icon="previewing.includes(i) ? 'spinner' : 'rotate'"
                        :spin="previewing.includes(i)"
                      />
                      Fetch preview
                    </button>
                  </div>
                </div>
                <label
                  >Description<textarea
                    v-model="link.description"
                    rows="2"
                    maxlength="1000"
                    placeholder="Optional link description"
                  ></textarea></label
                ><label
                  >Image URL
                  <div class="image-field">
                    <img
                      v-if="link.imageUrl"
                      :src="link.imageUrl"
                      alt="Link preview"
                      referrerpolicy="no-referrer"
                    /><input
                      v-model="link.imageUrl"
                      type="url"
                      placeholder="https://… (optional)"
                    /></div></label
                ><label
                  v-if="videoInfo(link.url) && form.mode === 'aggregate'"
                  class="checkbox-label"
                  ><input type="checkbox" v-model="link.embed" /><Fa icon="play" /> Let visitors
                  play this video on the page</label
                >
                <fieldset class="url-display">
                  <legend>Show on the card</legend>
                  <div class="kind-switch">
                    <button
                      type="button"
                      :class="{ chosen: link.fullUrl !== false }"
                      :aria-pressed="link.fullUrl !== false"
                      @click="link.fullUrl = true"
                    >
                      <span class="url-display-label">Full link</span>
                      <span class="url-display-sample">{{
                        linkText(link.url || 'https://example.com/page')
                      }}</span></button
                    ><button
                      type="button"
                      :class="{ chosen: link.fullUrl === false }"
                      :aria-pressed="link.fullUrl === false"
                      @click="link.fullUrl = false"
                    >
                      <span class="url-display-label">Domain only</span>
                      <span class="url-display-sample">{{
                        linkText(link.url || 'https://example.com/page', false)
                      }}</span>
                    </button>
                  </div>
                </fieldset>
                <label
                  >Icon
                  <div class="icon-field">
                    <span class="icon-swatch" aria-hidden="true"
                      ><Fa :icon="faIcon(resolveIcon(link, iconRules))" /></span
                    ><select v-model="link.icon">
                      <option value="">Automatic · {{ iconLabel(automaticIcon(link)) }}</option>
                      <option v-for="ic in linkIcons" :key="ic.id" :value="ic.id">
                        {{ ic.label }}
                      </option>
                    </select>
                  </div></label
                >
                <IconGallery v-model="link.icon" :label="'Link icon ' + (i + 1)" />
                <p class="field-help">
                  Automatic icons come from your
                  <RouterLink to="/admin/icon-rules">icon rules</RouterLink>, then the URL.
                </p>
              </template>
            </article>
            <div v-if="form.mode === 'aggregate'" class="add-items">
              <button
                type="button"
                class="add-link"
                @click="form.links.push(blankLink())"
                :disabled="form.links.length >= 100 || busy"
              >
                <Fa icon="plus" /> Add another link</button
              ><button
                type="button"
                class="add-link"
                @click="form.links.push(blankLink('file'))"
                :disabled="form.links.length >= 100 || busy"
              >
                <Fa icon="file-pdf" /> Add PDF</button
              ><button
                type="button"
                class="add-link"
                @click="form.links.push(blankLink('section'))"
                :disabled="form.links.length >= 100 || busy"
              >
                <Fa icon="heading" /> Add section
              </button>
            </div>
          </template>
        </section>
        <section class="form-panel">
          <h2><Fa icon="paper-plane" /> Campaigns</h2>
          <p class="muted small">
            Give each recipient their own URL for this page, like /{{ form.slug || 'slug' }}/acme,
            and see who opened it. The page and its links stay the same.
          </p>
          <div class="chip-field">
            <div class="chip-input">
              <span v-for="c in chosen" :key="c.id" class="chip"
                ><span
                  >{{ c.name }} <small>/{{ c.code }}</small></span
                ><span v-if="c.status !== 'active'" :class="['badge', c.status]">{{
                  c.status
                }}</span
                ><button
                  type="button"
                  class="icon-button"
                  :aria-label="'Remove campaign ' + c.name"
                  @click="form.campaignIds = form.campaignIds.filter((id) => id !== c.id)"
                >
                  <Fa icon="xmark" /></button></span
              ><input
                v-model="campaignQuery"
                maxlength="200"
                aria-label="Add a campaign"
                :placeholder="
                  chosen.length ? 'Add another campaign' : 'Type a name to add or create one'
                "
                @focus="campaignFocus = true"
                @blur="campaignFocus = false"
                @keydown.enter.prevent="campaignEnter"
                @keydown.escape="campaignFocus = false"
              />
            </div>
            <div
              v-if="campaignFocus && (suggestions.length || campaignQuery.trim())"
              class="chip-suggestions"
            >
              <button
                v-for="c in suggestions"
                :key="c.id"
                type="button"
                @mousedown.prevent
                @click="addCampaign(c.id)"
              >
                <Fa icon="paper-plane" /> {{ c.name }} <small>/{{ c.code }}</small>
                <span v-if="c.status !== 'active'" :class="['badge', c.status]">{{
                  c.status
                }}</span>
              </button>
              <button
                v-if="campaignQuery.trim() && !exactCampaign"
                type="button"
                :disabled="creatingCampaign"
                @mousedown.prevent
                @click="createCampaign(campaignQuery.trim())"
              >
                <Fa :icon="creatingCampaign ? 'spinner' : 'plus'" :spin="creatingCampaign" /> Create
                campaign “{{ campaignQuery.trim() }}”
              </button>
            </div>
          </div>
          <p v-if="campaignError" role="alert" class="error small">{{ campaignError }}</p>
          <ul v-if="originalSlug && savedCampaigns.length" class="campaign-urls">
            <li v-for="c in savedCampaigns.filter((c) => c.status === 'active')" :key="c.id">
              <span
                ><strong>{{ c.name }}</strong
                ><a :href="c.url" target="_blank" rel="noopener">{{ c.url }}</a></span
              ><CopyButton :url="c.url" compact />
            </li>
          </ul>
          <label class="checkbox-label"
            ><input type="checkbox" v-model="form.campaignOnly" /><Fa icon="lock" /> Only reachable
            through campaign links</label
          >
          <p class="field-help">
            When on, /{{ form.slug || originalSlug || 'slug' }} shows “Page unavailable”, so only
            recipients with a campaign URL can open the page.
          </p>
          <p v-if="form.campaignOnly && !form.campaignIds.length" class="info small">
            <Fa icon="lock" /> Nobody can open this page until you add an active campaign.
          </p>
        </section>
        <section class="form-panel">
          <h2><Fa icon="shield-halved" /> Just for you</h2>
          <label
            >Private note<textarea
              v-model="form.note"
              rows="3"
              maxlength="10000"
              placeholder="Campaign context, reminders, or anything you want to remember…"
            ></textarea>
          </label>
          <p class="field-help">
            Visible to you and authenticated agents. Never shown on the public page.
          </p>
          <label
            >Status<select v-model="form.status" aria-label="Status">
              <option value="active">Active — public URL works</option>
              <option value="inactive">Inactive — public URL disabled</option>
              <option value="archived">Archived — disabled and moved to archive</option>
            </select></label
          >
        </section>
        <div class="form-actions sticky-actions">
          <RouterLink to="/admin" class="button">Cancel</RouterLink
          ><button class="primary" :disabled="saving || busy || !pwaState.online">
            <Fa v-if="saving" icon="spinner" spin /><Fa v-else icon="check" />
            {{ saving ? 'Saving…' : isNew ? 'Create page' : 'Save changes' }}
          </button>
        </div>
      </form>
      <aside v-if="showPreview" class="preview-panel">
        <div class="preview-label"><Fa icon="eye" /> PUBLIC PREVIEW</div>
        <p v-if="form.mode === 'redirect'" class="info">
          <template v-if="form.links[0]?.kind === 'file'"
            >Visitors will download
            {{ form.links[0].file?.filename || 'your PDF' }} immediately.</template
          ><template v-else
            >Visitors will be redirected immediately to
            {{ form.links[0]?.url || 'your destination' }}.</template
          >
        </p>
        <div v-else :class="['theme-frame', 'theme-' + form.theme]">
          <LinkCollection
            :site="publicPreview"
            :rules="iconRules"
            :page-url="state.origin + '/' + (form.slug.trim() || originalSlug || '…')"
            preview
          />
        </div>
      </aside>
    </div>
  </section>
</template>
