const status = document.getElementById('update-status');
const retry = document.getElementById('retry');
let leaving = false;

const openLatest = () => {
  if (leaving) return;
  leaving = true;
  status.textContent = '更新できました。最新版を開きます…';
  const appUrl = new URL('./', window.location.href);
  appUrl.searchParams.set('updated', String(Date.now()));
  window.setTimeout(() => window.location.replace(appUrl), 300);
};

const activateWaitingWorker = (registration) => {
  if (!registration.waiting) return false;
  status.textContent = '最新版へ切り替えています…';
  registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  return true;
};

const runUpdate = async () => {
  retry.hidden = true;
  status.textContent = '更新を確認しています…';
  try {
    if (!('serviceWorker' in navigator)) return openLatest();
    const registration = await navigator.serviceWorker.register('./sw.js', {
      scope: './',
      updateViaCache: 'none',
    });
    navigator.serviceWorker.addEventListener('controllerchange', openLatest, { once: true });
    if (activateWaitingWorker(registration)) return;

    const watchInstallingWorker = () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed') {
          if (!activateWaitingWorker(registration)) openLatest();
        }
      });
    };
    registration.addEventListener('updatefound', watchInstallingWorker);
    await registration.update();
    watchInstallingWorker();
    if (activateWaitingWorker(registration)) return;
    window.setTimeout(openLatest, 2500);
  } catch (error) {
    status.textContent = '更新を完了できませんでした。通信状態を確認してください。';
    retry.hidden = false;
    console.error(error);
  }
};

retry.addEventListener('click', runUpdate);
void runUpdate();
