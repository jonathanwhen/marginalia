/**
 * Sync logic for Electron — ported from background.js.
 * Uses the storage module instead of chrome.storage.
 *
 * Reading/highlight sync to Supabase delegates to the extension's
 * lib/readings-sync.js so the Chrome extension and Electron app always
 * agree on the wire format and merge semantics. Single source of truth.
 */

const storage = require('./storage');
const libraryStorage = require('./library-storage');
const path = require('path');
const { pathToFileURL } = require('url');

// Lazy-load ESM modules from the extension's lib/ directory. Caching the
// loaded modules avoids re-import overhead on every sync tick.
const _libCache = {};
async function loadExtModule(relPath) {
  if (_libCache[relPath]) return _libCache[relPath];
  const { app } = require('electron');
  const extRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'ext')
    : path.resolve(__dirname, '..');
  const fileUrl = pathToFileURL(path.join(extRoot, relPath)).href;
  _libCache[relPath] = await import(fileUrl);
  return _libCache[relPath];
}
const getReadingsSyncLib = () => loadExtModule('lib/readings-sync.js');
const getPdfSyncLib       = () => loadExtModule('lib/pdf-sync.js');

// Extract highlight arrays from the full local-storage section. Mirrors
// extractHighlightsFromStorage in lib/readings-sync.js so the same
// "anything that's an Array under a non-reserved key" rule applies.
function extractHighlightsFromLocal(localSection) {
  const skip = new Set([
    'ocReadings', 'ocGitHubSha', 'ocMarkdownShas',
    'ocSupabaseSession', 'ocLastSyncResult'
  ]);
  const out = {};
  for (const [key, val] of Object.entries(localSection)) {
    if (!skip.has(key) && !key.startsWith('pos:') && Array.isArray(val)) {
      out[key] = val;
    }
  }
  return out;
}

// ── Supabase config (PDF sync) ───────────────────────────────────────
const SUPABASE_URL = 'https://lfvbrrxnjwanbniaegnf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxmdmJycnhuandhbmJuaWFlZ25mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2NzAxMDYsImV4cCI6MjA4ODI0NjEwNn0.6NzXByK1y8FP-iCqYx6GCiuG6DsIvXpbkyqiCX_R1Os';

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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
function upsertReading({ pageKey, title, author, url, tags, notes, estPages, conversationUrl, starred, mediaType, duration }) {
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
    conversationUrl: conversationUrl ?? existing?.conversationUrl ?? null,
    starred: starred ?? existing?.starred ?? false,
    mediaType: mediaType ?? existing?.mediaType ?? undefined,
    duration: duration ?? existing?.duration ?? undefined,
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
  const todayStr = localDateStr(now);
  let pages = 0, count = 0;

  for (const r of Object.values(readings)) {
    if (r.readingLog && r.readingLog[todayStr]) {
      pages += r.readingLog[todayStr];
      count++;
    } else if (r.createdAt) {
      const local = new Date(r.createdAt);
      const localStr = localDateStr(local);
      if (localStr === todayStr) {
        pages += r.estPages || 0;
        count++;
      }
    }
  }
  return { pages, count };
}

// ── GitHub sync ──────────────────────────────────────────────────────
async function githubGetFile(ghToken, ghOwner, ghRepo, ghPath, { withContent = false } = {}) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${ghOwner}/${ghRepo}/contents/${ghPath}`,
      { headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' } }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub GET ${res.status}`);
    const data = await res.json();
    const result = { sha: data.sha };
    if (withContent && data.content) {
      result.content = Buffer.from(data.content, 'base64').toString('utf8');
    }
    return result;
  } catch (e) {
    console.error('githubGetFile:', e);
    return null;
  }
}

// ── Bidirectional merge ─────────────────────────────────────────────
// Pull remote reading-log.json from GitHub and merge into local storage.
// Strategy: last-write-wins by updatedAt, union highlights by ID.
async function mergeFromRemote(ghToken, ghOwner, ghRepo, ghPath) {
  const file = await githubGetFile(ghToken, ghOwner, ghRepo, ghPath, { withContent: true });
  if (!file?.content) return { merged: 0, sha: file?.sha || null };

  let payload;
  try { payload = JSON.parse(file.content); } catch { return { merged: 0, sha: file.sha }; }
  if (!payload.readings) return { merged: 0, sha: file.sha };

  const localReadings = getReadings();
  let merged = 0;

  for (const [pageKey, remote] of Object.entries(payload.readings)) {
    const local = localReadings[pageKey];

    if (!local) {
      // New reading from remote — adopt it. Preserve every field the
      // extension may have written (conversationUrl, starred, mediaType,
      // duration) so cross-device sync doesn't lose data.
      const now = new Date().toISOString();
      localReadings[pageKey] = {
        title: remote.title || '', author: remote.author || '',
        url: remote.url || pageKey, tags: remote.tags || [],
        notes: remote.notes || '', estPages: remote.estPages || 0,
        conversationUrl: remote.conversationUrl ?? null,
        starred: remote.starred ?? false,
        ...(remote.mediaType !== undefined ? { mediaType: remote.mediaType } : {}),
        ...(remote.duration !== undefined ? { duration: remote.duration } : {}),
        createdAt: remote.createdAt || now, updatedAt: remote.updatedAt || now,
        syncedAt: remote.updatedAt || now,
        ...(remote.readingLog ? { readingLog: remote.readingLog } : {})
      };
      merged++;
    } else if (remote.updatedAt && remote.updatedAt > (local.updatedAt || '')) {
      // Remote is newer — adopt remote fields, fall back to local where missing.
      localReadings[pageKey] = {
        title: remote.title || local.title,
        author: remote.author || local.author,
        url: remote.url || local.url,
        tags: remote.tags || local.tags,
        notes: remote.notes || local.notes,
        estPages: remote.estPages || local.estPages,
        conversationUrl: remote.conversationUrl ?? local.conversationUrl ?? null,
        starred: remote.starred ?? local.starred ?? false,
        ...(remote.mediaType !== undefined || local.mediaType !== undefined
          ? { mediaType: remote.mediaType ?? local.mediaType } : {}),
        ...(remote.duration !== undefined || local.duration !== undefined
          ? { duration: remote.duration ?? local.duration } : {}),
        createdAt: remote.createdAt || local.createdAt,
        updatedAt: remote.updatedAt,
        syncedAt: remote.updatedAt,
        ...(remote.readingLog || local.readingLog
          ? { readingLog: { ...local.readingLog, ...remote.readingLog } }
          : {})
      };
      merged++;
    }

    // Merge highlights by ID (union); remote wins on duplicate IDs only when
    // remote has a later timestamp, matching lib/readings-sync.js semantics.
    if (remote.highlights?.length) {
      const localHls = storage.get('local', [pageKey])[pageKey] || [];
      const byId = new Map();
      for (const h of localHls) byId.set(h.id || h.text, h);
      let mutated = false;
      for (const r of remote.highlights) {
        const id = r.id || r.text;
        const existing = byId.get(id);
        if (!existing) { byId.set(id, r); mutated = true; }
        else {
          const localTime = existing.timestamp || existing.createdAt || '';
          const remoteTime = r.timestamp || r.createdAt || '';
          if (remoteTime > localTime) { byId.set(id, r); mutated = true; }
        }
      }
      if (mutated) storage.set('local', { [pageKey]: Array.from(byId.values()) });
    }
  }

  saveReadings(localReadings);
  return { merged, sha: file.sha };
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

  const syncPath = ghPath || 'reading-log.json';
  let githubOk = true;
  let telegramOk = true;

  // Phase 0: Pull from GitHub and merge remote changes into local
  if (hasGitHub) {
    try {
      const mergeResult = await mergeFromRemote(ghToken, ghOwner, ghRepo, syncPath);
      if (mergeResult.merged > 0) {
        console.log(`Merged ${mergeResult.merged} reading(s) from GitHub`);
      }
    } catch (e) {
      console.error('Pull/merge from GitHub failed:', e);
    }
  }

  // Re-read after merge (local data may have changed)
  const readings = getReadings();
  const allKeys = Object.keys(readings);
  const changedKeys = allKeys.filter(k => needsSync(readings[k]));
  if (changedKeys.length === 0 && !hasGitHub) return { synced: 0, failed: 0 };

  // Batch-fetch highlights
  const allHighlights = {};
  for (const k of allKeys) {
    const data = storage.get('local', [k]);
    allHighlights[k] = data[k] || [];
  }

  // GitHub phase: push full export
  if (hasGitHub) {
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
      const existing = await githubGetFile(ghToken, ghOwner, ghRepo, syncPath);
      sha = existing?.sha || null;
    }

    githubOk = await githubPushFile(ghToken, ghOwner, ghRepo, syncPath, content, sha);
    if (!githubOk && sha) {
      const fresh = await githubGetFile(ghToken, ghOwner, ghRepo, syncPath);
      if (fresh?.sha) githubOk = await githubPushFile(ghToken, ghOwner, ghRepo, syncPath, content, fresh.sha);
    }
  }

  // Phase 1.7: Supabase readings/highlights sync
  try {
    const auth = await getSupabaseAuth();
    if (auth) {
      await syncReadingsToSupabase(auth.token, auth.userId, readings);
    }
  } catch (e) {
    console.error('Supabase readings sync failed:', e);
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

  // Sync library PDFs via Supabase Storage (fire-and-forget, don't block reading sync)
  syncLibraryPdfs()
    .then(r => { if (r && (r.uploaded > 0 || r.downloaded > 0)) console.log(`PDF sync: ${r.uploaded} uploaded, ${r.downloaded} downloaded`); })
    .catch(e => console.error('Library PDF sync failed:', e));

  const pushed = allOk ? changedKeys.length : 0;

  // Store sync result so UI can display last-sync status
  storage.set('local', {
    ocLastSyncResult: {
      syncedAt: new Date().toISOString(),
      synced: true,
      count: pushed
    }
  });

  return { synced: pushed, failed: allOk ? 0 : changedKeys.length, githubOk, telegramOk };
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

// ── Restore from GitHub ──────────────────────────────────────────────
async function restoreFromGitHub() {
  const { ghToken, ghOwner, ghRepo, ghPath } = storage.get('sync',
    ['ghToken', 'ghOwner', 'ghRepo', 'ghPath']);

  if (!ghToken || !ghOwner || !ghRepo) {
    return { error: 'GitHub sync not configured — set it up in Settings first' };
  }

  const syncPath = ghPath || 'reading-log.json';
  try {
    const result = await mergeFromRemote(ghToken, ghOwner, ghRepo, syncPath);
    const readings = getReadings();
    const total = Object.keys(readings).length;
    return { ok: true, restored: result.merged, total };
  } catch (e) {
    return { error: `Restore failed: ${e.message}` };
  }
}

// ── Supabase auth helper ─────────────────────────────────────────────
async function getSupabaseAuth() {
  const { ocSupabaseSession } = storage.get('local', ['ocSupabaseSession']);
  if (!ocSupabaseSession) return null;

  const expiresAt = ocSupabaseSession.expires_at || 0;
  if (Date.now() / 1000 > expiresAt - 60) {
    // Refresh expired token
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
        body: JSON.stringify({ refresh_token: ocSupabaseSession.refresh_token })
      });
      if (!res.ok) return null;
      const data = await res.json();
      storage.set('local', {
        ocSupabaseSession: {
          access_token: data.access_token, refresh_token: data.refresh_token,
          expires_at: data.expires_at, user: data.user
        }
      });
      return { token: data.access_token, userId: data.user.id };
    } catch (e) {
      console.error('Supabase token refresh failed:', e);
      return null;
    }
  }

  return { token: ocSupabaseSession.access_token, userId: ocSupabaseSession.user.id };
}

// ── Library PDF sync via Supabase ────────────────────────────────────
// Delegates to lib/pdf-sync.js so list/upload/download wire formats stay
// aligned with the Chrome extension.
async function syncLibraryPdfs() {
  const auth = await getSupabaseAuth();
  if (!auth) return null;
  const { token, userId } = auth;

  const pdfSync = await getPdfSyncLib();

  let remotePdfs;
  try {
    remotePdfs = await pdfSync.listRemotePdfs(token, userId);
  } catch (e) {
    console.error('listRemotePdfs failed:', e);
    return null;
  }

  const remoteByKey = new Map(remotePdfs.map(p => [p.page_key, p]));
  const localMeta = libraryStorage.getAllTranscriptsMeta();
  const localKeys = new Set(localMeta.map(t => t.pageKey));

  let uploaded = 0, downloaded = 0;

  // Upload local PDFs not yet in Supabase
  for (const meta of localMeta) {
    if (remoteByKey.has(meta.pageKey)) continue;
    try {
      const transcript = libraryStorage.getTranscript(meta.pageKey);
      if (!transcript?.pdfData) continue;
      await pdfSync.uploadPdf(token, userId, {
        pageKey: meta.pageKey, fileHash: meta.fileHash, byteSize: meta.byteSize,
        title: meta.title, author: meta.author, fileName: meta.fileName,
        pageCount: meta.pageCount, wordCount: meta.wordCount, tags: meta.tags,
        // Buffer wraps the Uint8Array (zero-copy); Node's fetch accepts it as body.
        pdfData: Buffer.from(transcript.pdfData)
      });
      uploaded++;
    } catch (e) {
      console.error(`PDF upload failed for ${meta.pageKey}:`, e);
    }
  }

  // Download remote PDFs missing locally
  for (const remote of remotePdfs) {
    if (localKeys.has(remote.page_key)) continue;
    try {
      const buf = await pdfSync.downloadPdf(token, remote.storage_path);
      libraryStorage.putTranscript({
        pageKey: remote.page_key, title: remote.title || '', author: remote.author || '',
        pdfData: new Uint8Array(buf), content: '',
        fileName: remote.file_name || '', fileHash: remote.file_hash || '',
        byteSize: remote.byte_size || 0, pageCount: remote.page_count || 0,
        wordCount: remote.word_count || 0, tags: remote.tags || [],
        importedAt: remote.uploaded_at || new Date().toISOString(),
        format: 'pdf'
      });
      // Create reading entry so it shows on the dashboard.
      upsertReading({
        pageKey: remote.page_key, title: remote.title || '',
        author: remote.author || '', url: remote.page_key,
        tags: remote.tags || [], estPages: remote.page_count || 0
      });
      downloaded++;
    } catch (e) {
      console.error(`PDF download failed for ${remote.page_key}:`, e);
    }
  }

  return { uploaded, downloaded };
}

// ── Debounced sync ───────────────────────────────────────────────────
// Schedules a sync 30s after the last mutation, so rapid edits batch up.
let _syncTimer = null;
function scheduleSyncSoon() {
  if (_syncTimer) clearTimeout(_syncTimer);
  _syncTimer = setTimeout(async () => {
    _syncTimer = null;
    try {
      await syncReadings();
    } catch (e) {
      console.error('scheduleSyncSoon failed:', e);
    }
  }, 30000);
}

// ── Supabase readings/highlights sync ────────────────────────────────
// Delegates entirely to lib/readings-sync.js (the extension's module) so
// wire format and merge semantics are guaranteed identical between the
// Chrome extension and the Electron app. Behavior:
//   1. Pull remote → merge with local (LWW for readings, union-by-ID
//      with timestamp tiebreaker for highlights).
//   2. Persist merged state.
//   3. Push only readings whose updatedAt > syncedAt.
async function syncReadingsToSupabase(token, userId, readings) {
  const lib = await getReadingsSyncLib();
  const localSection = storage.get('local'); // full section, not a single key

  const remote = await lib.pullReadings(token, userId);

  const merged = await lib.mergeReadings(
    { readings, highlights: extractHighlightsFromLocal(localSection) },
    remote
  );

  if (merged.changed) {
    Object.assign(readings, merged.readings);
    saveReadings(readings);
    for (const [pageKey, hl] of Object.entries(merged.highlights)) {
      storage.set('local', { [pageKey]: hl });
    }
  }

  // Re-read after merge so the push sees the freshly-merged state.
  const freshLocal = merged.changed ? storage.get('local') : localSection;
  await lib.pushReadings(token, userId, readings, freshLocal);
}

// ── Message router ───────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {
    case 'oc-upsert-reading': {
      const result = upsertReading(msg);
      scheduleSyncSoon();
      return result;
    }
    case 'oc-get-reading': {
      const readings = getReadings();
      return { reading: readings[msg.pageKey] || null };
    }
    case 'oc-highlight-changed': {
      if (msg.action === 'create' || msg.action === 'update') {
        const readings = getReadings();
        const existing = readings[msg.pageKey];
        if (!existing) {
          // Auto-create reading — look up library metadata for page count
          const meta = libraryStorage.getTranscriptMeta(msg.pageKey);
          upsertReading({
            pageKey: msg.pageKey,
            title: meta?.title || msg.pageKey,
            url: msg.pageKey,
            tags: meta?.tags || [],
            estPages: meta?.pageCount || 0
          });
          if (meta?.pageCount > 0) {
            const now = new Date();
            const today = localDateStr(now);
            logPages(msg.pageKey, today, meta.pageCount);
          }
        } else if (!existing.readingLog || Object.keys(existing.readingLog).length === 0) {
          // Reading exists but no log — auto-log on first highlight
          const estPages = existing.estPages || 0;
          if (estPages > 0) {
            const now = new Date();
            const today = localDateStr(now);
            logPages(msg.pageKey, today, estPages);
          }
        }
      }
      touchReading(msg.pageKey);
      scheduleSyncSoon();
      return { ok: true };
    }
    case 'oc-log-pages': return logPages(msg.pageKey, msg.date, msg.pages);
    case 'oc-get-today-pages': return getTodayPages();
    case 'oc-flush': return syncReadings();
    case 'oc-restore-from-github': return restoreFromGitHub();
    case 'oc-reset-alarm': return { ok: true }; // no-op in Electron (uses setInterval)
    default: return { error: `Unknown message type: ${msg.type}` };
  }
}

module.exports = { handleMessage, syncReadings, getReadings };
