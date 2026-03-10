// nav-sync.js — Wires up the Sync button in the nav bar.
// Included on every page that has a #nav-sync-btn element.

(function () {
  const btn = document.getElementById('nav-sync-btn');
  if (!btn) return;

  // ── Tooltip: show last sync time ──────────────────────────────────
  function formatRelativeTime(isoString) {
    const diff = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  function updateTooltip(result) {
    if (!result) { btn.title = 'Not yet synced'; return; }
    if (result.synced) {
      btn.title = 'Last synced: ' + formatRelativeTime(result.syncedAt);
    } else {
      btn.title = 'Last sync failed: ' + (result.error || 'unknown error');
    }
  }

  // Initialize tooltip from stored result
  chrome.storage.local.get('ocLastSyncResult', ({ ocLastSyncResult }) => {
    updateTooltip(ocLastSyncResult);
  });

  // Update tooltip in real-time when sync result changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.ocLastSyncResult) {
      updateTooltip(changes.ocLastSyncResult.newValue);
    }
  });

  // Refresh relative time display every 60s so "5 min ago" stays current
  setInterval(() => {
    chrome.storage.local.get('ocLastSyncResult', ({ ocLastSyncResult }) => {
      updateTooltip(ocLastSyncResult);
    });
  }, 60000);

  // ── Click handler ─────────────────────────────────────────────────
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
