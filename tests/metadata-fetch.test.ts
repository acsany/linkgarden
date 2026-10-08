import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
const stubs = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn(), connects: [] as any[] }));
vi.mock('node:dns/promises', () => ({ lookup: stubs.lookup }));
vi.mock('undici', () => ({
  Agent: class {
    constructor(options: any) {
      stubs.connects.push(options.connect);
    }
    async close() {}
  },
  request: stubs.request,
}));
import { safeFetch, fetchMetadata } from '../server/metadata.js';
function response(
  content: string,
  contentType = 'text/html',
  status = 200,
  headers: Record<string, string> = {},
) {
  return {
    statusCode: status,
    headers: { 'content-type': contentType, ...headers },
    body: Readable.from([Buffer.from(content)]),
  };
}
beforeEach(() => {
  stubs.lookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  stubs.request.mockReset();
  stubs.connects.length = 0;
});
describe('public preview fetches', () => {
  it('resolves relative images from the final URL after redirects', async () => {
    stubs.request
      .mockResolvedValueOnce(
        response('', 'text/html', 302, { location: 'https://destination.example/posts/article' }),
      )
      .mockResolvedValueOnce(response('<meta property="og:image" content="./thumbnail.jpg">'));
    expect((await fetchMetadata('https://short.example/a')).imageUrl).toBe(
      'https://destination.example/posts/thumbnail.jpg',
    );
  });
  it('parses Open Graph metadata and resolves relative images', async () => {
    stubs.request.mockResolvedValue(
      response(
        '<title>fallback</title><meta property="og:title" content="A useful page"><meta property="og:description" content="Short description"><meta property="og:image" content="/image.jpg">',
      ),
    );
    expect(await fetchMetadata('https://example.com/article')).toMatchObject({
      title: 'A useful page',
      description: 'Short description',
      imageUrl: 'https://example.com/image.jpg',
      warning: '',
    });
    const pinned = await new Promise((resolve, reject) =>
      stubs.connects[0].lookup('example.com', {}, (err: any, address: string, family: number) =>
        err ? reject(err) : resolve({ address, family }),
      ),
    );
    expect(pinned).toEqual({ address: '93.184.216.34', family: 4 });
  });
  it('discards unread error bodies without crashing the process', async () => {
    // Like undici, destroying an unread body emits an abort error.
    const body = new Readable({
      read() {},
      destroy(_err, callback) {
        callback(new Error('Request aborted'));
      },
    });
    stubs.request.mockResolvedValue({
      statusCode: 999,
      headers: { 'content-type': 'text/html' },
      body,
    });
    await expect(safeFetch('https://www.linkedin.com/in/example/')).rejects.toThrow(
      'did not return a preview',
    );
    await new Promise((resolve) => setImmediate(resolve));
  });
  it('rejects a public site redirecting into the local network before the second request', async () => {
    stubs.request.mockResolvedValue(
      response('', 'text/html', 302, { location: 'http://127.0.0.1/admin' }),
    );
    await expect(safeFetch('https://example.com')).rejects.toThrow('Private network');
    expect(stubs.request).toHaveBeenCalledTimes(1);
  });
  it('checks all DNS answers and each redirect host, preventing mixed-answer bypasses', async () => {
    stubs.lookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([
        { address: '93.184.216.35', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]);
    stubs.request.mockResolvedValue(
      response('', 'text/html', 302, { location: 'https://redirect.example/private' }),
    );
    await expect(safeFetch('https://example.com')).rejects.toThrow('Private network');
    expect(stubs.request).toHaveBeenCalledTimes(1);
  });
  it('bounds response size and rejects unsupported binary content', async () => {
    stubs.request
      .mockResolvedValueOnce(response('x'.repeat(1024 * 1024 + 1)))
      .mockResolvedValueOnce(response('image', 'image/png'));
    await expect(safeFetch('https://example.com')).rejects.toThrow('too large');
    await expect(safeFetch('https://example.com')).rejects.toThrow('supported preview');
  });
  it('caps redirect chains', async () => {
    stubs.request.mockResolvedValue(response('', 'text/html', 302, { location: '/again' }));
    await expect(safeFetch('https://example.com')).rejects.toThrow('Too many');
    expect(stubs.request).toHaveBeenCalledTimes(5);
  });
  it('loads video metadata from trusted oEmbed hosts, without accepting arbitrary embed HTML', async () => {
    stubs.request.mockResolvedValue(
      response(
        JSON.stringify({
          title: 'Video title',
          thumbnail_url: 'https://i.ytimg.com/video.jpg',
          html: '<script>evil()</script>',
        }),
        'application/json',
      ),
    );
    const data = await fetchMetadata('https://youtu.be/dQw4w9WgXcQ');
    expect(data.title).toBe('Video title');
    expect(data.embedUrl).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(data).not.toHaveProperty('html');
    expect(String(stubs.request.mock.calls[0][0])).toContain('https://www.youtube.com/oembed');
  });
});
describe('feed fallback for blocked sites', () => {
  it('takes a podcast episode title and image from its feed when the page is blocked', async () => {
    const feed = `<?xml version="1.0"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
      <itunes:image href="https://files.example/show.png"/>
      <item><title>Episode 288</title><link>https://realpython.com/podcasts/rpp/288/</link><itunes:image href="https://files.example/288.jpg"/></item>
      <item><title>Episode #287: Editing</title><link>https://realpython.com/podcasts/rpp/287/</link><itunes:image href="https://files.example/287.jpg"/></item>
    </channel></rss>`;
    stubs.request.mockImplementation(async (url: URL) =>
      String(url).endsWith('/feed')
        ? response(feed, 'application/xml; charset=utf-8')
        : response('Just a moment...', 'text/html', 403),
    );
    expect(await fetchMetadata('https://www.realpython.com/podcasts/rpp/287')).toMatchObject({
      title: 'Episode #287: Editing',
      imageUrl: 'https://files.example/287.jpg',
      warning: '',
    });
    // The parsed feed is cached, so a second episode needs only its page request.
    const calls = stubs.request.mock.calls.length;
    expect((await fetchMetadata('https://realpython.com/podcasts/rpp/288/')).imageUrl).toBe(
      'https://files.example/288.jpg',
    );
    expect(stubs.request.mock.calls.length).toBe(calls + 1);
    // Other pages on the site keep the plain fallback.
    expect(await fetchMetadata('https://realpython.com/python-logging/')).toMatchObject({
      imageUrl: '',
      warning: 'This website did not return a preview.',
    });
  });
});
