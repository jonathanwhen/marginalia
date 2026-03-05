import { signUp, signIn, signOut, getCurrentUser, getMyShares, deleteShare, getShareUrl } from './lib/supabase.js';

// ── Account / Auth ─────────────────────────────────────────────────
const accountAuth = document.getElementById('account-auth');
const accountSignedIn = document.getElementById('account-signed-in');
const authForm = document.getElementById('auth-form');
const authFormTitle = document.getElementById('auth-form-title');
const authNameField = document.getElementById('auth-name-field');
const authMsg = document.getElementById('auth-msg');
let authMode = 'signin'; // 'signin' or 'signup'

document.getElementById('auth-show-signin').addEventListener('click', () => {
  authMode = 'signin';
  authFormTitle.textContent = 'Sign In';
  authNameField.style.display = 'none';
  document.getElementById('auth-submit').textContent = 'Sign In';
  authForm.style.display = 'block';
});

document.getElementById('auth-show-signup').addEventListener('click', () => {
  authMode = 'signup';
  authFormTitle.textContent = 'Create Account';
  authNameField.style.display = 'block';
  document.getElementById('auth-submit').textContent = 'Create Account';
  authForm.style.display = 'block';
});

document.getElementById('auth-submit').addEventListener('click', async () => {
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const name = document.getElementById('auth-name').value.trim();

  if (!email || !password) { showAuthMsg('Email and password required', true); return; }
  if (password.length < 6) { showAuthMsg('Password must be 6+ characters', true); return; }

  const btn = document.getElementById('auth-submit');
  btn.disabled = true;
  btn.textContent = authMode === 'signup' ? 'Creating...' : 'Signing in...';

  try {
    if (authMode === 'signup') {
      const result = await signUp(email, password, name || email.split('@')[0]);
      if (!result.access_token) {
        showAuthMsg('Check your email to confirm your account', false);
        btn.disabled = false;
        btn.textContent = 'Create Account';
        return;
      }
    } else {
      await signIn(email, password);
    }
    await showSignedInState();
  } catch (e) {
    showAuthMsg(e.message, true);
    btn.disabled = false;
    btn.textContent = authMode === 'signup' ? 'Create Account' : 'Sign In';
  }
});

document.getElementById('auth-signout').addEventListener('click', async () => {
  await signOut();
  showSignedOutState();
});

function showAuthMsg(text, isError) {
  authMsg.textContent = text;
  authMsg.style.display = 'inline';
  authMsg.style.color = isError ? '#eb5757' : '#6fcf97';
  if (!isError) setTimeout(() => { authMsg.style.display = 'none'; }, 4000);
}

async function showSignedInState() {
  const user = await getCurrentUser();
  if (!user) { showSignedOutState(); return; }

  accountAuth.style.display = 'none';
  accountSignedIn.style.display = 'block';
  document.getElementById('account-display').textContent = user.user_metadata?.display_name || user.email.split('@')[0];
  document.getElementById('account-email').textContent = user.email;

  loadMyShares();
}

function showSignedOutState() {
  accountAuth.style.display = 'block';
  accountSignedIn.style.display = 'none';
  authForm.style.display = 'none';
}

async function loadMyShares() {
  const list = document.getElementById('my-shares-list');
  const shares = await getMyShares();

  if (!shares.length) {
    list.innerHTML = '<span style="color:#555;">No shares yet. Use the Share button on any reading to create one.</span>';
    return;
  }

  list.innerHTML = shares.map(s => {
    const date = new Date(s.updated_at).toLocaleDateString();
    const shareUrl = getShareUrl(s.share_code, s.url);
    return `<div style="display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid #1a1a1a;">
      <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(s.title)}">${esc(s.title)}</span>
      <span style="color:#555; font-size:10px; white-space:nowrap;">${date}</span>
      <button class="copy-share-btn" data-url="${esc(shareUrl)}" style="background:none; border:1px solid #3a3a3a; color:#e8a87c; font-size:10px; padding:2px 8px; border-radius:4px; cursor:pointer; white-space:nowrap;">Copy Link</button>
      <button class="delete-share-btn" data-id="${s.id}" style="background:none; border:none; color:#555; font-size:14px; cursor:pointer; padding:0 2px;">&times;</button>
    </div>`;
  }).join('');

  // Wire up copy buttons
  list.querySelectorAll('.copy-share-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(btn.dataset.url);
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy Link'; }, 1500);
    });
  });

  // Wire up delete buttons
  list.querySelectorAll('.delete-share-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await deleteShare(btn.dataset.id);
        btn.closest('div').remove();
      } catch (e) {
        showAuthMsg(e.message || 'Failed to delete share', true);
      }
    });
  });
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

// Check auth state on load
getCurrentUser().then(user => {
  if (user) showSignedInState();
});

// Load saved settings
chrome.storage.sync.get(
  ['botToken', 'chatId', 'ghToken', 'ghOwner', 'ghRepo', 'ghPath', 'ghNotesDir', 'claudeApiKey', 'autoExtract'],
  ({ botToken, chatId, ghToken, ghOwner, ghRepo, ghPath, ghNotesDir, claudeApiKey, autoExtract }) => {
    if (botToken) document.getElementById('botToken').value = botToken;
    if (chatId) document.getElementById('chatId').value = chatId;
    if (ghToken) document.getElementById('ghToken').value = ghToken;
    if (ghOwner) document.getElementById('ghOwner').value = ghOwner;
    if (ghRepo) document.getElementById('ghRepo').value = ghRepo;
    if (ghPath) document.getElementById('ghPath').value = ghPath;
    if (ghNotesDir) document.getElementById('ghNotesDir').value = ghNotesDir;
    if (claudeApiKey) document.getElementById('claudeApiKey').value = claudeApiKey;
    if (autoExtract) document.getElementById('autoExtract').checked = autoExtract;
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
  const ghNotesDir = document.getElementById('ghNotesDir').value.trim();
  const claudeApiKey = document.getElementById('claudeApiKey').value.trim();
  const autoExtract = document.getElementById('autoExtract').checked;
  const flushInterval = parseInt(document.getElementById('flushInterval').value, 10) || 60;

  chrome.storage.sync.set({ botToken, chatId, ghToken, ghOwner, ghRepo, ghPath, ghNotesDir, claudeApiKey, autoExtract });
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

// ── Settings export/import ───────────────────────────────────────────
const SETTINGS_KEYS = ['botToken', 'chatId', 'ghToken', 'ghOwner', 'ghRepo', 'ghPath', 'ghNotesDir', 'claudeApiKey', 'autoExtract'];
const settingsMsg = document.getElementById('settings-transfer-msg');

function showSettingsMsg(text, isError) {
  settingsMsg.textContent = text;
  settingsMsg.style.display = 'block';
  settingsMsg.style.color = isError ? '#eb5757' : '#6fcf97';
  if (!isError) setTimeout(() => { settingsMsg.style.display = 'none'; }, 4000);
}

// Export
document.getElementById('export-settings-btn').addEventListener('click', async () => {
  const settings = await chrome.storage.sync.get(SETTINGS_KEYS);
  const { ocFlushIntervalMinutes } = await chrome.storage.local.get('ocFlushIntervalMinutes');
  if (ocFlushIntervalMinutes) settings.ocFlushIntervalMinutes = ocFlushIntervalMinutes;

  const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'marginalia-settings.json';
  a.click();
  URL.revokeObjectURL(url);
  showSettingsMsg('Settings exported');
});

// Import
document.getElementById('import-settings-btn').addEventListener('click', () => {
  document.getElementById('import-settings-input').click();
});

document.getElementById('import-settings-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const settings = JSON.parse(text);

    // Split into sync and local keys
    const syncItems = {};
    const localItems = {};
    for (const [key, value] of Object.entries(settings)) {
      if (key === 'ocFlushIntervalMinutes') {
        localItems[key] = value;
      } else if (SETTINGS_KEYS.includes(key)) {
        syncItems[key] = value;
      }
    }

    if (Object.keys(syncItems).length) await chrome.storage.sync.set(syncItems);
    if (Object.keys(localItems).length) await chrome.storage.local.set(localItems);

    // Update form fields to reflect imported values
    for (const key of SETTINGS_KEYS) {
      const el = document.getElementById(key);
      if (!el) continue;
      if (el.type === 'checkbox') {
        el.checked = !!settings[key];
      } else if (settings[key] !== undefined) {
        el.value = settings[key];
      }
    }
    if (settings.ocFlushIntervalMinutes) {
      document.getElementById('flushInterval').value = settings.ocFlushIntervalMinutes;
    }

    showSettingsMsg(`Imported ${Object.keys(settings).length} settings`);
  } catch (err) {
    showSettingsMsg(`Error: ${err.message}`, true);
  }

  e.target.value = '';
});
