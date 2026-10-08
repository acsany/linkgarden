<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { notify } from '../state';
defineOptions({ inheritAttrs: false });
// label names the URL when several are offered, e.g. a campaign in a copy menu.
const props = defineProps<{ url: string; compact?: boolean; label?: string }>();
const manual = ref(false),
  field = ref<HTMLInputElement>();
async function copy() {
  try {
    await navigator.clipboard.writeText(props.url);
  } catch {
    const previous = document.activeElement as HTMLElement | null;
    const textarea = document.createElement('textarea');
    textarea.value = props.url;
    textarea.readOnly = true;
    textarea.style.cssText = 'position:fixed;left:0;top:0;opacity:0;pointer-events:none';
    document.body.append(textarea);
    textarea.select();
    textarea.setSelectionRange(0, props.url.length);
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      /* Fall back to a selectable URL. */
    }
    textarea.remove();
    previous?.focus();
    if (!copied) {
      manual.value = true;
      await nextTick();
      field.value?.focus();
      field.value?.select();
      return;
    }
  }
  notify('Short URL copied.');
}
</script>
<template>
  <button
    type="button"
    v-bind="$attrs"
    :class="['copy-button', { compact }]"
    :aria-label="label ? 'Copy URL for ' + label : 'Copy short URL'"
    @click="copy"
  >
    <Fa icon="copy" /><span>{{ label || 'Copy URL' }}</span>
  </button>
  <Teleport to="body">
    <div v-if="manual" class="modal-backdrop" @click.self="manual = false">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="copy-title">
        <div class="section-heading">
          <h2 id="copy-title">Copy short URL</h2>
          <button class="icon-button" aria-label="Close copy dialog" @click="manual = false">
            <Fa icon="xmark" />
          </button>
        </div>
        <p>Your browser couldn't copy automatically. Select and copy this URL.</p>
        <input
          ref="field"
          :value="url"
          readonly
          aria-label="Short URL to copy"
          @focus="field?.select()"
        />
        <button class="primary full" @click="manual = false">Done</button>
      </section>
    </div>
  </Teleport>
</template>
