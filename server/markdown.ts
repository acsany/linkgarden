import type { SiteService } from './sites.js';
type PublicSite = Awaited<ReturnType<SiteService['publicSite']>>['site'];
// Page text stays text: no newlines, inline markup, links, raw HTML, or line-start
// block markers (headings, lists, quotes) that would change the document structure.
export const mdText = (v: string) =>
  v
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_[\]()<>!~|]/g, '\\$&')
    .replace(/^([#>+=-]|\d+[.)])/, (m) => m.slice(0, -1) + '\\' + m.slice(-1));
// Validated http(s) URLs; parentheses and spaces are encoded so they cannot end the link.
const mdUrl = (v: string) =>
  v.replace(/[()\s<>]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1048576).toFixed(1).replace(/\.0$/, '')} MB`;
// Built only from publicSite(), so notes, campaign names, and file storage never appear.
// `base` is the page URL including any campaign code; downloads keep the code.
export function siteMarkdown(site: PublicSite, origin: string, base: string) {
  if (site.mode === 'redirect') {
    const link = site.links[0]!;
    // A PDF redirect points back at the short URL itself, which downloads it.
    const url = link.kind === 'file' ? base : link.url;
    return `This link redirects to [${mdText(url)}](${mdUrl(url)}).\n`;
  }
  const out = [`# ${mdText(site.title)}`];
  if (site.description.trim()) out.push(mdText(site.description));
  let list: string[] = [];
  const flush = () => {
    if (list.length) out.push(list.join('\n'));
    list = [];
  };
  for (const link of site.links) {
    if (link.kind === 'section') {
      flush();
      out.push(`## ${mdText(link.title) || 'Section'}`);
      if (link.description.trim()) out.push(mdText(link.description));
      continue;
    }
    const file = link.kind === 'file' ? link.file : undefined;
    const url =
      link.kind === 'file'
        ? `${origin}/r/${link.id}${site.campaign ? '?c=' + encodeURIComponent(site.campaign) : ''}`
        : link.url;
    const title = link.title || file?.filename || link.url;
    const details = [
      link.description,
      ...(link.kind === 'file' ? ['PDF' + (file ? ', ' + size(file.size) : '')] : []),
    ].filter((v) => v.trim());
    list.push(
      `- [${mdText(title)}](${mdUrl(url)})` +
        (details.length ? ' — ' + details.map(mdText).join(' · ') : ''),
    );
  }
  flush();
  return out.join('\n\n') + '\n';
}
