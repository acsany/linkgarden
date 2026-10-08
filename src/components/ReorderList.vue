<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef } from 'vue';
import type { Link } from '../types';
import { linkText } from '../state';
import { faIcon } from '../linkIcon';
import { resolveIcon, type IconRule } from '../../shared/icons';
import { groups, intoSection, nearest, place, plan, step, type Plan, type Step } from '../reorder';
const props = defineProps<{ links: Link[]; rules?: IconRule[] }>();
const emit = defineEmits<{ 'update:links': [links: Link[]] }>();
// Items are held by identity: indexes change with every move.
const selected = shallowRef(new Set<Link>()),
  collapsed = shallowRef(new Set<Link>()),
  announcement = ref('');
interface Row {
  link: Link;
  index: number;
  inSection: boolean;
  count: number;
}
const rows = computed(() =>
  groups(props.links).flatMap((g) => {
    const head: Row[] =
      g.section === null
        ? []
        : [
            {
              link: props.links[g.section],
              index: g.section,
              inSection: false,
              count: g.items.length,
            },
          ];
    if (g.section !== null && collapsed.value.has(props.links[g.section])) return head;
    return [
      ...head,
      ...g.items.map((i) => ({
        link: props.links[i],
        index: i,
        inSection: g.section !== null,
        count: 0,
      })),
    ];
  }),
);
const sections = computed(() => props.links.filter((l) => l.kind === 'section'));
const title = (l: Link) =>
  l.title ||
  (l.kind === 'file' ? l.file?.filename || 'PDF' : l.kind === 'link' ? linkText(l.url) : '') ||
  'Untitled';
const meta = (r: Row) =>
  r.link.kind === 'section'
    ? `${r.count} ${r.count === 1 ? 'item' : 'items'}`
    : r.link.kind === 'file'
      ? 'PDF'
      : linkText(r.link.url, false);
const icon = (l: Link) => faIcon(resolveIcon(l, props.rules));

let anchor: Link | null = null;
function toggle(r: Row, e: MouseEvent) {
  if (suppressClick) return;
  const next = new Set(selected.value);
  const visible = rows.value.map((x) => x.link);
  const from = anchor ? visible.indexOf(anchor) : -1;
  if (e.shiftKey && from >= 0) {
    const to = visible.indexOf(r.link);
    for (const l of visible.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(l);
  } else if (next.has(r.link)) next.delete(r.link);
  else next.add(r.link);
  anchor = r.link;
  selected.value = next;
}
function toggleCollapse(section: Link) {
  const next = new Set(collapsed.value);
  if (next.has(section)) next.delete(section);
  else next.add(section);
  collapsed.value = next;
}
const allCollapsed = computed(
  () => sections.value.length > 0 && sections.value.every((s) => collapsed.value.has(s)),
);
function collapseAll() {
  collapsed.value = allCollapsed.value ? new Set() : new Set(sections.value);
}

function apply(p: Plan<Link>, at: number | null) {
  if (at === null || at === p.current) return;
  emit('update:links', place(p, at));
  const sectionCount = p.block.filter((l) => l.kind === 'section').length;
  announcement.value =
    `Moved ${p.block.length} ${p.block.length === 1 ? 'item' : 'items'}` +
    (sectionCount
      ? `, including ${sectionCount} ${sectionCount === 1 ? 'section' : 'sections'}`
      : '') +
    '.';
}
const current = computed(() => (selected.value.size ? plan(props.links, selected.value) : null));
const canMove = (where: Step) => !!current.value && step(current.value, where) !== null;
function moveBy(where: Step) {
  if (current.value) apply(current.value, step(current.value, where));
}
const hasSection = computed(() => !!current.value?.block.some((l) => l.kind === 'section'));
function moveInto(e: Event) {
  const select = e.target as HTMLSelectElement;
  const value = select.value;
  select.value = '';
  if (!current.value || !value) return;
  const section = value === 'top' ? null : sections.value[Number(value)];
  apply(current.value, intoSection(current.value, section));
}

// Dragging: the grip works for touch and mouse; a mouse can also drag the whole row.
const list = ref<HTMLElement>();
const drag = shallowRef<{ plan: Plan<Link>; at: number | null; inBlock: Set<Link> } | null>(null);
let start: { x: number; y: number; link: Link } | null = null,
  lastY = 0,
  frame = 0,
  suppressClick = false;
function down(e: PointerEvent, link: Link, grip: boolean) {
  if (!grip && (e.pointerType !== 'mouse' || e.button !== 0)) return;
  start = { x: e.clientX, y: e.clientY, link };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}
function move(e: PointerEvent) {
  lastY = e.clientY;
  if (!drag.value && start) {
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6) return;
    if (!selected.value.has(start.link)) selected.value = new Set([start.link]);
    const p = plan(props.links, selected.value);
    drag.value = { plan: p, at: p.current, inBlock: new Set(p.block) };
    frame = requestAnimationFrame(scroll);
  }
  if (drag.value) {
    e.preventDefault();
    target();
  }
}
// The drop point is before the first visible row whose middle is below the pointer.
function target() {
  const d = drag.value;
  if (!d || !list.value) return;
  const els = [...list.value.querySelectorAll<HTMLElement>('[data-index]')];
  const before = els.find((el) => {
    const r = el.getBoundingClientRect();
    return lastY < r.top + r.height / 2;
  });
  const index = before ? Number(before.dataset.index) : props.links.length;
  const pos = props.links.slice(0, index).filter((l) => !d.inBlock.has(l)).length;
  drag.value = { ...d, at: nearest(d.plan.allowed, pos) };
}
function scroll() {
  const edge = 70;
  const speed = lastY < edge ? -12 : lastY > innerHeight - edge ? 12 : 0;
  if (speed) {
    scrollBy(0, speed);
    target();
  }
  frame = requestAnimationFrame(scroll);
}
function stop() {
  cancelAnimationFrame(frame);
  window.removeEventListener('pointermove', move);
  window.removeEventListener('pointerup', up);
  window.removeEventListener('pointercancel', cancel);
  start = null;
}
function up() {
  const d = drag.value;
  stop();
  drag.value = null;
  if (!d) return;
  // The click that follows a drag must not toggle the row.
  suppressClick = true;
  setTimeout(() => (suppressClick = false));
  apply(d.plan, d.at);
}
function cancel() {
  stop();
  drag.value = null;
}
onUnmounted(stop);
// Where the drop line shows: before the first visible row of the rest at that position.
const dropBefore = computed(() => {
  const d = drag.value;
  if (!d || d.at === null) return null;
  const visible = new Set(rows.value.map((r) => r.link));
  return d.plan.rest.slice(d.at).find((l) => visible.has(l)) ?? 'end';
});
</script>
<template>
  <div class="reorder">
    <div class="reorder-toolbar" role="toolbar" aria-label="Move selected items">
      <span class="reorder-count">{{
        selected.size ? `${selected.size} selected` : 'Select items to move'
      }}</span>
      <div class="reorder-moves">
        <button type="button" :disabled="!canMove('top')" @click="moveBy('top')">To top</button
        ><button
          type="button"
          class="icon-button"
          aria-label="Move selected up"
          title="Move up"
          :disabled="!canMove('up')"
          @click="moveBy('up')"
        >
          <Fa icon="chevron-up" /></button
        ><button
          type="button"
          class="icon-button"
          aria-label="Move selected down"
          title="Move down"
          :disabled="!canMove('down')"
          @click="moveBy('down')"
        >
          <Fa icon="chevron-down" /></button
        ><button type="button" :disabled="!canMove('bottom')" @click="moveBy('bottom')">
          To bottom
        </button>
        <select
          v-if="sections.length"
          aria-label="Move selected into section"
          :disabled="!selected.size || hasSection"
          :title="hasSection ? 'Sections cannot go inside other sections' : ''"
          @change="moveInto"
        >
          <option value="">Move into section…</option>
          <option value="top">Above all sections</option>
          <option v-for="(s, k) in sections" :key="s.id || k" :value="k">
            {{ s.title || 'Untitled section' }}
          </option>
        </select>
      </div>
      <div class="reorder-view">
        <button v-if="sections.length" type="button" class="text-button" @click="collapseAll">
          {{ allCollapsed ? 'Expand sections' : 'Collapse sections' }}</button
        ><button
          v-if="selected.size"
          type="button"
          class="text-button"
          @click="selected = new Set()"
        >
          Clear selection
        </button>
      </div>
    </div>
    <p class="field-help reorder-help">
      Tap items to select them, then drag a grip or use the buttons. A section moves with its links.
    </p>
    <ul ref="list" :class="['reorder-list', { dragging: drag, 'drop-end': dropBefore === 'end' }]">
      <li
        v-for="r in rows"
        :key="r.link.id || r.index"
        :data-index="r.index"
        :class="[
          'reorder-row',
          r.link.kind === 'section' ? 'reorder-section' : 'reorder-item',
          {
            nested: r.inSection,
            selected: selected.has(r.link),
            moving: drag?.inBlock.has(r.link),
            'drop-before': dropBefore === r.link,
          },
        ]"
        @pointerdown="down($event, r.link, false)"
      >
        <span
          class="reorder-grip"
          aria-hidden="true"
          title="Drag to move"
          @pointerdown.stop="down($event, r.link, true)"
          ><Fa icon="grip-vertical"
        /></span>
        <button
          type="button"
          class="reorder-pick"
          :aria-pressed="selected.has(r.link)"
          @click="toggle(r, $event)"
        >
          <span class="reorder-check" aria-hidden="true"
            ><Fa v-if="selected.has(r.link)" icon="check"
          /></span>
          <Fa
            :icon="
              r.link.kind === 'section'
                ? icon(r.link)
                : r.link.kind === 'file'
                  ? 'file-pdf'
                  : icon(r.link)
            "
            class="reorder-icon"
          />
          <span class="reorder-text"
            ><span class="reorder-title">{{ title(r.link) }}</span
            ><span class="reorder-meta">{{ meta(r) }}</span></span
          >
        </button>
        <button
          v-if="r.link.kind === 'section'"
          type="button"
          class="icon-button reorder-fold"
          :aria-expanded="!collapsed.has(r.link)"
          :aria-label="(collapsed.has(r.link) ? 'Expand ' : 'Collapse ') + title(r.link)"
          @click="toggleCollapse(r.link)"
        >
          <Fa :icon="collapsed.has(r.link) ? 'chevron-down' : 'chevron-up'" />
        </button>
      </li>
    </ul>
    <p class="sr-only" aria-live="polite">{{ announcement }}</p>
  </div>
</template>
