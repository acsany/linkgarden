<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../state';
import type { Site, Status } from '../types';
// The server echoes the campaign code only when it attributes the visit, and sends a
// status only to the signed-in admin previewing a page that is not active.
type PublicSite = Omit<Site, 'status'> & { campaign?: string; status?: Status };
import LinkCollection from './LinkCollection.vue';
const route = useRoute(),
  site = ref<PublicSite | null>(null),
  error = ref(''),
  loading = ref(true);
// The server marks the body with the page theme so loading and errors match it.
const initialTheme = document.body.dataset.theme || 'default';
const location = window.location;
onMounted(async () => {
  try {
    const code = route.params.code ? String(route.params.code) : '';
    site.value = await api(
      '/api/public/sites/' +
        encodeURIComponent(String(route.params.slug)) +
        (code ? '?c=' + encodeURIComponent(code) : ''),
    );
    if (site.value?.mode === 'redirect')
      location.replace(
        '/' + encodeURIComponent(site.value.slug) + (code ? '/' + encodeURIComponent(code) : ''),
      );
  } catch {
    error.value = 'This link may have changed or been deactivated.';
  } finally {
    loading.value = false;
  }
});
</script>
<template>
  <main :class="['public-wrap', 'theme-' + (site?.theme || initialTheme)]">
    <div v-if="loading" class="empty"><Fa icon="spinner" spin /> Loading…</div>
    <div v-else-if="error" class="empty">
      <span class="empty-icon"><Fa icon="link" /></span>
      <h1>Page unavailable</h1>
      <p class="muted">{{ error }}</p>
    </div>
    <template v-else-if="site">
      <p v-if="site.status" class="status-banner" role="status">
        <Fa icon="eye" />
        <span
          >This page is <strong>{{ site.status }}</strong
          >. Only you can see it, because you're signed in.</span
        >
      </p>
      <LinkCollection
        :site="site"
        :campaign="site.campaign"
        :page-url="location.origin + location.pathname"
      />
    </template>
  </main>
</template>
