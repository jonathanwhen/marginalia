/**
 * Sync logic for Electron — ported from background.js.
 * Uses the storage module instead of chrome.storage.
 */

const storage = require('./storage');

// ── Reading helpers ──────────────────────────────────────────────────
function getReadings() {
  const { ocReadings = {} } = storage.get('local', ['ocReadings']);
  return ocReadings;
}

function saveReadings(readings) {
  storage.set('local', { ocReadings: readings });
}

function needsSync(reading) {
  return !reading.syncedAt || reading.syncedAt < reading.updatedAt;
}

// ── Upsert reading ───────────────────────────────────────────────────
function upsertReading({ pageKey, title, author, url, tags, notes, estPages }) {
  const readings = getReadings();
  const now = new Date().toISOString();
  const existing = readings[pageKey];

  const resolvedTags = tags ?? existing?.tags ?? [];

  readings[pageKey] = {
    title: title ?? existing?.title ?? '',
    author: author ?? existing?.author ?? '',
    url: url ?? existing?.url ?? pageKey,
    tags: resolvedTags,
    notes: notes ?? existing?.notes ?? '',
    estPages: estPages ?? existing?.estPages ?? 0,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    syncedAt: existing?.syncedAt ?? null,
    ...(existing?.readingLog ? { readingLog: existing.readingLog } : {})
  };

  saveReadings(readings);
  return { ok: true, created: !existing };
}

// ── Touch reading ────────────────────────────────────────────────────
function touchReading(pageKey) {
  const readings = getReadings();
  if (readings[pageKey]) {
    readings[pageKey].updatedAt = new Date().toISOString();
    saveReadings(readings);
  }
}

// ── Log pages ────────────────────────────────────────────────────────
function logPages(pageKey, date, pages) {
  const readings = getReadings();
  const reading = readings[pageKey];
  if (!reading) return { error: 'Reading not found' };

  if (!reading.readingLog) reading.readingLog = {};
  if (pages <= 0) {
    delete reading.readingLog[date];
    if (Object.keys(reading.readingLog).length === 0) delete reading.readingLog;
  } else {
    reading.readingLog[date] = pages;
  }

  saveReadings(readings);
  touchReading(pageKey);
  return { ok: true };
}

// ── Today's pages ────────────────────────────────────────────────────
function getTodayPages() {
  const readings = getReadings();
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  let pages = 0, count = 0;

  for (const r of Object.values(readings)) {
    if (r.readingLog && r.readingLog[todayStr]) {
      pages += r.readingLog[todayStr];
      count++;
    } else if (r.createdAt) {
      const local = new Date(r.createdAt);
      const localStr = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
      if (localStr === todayStr) {
        pages += r.estPages || 0;
        count++;
      }
    }
  }
  return { pages, count };
}

// ── GitHub sync ──────────────────────────────────────────────────────
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

async function githubPushFile(ghToken, ghOwner, ghRepo, ghPath, content, sha) {
  const encoded = Buffer.from(content, 'utf8').toString('base64');
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
    storage.set('local', { ocGitHubSha: data.content.sha });
    return true;
  } catch (e) {
    console.error('githubPushFile:', e);
    return false;
  }
}

async function syncReadings() {
  const { botToken, chatId, ghToken, ghOwner, ghRepo, ghPath } = storage.get('sync',
    ['botToken', 'chatId', 'ghToken', 'ghOwner', 'ghRepo', 'ghPath']);

  const hasGitHub = ghToken && ghOwner && ghRepo;
  const hasTelegram = botToken && chatId;

  if (!hasGitHub && !hasTelegram) {
    return { synced: 0, failed: 0, error: 'No sync channels configured' };
  }

  const readings = getReadings();
  const allKeys = Object.keys(readings);
  const changedKeys = allKeys.filter(k => needsSync(readings[k]));
  if (changedKeys.length === 0) return { synced: 0, failed: 0 };

  // Batch-fetch highlights
  const allHighlights = {};
  for (const k of allKeys) {
    const data = storage.get('local', [k]);
    allHighlights[k] = data[k] || [];
  }

  let githubOk = true;
  let telegramOk = true;

  // GitHub phase
  if (hasGitHub) {
    const path = ghPath || 'reading-log.json';
    const exportPayload = { version: 1, exportedAt: new Date().toISOString(), readings: {} };

    for (const [key, reading] of Object.entries(readings)) {
      exportPayload.readings[key] = {
        title: reading.title, author: reading.author, url: reading.url,
        tags: reading.tags, notes: reading.notes, estPages: reading.estPages,
        createdAt: reading.createdAt, updatedAt: reading.updatedAt,
        highlights: allHighlights[key] || [],
        ...(reading.readingLog ? { readingLog: reading.readingLog } : {})
      };
    }

    const content = JSON.stringify(exportPayload, null, 2);
    const { ocGitHubSha } = storage.get('local', ['ocGitHubSha']);
    let sha = ocGitHubSha || null;
    if (!sha) {
      const existing = await githubGetFile(ghToken, ghOwner, ghRepo, path);
      sha = existing?.sha || null;
    }

    githubOk = await githubPushFile(ghToken, ghOwner, ghRepo, path, content, sha);
    if (!githubOk && sha) {
      const fresh = await githubGetFile(ghToken, ghOwner, ghRepo, path);
      if (fresh?.sha) githubOk = await githubPushFile(ghToken, ghOwner, ghRepo, path, content, fresh.sha);
    }
  }

  // Telegram phase
  if (hasTelegram) {
    const changedEntries = changedKeys.map(k => ({
      reading: readings[k],
      highlightCount: (allHighlights[k] || []).length,
      isNew: !readings[k].syncedAt
    }));

    let diffMsg = buildDiffMessage(changedEntries);
    if (diffMsg) {
      if (diffMsg.length > 4000) diffMsg = diffMsg.slice(0, 3980) + '\n\n… (truncated)';
      telegramOk = await telegramSend(botToken, chatId, diffMsg);
    }
  }

  // Stamp syncedAt
  const allOk = (!hasGitHub || githubOk) && (!hasTelegram || telegramOk);
  if (allOk) {
    const now = new Date().toISOString();
    for (const k of changedKeys) readings[k].syncedAt = now;
    saveReadings(readings);
  }

  return { synced: allOk ? changedKeys.length : 0, failed: allOk ? 0 : changedKeys.length, githubOk, telegramOk };
}

function buildDiffMessage(changedEntries) {
  const lines = [];
  for (const { reading, highlightCount, isNew } of changedEntries) {
    const icon = isNew ? '\uD83D\uDCDA' : '\u270F\uFE0F';
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

async function telegramSend(botToken, chatId, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
    });
    return res.ok;
  } catch (err) {
    console.error('Telegram send failed:', err);
    return false;
  }
}

// ── Message router ───────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {
    case 'oc-upsert-reading': return upsertReading(msg);
    case 'oc-get-reading': {
      const readings = getReadings();
      return { reading: readings[msg.pageKey] || null };
    }
    case 'oc-highlight-changed': {
      touchReading(msg.pageKey);
      return { ok: true };
    }
    case 'oc-log-pages': return logPages(msg.pageKey, msg.date, msg.pages);
    case 'oc-get-today-pages': return getTodayPages();
    case 'oc-flush': return syncReadings();
    default: return { error: `Unknown message type: ${msg.type}` };
  }
}

module.exports = { handleMessage, syncReadings, getReadings };
