<script setup lang="ts">
import { linkIcons } from '../../shared/icons';
import { faIcon } from '../linkIcon';
defineProps<{ label: string }>();
const model = defineModel<string>();
</script>
<template>
  <details class="icon-gallery">
    <summary>
      Browse icons <span class="sr-only">— {{ label }}</span>
    </summary>
    <div class="icon-options" role="group" :aria-label="label">
      <button
        v-for="icon in linkIcons"
        :key="icon.id"
        type="button"
        :aria-pressed="model === icon.id"
        @click="model = icon.id"
      >
        <Fa :icon="faIcon(icon.id)" aria-hidden="true" />
        <span>{{ icon.label }}</span>
      </button>
    </div>
  </details>
</template>
