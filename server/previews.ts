import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import type { Database } from './db.js';
import { fetchImage, fetchMetadata } from './metadata.js';
import { httpUrl } from '../shared/schemas.js';
import { videoInfo } from '../shared/video.js';
import { AppError } from './errors.js';

// Preserve path case, meaningful query parameters, and trailing slashes on other hosts.
export function previewKey(input: string) {
  const url = new URL(httpUrl.parse(input));
  url.hash = '';
  for (const key of [...url.searchParams.keys()])
    if (/^utm_/i.test(key) || ['fbclid', 'gclid'].includes(key)) url.searchParams.delete(key);
  if (['realpython.com', 'www.realpython.com'].includes(url.hostname)) {
    url.protocol = 'https:';
    url.hostname = 'realpython.com';
    url.pathname = url.pathname.replace(/\/*$/, '/');
  }
  url.searchParams.sort();
  return url.href;
}
export const importPreviewSchema = z
  .object({
    url: httpUrl,
    title: z.string().max(200).default(''),
    description: z.string().max(1000).default(''),
    imageUrl: httpUrl.optional(),
    // Laptop importer sends a compressed thumbnail, never CMS credentials or article bodies.
    imageBase64: z
      .string()
      .max(700000)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .optional(),
  })
  .refine((v) => !!v.imageUrl !== !!v.imageBase64, 'Supply imageUrl or imageBase64, but not both.');

export async function thumbnail(bytes: Buffer) {
  if (!bytes.length || bytes.length > 5 * 1024 * 1024)
    throw new AppError(422, 'Preview images must be between 1 byte and 5 MB.');
  try {
    const input = sharp(bytes, { limitInputPixels: 25000000, failOn: 'warning' });
    const metadata = await input.metadata();
    if (!['jpeg', 'png', 'webp', 'gif', 'heif'].includes(metadata.format || ''))
      throw new Error('Unsupported image');
    const output = await input
      .rotate()
      .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .timeout({ seconds: 5 })
      .toBuffer();
    if (output.length > 500000) throw new Error('Too large');
    return output;
  } catch {
    throw new AppError(
      422,
      'Use a valid JPEG, PNG, WebP, GIF, or AVIF image (at most 25 megapixels).',
    );
  }
}

// Matched by path, so stored URLs keep working if the configured origin changes.
const storedImage = /^(?:https?:\/\/[^/?#]+)?\/api\/public\/images\/([a-f0-9]{64})$/;
// Failed sources and targets are not refetched on every save or backfill call.
const retryAfter = 6 * 3600000;
const safeKey = (url: string) => {
  try {
    return previewKey(url);
  } catch {
    return null;
  }
};

export class PreviewStore {
  failedSources = new Map<string, number>();
  failedTargets = new Map<string, number>();
  constructor(
    public db: Database,
    public origin: string,
  ) {}
  url(id: string) {
    return `${this.origin}/api/public/images/${id}`;
  }
  id(url: string) {
    return storedImage.exec(url)?.[1] ?? null;
  }
  recentlyFailed(failures: Map<string, number>, key: string) {
    const at = failures.get(key);
    return at !== undefined && Date.now() - at < retryAfter;
  }
  forgetFailures() {
    for (const failures of [this.failedSources, this.failedTargets])
      for (const [key, at] of failures) if (Date.now() - at >= retryAfter) failures.delete(key);
  }
  // Public images for links, in order: the stored image, the stored copy of an external
  // source, then the cached preview of the link's target. Never the external URL.
  async publicImages(links: { kind: string; url: string; imageUrl: string }[]) {
    const ids = new Set<string>();
    const sources = new Set<string>();
    const keys = new Set<string>();
    for (const link of links) {
      if (!link.imageUrl) continue;
      const id = this.id(link.imageUrl);
      if (id) ids.add(id);
      else sources.add(link.imageUrl);
      const key = link.kind === 'link' ? safeKey(link.url) : null;
      if (key) keys.add(key);
    }
    const lookup = async (sql: string, values: Set<string>) =>
      values.size
        ? new Map(
            (await this.db.query(sql, [[...values]])).rows.map((r) => [r.key, r.id as string]),
          )
        : new Map<string, string>();
    const [stored, fromSource, fromCache] = await Promise.all([
      lookup('SELECT id AS key,id FROM preview_images WHERE id=ANY($1::text[])', ids),
      lookup(
        'SELECT url AS key,image_id AS id FROM preview_sources WHERE url=ANY($1::text[])',
        sources,
      ),
      lookup('SELECT url AS key,image_id AS id FROM preview_cache WHERE url=ANY($1::text[])', keys),
    ]);
    return links.map((link) => {
      if (!link.imageUrl) return '';
      const id = this.id(link.imageUrl);
      const key = link.kind === 'link' ? safeKey(link.url) : null;
      const found =
        (id ? stored.get(id) : fromSource.get(link.imageUrl)) || (key && fromCache.get(key));
      return found ? this.url(found) : '';
    });
  }
  async resolve(source: string) {
    if (!source) return '';
    const id = this.id(source);
    const result = id
      ? await this.db.query('SELECT id FROM preview_images WHERE id=$1', [id])
      : await this.db.query('SELECT image_id AS id FROM preview_sources WHERE url=$1', [source]);
    return result.rows[0] ? this.url(result.rows[0].id) : '';
  }
  async store(bytes: Buffer) {
    const image = await thumbnail(bytes);
    const id = createHash('sha256').update(image).digest('hex');
    await this.db.query(
      'INSERT INTO preview_images(id,bytes) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [id, image],
    );
    return this.url(id);
  }
  async remote(source: string) {
    const known = await this.resolve(source);
    if (known) return known;
    // Do not fetch arbitrary paths from our own server through the public fetcher.
    if (this.id(source)) throw new AppError(404, 'Stored preview image unavailable.');
    if (this.recentlyFailed(this.failedSources, source))
      throw new AppError(422, 'This image could not be fetched recently.');
    let imageUrl: string;
    try {
      imageUrl = await this.store(await fetchImage(source));
    } catch (err) {
      this.failedSources.set(source, Date.now());
      throw err;
    }
    this.failedSources.delete(source);
    await this.db.query(
      'INSERT INTO preview_sources(url,image_id) VALUES($1,$2) ON CONFLICT(url) DO UPDATE SET image_id=excluded.image_id,created_at=now()',
      [source, this.id(imageUrl)],
    );
    return imageUrl;
  }
  async cached(input: string) {
    const key = safeKey(input);
    const row = key
      ? (await this.db.query('SELECT * FROM preview_cache WHERE url=$1', [key])).rows[0]
      : undefined;
    return row
      ? {
          title: row.title as string,
          description: row.description as string,
          imageUrl: this.url(row.image_id),
          embedUrl: videoInfo(input)?.embedUrl || null,
          warning: '',
        }
      : null;
  }
  async remember(url: string, title: string, description: string, imageUrl: string) {
    const id = this.id(imageUrl);
    if (!id) return;
    await this.db.query(
      `INSERT INTO preview_cache(url,title,description,image_id) VALUES($1,$2,$3,$4)
      ON CONFLICT(url) DO UPDATE SET title=excluded.title,description=excluded.description,image_id=excluded.image_id,updated_at=now()`,
      [previewKey(url), title, description, id],
    );
  }
  // With store=false (read-only agent tokens) nothing is fetched into or written to the cache.
  async known(input: string, store = true) {
    const cached = await this.cached(input);
    if (cached) return cached;
    const key = previewKey(input);
    // Legacy records predate the shared cache. Their title and description may be
    // private page-specific edits, so only reuse their stored image.
    const links = (
      await this.db.query(
        "SELECT url,title,description,image_url FROM links WHERE kind='link' AND image_url<>'' ORDER BY created_at DESC",
      )
    ).rows;
    for (const link of links) {
      if (safeKey(link.url) !== key) continue;
      try {
        const imageUrl = store
          ? await this.remote(link.image_url)
          : await this.resolve(link.image_url);
        if (!imageUrl) continue;
        if (store) await this.remember(input, '', '', imageUrl);
        return {
          title: '',
          description: '',
          imageUrl,
          embedUrl: videoInfo(input)?.embedUrl || null,
          warning: '',
        };
      } catch {
        /* A stale image should not prevent another source from being tried. */
      }
    }
    return null;
  }
  async preview(url: string, store = true) {
    const known = await this.known(url, store);
    if (known) return known;
    const metadata = await fetchMetadata(url);
    if (!metadata.imageUrl || !store) return metadata;
    try {
      metadata.imageUrl = await this.remote(metadata.imageUrl);
      await this.remember(url, metadata.title, metadata.description, metadata.imageUrl);
    } catch {
      metadata.imageUrl = '';
      metadata.warning =
        'The preview image could not be saved. You can import it from your laptop or choose another image URL.';
    }
    return metadata;
  }
  // A stored image for an existing link: its own image if that can be saved, else the
  // target's cached preview. Links without an image only get one when fill is set.
  async linkImage(link: Record<string, any>) {
    if (link.image_url) {
      try {
        return await this.remote(link.image_url);
      } catch (err) {
        const cached = await this.cached(link.url);
        if (cached) return cached.imageUrl;
        throw err;
      }
    }
    const imageUrl = (await this.preview(link.url)).imageUrl;
    if (!imageUrl) throw new Error('No image');
    return imageUrl;
  }
  // Targets that failed recently are skipped, so repeated calls always make progress.
  async backfill({ fill = true, limit = 20 }: { fill?: boolean; limit?: number } = {}) {
    const links = (
      await this.db.query(
        "SELECT id,url,image_url FROM links WHERE kind='link' ORDER BY created_at",
      )
    ).rows;
    const groups = new Map<string, typeof links>();
    for (const link of links) {
      if (this.id(link.image_url) || (!fill && !link.image_url)) continue;
      const key = safeKey(link.url);
      if (key) groups.set(key, [...(groups.get(key) || []), link]);
    }
    const failed: string[] = [];
    let updated = 0,
      processed = 0,
      retryLater = 0;
    for (const [target, group] of groups) {
      if (processed >= limit) break;
      if (this.recentlyFailed(this.failedTargets, target)) {
        retryLater++;
        continue;
      }
      processed++;
      for (const link of group) {
        try {
          const imageUrl = await this.linkImage(link);
          const result = await this.db.query(
            'UPDATE links SET image_url=$2 WHERE id=$1 AND image_url=$3 RETURNING id',
            [link.id, imageUrl, link.image_url],
          );
          updated += result.rows.length;
        } catch {
          if (!failed.includes(target)) failed.push(target);
        }
      }
      if (failed.includes(target)) this.failedTargets.set(target, Date.now());
      else this.failedTargets.delete(target);
    }
    return {
      updated,
      failed,
      retryLater,
      remainingTargets: groups.size - processed - retryLater,
    };
  }
  async import(input: z.infer<typeof importPreviewSchema>) {
    const data = importPreviewSchema.parse(input);
    const imageUrl = data.imageBase64
      ? await this.store(Buffer.from(data.imageBase64, 'base64'))
      : await this.remote(data.imageUrl!);
    await this.remember(data.url, data.title, data.description, imageUrl);
    const key = previewKey(data.url);
    this.failedTargets.delete(key);
    // Repair links to this target without a working image; keep images that already work.
    const links = (await this.db.query("SELECT id,url,image_url FROM links WHERE kind='link'"))
      .rows;
    let updated = 0;
    for (const link of links) {
      if (safeKey(link.url) !== key) continue;
      if (link.image_url && (await this.resolve(link.image_url))) continue;
      const result = await this.db.query(
        'UPDATE links SET image_url=$2 WHERE id=$1 AND image_url=$3 RETURNING id',
        [link.id, imageUrl, link.image_url],
      );
      updated += result.rows.length;
    }
    return { url: key, imageUrl, updated };
  }
  async cleanup() {
    this.forgetFailures();
    // Mappings and images that a saved link still uses are kept regardless of age.
    await this.db.query(
      "DELETE FROM preview_sources WHERE created_at < now() - interval '365 days' AND NOT EXISTS (SELECT 1 FROM links WHERE image_url=preview_sources.url)",
    );
    await this.db.query("DELETE FROM preview_cache WHERE updated_at < now() - interval '365 days'");
    await this.db.query(
      "DELETE FROM preview_images WHERE created_at < now() - interval '1 day' AND NOT EXISTS (SELECT 1 FROM preview_sources WHERE image_id=preview_images.id) AND NOT EXISTS (SELECT 1 FROM preview_cache WHERE image_id=preview_images.id) AND NOT EXISTS (SELECT 1 FROM links WHERE image_url LIKE ('%/api/public/images/' || preview_images.id))",
    );
  }
}
