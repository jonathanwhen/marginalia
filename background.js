const ALARM_NAME = 'oc-flush';
const DEFAULT_FLUSH_INTERVAL = 60; // minutes

// ── Context menu setup ──────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'oc-highlight',
    title: '\uD83E\uDD9E Highlight with OpenClaw',
    contexts: ['selection']
  });
  setupFlushAlarm();
  updateBadge();
});

// Also reset alarm on service worker startup (survives SW restarts)
setupFlushAlarm();
updateBadge();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'oc-highlight') return;
  const text = info.selectionText.trim();
  const msg = `highlight: "${text.slice(0, 300)}"\nsource: ${tab.url}`;
  await enqueueMessage(msg);
});

// ── Message router ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'oc-enqueue') {
    enqueueMessage(msg.text, msg.highlightId).then(() => sendResponse({ ok: true }));
    return true; // keep channel open for async response
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
    setupFlushAlarm(msg.intervalMinutes);
    sendResponse({ ok: true });
  }
});

// ── Alarm listener — auto-flush ─────────────────────────────────────
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) flushOutbox();
});

// ── Outbox: enqueue a message for later sending ─────────────────────
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

// ── Outbox: flush all pending messages to Telegram ──────────────────
async function flushOutbox() {
  const { ocOutbox = [] } = await chrome.storage.local.get('ocOutbox');
  if (!ocOutbox.length) return { sent: 0, failed: 0 };

  const { botToken, chatId } = await chrome.storage.sync.get(['botToken', 'chatId']);
  if (!botToken || !chatId) return { sent: 0, failed: 0, error: 'No Telegram credentials configured' };

  let sent = 0;
  let failed = 0;
  const remaining = [];

  // Batch items into single messages where possible (Telegram limit: 4096 chars)
  const MAX_LEN = 4096;
  let batch = '';
  const batchGroups = []; // each: { text, items[] }
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
  await updateBadge();
  return { sent, failed };
}

// ── Badge: show pending count on extension icon ─────────────────────
async function updateBadge() {
  const { ocOutbox = [] } = await chrome.storage.local.get('ocOutbox');
  const count = ocOutbox.length;
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
