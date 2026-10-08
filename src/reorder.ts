// Pages are one ordered list; a section heads every item after it until the next
// section. These helpers treat a section and its items as one group, so moving a
// section takes its links along while the saved order stays a flat list.
export interface Item {
  kind: string;
}
export interface Group {
  section: number | null;
  items: number[];
}
export function groups(list: Item[]): Group[] {
  const out: Group[] = [];
  list.forEach((item, i) => {
    if (item.kind === 'section') out.push({ section: i, items: [] });
    else if (!out.length) out.push({ section: null, items: [i] });
    else out[out.length - 1].items.push(i);
  });
  return out;
}
// Selected sections bring their items; the block keeps the page order.
export function expand<T extends Item>(list: T[], selected: Set<T>) {
  const block = new Set<T>();
  let carrying = false;
  for (const item of list) {
    if (item.kind === 'section') carrying = selected.has(item);
    if (carrying || selected.has(item)) block.add(item);
  }
  return block;
}
// Positions in the list without the block where it may be inserted. A block with a
// section only lands between groups, or it would take over another section's links.
export function positions<T extends Item>(rest: T[], block: T[]) {
  const all = Array.from({ length: rest.length + 1 }, (_, p) => p);
  if (!block.some((i) => i.kind === 'section')) return all;
  return all.filter((p) => p === rest.length || rest[p].kind === 'section');
}
export function nearest(allowed: number[], p: number) {
  return allowed.reduce((best, q) => (Math.abs(q - p) < Math.abs(best - p) ? q : best));
}
export interface Plan<T> {
  block: T[];
  rest: T[];
  allowed: number[];
  // Where the block sits now, in rest positions.
  current: number;
}
export function plan<T extends Item>(list: T[], selected: Set<T>): Plan<T> {
  const inBlock = expand(list, selected);
  const block = list.filter((i) => inBlock.has(i)),
    rest = list.filter((i) => !inBlock.has(i));
  const first = list.findIndex((i) => inBlock.has(i));
  const current = list.slice(0, Math.max(first, 0)).filter((i) => !inBlock.has(i)).length;
  return { block, rest, allowed: positions(rest, block), current };
}
export function place<T>(p: Plan<T>, at: number): T[] {
  return [...p.rest.slice(0, at), ...p.block, ...p.rest.slice(at)];
}
export type Step = 'up' | 'down' | 'top' | 'bottom';
// The target position for a button move, or null when the block cannot go further.
export function step<T>(p: Plan<T>, where: Step): number | null {
  const target =
    where === 'top'
      ? p.allowed[0]
      : where === 'bottom'
        ? p.allowed[p.allowed.length - 1]
        : where === 'up'
          ? [...p.allowed].reverse().find((q) => q < p.current)
          : p.allowed.find((q) => q > p.current);
  return target === undefined || target === p.current ? null : target;
}
// End of a section's group in rest positions, or 0 for the items before any section.
export function intoSection<T extends Item>(p: Plan<T>, section: T | null) {
  if (!section) return 0;
  const start = p.rest.indexOf(section);
  if (start < 0) return null;
  const next = p.rest.findIndex((i, k) => k > start && i.kind === 'section');
  return next < 0 ? p.rest.length : next;
}
