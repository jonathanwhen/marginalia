// nav-sync.js — Wires up the Sync button in the nav bar.
// Included on every page that has a #nav-sync-btn element.

(function () {
  const btn = document.getElementById('nav-sync-btn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    if (btn.classList.contains('syncing')) return;
    btn.classList.add('syncing');
    btn.textContent = 'Syncing...';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'oc-flush' });
      if (result.error) {
        btn.textContent = 'Error';
      } else if (result.synced > 0) {
        btn.textContent = `Synced ${result.synced}`;
      } else {
        btn.textContent = 'Up to date';
      }
    } catch (e) {
      btn.textContent = 'Error';
    }
    btn.classList.remove('syncing');
    setTimeout(() => { btn.textContent = 'Sync'; }, 2500);
  });
})();
