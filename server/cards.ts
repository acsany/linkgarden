import { createHash } from 'node:crypto';
import qrcode from 'qrcode-generator';
import sharp from 'sharp';
import { faLeaf } from '@fortawesome/free-solid-svg-icons/faLeaf';
import type { Database } from './db.js';
import { themes, type ThemeId } from '../shared/themes.js';
import { caption } from './card-text.js';

// Share cards: the og:image of a link collection, a QR code of the page's URL on the
// theme's light background, with "Scan to open" and the logo in the lower right.
// 1200x630 is the common Open Graph size; the QR code sits in the middle so a square
// crop (WhatsApp, X's small card) still shows it. Bump version to redraw every card.
const version = 1;
const width = 1200,
  height = 630,
  tile = 420,
  logo = 56,
  margin = 48;

// Card URLs carry this key, so a new slug, code, or theme gets a new image URL and
// platforms that cache images by URL fetch the new one.
export const cardKey = (url: string, theme: ThemeId) =>
  createHash('sha256').update(`${version}\n${theme}\n${url}`).digest('hex');

export function cardSvg(url: string, theme: ThemeId) {
  const colors = (themes.find((t) => t.id === theme) ?? themes[0]).card;
  const qr = qrcode(0, 'M');
  qr.addData(url, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  // Whole-pixel modules keep edges sharp in the PNG; at least two modules of quiet zone.
  const module = Math.floor(tile / (n + 4));
  const size = module * n;
  const x0 = (width - size) / 2,
    y0 = (height - size) / 2;
  let modules = '';
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c))
        modules += `M${x0 + c * module} ${y0 + r * module}h${module}v${module}h-${module}z`;
  const [glyphWidth, glyphHeight, , , glyph] = faLeaf.icon;
  const logoX = width - margin - logo,
    logoY = height - margin - logo;
  // Caption baseline sits so its capitals center on the logo.
  const textX = logoX - 18 - caption.width,
    textY = logoY + logo / 2 - caption.top / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="${colors.bg}"/>
<rect x="${(width - tile) / 2}" y="${(height - tile) / 2}" width="${tile}" height="${tile}" rx="24" fill="#fff" stroke="${colors.border}" stroke-width="2"/>
<path fill="${colors.ink}" shape-rendering="crispEdges" d="${modules}"/>
<path fill="${colors.muted}" transform="translate(${textX} ${textY})" d="${caption.path}"/>
<rect x="${logoX}" y="${logoY}" width="${logo}" height="${logo}" rx="14" fill="#6855d9"/>
<svg x="${logoX + 13}" y="${logoY + 13}" width="${logo - 26}" height="${logo - 26}" viewBox="0 0 ${glyphWidth} ${glyphHeight}"><path fill="#fff" d="${glyph}"/></svg>
</svg>`;
}

export class CardStore {
  constructor(
    public db: Database,
    public origin: string,
  ) {}
  pageUrl(slug: string, code?: string) {
    return `${this.origin}/${slug}${code ? '/' + code : ''}`;
  }
  // Slugs never contain a dot, so /api/public/cards/<slug>.png is unambiguous.
  url(slug: string, code: string | undefined, theme: ThemeId) {
    const v = cardKey(this.pageUrl(slug, code), theme).slice(0, 16);
    const c = code ? '&c=' + encodeURIComponent(code) : '';
    return `${this.origin}/api/public/cards/${slug}.png?v=${v}${c}`;
  }
  // Renders a card once and keeps the PNG; later requests and other pages with the same
  // URL and theme reuse it. Cards are small (about 20 KB), so they live in PostgreSQL.
  async png(url: string, theme: ThemeId) {
    const id = cardKey(url, theme);
    const found = (await this.db.query('SELECT bytes FROM share_cards WHERE id=$1', [id])).rows[0];
    if (found) return Buffer.from(found.bytes);
    const bytes = await sharp(Buffer.from(cardSvg(url, theme)))
      .png({ palette: true })
      .toBuffer();
    await this.db.query(
      'INSERT INTO share_cards(id,bytes) VALUES($1,$2) ON CONFLICT (id) DO NOTHING',
      [id, bytes],
    );
    return bytes;
  }
  // Saving a page draws its card right away, so the first share needs no rendering.
  // Campaign URLs get theirs on first use. A failure here never fails the save.
  async warm(site: { slug: string; mode: string; theme: ThemeId }) {
    if (site.mode !== 'aggregate') return;
    try {
      await this.png(this.pageUrl(site.slug), site.theme);
    } catch (err) {
      console.error('Share card failed', err);
    }
  }
  // Cards are redrawn on demand, so old ones can go; a renamed page's card is unreachable.
  async cleanup() {
    await this.db.query("DELETE FROM share_cards WHERE created_at < now() - interval '30 days'");
  }
}
