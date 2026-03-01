// Load saved settings
chrome.storage.sync.get(
  ['botToken', 'chatId', 'ghToken', 'ghOwner', 'ghRepo', 'ghPath'],
  ({ botToken, chatId, ghToken, ghOwner, ghRepo, ghPath }) => {
    if (botToken) document.getElementById('botToken').value = botToken;
    if (chatId) document.getElementById('chatId').value = chatId;
    if (ghToken) document.getElementById('ghToken').value = ghToken;
    if (ghOwner) document.getElementById('ghOwner').value = ghOwner;
    if (ghRepo) document.getElementById('ghRepo').value = ghRepo;
    if (ghPath) document.getElementById('ghPath').value = ghPath;
  }
);
chrome.storage.local.get('ocFlushIntervalMinutes', ({ ocFlushIntervalMinutes }) => {
  if (ocFlushIntervalMinutes) document.getElementById('flushInterval').value = ocFlushIntervalMinutes;
});

document.getElementById('save').addEventListener('click', () => {
  const botToken = document.getElementById('botToken').value.trim();
  const chatId = document.getElementById('chatId').value.trim();
  const ghToken = document.getElementById('ghToken').value.trim();
  const ghOwner = document.getElementById('ghOwner').value.trim();
  const ghRepo = document.getElementById('ghRepo').value.trim();
  const ghPath = document.getElementById('ghPath').value.trim() || 'reading-log.json';
  const flushInterval = parseInt(document.getElementById('flushInterval').value, 10) || 60;

  chrome.storage.sync.set({ botToken, chatId, ghToken, ghOwner, ghRepo, ghPath });
  chrome.storage.local.set({ ocFlushIntervalMinutes: flushInterval }, () => {
    // Tell background to reconfigure the alarm with the new interval
    chrome.runtime.sendMessage({ type: 'oc-reset-alarm', intervalMinutes: flushInterval });

    const msg = document.getElementById('saved-msg');
    msg.style.display = 'inline';
    setTimeout(() => { msg.style.display = 'none'; }, 2000);
  });
});

// ── Restore ──────────────────────────────────────────────────────────
const restoreMsg = document.getElementById('restore-msg');

function showRestoreMsg(text, isError) {
  restoreMsg.textContent = text;
  restoreMsg.style.display = 'block';
  restoreMsg.style.color = isError ? '#eb5757' : '#6fcf97';
  if (!isError) setTimeout(() => { restoreMsg.style.display = 'none'; }, 5000);
}

// Restore from GitHub
document.getElementById('restore-gh-btn').addEventListener('click', async () => {
  restoreMsg.style.display = 'none';
  const btn = document.getElementById('restore-gh-btn');
  btn.textContent = 'Restoring...';
  btn.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({ type: 'oc-restore-from-github' });
    if (result.error) {
      showRestoreMsg(result.error, true);
    } else {
      showRestoreMsg(`Restored ${result.restored} of ${result.total} readings`);
    }
  } catch (e) {
    showRestoreMsg(`Error: ${e.message}`, true);
  }

  btn.textContent = 'Restore from GitHub';
  btn.disabled = false;
});

// Restore from local JSON file
document.getElementById('restore-file-btn').addEventListener('click', () => {
  document.getElementById('restore-file-input').click();
});

document.getElementById('restore-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  restoreMsg.style.display = 'none';

  try {
    const text = await file.text();
    const payload = JSON.parse(text);

    if (!payload.readings || typeof payload.readings !== 'object') {
      showRestoreMsg('Invalid backup file — no readings found', true);
      return;
    }

    const { ocReadings = {} } = await chrome.storage.local.get('ocReadings');
    let restored = 0;
    const highlightsToSet = {};
    const now = new Date().toISOString();

    for (const [pageKey, entry] of Object.entries(payload.readings)) {
      if (!ocReadings[pageKey]) {
        ocReadings[pageKey] = {
          title: entry.title || '',
          author: entry.author || '',
          url: entry.url || pageKey,
          tags: entry.tags || [],
          notes: entry.notes || '',
          estPages: entry.estPages || 0,
          createdAt: entry.createdAt || now,
          updatedAt: entry.updatedAt || now,
          syncedAt: entry.updatedAt || now
        };
        restored++;
      }

      if (entry.highlights?.length) {
        highlightsToSet[pageKey] = entry.highlights;
      }
    }

    await chrome.storage.local.set({ ocReadings });

    // Restore highlights for pages that have none locally
    if (Object.keys(highlightsToSet).length) {
      const existingHl = await chrome.storage.local.get(Object.keys(highlightsToSet));
      const toWrite = {};
      for (const [key, hl] of Object.entries(highlightsToSet)) {
        const existing = existingHl[key];
        if (!existing || !Array.isArray(existing) || existing.length === 0) {
          toWrite[key] = hl;
        }
      }
      if (Object.keys(toWrite).length) {
        await chrome.storage.local.set(toWrite);
      }
    }

    const total = Object.keys(payload.readings).length;
    showRestoreMsg(`Restored ${restored} of ${total} readings`);
  } catch (err) {
    showRestoreMsg(`Error: ${err.message}`, true);
  }

  e.target.value = '';
});
