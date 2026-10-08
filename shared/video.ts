export function videoInfo(
  input: string,
): { provider: 'youtube' | 'vimeo'; id: string; embedUrl: string; thumbnail?: string } | null {
  try {
    const u = new URL(input);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    let id: string | undefined;
    if (host === 'youtu.be') id = u.pathname.split('/')[1];
    if (['youtube.com', 'm.youtube.com', 'youtube-nocookie.com'].includes(host)) {
      id = u.searchParams.get('v') || /^\/(?:shorts|embed|live)\/([^/]+)/.exec(u.pathname)?.[1];
    }
    if (id && /^[\w-]{11}$/.test(id))
      return {
        provider: 'youtube',
        id,
        embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      };
    if (host === 'vimeo.com' || host === 'player.vimeo.com') {
      const match = /^\/(?:video\/)?(\d+)(?:\/([\da-f]+))?\/?$/.exec(u.pathname);
      if (match) {
        const hash = match[2] || u.searchParams.get('h');
        return {
          provider: 'vimeo',
          id: match[1],
          embedUrl: `https://player.vimeo.com/video/${match[1]}${hash && /^[\da-f]+$/.test(hash) ? `?h=${hash}` : ''}`,
        };
      }
    }
  } catch {
    /* invalid URL */
  }
  return null;
}
