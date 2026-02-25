const ALARM_NAME = 'oc-flush';
const DAILY_ALARM = 'oc-daily-summary';
const DEFAULT_FLUSH_INTERVAL = 60; // minutes
const PAGES_PER_DAY_GOAL = 150;

// ── Context menu setup ──────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'oc-highlight',
    title: '\uD83E\uDD9E Highlight with OpenClaw',
    contexts: ['selection']
  });
  migrateReadingLog();
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
  const msg = `highlight: "${text.slice(0, 300)}"\nsource: ${tab.url}`;
  await enqueueMessage(msg);
});

// ── Reading storage helpers ─────────────────────────────────────────
async function getReadings() {
  const { ocReadings = {} } = await chrome.storage.local.get('ocReadings');
  return ocReadings;
}

async function saveReadings(readings) {
  await chrome.storage.local.set({ ocReadings: readings });
}

async function markReadingDirty(pageKey) {
  const readings = await getReadings();
  if (readings[pageKey]) {
    readings[pageKey].dirty = true;
    readings[pageKey].updatedAt = new Date().toISOString();
    await saveReadings(readings);
    await updateBadge();
  }
}

// ── Migration: convert old readingLog array → ocReadings map ────────
async function migrateReadingLog() {
  const { readingLog, ocReadings } = await chrome.storage.local.get(['readingLog', 'ocReadings']);
  if (!readingLog || !readingLog.length) return; // nothing to migrate
  if (ocReadings && Object.keys(ocReadings).length) return; // already migrated

  const migrated = {};
  for (const entry of readingLog) {
    // Use URL as key; last-write-wins for duplicates
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
      dirty: false // already sent
    };
  }
  await chrome.storage.local.set({ ocReadings: migrated });
  await chrome.storage.local.remove('readingLog');
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
    handleHighlightChanged(msg).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'oc-get-today-pages') {
    getTodayPages().then(result => sendResponse(result));
    return true;
  }
  if (msg.type === 'oc-enqueue') {
    enqueueMessage(msg.text, msg.highlightId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'oc-dequeue-highlight') {
    dequeueByHighlight(msg.highlightId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'oc-flush') {
    flushOutbox().then(result => sendResponse(result));
    return true;
  }
  if (msg.type === 'oc-reset-alarm') {
    setupFlushAlarm(msg.intervalMinutes).then(() => sendResponse({ ok: true }));
    return true;
  }
});

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
    dirty: true
  };

  await saveReadings(readings);
  await updateBadge();
  return { ok: true, created: !existing };
}

// ── Handle highlight create/update/delete ───────────────────────────
async function handleHighlightChanged({ pageKey, action, text, highlightId }) {
  const readings = await getReadings();
  if (readings[pageKey]) {
    // Reading exists — mark it dirty so highlights get bundled on flush
    await markReadingDirty(pageKey);
  } else if (action === 'create' || action === 'update') {
    // No reading — fall back to standalone outbox entry
    const msg = action === 'create'
      ? `highlight: "${(text || '').slice(0, 200)}"\nsource: ${pageKey}`
      : `annotation update on: "${(text || '').slice(0, 100)}"\nsource: ${pageKey}`;
    await enqueueMessage(msg, highlightId);
  } else if (action === 'delete') {
    // No reading — dequeue the standalone entry
    await dequeueByHighlight(highlightId);
  }
}

// ── Today's page count ──────────────────────────────────────────────
async function getTodayPages() {
  const readings = await getReadings();
  const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let pages = 0;
  let count = 0;
  for (const r of Object.values(readings)) {
    if (r.createdAt && r.createdAt.slice(0, 10) === todayStr) {
      pages += r.estPages || 0;
      count++;
    }
  }
  return { pages, count };
}

// ── Alarm listener — auto-flush + daily summary ─────────────────────
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) flushOutbox();
  if (alarm.name === DAILY_ALARM) sendDailySummary();
});

// ── Outbox: enqueue a standalone message for later sending ──────────
async function enqueueMessage(text, highlightId) {
  const { ocOutbox = [] } = await chrome.storage.local.get('ocOutbox');
  const entry = { id: Date.now().toString(), text, createdAt: new Date().toISOString() };
  if (highlightId) entry.highlightId = highlightId;
  ocOutbox.push(entry);
  await chrome.storage.local.set({ ocOutbox });
  await updateBadge();
}

// Remove all outbox entries tied to a deleted highlight
async function dequeueByHighlight(highlightId) {
  const { ocOutbox = [] } = await chrome.storage.local.get('ocOutbox');
  const filtered = ocOutbox.filter(item => item.highlightId !== highlightId);
  await chrome.storage.local.set({ ocOutbox: filtered });
  await updateBadge();
}

// ── Two-phase flush: dirty readings first, then standalone outbox ───
async function flushOutbox() {
  const { botToken, chatId } = await chrome.storage.sync.get(['botToken', 'chatId']);
  if (!botToken || !chatId) return { sent: 0, failed: 0, error: 'No Telegram credentials configured' };

  let sent = 0;
  let failed = 0;

  // Phase 1: Flush dirty readings as bundled messages
  const readings = await getReadings();
  for (const [pageKey, reading] of Object.entries(readings)) {
    if (!reading.dirty) continue;

    // Build bundled message: reading metadata + highlights
    let msg = `📚 ${reading.title}`;
    if (reading.author) msg += ` by ${reading.author}`;
    if (reading.tags?.length) msg += `\ntags: ${reading.tags.join(', ')}`;
    if (reading.estPages) msg += `\npages: ~${reading.estPages}`;
    if (reading.url) msg += `\nurl: ${reading.url}`;
    if (reading.notes) msg += `\nnotes: ${reading.notes}`;

    // Pull highlights from per-page storage
    const hlResult = await chrome.storage.local.get([pageKey]);
    const highlights = hlResult[pageKey] || [];
    if (highlights.length) {
      msg += '\n\n--- highlights ---';
      for (const h of highlights) {
        msg += `\n• "${h.text.slice(0, 200)}"`;
        if (h.comment) msg += ` — ${h.comment}`;
      }
    }

    const ok = await telegramSend(botToken, chatId, msg);
    if (ok) {
      reading.dirty = false;
      reading.updatedAt = new Date().toISOString();
      sent++;
    } else {
      failed++;
    }
  }
  await saveReadings(readings);

  // Phase 2: Flush standalone outbox items (context menu highlights, etc.)
  const { ocOutbox = [] } = await chrome.storage.local.get('ocOutbox');
  if (ocOutbox.length) {
    const MAX_LEN = 4096;
    let batch = '';
    const batchGroups = [];
    let currentItems = [];

    for (const item of ocOutbox) {
      const entry = item.text;
      if (batch && (batch.length + 2 + entry.length) > MAX_LEN) {
        batchGroups.push({ text: batch, items: currentItems });
        batch = entry;
        currentItems = [item];
      } else {
        batch = batch ? batch + '\n\n' + entry : entry;
        currentItems.push(item);
      }
    }
    if (batch) batchGroups.push({ text: batch, items: currentItems });

    const remaining = [];
    for (const group of batchGroups) {
      const ok = await telegramSend(botToken, chatId, group.text);
      if (ok) {
        sent += group.items.length;
      } else {
        failed += group.items.length;
        remaining.push(...group.items);
      }
    }
    await chrome.storage.local.set({ ocOutbox: remaining });
  }

  await updateBadge();
  return { sent, failed };
}

// ── Badge: show pending count (dirty readings + outbox items) ───────
async function updateBadge() {
  const readings = await getReadings();
  const dirtyCount = Object.values(readings).filter(r => r.dirty).length;
  const { ocOutbox = [] } = await chrome.storage.local.get('ocOutbox');
  const count = dirtyCount + ocOutbox.length;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#e8a87c' });
}

// ── Alarm: configure periodic auto-flush ────────────────────────────
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
  // If it's already past 23:00 today, schedule for tomorrow
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
  if (count === 0) return; // nothing read today
  const msg = `📊 Daily reading: ${pages}/${PAGES_PER_DAY_GOAL} pages across ${count} reading${count !== 1 ? 's' : ''}`;
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
