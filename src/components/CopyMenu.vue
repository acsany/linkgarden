<script setup lang="ts">
import { ref } from 'vue';
import CopyButton from './CopyButton.vue';
// One copy button for a single URL; a menu when a page also has campaign URLs.
defineProps<{ urls: { label: string; url: string }[] }>();
const menu = ref<HTMLDetailsElement>();
</script>
<template>
  <CopyButton v-if="urls.length === 1" :url="urls[0].url" compact />
  <details v-else-if="urls.length" ref="menu" class="action-menu copy-menu">
    <summary class="button copy-button compact" aria-label="Copy a short URL">
      <Fa icon="copy" /><span>Copy URL</span><Fa icon="caret-down" />
    </summary>
    <div class="menu" @click="menu && (menu.open = false)">
      <CopyButton v-for="u in urls" :key="u.url" :url="u.url" :label="u.label" />
    </div>
  </details>
</template>
