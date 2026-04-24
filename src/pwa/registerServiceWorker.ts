export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  if (import.meta.env.DEV) {
    window.addEventListener('load', async () => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key.startsWith('orbit-lab-')).map((key) => caches.delete(key)));
      }
    });
    return;
  }

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      const announceUpdate = () => {
        const waiting = registration.waiting;
        if (!waiting) return;
        window.dispatchEvent(
          new CustomEvent('orbit-lab:update-available', {
            detail: {
              apply: async () => {
                waiting.postMessage({ type: 'SKIP_WAITING' });
              },
            },
          }),
        );
      };

      if (registration.waiting) {
        announceUpdate();
      }

      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            announceUpdate();
          }
        });
      });

      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.location.reload();
      });
    } catch (error) {
      console.error('Service worker registration failed', error);
    }
  });
}
