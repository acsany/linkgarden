import { reactive } from 'vue';

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
const standalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
export const pwaState = reactive({
  online: navigator.onLine,
  standalone: standalone(),
  installAvailable: false,
  updateAvailable: false,
});
let prompt: InstallPrompt | undefined;
let registration: ServiceWorkerRegistration | undefined;
let refreshing = false;
export function initializePwa() {
  window.addEventListener('online', () => {
    pwaState.online = true;
    window.dispatchEvent(new Event('linkgarden:changed'));
    void registration?.update().catch(() => {});
  });
  window.addEventListener('offline', () => {
    pwaState.online = false;
  });
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    prompt = event as InstallPrompt;
    pwaState.installAvailable = true;
  });
  window.addEventListener('appinstalled', () => {
    prompt = undefined;
    pwaState.installAvailable = false;
    pwaState.standalone = true;
  });
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  let controlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) window.location.reload();
    else if (controlled) pwaState.updateAvailable = true;
    controlled = true;
  });
  const register = async () => {
    try {
      registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      pwaState.updateAvailable = Boolean(registration.waiting);
      const observeInstalling = () => {
        const worker = registration?.installing;
        if (!worker) return;
        const check = () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller)
            pwaState.updateAvailable = true;
        };
        worker.addEventListener('statechange', check);
        check();
      };
      registration.addEventListener('updatefound', observeInstalling);
      observeInstalling();
      window.addEventListener('focus', () => {
        if (navigator.onLine) void registration?.update().catch(() => {});
      });
    } catch {
      /* The online app remains usable if browser policy blocks registration. */
    }
  };
  if (document.readyState === 'complete') void register();
  else window.addEventListener('load', () => void register(), { once: true });
}
export async function installPwa() {
  if (!prompt) return false;
  const current = prompt;
  prompt = undefined;
  pwaState.installAvailable = false;
  await current.prompt();
  await current.userChoice;
  return true;
}
export function refreshPwa() {
  if (!pwaState.online || !pwaState.updateAvailable) return;
  refreshing = true;
  if (registration?.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  else window.location.reload();
}
