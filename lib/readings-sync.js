// lib/readings-sync.js - Sync readings & highlights via Supabase
// Uses same REST API pattern as lib/supabase.js (direct fetch, no SDK).

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase.js';

// ── Helpers ─────────────────────────────────────────────────────────

function authHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${token}`,
    'Prefer': 'return=minimal'
  };
}

function readHeaders(token) {
  return {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${token}`
  };
}

// ── Push local readings & highlights to Supabase ────────────────────

/**
 * Upserts readings and their highlights to Supabase.
 * Only pushes entries where updatedAt > syncedAt (i.e., locally changed).
 *
 * @param {string} token  - Supabase access token
 * @param {string} userId - Current user's UUID
 * @param {Object} readings - Full readings map {pageKey: readingData}
 * @param {Object} allStorage - Result of chrome.storage.local.get(null),
 *                              used to extract per-page highlight arrays
 */
export async function pushReadings(token, userId, readings, allStorage) {
  const highlights = extractHighlightsFromStorage(allStorage);
  const now = new Date().toISOString();

  // Collect rows that need pushing (locally changed since last sync)
  const readingRows = [];
  const highlightRows = [];

  for (const [pageKey, reading] of Object.entries(readings)) {
    const needsPush = !reading.syncedAt || reading.syncedAt < reading.updatedAt;
    if (!needsPush) continue;

    readingRows.push({
      user_id: userId,
      page_key: pageKey,
      data: reading,
      updated_at: reading.updatedAt || now
    });

    // Push highlights for the same page (even if empty, so remote stays in sync)
    highlightRows.push({
      user_id: userId,
      page_key: pageKey,
      highlights: highlights[pageKey] || [],
      updated_at: reading.updatedAt || now
    });
  }

  if (readingRows.length === 0) return;

  // Batch upsert readings (Supabase supports bulk POST with on-conflict)
  const readingsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/synced_readings?on_conflict=user_id,page_key`,
    {
      method: 'POST',
      headers: { ...authHeaders(token), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(readingRows)
    }
  );
  // 404 means table doesn't exist yet — skip silently
  if (readingsRes.status === 404) return;
  if (!readingsRes.ok) {
    const err = await readingsRes.text();
    throw new Error(`Push readings failed (${readingsRes.status}): ${err}`);
  }

  // Batch upsert highlights
  const highlightsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/synced_highlights?on_conflict=user_id,page_key`,
    {
      method: 'POST',
      headers: { ...authHeaders(token), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(highlightRows)
    }
  );
  if (highlightsRes.status === 404) return;
  if (!highlightsRes.ok) {
    const err = await highlightsRes.text();
    throw new Error(`Push highlights failed (${highlightsRes.status}): ${err}`);
  }
}

// ── Pull remote readings & highlights ───────────────────────────────

/**
 * Fetches all synced readings and highlights for this user.
 *
 * @param {string} token  - Supabase access token
 * @param {string} userId - Current user's UUID
 * @returns {{ readings: Object, highlights: Object }}
 *   readings:   { pageKey: { ...readingData } }
 *   highlights: { pageKey: [ ...highlightArray ] }
 */
export async function pullReadings(token, userId) {
  const [readingsRes, highlightsRes] = await Promise.all([
    fetch(
      `${SUPABASE_URL}/rest/v1/synced_readings?user_id=eq.${userId}&select=page_key,data,updated_at`,
      { headers: readHeaders(token) }
    ),
    fetch(
      `${SUPABASE_URL}/rest/v1/synced_highlights?user_id=eq.${userId}&select=page_key,highlights,updated_at`,
      { headers: readHeaders(token) }
    )
  ]);

  // 404 means table doesn't exist yet — treat as empty, not an error
  if (readingsRes.status === 404 || highlightsRes.status === 404) {
    return { readings: {}, highlights: {} };
  }
  if (!readingsRes.ok) throw new Error(`Pull readings failed: ${readingsRes.status}`);
  if (!highlightsRes.ok) throw new Error(`Pull highlights failed: ${highlightsRes.status}`);

  const readingsRows = await readingsRes.json();
  const highlightsRows = await highlightsRes.json();

  const readings = {};
  for (const row of readingsRows) {
    readings[row.page_key] = { ...row.data, _remoteUpdatedAt: row.updated_at };
  }

  const highlights = {};
  for (const row of highlightsRows) {
    highlights[row.page_key] = row.highlights || [];
  }

  return { readings, highlights };
}

// ── Merge local + remote ────────────────────────────────────────────

/**
 * Merges local and remote readings/highlights.
 *
 * Strategy:
 *  - Readings: last-write-wins by updatedAt
 *  - Highlights: union by highlight ID; for duplicates, keep the later one
 *
 * @param {{ readings: Object, highlights: Object }} local
 * @param {{ readings: Object, highlights: Object }} remote
 * @returns {{ readings: Object, highlights: Object, changed: boolean }}
 */
export async function mergeReadings(local, remote) {
  const mergedReadings = { ...local.readings };
  const mergedHighlights = { ...local.highlights };
  let changed = false;

  // Merge readings: last-write-wins
  for (const [pageKey, remoteReading] of Object.entries(remote.readings)) {
    const localReading = mergedReadings[pageKey];

    if (!localReading) {
      // New from remote — adopt it (strip internal field)
      const { _remoteUpdatedAt, ...data } = remoteReading;
      mergedReadings[pageKey] = data;
      changed = true;
    } else {
      // Both exist — compare updatedAt timestamps
      const localTime = localReading.updatedAt || '';
      const remoteTime = remoteReading._remoteUpdatedAt || remoteReading.updatedAt || '';

      if (remoteTime > localTime) {
        const { _remoteUpdatedAt, ...data } = remoteReading;
        mergedReadings[pageKey] = data;
        changed = true;
      }
    }
  }

  // Merge highlights: union by highlight ID
  for (const [pageKey, remoteHl] of Object.entries(remote.highlights)) {
    const localHl = mergedHighlights[pageKey] || [];
    const merged = mergeHighlightArrays(localHl, remoteHl);

    if (merged.length !== localHl.length || merged.some((h, i) => h !== localHl[i])) {
      mergedHighlights[pageKey] = merged;
      changed = true;
    }
  }

  return { readings: mergedReadings, highlights: mergedHighlights, changed };
}

// ── Internal: highlight array union ─────────────────────────────────

/**
 * Merges two highlight arrays by ID. For entries with the same ID,
 * keeps the one with the later timestamp. For unique IDs, includes both.
 */
function mergeHighlightArrays(localArr, remoteArr) {
  if (!Array.isArray(localArr)) localArr = [];
  if (!Array.isArray(remoteArr)) remoteArr = [];

  const byId = new Map();

  for (const h of localArr) {
    const id = h.id || h.text; // fall back to text as identity if no id
    byId.set(id, h);
  }

  for (const h of remoteArr) {
    const id = h.id || h.text;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, h);
    } else {
      // Keep the one with the later timestamp
      const existingTime = existing.createdAt || existing.timestamp || '';
      const remoteTime = h.createdAt || h.timestamp || '';
      if (remoteTime > existingTime) {
        byId.set(id, h);
      }
    }
  }

  return Array.from(byId.values());
}

// ── Internal: extract highlight arrays from chrome.storage dump ─────

/**
 * Filters chrome.storage.local entries to find highlight arrays.
 * Skips known non-highlight keys and position-tracking keys.
 */
function extractHighlightsFromStorage(allStorage) {
  const skip = new Set([
    'ocReadings', 'ocGitHubSha', 'ocMarkdownShas',
    'ocSupabaseSession', 'ocLastSyncResult'
  ]);
  const highlights = {};
  for (const [key, val] of Object.entries(allStorage)) {
    if (!skip.has(key) && !key.startsWith('pos:') && Array.isArray(val)) {
      highlights[key] = val;
    }
  }
  return highlights;
}
