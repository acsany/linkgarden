import { describe, expect, it } from 'vitest';
import { groups, intoSection, place, plan, step } from '../src/reorder.js';

const item = (name: string) => ({ kind: name.startsWith('#') ? 'section' : 'link', name });
const page = (...names: string[]) => names.map(item);
const names = (list: { name: string }[]) => list.map((i) => i.name).join(' ');
const pick = (list: { name: string }[], ...wanted: string[]) =>
  new Set(list.filter((i) => wanted.includes(i.name)));

describe('reorder groups', () => {
  it('groups items under the section before them, with loose items first', () => {
    const list = page('a', '#A', 'b', 'c', '#B', '#C', 'd');
    expect(groups(list)).toEqual([
      { section: null, items: [0] },
      { section: 1, items: [2, 3] },
      { section: 4, items: [] },
      { section: 5, items: [6] },
    ]);
  });

  it('moves a section with its links, only between groups', () => {
    const list = page('a', '#A', 'b', 'c', '#B', 'd');
    const p = plan(list, pick(list, '#B'));
    expect(names(p.block)).toBe('#B d');
    // Before #A or at the end; never inside #A, and never above the loose item.
    expect(p.allowed).toEqual([1, 4]);
    expect(names(place(p, step(p, 'up')!))).toBe('a #B d #A b c');
    expect(step(p, 'down')).toBeNull();
    expect(names(place(p, step(p, 'top')!))).toBe('a #B d #A b c');
  });

  it('moves several selected links as one block, keeping their order', () => {
    const list = page('#A', 'a', 'b', '#B', 'c', 'd');
    const p = plan(list, pick(list, 'd', 'a'));
    expect(names(p.block)).toBe('a d');
    expect(names(place(p, step(p, 'top')!))).toBe('a d #A b #B c');
    expect(names(place(p, step(p, 'bottom')!))).toBe('#A b #B c a d');
    expect(names(place(p, step(p, 'down')!))).toBe('#A b a d #B c');
    expect(names(place(p, intoSection(p, list[3])!))).toBe('#A b #B c a d');
    expect(names(place(p, intoSection(p, null)!))).toBe('a d #A b #B c');
  });

  it('does not duplicate links that are selected along with their section', () => {
    const list = page('#A', 'a', '#B', 'b');
    const p = plan(list, pick(list, '#B', 'b'));
    expect(names(place(p, step(p, 'top')!))).toBe('#B b #A a');
  });
});
