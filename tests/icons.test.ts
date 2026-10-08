import { describe, expect, it } from 'vitest';
import { autoIcon, resolveIcon, ruleIcon } from '../shared/icons.js';
const rules = [
  { pattern: 'realpython.com/courses/*', icon: 'circle-play' as const },
  { pattern: 'github.com', icon: 'code' as const },
  { pattern: '*.example.org/docs/*', icon: 'book' as const },
  { pattern: 'realpython.com/*', icon: 'file-lines' as const },
];
describe('icon rules', () => {
  it.each([
    ['https://realpython.com/courses/python-basics/', 'circle-play'],
    ['https://www.realpython.com/courses/', 'circle-play'],
    ['https://realpython.com/python-logging/', 'file-lines'],
    ['https://github.com/example', 'code'],
    ['https://github.com', 'code'],
    ['https://api.example.org/docs/intro', 'book'],
    ['https://example.org/docs/intro', ''],
    ['https://notgithub.com/x', ''],
    ['not a url', ''],
  ])('matches %s', (url, icon) => expect(ruleIcon(rules, url)).toBe(icon));
  it('treats pattern text literally apart from *', () =>
    expect(ruleIcon([{ pattern: 'a.b/c?', icon: 'book' }], 'https://axb/c')).toBe(''));
  it('prefers a manual icon, then rules, then built-in guesses', () => {
    expect(resolveIcon({ kind: 'link', url: 'https://github.com/x', icon: 'user' }, rules)).toBe(
      'user',
    );
    expect(resolveIcon({ kind: 'link', url: 'https://github.com/x' }, rules)).toBe('code');
    expect(resolveIcon({ kind: 'link', url: 'https://github.com/x' })).toBe('github');
    expect(resolveIcon({ kind: 'file', url: '' }, rules)).toBe('file-pdf');
    expect(resolveIcon({ kind: 'section', url: '' }, rules)).toBe('layer-group');
  });
  it.each([
    ['https://youtu.be/abc', 'youtube'],
    ['https://example.com/podcasts/12/', 'podcast'],
    ['https://example.com/', 'globe'],
    ['https://example.com/some-article', 'file-lines'],
  ])('guesses %s', (url, icon) => expect(autoIcon(url)).toBe(icon));
});
