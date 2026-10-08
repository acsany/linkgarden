<script setup lang="ts">
import { ref } from 'vue';
import { installPwa, pwaState } from '../pwa';
const showHelp = ref(false);
async function install() {
  try {
    if (!(await installPwa())) showHelp.value = true;
  } catch {
    showHelp.value = true;
  }
}
</script>
<template>
  <button
    v-if="!pwaState.standalone"
    class="install-button"
    @click="install"
    aria-label="Install Linkgarden"
  >
    <Fa icon="download" /> <span>Install app</span>
  </button>
  <Teleport to="body">
    <div v-if="showHelp" class="modal-backdrop" @click.self="showHelp = false">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="install-title">
        <div class="section-heading">
          <h2 id="install-title">Linkgarden on your phone</h2>
          <button
            class="icon-button"
            aria-label="Close installation help"
            @click="showHelp = false"
          >
            <Fa icon="xmark" />
          </button>
        </div>
        <p>
          <strong>iPhone or iPad:</strong> open this site in Safari, tap Share, then
          <strong>Add to Home Screen</strong>. If shown, keep Open as Web App enabled.
        </p>
        <p>
          <strong>Android:</strong> open your browser menu, then choose
          <strong>Install app</strong> or <strong>Add to home screen</strong>.
        </p>
        <p class="muted">
          Use the hosted HTTPS address. Browser support determines which install option appears.
        </p>
        <button class="primary full" @click="showHelp = false">Got it</button>
      </section>
    </div>
  </Teleport>
</template>
