import { classifyReading } from './lib/classify.js';

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
  classifyUntaggedReadings();
  setupFlushAlarm();
  setupDailySummaryAlarm();
  updateBadge();
});

// Also reset alarms on service worker startup (survives SW restarts)
setupFlushAlarm();
setupDailySummaryAlarm();
updateBadge();

// ── ArXiv PDF auto-intercept → open in built-in reader ──────────────
// Disabled: text layer quality needs improvement before auto-redirecting
// chrome.webNavigation.onBeforeNavigate.addListener((details) => {
//   if (details.frameId !== 0) return;
//   if (/^https:\/\/(www\.)?arxiv\.org\/pdf\//.test(details.url)) {
//     chrome.tabs.update(details.tabId, {
//       url: chrome.runtime.getURL('reader.html?url=' + encodeURIComponent(details.url))
//     });
//   }
// });

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
    id: crypto.randomUUID(),
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

// ── Retroactive auto-classification ─────────────────────────────────
// Classifies any existing readings that have no tags. Runs once on
// install/update. Non-destructive: only fills in empty tag arrays.
async function classifyUntaggedReadings() {
  const readings = await getReadings();
  let changed = false;
  for (const [pageKey, reading] of Object.entries(readings)) {
    if (!reading.tags || reading.tags.length === 0) {
      const tag = classifyReading(reading.title || '', reading.url || pageKey, '');
      reading.tags = [tag];
      reading.updatedAt = new Date().toISOString();
      reading.syncedAt = null; // mark for re-sync so tags propagate to GitHub
      changed = true;
    }
  }
  if (changed) await saveReadings(readings);
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
  if (msg.type === 'oc-log-pages') {
    logPages(msg.pageKey, msg.date, msg.pages).then(result => sendResponse(result));
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
  if (msg.type === 'oc-fetch-pdf') {
    // Proxy PDF fetches through the service worker which has full host_permissions
    fetch(msg.url)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then(buf => {
        // Encode as base64 to send through message passing
        const bytes = new Uint8Array(buf);
        let binary = '';
        // Process in chunks to avoid call stack overflow
        const chunkSize = 32768;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        sendResponse({ data: btoa(binary) });
      })
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'oc-reset-alarm') {
    setupFlushAlarm(msg.intervalMinutes).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'oc-restore-from-github') {
    restoreFromGitHub().then(result => sendResponse(result));
    return true;
  }
  if (msg.type === 'oc-extract-concepts') {
    extractConceptsForReading(msg.pageKey).then(result => sendResponse({ ok: true, ...result })).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'oc-extract-concepts-batch') {
    extractConceptsBatch(msg.pageKeys).then(result => sendResponse(result)).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'oc-get-concepts') {
    chrome.storage.local.get('ocConcepts', ({ ocConcepts }) => sendResponse(ocConcepts || { readings: {}, edges: [] }));
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
async function upsertReading({ pageKey, title, author, url, tags, notes, estPages, content }) {
  const readings = await getReadings();
  const now = new Date().toISOString();
  const existing = readings[pageKey];

  // Auto-classify new readings that have no tags
  const resolvedTags = tags ?? existing?.tags ?? [];
  if (!existing && resolvedTags.length === 0) {
    const autoTag = classifyReading(title || '', url || pageKey, content || '');
    resolvedTags.push(autoTag);
  }

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

// ── Log pages read on a specific date ────────────────────────────────
async function logPages(pageKey, date, pages) {
  const readings = await getReadings();
  const reading = readings[pageKey];
  if (!reading) return { error: 'Reading not found' };

  if (!reading.readingLog) reading.readingLog = {};

  if (pages <= 0) {
    delete reading.readingLog[date];
    // Remove empty readingLog object
    if (Object.keys(reading.readingLog).length === 0) delete reading.readingLog;
  } else {
    reading.readingLog[date] = pages;
  }

  await saveReadings(readings);
  await touchReading(pageKey);
  return { ok: true };
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
    if (r.readingLog) {
      // Use readingLog entry for today if present
      if (r.readingLog[todayStr]) {
        pages += r.readingLog[todayStr];
        count++;
      }
    } else {
      if (!r.createdAt) continue;
      // Convert stored UTC createdAt to local date string for comparison
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

// Clear cached SHAs when GitHub credentials change
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  const ghKeys = ['ghToken', 'ghOwner', 'ghRepo', 'ghPath', 'ghNotesDir'];
  if (ghKeys.some(k => k in changes)) {
    chrome.storage.local.remove(['ocGitHubSha', 'ocMarkdownShas']);
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

// ── LLM concept extraction ───────────────────────────────────────────

async function extractConcepts(reading, highlights, existingTitles) {
  const { claudeApiKey } = await chrome.storage.sync.get('claudeApiKey');
  if (!claudeApiKey) throw new Error('No Claude API key configured');

  const hlText = highlights
    .slice(0, 30) // limit to avoid token overflow
    .map(h => `- "${h.text}"${h.comment ? ` (note: ${h.comment})` : ''}`)
    .join('\n');

  const prompt = `Analyze this reading and extract key concepts.

Title: ${reading.title}
Author: ${reading.author || 'Unknown'}
Tags: ${(reading.tags || []).join(', ')}
Notes: ${reading.notes || '(none)'}
Highlights:
${hlText || '(none)'}

Other readings in library: ${existingTitles.slice(0, 50).join(', ')}

Return JSON with:
- concepts: [{name: string, type: "theory"|"method"|"person"|"field"|"tool"|"dataset"|"finding"}]
- domains: [string] (broad academic domains)
- connections: [{title: string, shared_concepts: [string]}] (connections to other readings listed above)

Return ONLY valid JSON, no markdown fences.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': claudeApiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Claude API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';

  try {
    return JSON.parse(text);
  } catch {
    // Try extracting JSON from response
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Failed to parse Claude response as JSON');
  }
}

async function extractConceptsForReading(pageKey) {
  const readings = await getReadings();
  const reading = readings[pageKey];
  if (!reading) throw new Error('Reading not found');

  const hlData = await chrome.storage.local.get([pageKey]);
  const highlights = hlData[pageKey] || [];
  const existingTitles = Object.values(readings).map(r => r.title).filter(Boolean);

  const result = await extractConcepts(reading, highlights, existingTitles);

  // Store in ocConcepts
  const { ocConcepts = { readings: {}, edges: [] } } = await chrome.storage.local.get('ocConcepts');

  ocConcepts.readings[pageKey] = {
    concepts: result.concepts || [],
    domains: result.domains || [],
    extractedAt: new Date().toISOString()
  };

  // Rebuild edges: shared concepts between readings
  const allReadingKeys = Object.keys(ocConcepts.readings);
  const newEdges = [];
  for (let i = 0; i < allReadingKeys.length; i++) {
    const aKey = allReadingKeys[i];
    const aConcepts = new Set((ocConcepts.readings[aKey]?.concepts || []).map(c => c.name.toLowerCase()));
    for (let j = i + 1; j < allReadingKeys.length; j++) {
      const bKey = allReadingKeys[j];
      const bConcepts = (ocConcepts.readings[bKey]?.concepts || []).map(c => c.name.toLowerCase());
      const shared = bConcepts.filter(c => aConcepts.has(c));
      if (shared.length > 0) {
        newEdges.push({ source: aKey, target: bKey, shared });
      }
    }
  }
  ocConcepts.edges = newEdges;

  // Also incorporate explicit connections from Claude
  if (result.connections) {
    for (const conn of result.connections) {
      const targetKey = Object.entries(readings).find(([_, r]) => r.title === conn.title)?.[0];
      if (targetKey && targetKey !== pageKey) {
        const exists = ocConcepts.edges.some(e =>
          (e.source === pageKey && e.target === targetKey) || (e.source === targetKey && e.target === pageKey)
        );
        if (!exists) {
          ocConcepts.edges.push({ source: pageKey, target: targetKey, shared: conn.shared_concepts });
        }
      }
    }
  }

  await chrome.storage.local.set({ ocConcepts });
  return result;
}

async function extractConceptsBatch(pageKeys) {
  const results = { extracted: 0, skipped: 0, failed: 0 };
  const readings = await getReadings();
  const { ocConcepts = { readings: {}, edges: [] } } = await chrome.storage.local.get('ocConcepts');

  for (const key of pageKeys) {
    // Skip if already extracted and reading hasn't changed
    const existing = ocConcepts.readings[key];
    const reading = readings[key];
    if (existing?.extractedAt && reading?.updatedAt && existing.extractedAt >= reading.updatedAt) {
      results.skipped++;
      continue;
    }

    try {
      await extractConceptsForReading(key);
      results.extracted++;
      // Rate limit: 500ms between calls
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.error(`Concept extraction failed for ${key}:`, e);
      results.failed++;
    }
  }
  return results;
}

// ── Markdown notes sync (Obsidian-compatible) ────────────────────────

function makeMarkdownFilename(reading, pageKey) {
  // Slugify title: lowercase, strip special chars, collapse hyphens, max 60 chars
  const slug = (reading.title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

  // 6-char hash of pageKey for uniqueness
  let hash = 0;
  for (let i = 0; i < pageKey.length; i++) {
    hash = ((hash << 5) - hash + pageKey.charCodeAt(i)) | 0;
  }
  const hashStr = Math.abs(hash).toString(36).slice(0, 6).padEnd(6, '0');

  return `${slug}-${hashStr}.md`;
}

function buildMarkdownContent(pageKey, reading, highlights) {
  const lines = ['---'];

  // YAML frontmatter
  lines.push(`title: "${(reading.title || '').replace(/"/g, '\\"')}"`);
  if (reading.author) lines.push(`author: "${reading.author.replace(/"/g, '\\"')}"`);
  if (reading.tags?.length) lines.push(`tags: [${reading.tags.map(t => `"${t}"`).join(', ')}]`);
  if (reading.url) lines.push(`url: "${reading.url}"`);
  if (reading.estPages) lines.push(`pages: ${reading.estPages}`);
  lines.push(`created: "${reading.createdAt || ''}"`);
  lines.push(`updated: "${reading.updatedAt || ''}"`);
  lines.push('---');
  lines.push('');

  // Title
  lines.push(`# ${reading.title || 'Untitled'}`);
  lines.push('');

  // Notes
  if (reading.notes) {
    lines.push('## Notes');
    lines.push('');
    lines.push(reading.notes);
    lines.push('');
  }

  // Reading log
  if (reading.readingLog && Object.keys(reading.readingLog).length) {
    lines.push('## Reading Log');
    lines.push('');
    const sortedDates = Object.keys(reading.readingLog).sort();
    for (const date of sortedDates) {
      lines.push(`- ${date}: ${reading.readingLog[date]} pages`);
    }
    lines.push('');
  }

  // Highlights
  if (highlights?.length) {
    lines.push('## Highlights');
    lines.push('');

    const sorted = [...highlights].sort((a, b) =>
      (a.pageIndex ?? 0) - (b.pageIndex ?? 0) || (a.startOffset ?? 0) - (b.startOffset ?? 0)
    );

    for (const h of sorted) {
      lines.push(`> ${h.text}`);
      if (h.latex) lines.push(`> **LaTeX:** \`${h.latex}\``);
      if (h.comment) lines.push(`> — *${h.comment}*`);
      const meta = [];
      if (h.pageIndex !== undefined) meta.push(`Page ${h.pageIndex + 1}`);
      if (h.color && h.color !== 'orange') meta.push(h.color);
      if (meta.length) lines.push(`> *(${meta.join(', ')})*`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

async function pushMarkdownFile(ghToken, ghOwner, ghRepo, dir, filename, content, shaCache) {
  const filePath = dir ? `${dir.replace(/\/+$/, '')}/${filename}` : filename;
  const encoded = btoa(unescape(encodeURIComponent(content)));
  const body = {
    message: `update ${filename} ${new Date().toISOString().slice(0, 10)}`,
    content: encoded
  };

  // Use cached SHA if available
  const cachedSha = shaCache[filePath];
  if (cachedSha) body.sha = cachedSha;

  try {
    let res = await fetch(
      `https://api.github.com/repos/${ghOwner}/${ghRepo}/contents/${filePath}`,
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

    // SHA conflict — fetch fresh SHA and retry
    if (res.status === 409 || res.status === 422) {
      const existing = await githubGetFile(ghToken, ghOwner, ghRepo, filePath);
      if (existing?.sha) {
        body.sha = existing.sha;
        res = await fetch(
          `https://api.github.com/repos/${ghOwner}/${ghRepo}/contents/${filePath}`,
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
      }
    }

    if (!res.ok) return null;
    const data = await res.json();
    return data.content?.sha || null;
  } catch (e) {
    console.error('pushMarkdownFile:', e);
    return null;
  }
}

async function syncMarkdownNotes(ghToken, ghOwner, ghRepo, ghNotesDir, changedKeys, readings, allHighlights) {
  // Load SHA cache
  const { ocMarkdownShas = {} } = await chrome.storage.local.get('ocMarkdownShas');
  let pushed = 0, failed = 0;

  for (const key of changedKeys) {
    const reading = readings[key];
    if (!reading) continue;

    const filename = makeMarkdownFilename(reading, key);
    const content = buildMarkdownContent(key, reading, allHighlights[key] || []);
    const newSha = await pushMarkdownFile(ghToken, ghOwner, ghRepo, ghNotesDir, filename, content, ocMarkdownShas);

    if (newSha) {
      const filePath = ghNotesDir ? `${ghNotesDir.replace(/\/+$/, '')}/${filename}` : filename;
      ocMarkdownShas[filePath] = newSha;
      pushed++;
    } else {
      failed++;
    }
  }

  // Save updated SHA cache
  await chrome.storage.local.set({ ocMarkdownShas });
  return { pushed, failed };
}

// ── syncReadings() — replaces flushOutbox() ─────────────────────────
async function syncReadings() {
  const { botToken, chatId, ghToken, ghOwner, ghRepo, ghPath, ghNotesDir } =
    await chrome.storage.sync.get(['botToken', 'chatId', 'ghToken', 'ghOwner', 'ghRepo', 'ghPath', 'ghNotesDir']);

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
        highlights: allHighlights[key] || [],
        ...(reading.readingLog ? { readingLog: reading.readingLog } : {})
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

  // Phase 1.5: Markdown notes sync (Obsidian-compatible)
  if (hasGitHub && ghNotesDir) {
    try {
      await syncMarkdownNotes(ghToken, ghOwner, ghRepo, ghNotesDir, changedKeys, readings, allHighlights);
    } catch (e) {
      console.error('Markdown notes sync failed:', e);
      // Non-fatal: don't affect githubOk/telegramOk/syncedAt
    }
  }

  // Phase 1.75: Auto-extract concepts if enabled (fire-and-forget)
  const { autoExtract } = await chrome.storage.sync.get('autoExtract');
  if (autoExtract && changedKeys.length > 0) {
    extractConceptsBatch(changedKeys).catch(e => console.error('Auto-extract failed:', e));
  }

  // Phase 2: Telegram — send diff message for changed readings only
  if (hasTelegram) {
    const changedEntries = changedKeys.map(k => ({
      reading: readings[k],
      highlightCount: (allHighlights[k] || []).length,
      isNew: !readings[k].syncedAt
    }));

    let diffMsg = buildDiffMessage(changedEntries);
    if (diffMsg) {
      // Telegram has a 4096 char limit per message
      if (diffMsg.length > 4000) {
        diffMsg = diffMsg.slice(0, 3980) + '\n\n… (truncated)';
      }
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

// ── Restore from GitHub backup ───────────────────────────────────────
async function restoreFromGitHub() {
  const { ghToken, ghOwner, ghRepo, ghPath } =
    await chrome.storage.sync.get(['ghToken', 'ghOwner', 'ghRepo', 'ghPath']);

  if (!ghToken || !ghOwner || !ghRepo) {
    return { error: 'GitHub sync not configured — set it up above first' };
  }

  const path = ghPath || 'reading-log.json';

  try {
    // Fetch the file content from GitHub
    const res = await fetch(
      `https://api.github.com/repos/${ghOwner}/${ghRepo}/contents/${path}`,
      { headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' } }
    );
    if (res.status === 404) return { error: 'reading-log.json not found in repo' };
    if (!res.ok) return { error: `GitHub API error: ${res.status}` };

    const data = await res.json();
    // Decode base64 content (handle Unicode)
    const content = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
    const payload = JSON.parse(content);

    if (!payload.readings || typeof payload.readings !== 'object') {
      return { error: 'Invalid backup format — no readings found' };
    }

    // Merge into existing data (don't overwrite — merge)
    const existingReadings = await getReadings();
    let restored = 0;

    const highlightsToSet = {};

    for (const [pageKey, entry] of Object.entries(payload.readings)) {
      // Only restore if this reading doesn't already exist locally
      if (!existingReadings[pageKey]) {
        const now = new Date().toISOString();
        existingReadings[pageKey] = {
          title: entry.title || '',
          author: entry.author || '',
          url: entry.url || pageKey,
          tags: entry.tags || [],
          notes: entry.notes || '',
          estPages: entry.estPages || 0,
          createdAt: entry.createdAt || now,
          updatedAt: entry.updatedAt || now,
          syncedAt: entry.updatedAt || now,  // Mark as synced (came from GitHub)
          ...(entry.readingLog ? { readingLog: entry.readingLog } : {})
        };
        restored++;
      }

      // Restore highlights if we don't have any locally for this page
      if (entry.highlights?.length) {
        highlightsToSet[pageKey] = entry.highlights;
      }
    }

    // Save readings
    await saveReadings(existingReadings);

    // Restore highlights — only for pages that have no local highlights
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

    // Cache the SHA for future pushes
    await chrome.storage.local.set({ ocGitHubSha: data.sha });

    await updateBadge();

    const total = Object.keys(payload.readings).length;
    return { ok: true, restored, total };
  } catch (e) {
    return { error: `Restore failed: ${e.message}` };
  }
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
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`Telegram API error ${res.status}: ${body}`);
    }
    return res.ok;
  } catch (err) {
    console.error('Telegram send failed:', err.message || err);
    return false;
  }
}
