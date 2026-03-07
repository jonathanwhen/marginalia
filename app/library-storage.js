/**
 * File-based library storage for Electron.
 * Replaces IndexedDB for PDF transcript storage.
 *
 * Layout:
 *   ~/.marginalia/library/meta.json   — array of transcript metadata
 *   ~/.marginalia/library/<hash>.pdf  — raw PDF files
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const LIB_DIR = path.join(os.homedir(), '.marginalia', 'library');
const META_FILE = path.join(LIB_DIR, 'meta.json');

let metaCache = null;

function ensureDir() {
  if (!fs.existsSync(LIB_DIR)) {
    fs.mkdirSync(LIB_DIR, { recursive: true });
  }
}

function loadMeta() {
  if (metaCache) return metaCache;
  ensureDir();
  if (fs.existsSync(META_FILE)) {
    try {
      metaCache = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    } catch {
      metaCache = [];
    }
  } else {
    metaCache = [];
  }
  return metaCache;
}

function saveMeta() {
  ensureDir();
  const tmp = META_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(metaCache, null, 2), 'utf8');
  fs.renameSync(tmp, META_FILE);
}

function pdfPath(pageKey) {
  const hash = crypto.createHash('sha256').update(pageKey).digest('hex').slice(0, 16);
  return path.join(LIB_DIR, hash + '.pdf');
}

// ── CRUD ─────────────────────────────────────────────────────────────

function getTranscript(pageKey) {
  const meta = loadMeta();
  const entry = meta.find(m => m.pageKey === pageKey);
  if (!entry) return null;

  // Load PDF data
  const pPath = pdfPath(pageKey);
  if (fs.existsSync(pPath)) {
    const buf = fs.readFileSync(pPath);
    // Return as Uint8Array (same as IndexedDB would)
    return { ...entry, pdfData: new Uint8Array(buf) };
  }
  return { ...entry, pdfData: null };
}

function putTranscript(transcript) {
  const meta = loadMeta();
  const { pdfData, ...rest } = transcript;

  // Save PDF binary
  if (pdfData) {
    ensureDir();
    const buf = Buffer.from(pdfData);
    fs.writeFileSync(pdfPath(transcript.pageKey), buf);
  }

  // Upsert metadata
  const idx = meta.findIndex(m => m.pageKey === transcript.pageKey);
  if (idx >= 0) {
    meta[idx] = rest;
  } else {
    meta.push(rest);
  }
  metaCache = meta;
  saveMeta();
  return transcript.pageKey;
}

function getTranscriptMeta(pageKey) {
  const meta = loadMeta();
  return meta.find(m => m.pageKey === pageKey) || null;
}

function getAllTranscriptsMeta() {
  return loadMeta().map(m => ({ ...m }));
}

function deleteTranscript(pageKey) {
  const meta = loadMeta();
  metaCache = meta.filter(m => m.pageKey !== pageKey);
  saveMeta();

  // Delete PDF file
  const pPath = pdfPath(pageKey);
  if (fs.existsSync(pPath)) {
    fs.unlinkSync(pPath);
  }
}

function updateTranscriptField(pageKey, field, value) {
  const meta = loadMeta();
  const entry = meta.find(m => m.pageKey === pageKey);
  if (!entry) throw new Error(`Transcript not found: ${pageKey}`);
  entry[field] = value;
  saveMeta();
}

function hasTranscript(pageKey) {
  const meta = loadMeta();
  return meta.some(m => m.pageKey === pageKey);
}

function searchTranscripts(query) {
  const meta = loadMeta();
  if (!query) return meta;
  const q = query.toLowerCase();
  return meta.filter(t =>
    (t.title || '').toLowerCase().includes(q) ||
    (t.author || '').toLowerCase().includes(q) ||
    (t.content || '').toLowerCase().includes(q) ||
    (t.tags || []).some(tag => tag.toLowerCase().includes(q))
  );
}

module.exports = {
  getTranscript,
  getTranscriptMeta,
  putTranscript,
  getAllTranscriptsMeta,
  deleteTranscript,
  updateTranscriptField,
  hasTranscript,
  searchTranscripts
};
