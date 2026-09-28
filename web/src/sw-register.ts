/** Registro do service worker + estratégia de atualização (o usuário decide quando recarregar). */
type Listener = (reg: ServiceWorkerRegistration) => void;
const listeners = new Set<Listener>();
let waiting: ServiceWorkerRegistration | null = null;

export function onUpdateAvailable(fn: Listener) {
  listeners.add(fn);
  if (waiting) fn(waiting);
  return () => listeners.delete(fn);
}

export function applyUpdate(reg: ServiceWorkerRegistration) {
  reg.waiting?.postMessage('SKIP_WAITING');
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const notify = () => { waiting = reg; listeners.forEach((l) => l(reg)); };
      if (reg.waiting && navigator.serviceWorker.controller) notify();
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw?.addEventListener('statechange', () => { if (sw.state === 'installed' && navigator.serviceWorker.controller) notify(); });
      });
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    } catch { /* PWA indisponível neste navegador: o app segue funcionando on-line */ }
  });
}
