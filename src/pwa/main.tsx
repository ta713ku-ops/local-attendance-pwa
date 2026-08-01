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
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    announceUpdate(registration);
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) announceUpdate(registration);
      });
    });
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
    await installWebAttendanceApi();
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
