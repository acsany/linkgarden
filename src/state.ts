import { reactive } from 'vue';
export const state = reactive({
  ready: false,
  authenticated: false,
  configured: true,
  email: '',
  csrfToken: '',
  origin: location.origin,
  notice: '',
  adminContext: false,
  browserTools: sessionStorage.getItem('browserTools') !== 'off',
  webmcpStatus: 'unavailable',
});
let timer: ReturnType<typeof setTimeout>;
export function notify(message: string) {
  state.notice = message;
  clearTimeout(timer);
  timer = setTimeout(() => (state.notice = ''), 5000);
}
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(state.csrfToken ? { 'X-CSRF-Token': state.csrfToken } : {}),
      ...options.headers,
    },
  }).catch(() => {
    throw new Error(
      navigator.onLine
        ? 'Could not reach the server. Please try again.'
        : "You're offline. Reconnect and try again.",
    );
  });
  const data = await response.json().catch(() => ({ error: 'Unexpected server response.' }));
  if (!response.ok) {
    if (response.status === 401 && path.startsWith('/api/admin')) state.authenticated = false;
    throw new Error(data.error || `Request failed (${response.status}).`);
  }
  return data;
}
export async function refreshSession() {
  try {
    const s = await api('/api/auth/session');
    Object.assign(state, s, { email: s.email || '', csrfToken: s.csrfToken || '' });
  } finally {
    state.ready = true;
  }
}
export const count = (v: number) => new Intl.NumberFormat().format(v);
export const fileSize = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1048576)} MB`;
// The URL line on a link card: the whole address without scheme and www, or only the domain.
export function linkText(url: string, full = true) {
  try {
    const u = new URL(url),
      host = u.hostname.replace(/^www\./, '');
    if (!full) return host;
    let path = u.pathname === '/' ? '' : u.pathname;
    try {
      path = decodeURI(path);
    } catch {
      // Keep malformed escapes as written.
    }
    return host + (u.port ? ':' + u.port : '') + path + u.search + u.hash;
  } catch {
    return 'Link';
  }
}
export const date = (v: string) =>
  new Date(v).toLocaleString(undefined, {
    timeZone: 'UTC',
    dateStyle: 'medium',
    timeStyle: 'short',
  }) + ' UTC';
