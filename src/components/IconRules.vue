<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { api, notify } from '../state';
import { linkIcons, iconLabel, ruleIcon, autoIcon, type IconRule } from '../../shared/icons';
import { faIcon } from '../linkIcon';
import IconGallery from './IconGallery.vue';
const rules = ref<IconRule[]>([]),
  initial = ref('[]'),
  loading = ref(true),
  saving = ref(false),
  error = ref(''),
  testUrl = ref('');
const changed = computed(() => initial.value !== JSON.stringify(rules.value));
onBeforeRouteLeave(() => !changed.value || window.confirm('Discard unsaved icon rule changes?'));
// Shows which icon a URL would get and why, using the rules as currently edited.
const tested = computed(() => {
  const url = testUrl.value.trim();
  if (!url) return null;
  try {
    new URL(url);
  } catch {
    return null;
  }
  const valid = rules.value.filter((r) => r.pattern.trim());
  const ruled = ruleIcon(valid, url);
  const index = ruled ? valid.findIndex((r) => ruleIcon([r], url)) : -1;
  return {
    icon: ruled || autoIcon(url),
    reason: ruled ? `rule ${index + 1} (${valid[index].pattern})` : 'built-in guess',
  };
});
onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload);
  try {
    rules.value = await api<IconRule[]>('/api/admin/icon-rules');
    initial.value = JSON.stringify(rules.value);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
});
function beforeUnload(e: BeforeUnloadEvent) {
  if (changed.value) {
    e.preventDefault();
    e.returnValue = '';
  }
}
onUnmounted(() => window.removeEventListener('beforeunload', beforeUnload));
function move(i: number, delta: number) {
  const j = i + delta;
  if (j < 0 || j >= rules.value.length) return;
  [rules.value[i], rules.value[j]] = [rules.value[j], rules.value[i]];
}
async function save() {
  error.value = '';
  saving.value = true;
  try {
    rules.value = await api<IconRule[]>('/api/admin/icon-rules', {
      method: 'PUT',
      body: JSON.stringify({ rules: rules.value.filter((r) => r.pattern.trim()) }),
    });
    initial.value = JSON.stringify(rules.value);
    notify('Icon rules saved.');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <section class="content icon-rules-content">
    <RouterLink to="/admin" class="back-link"><Fa icon="arrow-left" /> Back to pages</RouterLink>
    <div class="page-heading">
      <div>
        <div class="eyebrow">A FITTING ICON FOR EVERY LINK</div>
        <h1>Icon rules</h1>
        <p class="muted">
          Links without a chosen icon use the first rule that matches their URL, then a built-in
          guess.
        </p>
      </div>
    </div>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <div v-if="loading" class="empty"><Fa icon="spinner" spin /> Loading…</div>
    <form v-else @submit.prevent="save">
      <section class="form-panel">
        <div class="section-heading">
          <h2><Fa icon="layer-group" /> Rules</h2>
          <span class="muted small">{{ rules.length }} / 100</span>
        </div>
        <p class="field-help">
          Patterns match host and path, without <code>https://</code> or <code>www.</code>:
          <code>realpython.com/courses/*</code>. <code>*</code> matches anything, and a pattern
          without a path, like <code>github.com</code>, covers the whole site. Order matters: put
          specific rules above general ones.
        </p>
        <p v-if="!rules.length" class="muted small">No rules yet. Built-in guesses apply.</p>
        <div v-for="(rule, i) in rules" :key="i" class="icon-rule">
          <span class="icon-swatch" aria-hidden="true"><Fa :icon="faIcon(rule.icon)" /></span>
          <label class="icon-rule-pattern"
            ><span class="sr-only">Pattern {{ i + 1 }}</span
            ><input
              v-model="rule.pattern"
              required
              maxlength="300"
              placeholder="example.com/blog/*"
              spellcheck="false"
              autocapitalize="off"
          /></label>
          <label class="icon-rule-icon"
            ><span class="sr-only">Icon for rule {{ i + 1 }}</span
            ><select v-model="rule.icon">
              <option v-for="ic in linkIcons" :key="ic.id" :value="ic.id">{{ ic.label }}</option>
            </select></label
          >
          <div class="row-actions">
            <button
              type="button"
              class="icon-button"
              :disabled="i === 0"
              :aria-label="'Move rule ' + (i + 1) + ' up'"
              @click="move(i, -1)"
            >
              <Fa icon="chevron-up" /></button
            ><button
              type="button"
              class="icon-button"
              :disabled="i === rules.length - 1"
              :aria-label="'Move rule ' + (i + 1) + ' down'"
              @click="move(i, 1)"
            >
              <Fa icon="chevron-down" /></button
            ><button
              type="button"
              class="icon-button"
              :aria-label="'Remove rule ' + (i + 1)"
              @click="rules.splice(i, 1)"
            >
              <Fa icon="trash" />
            </button>
          </div>
          <IconGallery v-model="rule.icon" :label="'Icon for rule ' + (i + 1)" />
        </div>
        <div class="add-items">
          <button
            type="button"
            class="add-link"
            :disabled="rules.length >= 100"
            @click="rules.push({ pattern: '', icon: 'file-lines' })"
          >
            <Fa icon="plus" /> Add rule
          </button>
        </div>
      </section>
      <section class="form-panel">
        <h2><Fa icon="magnifying-glass" /> Try a URL</h2>
        <label
          >URL<input v-model="testUrl" type="url" placeholder="https://realpython.com/courses/…"
        /></label>
        <p v-if="tested" class="icon-test">
          <span class="icon-swatch" aria-hidden="true"><Fa :icon="faIcon(tested.icon)" /></span>
          <span
            ><strong>{{ iconLabel(tested.icon) }}</strong
            ><small class="muted">from {{ tested.reason }}</small></span
          >
        </p>
      </section>
      <div class="form-actions">
        <button class="primary" :disabled="saving || !changed">
          <Fa v-if="saving" icon="spinner" spin /> Save rules
        </button>
      </div>
    </form>
  </section>
</template>
