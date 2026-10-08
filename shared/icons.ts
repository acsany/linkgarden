import { z } from 'zod';
// Icons a link can show. Ids are Font Awesome names; src/linkIcon.ts maps them to glyphs.
export const linkIcons = [
  { id: 'file-lines', label: 'Article' },
  { id: 'circle-play', label: 'Video or course' },
  { id: 'podcast', label: 'Podcast' },
  { id: 'newspaper', label: 'News' },
  { id: 'user', label: 'Profile' },
  { id: 'book', label: 'Book' },
  { id: 'graduation-cap', label: 'Class' },
  { id: 'code', label: 'Code' },
  { id: 'microphone', label: 'Talk' },
  { id: 'calendar', label: 'Event' },
  { id: 'envelope', label: 'Email' },
  { id: 'globe', label: 'Website' },
  { id: 'link', label: 'Link' },
  { id: 'github', label: 'GitHub' },
  { id: 'gitlab', label: 'GitLab' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'vimeo', label: 'Vimeo' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'x-twitter', label: 'X' },
  { id: 'bluesky', label: 'Bluesky' },
  { id: 'mastodon', label: 'Mastodon' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'stack-overflow', label: 'Stack Overflow' },
  { id: 'python', label: 'Python' },
] as const;
export type IconId = (typeof linkIcons)[number]['id'];
export const iconIds = linkIcons.map((i) => i.id) as [IconId, ...IconId[]];
export const iconLabel = (id: string) => linkIcons.find((i) => i.id === id)?.label ?? id;

// A rule maps a URL pattern such as realpython.com/courses/* to an icon. Patterns
// match host and path without scheme or www; * matches anything, and a pattern
// without a path covers the whole host.
export const iconRuleSchema = z.object({
  pattern: z.string().trim().min(1).max(300).regex(/^\S+$/, 'Patterns cannot contain spaces.'),
  icon: z.enum(iconIds),
});
export const iconRulesSchema = z.array(iconRuleSchema).max(100);
export type IconRule = z.infer<typeof iconRuleSchema>;

const subject = (url: string) => {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().replace(/^www\./, '') + u.pathname;
  } catch {
    return '';
  }
};
const patternRegex = (pattern: string) => {
  let p = pattern
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '');
  if (!p.includes('/')) p += '/*';
  return new RegExp(
    '^' +
      p
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
  );
};
export function ruleIcon(rules: IconRule[], url: string): IconId | '' {
  const s = subject(url);
  if (!s) return '';
  return rules.find((r) => patternRegex(r.pattern).test(s))?.icon ?? '';
}

// Built-in guesses for links that no rule or manual choice covers.
const hosts: [RegExp, IconId][] = [
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'],
  [/(^|\.)vimeo\.com$/, 'vimeo'],
  [/(^|\.)github\.(com|io)$/, 'github'],
  [/(^|\.)gitlab\.com$/, 'gitlab'],
  [/(^|\.)linkedin\.com$/, 'linkedin'],
  [/(^|\.)(x|twitter)\.com$/, 'x-twitter'],
  [/(^|\.)bsky\.app$/, 'bluesky'],
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)stackoverflow\.com$/, 'stack-overflow'],
  [/(^|\.)(pypi|python)\.org$/, 'python'],
  [/(^|\.)(mastodon\.social|fosstodon\.org)$/, 'mastodon'],
];
// Path words hint at what a page is; the first match wins.
const paths: [RegExp, IconId][] = [
  [/podcast|episode/, 'podcast'],
  [/course|lesson|video|watch/, 'circle-play'],
  [/news|blog/, 'newspaper'],
  [/team|author|about|profile|people/, 'user'],
];
export function autoIcon(url: string): IconId {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'link';
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  return (
    hosts.find(([p]) => p.test(host))?.[1] ??
    paths.find(([p]) => p.test(path))?.[1] ??
    (path.replace(/\/+$/, '') ? 'file-lines' : 'globe')
  );
}

// The icon an item shows: sections allow a manual choice; PDFs stay fixed. Links use the manual
// choice, then the first matching rule, then the built-in guess.
export function resolveIcon(
  l: { kind: string; url: string; icon?: string },
  rules: IconRule[] = [],
): string {
  if (l.kind === 'section') return l.icon || 'layer-group';
  if (l.kind === 'file') return 'file-pdf';
  return l.icon || ruleIcon(rules, l.url) || autoIcon(l.url);
}
