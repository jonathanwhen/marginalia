/**
 * Sync logic for Electron — ported from background.js.
 * Uses the storage module instead of chrome.storage.
 */

const storage = require('./storage');
const libraryStorage = require('./library-storage');

// ── Supabase config (PDF sync) ───────────────────────────────────────
const SUPABASE_URL = 'https://lfvbrrxnjwanbniaegnf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxmdmJycnhuandhbmJuaWFlZ25mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2NzAxMDYsImV4cCI6MjA4ODI0NjEwNn0.6NzXByK1y8FP-iCqYx6GCiuG6DsIvXpbkyqiCX_R1Os';

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
      const now = new Date().toISOString();
      localReadings[pageKey] = {
        title: remote.title || '', author: remote.author || '',
        url: remote.url || pageKey, tags: remote.tags || [],
        notes: remote.notes || '', estPages: remote.estPages || 0,
        createdAt: remote.createdAt || now, updatedAt: remote.updatedAt || now,
        syncedAt: remote.updatedAt || now,
        ...(remote.readingLog ? { readingLog: remote.readingLog } : {})
      };
      merged++;
    } else if (remote.updatedAt && remote.updatedAt > (local.updatedAt || '')) {
      localReadings[pageKey] = {
        title: remote.title || local.title,
        author: remote.author || local.author,
        url: remote.url || local.url,
        tags: remote.tags || local.tags,
        notes: remote.notes || local.notes,
        estPages: remote.estPages || local.estPages,
        createdAt: remote.createdAt || local.createdAt,
        updatedAt: remote.updatedAt,
        syncedAt: remote.updatedAt,
        ...(remote.readingLog || local.readingLog
          ? { readingLog: { ...local.readingLog, ...remote.readingLog } }
          : {})
      };
      merged++;
    }

    // Merge highlights by ID (union)
    if (remote.highlights?.length) {
      const localHls = storage.get('local', [pageKey])[pageKey] || [];
      const localIds = new Set(localHls.map(h => h.id));
      const newHls = remote.highlights.filter(h => !localIds.has(h.id));
      if (newHls.length > 0) {
        storage.set('local', { [pageKey]: [...localHls, ...newHls] });
      }
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

  // Sync library PDFs via Supabase Storage
  try {
    const pdfResult = await syncLibraryPdfs();
    if (pdfResult && (pdfResult.uploaded > 0 || pdfResult.downloaded > 0)) {
      console.log(`PDF sync: ${pdfResult.uploaded} uploaded, ${pdfResult.downloaded} downloaded`);
    }
  } catch (e) {
    console.error('Library PDF sync failed:', e);
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
    } catch { return null; }
  }

  return { token: ocSupabaseSession.access_token, userId: ocSupabaseSession.user.id };
}

// ── Library PDF sync via Supabase ────────────────────────────────────
async function syncLibraryPdfs() {
  const auth = await getSupabaseAuth();
  if (!auth) return null;

  const { token, userId } = auth;
  const sbHeaders = { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${token}` };

  // List remote PDFs
  const listRes = await fetch(
    `${SUPABASE_URL}/rest/v1/library_pdfs?user_id=eq.${userId}&select=page_key,file_hash,byte_size,title,author,file_name,page_count,word_count,tags,storage_path,uploaded_at`,
    { headers: sbHeaders }
  );
  if (!listRes.ok) return null;
  const remotePdfs = await listRes.json();
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
      const storagePath = `${userId}/${meta.fileHash}-${meta.byteSize}.pdf`;

      const upRes = await fetch(`${SUPABASE_URL}/storage/v1/object/library/${storagePath}`, {
        method: 'POST',
        headers: { ...sbHeaders, 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
        body: Buffer.from(transcript.pdfData)
      });
      if (!upRes.ok) continue;

      await fetch(`${SUPABASE_URL}/rest/v1/library_pdfs`, {
        method: 'POST',
        headers: { ...sbHeaders, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({
          user_id: userId, page_key: meta.pageKey, file_hash: meta.fileHash || '',
          byte_size: meta.byteSize || 0, title: meta.title || '', author: meta.author || '',
          file_name: meta.fileName || '', page_count: meta.pageCount || 0,
          word_count: meta.wordCount || 0, tags: meta.tags || [],
          storage_path: storagePath, updated_at: new Date().toISOString()
        })
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
      const dlRes = await fetch(`${SUPABASE_URL}/storage/v1/object/library/${remote.storage_path}`, {
        headers: sbHeaders
      });
      if (!dlRes.ok) continue;
      const pdfData = await dlRes.arrayBuffer();

      libraryStorage.putTranscript({
        pageKey: remote.page_key, title: remote.title || '', author: remote.author || '',
        pdfData: new Uint8Array(pdfData), content: '',
        fileName: remote.file_name || '', fileHash: remote.file_hash || '',
        byteSize: remote.byte_size || 0, pageCount: remote.page_count || 0,
        wordCount: remote.word_count || 0, tags: remote.tags || [],
        importedAt: remote.uploaded_at || new Date().toISOString(),
        format: 'pdf'
      });

      // Create reading entry
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

// ── Message router ───────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {
    case 'oc-upsert-reading': return upsertReading(msg);
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
          const allMeta = libraryStorage.getAllTranscriptsMeta();
          const meta = allMeta.find(t => t.pageKey === msg.pageKey);
          upsertReading({
            pageKey: msg.pageKey,
            title: meta?.title || msg.pageKey,
            url: msg.pageKey,
            tags: meta?.tags || [],
            estPages: meta?.pageCount || 0
          });
          if (meta?.pageCount > 0) {
            const now = new Date();
            const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            logPages(msg.pageKey, today, meta.pageCount);
          }
        } else if (!existing.readingLog || Object.keys(existing.readingLog).length === 0) {
          // Reading exists but no log — auto-log on first highlight
          const estPages = existing.estPages || 0;
          if (estPages > 0) {
            const now = new Date();
            const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            logPages(msg.pageKey, today, estPages);
          }
        }
      }
      touchReading(msg.pageKey);
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
