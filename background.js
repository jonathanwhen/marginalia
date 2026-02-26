const ALARM_NAME = 'oc-flush';
const DAILY_ALARM = 'oc-daily-summary';
const DEFAULT_FLUSH_INTERVAL = 60; // minutes
const PAGES_PER_DAY_GOAL = 150;

// ── Context menu setup ──────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'oc-highlight',
    title: '✦ Highlight with Marginalia',
    contexts: ['selection']
  });
  migrateReadingLog();
  migrateDirtyToSyncedAt();
  setupFlushAlarm();
  setupDailySummaryAlarm();
  updateBadge();
});

// Also reset alarms on service worker startup (survives SW restarts)
setupFlushAlarm();
setupDailySummaryAlarm();
updateBadge();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'oc-highlight') return;
  const text = info.selectionText.trim();
  const pageKey = new URL(tab.url).origin + new URL(tab.url).pathname;

  // Auto-create reading with page estimate if none exists
  const readings = await getReadings();
  if (!readings[pageKey]) {
    const estPages = await estimatePages(tab.id);
    await upsertReading({ pageKey, title: tab.title || pageKey, url: tab.url, estPages });
  }

  // Save highlight to per-page storage
  const hlResult = await chrome.storage.local.get([pageKey]);
  const highlights = hlResult[pageKey] || [];
  highlights.push({
    id: Date.now().toString(),
    text: text.slice(0, 300),
    comment: '',
    timestamp: new Date().toISOString()
  });
  await chrome.storage.local.set({ [pageKey]: highlights });

  // Mark reading as needing sync
  await touchReading(pageKey);
});

// ── Reading storage helpers ─────────────────────────────────────────
async function getReadings() {
  const { ocReadings = {} } = await chrome.storage.local.get('ocReadings');
  return ocReadings;
}

async function saveReadings(readings) {
  await chrome.storage.local.set({ ocReadings: readings });
}

// Sync status is derived: reading needs sync when syncedAt is null or < updatedAt
function needsSync(reading) {
  return !reading.syncedAt || reading.syncedAt < reading.updatedAt;
}

// Update updatedAt timestamp — sync status derived from syncedAt < updatedAt
async function touchReading(pageKey) {
  const readings = await getReadings();
  if (readings[pageKey]) {
    readings[pageKey].updatedAt = new Date().toISOString();
    await saveReadings(readings);
    await updateBadge();
  }
}

// ── Migration: convert old readingLog array → ocReadings map ────────
async function migrateReadingLog() {
  const { readingLog, ocReadings } = await chrome.storage.local.get(['readingLog', 'ocReadings']);
  if (!readingLog || !readingLog.length) return;
  if (ocReadings && Object.keys(ocReadings).length) return;

  const migrated = {};
  for (const entry of readingLog) {
    const key = entry.url || `unknown-${entry.timestamp}`;
    migrated[key] = {
      title: entry.title || '',
      author: entry.author || '',
      url: entry.url || '',
      tags: entry.tags || [],
      notes: entry.notes || '',
      estPages: 0,
      createdAt: entry.timestamp || new Date().toISOString(),
      updatedAt: entry.timestamp || new Date().toISOString(),
      syncedAt: entry.timestamp || new Date().toISOString() // already sent
    };
  }
  await chrome.storage.local.set({ ocReadings: migrated });
  await chrome.storage.local.remove('readingLog');
}

// ── Migration: dirty boolean → syncedAt timestamp ───────────────────
async function migrateDirtyToSyncedAt() {
  const readings = await getReadings();
  let changed = false;
  for (const reading of Object.values(readings)) {
    if ('dirty' in reading) {
      if (reading.dirty) {
        reading.syncedAt = null;
      } else {
        reading.syncedAt = reading.updatedAt;
      }
      delete reading.dirty;
      changed = true;
    }
  }
  if (changed) await saveReadings(readings);
  // Clean up legacy outbox
  await chrome.storage.local.remove('ocOutbox');
}

// ── Message router ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'oc-upsert-reading') {
    upsertReading(msg).then(result => sendResponse(result));
    return true;
  }
  if (msg.type === 'oc-get-reading') {
    getReadings().then(readings => {
      sendResponse({ reading: readings[msg.pageKey] || null });
    });
    return true;
  }
  if (msg.type === 'oc-highlight-changed') {
    handleHighlightChanged(msg, _sender.tab).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'oc-get-today-pages') {
    getTodayPages().then(result => sendResponse(result));
    return true;
  }
  if (msg.type === 'oc-flush') {
    syncReadings().then(result => sendResponse(result));
    return true;
  }
  if (msg.type === 'oc-reset-alarm') {
    setupFlushAlarm(msg.intervalMinutes).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ── Estimate page count from tab's word count ───────────────────────
async function estimatePages(tabId) {
  try {
    // Ensure content script is injected
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    const result = await chrome.tabs.sendMessage(tabId, { type: 'oc-get-word-count' });
    if (result?.wordCount) return Math.max(1, Math.round(result.wordCount / 275));
  } catch (e) {}
  return 0;
}

// ── Upsert a reading entry ──────────────────────────────────────────
async function upsertReading({ pageKey, title, author, url, tags, notes, estPages }) {
  const readings = await getReadings();
  const now = new Date().toISOString();
  const existing = readings[pageKey];

  readings[pageKey] = {
    title: title ?? existing?.title ?? '',
    author: author ?? existing?.author ?? '',
    url: url ?? existing?.url ?? pageKey,
    tags: tags ?? existing?.tags ?? [],
    notes: notes ?? existing?.notes ?? '',
    estPages: estPages ?? existing?.estPages ?? 0,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    syncedAt: existing?.syncedAt ?? null
  };

  await saveReadings(readings);
  await updateBadge();
  return { ok: true, created: !existing };
}

// ── Handle highlight create/update/delete ───────────────────────────
async function handleHighlightChanged({ pageKey, action, text, highlightId }, tab) {
  const readings = await getReadings();
  if (!readings[pageKey] && (action === 'create' || action === 'update')) {
    const estPages = tab?.id ? await estimatePages(tab.id) : 0;
    await upsertReading({
      pageKey,
      title: tab?.title || pageKey,
      url: tab?.url || pageKey,
      estPages
    });
  }
  await touchReading(pageKey);
}

// ── Today's page count ──────────────────────────────────────────────
// Uses local date (not UTC) so the day boundary aligns with the user's timezone
async function getTodayPages() {
  const readings = await getReadings();
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  let pages = 0;
  let count = 0;
  for (const r of Object.values(readings)) {
    if (!r.createdAt) continue;
    // Convert stored UTC createdAt to local date string for comparison
    const local = new Date(r.createdAt);
    const localStr = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
    if (localStr === todayStr) {
      pages += r.estPages || 0;
      count++;
    }
  }
  return { pages, count };
}

// ── Alarm listener — auto-sync + daily summary ──────────────────────
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) syncReadings();
  if (alarm.name === DAILY_ALARM) sendDailySummary();
});

// ── GitHub API helpers ──────────────────────────────────────────────

// GET the file to retrieve its SHA (needed for updates)
// Returns { sha, content } or null if 404
async function githubGetFile(ghToken, ghOwner, ghRepo, ghPath) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${ghOwner}/${ghRepo}/contents/${ghPath}`,
      { headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' } }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub GET ${res.status}`);
    const data = await res.json();
    return { sha: data.sha };
  } catch (e) {
    console.error('githubGetFile:', e);
    return null;
  }
}

// PUT the file (create if no SHA, update if SHA provided)
// Returns true on success, false on failure
async function githubPushFile(ghToken, ghOwner, ghRepo, ghPath, content, sha) {
  // Unicode-safe base64 encoding
  const encoded = btoa(unescape(encodeURIComponent(content)));
  const body = {
    message: `sync reading log ${new Date().toISOString().slice(0, 10)}`,
    content: encoded
  };
  if (sha) body.sha = sha;

  try {
    const res = await fetch(
      `https://api.github.com/repos/${ghOwner}/${ghRepo}/contents/${ghPath}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );
    if (!res.ok) return false;
    const data = await res.json();
    // Cache the new SHA for next push
    await chrome.storage.local.set({ ocGitHubSha: data.content.sha });
    return true;
  } catch (e) {
    console.error('githubPushFile:', e);
    return false;
  }
}

// Clear cached SHA when GitHub credentials change
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  const ghKeys = ['ghToken', 'ghOwner', 'ghRepo', 'ghPath'];
  if (ghKeys.some(k => k in changes)) {
    chrome.storage.local.remove('ocGitHubSha');
  }
});

// ── Telegram diff message builder ───────────────────────────────────
function buildDiffMessage(changedEntries) {
  const lines = [];
  for (const { reading, highlightCount, isNew } of changedEntries) {
    const icon = isNew ? '\uD83D\uDCDA' : '\u270F\uFE0F'; // 📚 or ✏️
    const verb = isNew ? 'New' : 'Updated';
    let line = `${icon} ${verb}: "${reading.title}"`;
    if (reading.author) line += ` by ${reading.author}`;
    const meta = [];
    if (reading.estPages) meta.push(`${reading.estPages} pages`);
    if (reading.tags?.length) meta.push(reading.tags[0]);
    if (meta.length) line += ` (${meta.join(', ')})`;
    if (highlightCount > 0) line += `\n   ${highlightCount} highlight${highlightCount !== 1 ? 's' : ''}`;
    lines.push(line);
  }
  return lines.join('\n\n');
}

// ── syncReadings() — replaces flushOutbox() ─────────────────────────
async function syncReadings() {
  const { botToken, chatId, ghToken, ghOwner, ghRepo, ghPath } =
    await chrome.storage.sync.get(['botToken', 'chatId', 'ghToken', 'ghOwner', 'ghRepo', 'ghPath']);

  const hasGitHub = ghToken && ghOwner && ghRepo;
  const hasTelegram = botToken && chatId;

  if (!hasGitHub && !hasTelegram) {
    return { synced: 0, failed: 0, error: 'No sync channels configured' };
  }

  const readings = await getReadings();
  const allKeys = Object.keys(readings);

  // Identify readings that need sync
  const changedKeys = allKeys.filter(k => needsSync(readings[k]));
  if (changedKeys.length === 0) {
    return { synced: 0, failed: 0 };
  }

  // Batch-fetch all highlights from per-page storage
  const allHighlights = {};
  if (allKeys.length > 0) {
    const hlData = await chrome.storage.local.get(allKeys);
    for (const k of allKeys) {
      allHighlights[k] = hlData[k] || [];
    }
  }

  let githubOk = true;
  let telegramOk = true;

  // Phase 1: GitHub — push full export (all readings, not just changed)
  if (hasGitHub) {
    const path = ghPath || 'reading-log.json';
    const exportPayload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      readings: {}
    };

    for (const [key, reading] of Object.entries(readings)) {
      exportPayload.readings[key] = {
        title: reading.title,
        author: reading.author,
        url: reading.url,
        tags: reading.tags,
        notes: reading.notes,
        estPages: reading.estPages,
        createdAt: reading.createdAt,
        updatedAt: reading.updatedAt,
        highlights: allHighlights[key] || []
      };
    }

    const content = JSON.stringify(exportPayload, null, 2);

    // Try cached SHA first, fall back to fetching
    const { ocGitHubSha } = await chrome.storage.local.get('ocGitHubSha');
    let sha = ocGitHubSha || null;
    if (!sha) {
      const existing = await githubGetFile(ghToken, ghOwner, ghRepo, path);
      sha = existing?.sha || null;
    }

    githubOk = await githubPushFile(ghToken, ghOwner, ghRepo, path, content, sha);

    // SHA conflict retry: re-fetch fresh SHA and try once more
    if (!githubOk && sha) {
      const fresh = await githubGetFile(ghToken, ghOwner, ghRepo, path);
      if (fresh?.sha) {
        githubOk = await githubPushFile(ghToken, ghOwner, ghRepo, path, content, fresh.sha);
      }
    }
  }

  // Phase 2: Telegram — send diff message for changed readings only
  if (hasTelegram) {
    const changedEntries = changedKeys.map(k => ({
      reading: readings[k],
      highlightCount: (allHighlights[k] || []).length,
      isNew: !readings[k].syncedAt
    }));

    const diffMsg = buildDiffMessage(changedEntries);
    if (diffMsg) {
      telegramOk = await telegramSend(botToken, chatId, diffMsg);
    }
  }

  // Phase 3: Stamp syncedAt only if all configured channels succeeded
  const allOk = (!hasGitHub || githubOk) && (!hasTelegram || telegramOk);
  if (allOk) {
    const now = new Date().toISOString();
    for (const k of changedKeys) {
      readings[k].syncedAt = now;
    }
    await saveReadings(readings);
  }

  await updateBadge();

  const synced = allOk ? changedKeys.length : 0;
  const failed = allOk ? 0 : changedKeys.length;
  return { synced, failed, githubOk, telegramOk };
}

// ── Badge: show pending count (unsynced readings) ───────────────────
async function updateBadge() {
  const readings = await getReadings();
  const count = Object.values(readings).filter(r => needsSync(r)).length;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#e8a87c' });
}

// ── Alarm: configure periodic auto-sync ─────────────────────────────
async function setupFlushAlarm(intervalOverride) {
  await chrome.alarms.clear(ALARM_NAME);
  let minutes = intervalOverride;
  if (!minutes) {
    const { ocFlushIntervalMinutes } = await chrome.storage.local.get('ocFlushIntervalMinutes');
    minutes = ocFlushIntervalMinutes || DEFAULT_FLUSH_INTERVAL;
  }
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
}

// ── Daily summary alarm — fires at 23:00 local time ─────────────────
async function setupDailySummaryAlarm() {
  await chrome.alarms.clear(DAILY_ALARM);
  const now = new Date();
  const target = new Date(now);
  target.setHours(23, 0, 0, 0);
  if (now >= target) target.setDate(target.getDate() + 1);
  const delayMs = target.getTime() - now.getTime();
  chrome.alarms.create(DAILY_ALARM, {
    when: Date.now() + delayMs,
    periodInMinutes: 24 * 60
  });
}

async function sendDailySummary() {
  const { botToken, chatId } = await chrome.storage.sync.get(['botToken', 'chatId']);
  if (!botToken || !chatId) return;
  const { pages, count } = await getTodayPages();
  if (count === 0) return;
  const msg = `\uD83D\uDCCA Daily reading: ${pages}/${PAGES_PER_DAY_GOAL} pages across ${count} reading${count !== 1 ? 's' : ''}`;
  await telegramSend(botToken, chatId, msg);
}

// ── Low-level Telegram fetch helper ─────────────────────────────────
async function telegramSend(botToken, chatId, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    return res.ok;
  } catch {
    return false;
  }
}
