<script setup lang="ts">
import { computed, ref } from 'vue';
import { api, fileSize, linkText } from '../state';
import type { Link } from '../types';
import { videoInfo } from '../../shared/video';
import { faIcon } from '../linkIcon';
import { resolveIcon, type IconRule } from '../../shared/icons';
const props = defineProps<{
  site: { title: string; description: string; theme?: string; links: Link[] };
  preview?: boolean;
  campaign?: string;
  // The editor preview passes the rules; public links arrive with their icon resolved.
  rules?: IconRule[];
  // The page's own address, which the CV theme shows in place of the brand.
  pageUrl?: string;
  // The share image (a QR code of the page), linked next to the footer address.
  cardUrl?: string;
}>();
const icon = (l: Link) => faIcon(resolveIcon(l, props.rules));
// The share card opens in a modal; its image loads only once the visitor asks for it.
const qrDialog = ref<HTMLDialogElement>(),
  qrOpened = ref(false);
function showQr() {
  qrOpened.value = true;
  qrDialog.value?.showModal();
}
const qrFilename = computed(() => {
  try {
    return new URL(props.pageUrl!).pathname.slice(1).replace(/\//g, '-') + '-qr.png';
  } catch {
    return 'qr-code.png';
  }
});
// Clicks from a campaign URL carry its code so the server can attribute them.
const tracked = (path: string) =>
  props.campaign ? path + '?c=' + encodeURIComponent(props.campaign) : path;
const playing = ref(new Set<string>()),
  broken = ref(new Set<string>()),
  error = ref('');
const key = (l: Link) => l.id || l.fileId || l.url;
// A custom title hides the file name, so the meta line names the file instead.
const fileMeta = (l: Link) =>
  [l.title && l.file?.filename, 'PDF', l.file && fileSize(l.file.size)].filter(Boolean).join(' · ');
// Link titles sit under section headings when a page has any, keeping the outline valid.
const linkHeading = computed(() =>
  props.site.links.some((l) => l.kind === 'section') ? 'h3' : 'h2',
);
async function play(l: Link) {
  error.value = '';
  try {
    if (!props.preview)
      await api(tracked('/api/public/links/' + l.id + '/embed'), { method: 'POST', body: '{}' });
    playing.value = new Set([...playing.value, key(l)]);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
const domain = (url: string) => linkText(url, false);
</script>
<template>
  <div class="link-collection">
    <span class="collection-avatar"><Fa icon="leaf" /></span>
    <h1>{{ site.title }}</h1>
    <p v-if="site.description" class="collection-description">{{ site.description }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="collection-links">
      <template v-for="l in site.links" :key="key(l)">
        <header v-if="l.kind === 'section'" class="collection-section">
          <span class="section-rail" aria-hidden="true"><Fa :icon="icon(l)" /></span>
          <div>
            <h2>{{ l.title }}</h2>
            <p v-if="l.description">{{ l.description }}</p>
          </div>
        </header>
        <article v-else class="collection-card">
          <iframe
            v-if="playing.has(key(l)) && videoInfo(l.url)"
            :src="videoInfo(l.url)!.embedUrl"
            :title="l.title || 'Video player'"
            loading="lazy"
            allow="encrypted-media; picture-in-picture; fullscreen"
            allowfullscreen
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
            referrerpolicy="strict-origin-when-cross-origin"
          ></iframe>
          <div v-else-if="l.embed && videoInfo(l.url)" class="video-preview">
            <img
              v-if="l.imageUrl && !broken.has(key(l))"
              :src="l.imageUrl"
              alt=""
              loading="lazy"
              referrerpolicy="no-referrer"
              @error="broken.add(key(l))"
            /><button
              @click="play(l)"
              class="play-button"
              :aria-label="'Play ' + (l.title || 'video')"
            >
              <Fa icon="play" /></button
            ><span class="video-consent"
              >Click to load
              {{ videoInfo(l.url)?.provider === 'youtube' ? 'YouTube' : 'Vimeo' }}</span
            >
          </div>
          <a
            v-if="l.kind === 'file'"
            :href="preview ? '/api/admin/files/' + l.fileId : tracked('/r/' + l.id)"
            download
            class="collection-link collection-file"
            ><span class="link-fallback" aria-hidden="true"><Fa icon="file-pdf" /></span>
            <span class="link-rail" aria-hidden="true"><Fa icon="file-pdf" /></span>
            <div>
              <component :is="linkHeading" class="link-title">{{
                l.title || l.file?.filename
              }}</component>
              <p v-if="l.description">{{ l.description }}</p>
              <span class="link-domain">{{ fileMeta(l) }}</span>
            </div>
            <Fa icon="download" class="outbound-icon"
          /></a>
          <a
            v-else
            :href="preview ? l.url : tracked('/r/' + l.id)"
            :target="preview ? '_blank' : undefined"
            rel="noopener noreferrer"
            class="collection-link"
            ><img
              v-if="!l.embed && l.imageUrl && !broken.has(key(l))"
              :src="l.imageUrl"
              alt=""
              loading="lazy"
              referrerpolicy="no-referrer"
              @error="broken.add(key(l))" /><span v-else-if="!l.embed" class="link-fallback"
              ><Fa :icon="icon(l)"
            /></span>
            <span class="link-rail" aria-hidden="true"
              ><Fa :icon="l.embed && videoInfo(l.url) ? 'play' : icon(l)"
            /></span>
            <div>
              <component :is="linkHeading" class="link-title">{{
                l.title || domain(l.url)
              }}</component>
              <p v-if="l.description">{{ l.description }}</p>
              <span class="link-domain">{{ linkText(l.url, l.fullUrl !== false) }}</span>
            </div>
            <Fa icon="arrow-up-right-from-square" class="outbound-icon"
          /></a>
        </article>
      </template>
    </div>
    <footer class="collection-footer">
      <a
        v-if="site.theme === 'cv' && pageUrl"
        class="collection-brand"
        :href="pageUrl"
        :target="preview ? '_blank' : undefined"
        >{{ linkText(pageUrl) }}</a
      >
      <a v-else class="collection-brand" href="/"><Fa icon="leaf" /> linkgarden</a>
      <button
        v-if="cardUrl"
        type="button"
        class="collection-qr"
        aria-label="Show QR code for this page"
        title="QR code for this page"
        @click="showQr"
      >
        <Fa icon="qrcode" />
      </button>
    </footer>
    <dialog
      v-if="cardUrl"
      ref="qrDialog"
      class="qr-dialog"
      aria-labelledby="qr-dialog-title"
      @click="$event.target === qrDialog && qrDialog.close()"
    >
      <h2 id="qr-dialog-title">Scan to open this page</h2>
      <div class="qr-crop">
        <img v-if="qrOpened" :src="cardUrl" :alt="'QR code for ' + (pageUrl || 'this page')" />
      </div>
      <div class="qr-dialog-actions">
        <a class="qr-download" :href="cardUrl" :download="qrFilename"
          ><Fa icon="download" /> Download PNG</a
        >
        <button type="button" class="qr-close" @click="qrDialog?.close()">Close</button>
      </div>
    </dialog>
  </div>
</template>
