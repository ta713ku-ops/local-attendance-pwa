import { createRoot } from 'react-dom/client';
import App from './App';
import { installWebAttendanceApi } from './local-api';

declare global {
  interface Window {
    __PWA_UPDATE_READY__?: boolean;
  }
}

const setConnectionState = () => {
  document.documentElement.dataset.connection = navigator.onLine ? 'online' : 'offline';
  window.dispatchEvent(new CustomEvent('attendance:connection-change', {
    detail: { online: navigator.onLine },
  }));
};

const announceUpdate = (registration: ServiceWorkerRegistration) => {
  if (!registration.waiting) return;
  window.__PWA_UPDATE_READY__ = true;
  window.dispatchEvent(new CustomEvent('attendance:update-ready', { detail: registration }));
};

const registerServiceWorker = async () => {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;

  try {
    const baseUrl = new URL(import.meta.env.BASE_URL, window.location.origin);
    const registration = await navigator.serviceWorker.register(
      new URL('sw.js', baseUrl),
      { scope: baseUrl.pathname, updateViaCache: 'none' },
    );
    announceUpdate(registration);
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) announceUpdate(registration);
      });
    });
    if (navigator.onLine) void registration.update().catch(() => undefined);
    const checkForUpdate = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void registration.update().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', checkForUpdate);
  } catch (error) {
    // The app is still usable online; do not interrupt a time-clock operation.
    console.warn('オフライン機能を準備できませんでした。', error);
  }
};

const requestPersistentStorage = async () => {
  if (!navigator.storage?.persist) return;
  try {
    const persisted = await navigator.storage.persist();
    document.documentElement.dataset.storage = persisted ? 'persistent' : 'best-effort';
  } catch {
    document.documentElement.dataset.storage = 'best-effort';
  }
};

const start = async () => {
  setConnectionState();
  window.addEventListener('online', setConnectionState);
  window.addEventListener('offline', setConnectionState);

  try {
    const controller = await installWebAttendanceApi();
    void controller.ensureAutoBackup();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void controller.ensureAutoBackup();
    });
  } catch (error) {
    console.error('ローカル勤怠データを開始できませんでした。', error);
  }

  const root = document.getElementById('root');
  if (!root) throw new Error('画面の開始位置が見つかりません。');
  createRoot(root).render(<App />);
  void requestPersistentStorage();
  void registerServiceWorker();
};

void start();
