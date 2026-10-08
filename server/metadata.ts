import { lookup } from 'node:dns/promises';
import type { Readable } from 'node:stream';
import ipaddr from 'ipaddr.js';
import { Agent, request } from 'undici';
import { load } from 'cheerio';
import { httpUrl } from '../shared/schemas.js';
import { videoInfo } from '../shared/video.js';
import { AppError } from './errors.js';
export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}
export async function publicAddress(input: string, signal?: AbortSignal) {
  const url = new URL(httpUrl.parse(input));
  if (url.port && !['80', '443'].includes(url.port))
    throw new AppError(400, 'Preview fetches only allow standard HTTP/HTTPS ports.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local'))
    throw new AppError(400, 'Private network URLs cannot be previewed.');
  const addresses = ipaddr.isValid(hostname)
    ? [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv6' ? 6 : 4 }]
    : await resolveWithDeadline(hostname, signal);
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    throw new AppError(400, 'Private network URLs cannot be previewed.');
  return { url, address: addresses[0] };
}
async function resolveWithDeadline(hostname: string, signal?: AbortSignal) {
  if (signal?.aborted) throw new AppError(422, 'Preview fetch timed out.');
  let timer: ReturnType<typeof setTimeout>;
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new AppError(422, 'Preview fetch timed out.'));
        timer = setTimeout(onAbort, 8000);
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer!);
    signal?.removeEventListener('abort', onAbort);
  }
}
const pageFetch = {
  accept: 'text/html,application/json',
  types: /text\/html|application\/json|application\/xhtml\+xml/,
  maxBytes: 1024 * 1024,
};
// undici emits RequestAbortedError when an unread body is destroyed; without a
// listener that error crashes the process (LinkedIn's 999 responses did).
function discard(body: Readable) {
  body.on('error', () => {});
  body.destroy();
}
export async function safeFetchBytes(
  input: string,
  options = pageFetch,
): Promise<{ content: Buffer; finalUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    let current = input;
    for (let hop = 0; hop < 5; hop++) {
      const { url, address } = await publicAddress(current, controller.signal);
      // Pin the validated address for this connection; never resolve it again during connect.
      const dispatcher = new Agent({
        connect: {
          autoSelectFamily: false,
          lookup: (_hostname, _options, callback) =>
            callback(null, address.address, address.family),
        },
      });
      try {
        const response = await request(url, {
          dispatcher,
          signal: controller.signal,
          headers: {
            'user-agent': 'Linkgarden/1.0 (link-preview)',
            accept: options.accept,
            'accept-encoding': 'identity',
          },
        });
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          const location = response.headers.location;
          discard(response.body);
          if (!location || Array.isArray(location))
            throw new AppError(400, 'Invalid preview redirect.');
          current = new URL(location, url).href;
          continue;
        }
        if (response.statusCode >= 400) {
          discard(response.body);
          throw new AppError(422, 'This website did not return a preview.');
        }
        if (!options.types.test(String(response.headers['content-type']))) {
          discard(response.body);
          throw new AppError(422, 'This URL has no supported preview.');
        }
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > options.maxBytes) {
            discard(response.body);
            throw new AppError(422, 'Preview response is too large.');
          }
          chunks.push(Buffer.from(chunk));
        }
        return { content: Buffer.concat(chunks), finalUrl: url.href };
      } finally {
        await dispatcher.close();
      }
    }
    throw new AppError(422, 'Too many preview redirects.');
  } finally {
    clearTimeout(timer);
  }
}
export async function safeFetch(input: string, options = pageFetch) {
  const result = await safeFetchBytes(input, options);
  return { ...result, content: result.content.toString('utf8') };
}
export async function fetchImage(input: string) {
  return (
    await safeFetchBytes(input, {
      accept: 'image/jpeg,image/png,image/webp,image/gif,image/avif',
      types: /^image\/(jpeg|png|webp|gif|avif)(?:;|$)/i,
      maxBytes: 5 * 1024 * 1024,
    })
  ).content;
}
// Sites that block preview fetches can still publish their items in a feed. Feeds
// are larger than pages, so they get their own bound and are cached briefly.
const feeds = [
  {
    match: /^https:\/\/(www\.)?realpython\.com\/podcasts\/rpp\/\d+\/?$/,
    url: 'https://realpython.com/podcasts/rpp/feed',
  },
];
const feedFetch = {
  accept: 'application/rss+xml,application/xml,text/xml',
  types: /xml/,
  maxBytes: 4 * 1024 * 1024,
};
type FeedItem = { title: string; imageUrl: string };
const feedCache = new Map<string, { at: number; items: Map<string, FeedItem> }>();
const feedKey = (url: string) =>
  url
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/\/+$/, '');
export async function feedItem(url: string): Promise<FeedItem | null> {
  const feed = feeds.find((f) => f.match.test(url));
  if (!feed) return null;
  let cached = feedCache.get(feed.url);
  if (!cached || Date.now() - cached.at > 3600000) {
    const { content, finalUrl } = await safeFetch(feed.url, feedFetch);
    const $ = load(content, { xml: true });
    const items = new Map<string, FeedItem>();
    $('item').each((_, el) => {
      const item = $(el);
      const link = item.children('link').first().text().trim();
      const image = item.children('itunes\\:image').first().attr('href') || '';
      if (link)
        items.set(feedKey(link), {
          title: item.children('title').first().text().trim(),
          imageUrl: image ? new URL(image, finalUrl).href : '',
        });
    });
    cached = { at: Date.now(), items };
    feedCache.set(feed.url, cached);
  }
  return cached.items.get(feedKey(url)) ?? null;
}
export async function fetchMetadata(input: string) {
  const metadata = await fetchPage(input);
  if (metadata.imageUrl) return metadata;
  try {
    const item = await feedItem(httpUrl.parse(input));
    if (!item?.imageUrl) return metadata;
    await publicAddress(item.imageUrl);
    return {
      ...metadata,
      // A failed page fetch only has the host name as its title.
      title: (metadata.warning && item.title ? item.title : metadata.title).slice(0, 200),
      imageUrl: item.imageUrl,
      warning: '',
    };
  } catch {
    return metadata;
  }
}
async function fetchPage(input: string) {
  const url = httpUrl.parse(input);
  const video = videoInfo(url);
  const fallback = {
    title: new URL(url).hostname.replace(/^www\./, ''),
    description: '',
    imageUrl: video?.thumbnail || '',
    embedUrl: video?.embedUrl || null,
    warning: '',
  };
  try {
    const endpoint =
      video?.provider === 'youtube'
        ? `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
        : video?.provider === 'vimeo'
          ? `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`
          : url;
    const { content, finalUrl } = await safeFetch(endpoint);
    let title = '';
    let description = '';
    let imageUrl = '';
    if (video) {
      const data = JSON.parse(content);
      title = String(data.title || '');
      imageUrl = String(data.thumbnail_url || fallback.imageUrl);
    } else {
      const $ = load(content);
      const meta = (key: string) =>
        $(`meta[property="${key}"],meta[name="${key}"]`).first().attr('content') || '';
      title = meta('og:title') || meta('twitter:title') || $('title').first().text();
      description = meta('og:description') || meta('description');
      imageUrl = meta('og:image') || meta('twitter:image');
    }
    if (imageUrl) {
      imageUrl = new URL(imageUrl, finalUrl).href;
      await publicAddress(imageUrl);
    }
    return {
      ...fallback,
      title: (title || fallback.title).trim().slice(0, 200),
      description: description.trim().slice(0, 1000),
      imageUrl: imageUrl || fallback.imageUrl,
    };
  } catch (err) {
    return {
      ...fallback,
      warning:
        err instanceof AppError
          ? err.message
          : 'Automatic preview unavailable. You can set the title and image manually.',
    };
  }
}
