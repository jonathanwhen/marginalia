// lib/db.js — IndexedDB wrapper for Marginalia library transcripts
//
// Stores imported PDFs (raw bytes + plain text for search) in IndexedDB,
// which has effectively unlimited capacity vs chrome.storage.local's ~10MB cap.
// Readings metadata + highlights still live in chrome.storage.local so
// they sync to GitHub automatically via the existing pipeline.
//
// In Electron, delegates to file-based storage via IPC (window.__marginaliaLibrary)
// instead of IndexedDB, so PDFs persist at ~/.marginalia/library/.

const lib = typeof window !== 'undefined' && window.__marginaliaLibrary;

// ── IndexedDB backend (Chrome extension) ─────────────────────────────

const DB_NAME = 'marginaliaDB';
const DB_VERSION = 1;
const STORE_NAME = 'transcripts';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'pageKey' });
        store.createIndex('title', 'title', { unique: false });
        store.createIndex('importedAt', 'importedAt', { unique: false });
        store.createIndex('tags', 'tags', { unique: false, multiEntry: true });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });
  return dbPromise;
}

// ── Exported functions (delegate to Electron IPC or IndexedDB) ───────

export async function getTranscript(pageKey) {
  if (lib) return lib.getTranscript(pageKey);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(pageKey);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function putTranscript(transcript) {
  if (lib) return lib.putTranscript(transcript);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(transcript);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllTranscripts() {
  if (lib) {
    const meta = await lib.getAllTranscriptsMeta();
    const results = [];
    for (const m of meta) {
      const full = await lib.getTranscript(m.pageKey);
      if (full) results.push(full);
    }
    return results;
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Returns all transcripts with pdfData stripped out to avoid loading
// potentially 5-50MB of PDF bytes into memory when browsing the library grid.
export async function getAllTranscriptsMeta() {
  if (lib) return lib.getAllTranscriptsMeta();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const results = [];
    const req = tx.objectStore(STORE_NAME).openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const { pdfData, ...meta } = cursor.value;
        results.push(meta);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteTranscript(pageKey) {
  if (lib) return lib.deleteTranscript(pageKey);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(pageKey);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// Full-text search across transcript content and titles.
// Returns matching transcripts (scans all records — fine for ~100 items).
export async function searchTranscripts(query) {
  if (lib) return lib.searchTranscripts(query);
  const all = await getAllTranscripts();
  if (!query) return all;
  const q = query.toLowerCase();
  return all.filter(t =>
    (t.title || '').toLowerCase().includes(q) ||
    (t.author || '').toLowerCase().includes(q) ||
    (t.content || '').toLowerCase().includes(q) ||
    (t.tags || []).some(tag => tag.toLowerCase().includes(q))
  );
}

// Update a single field on an existing transcript without loading pdfData into memory.
// Reads the full record, patches the field, and writes back within one transaction.
export async function updateTranscriptField(pageKey, field, value) {
  if (lib) return lib.updateTranscriptField(pageKey, field, value);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(pageKey);
    getReq.onsuccess = () => {
      const record = getReq.result;
      if (!record) return reject(new Error(`Transcript not found: ${pageKey}`));
      record[field] = value;
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// Check if a transcript with this pageKey already exists (for dedup).
export async function hasTranscript(pageKey) {
  if (lib) return lib.hasTranscript(pageKey);
  const result = await getTranscript(pageKey);
  return result !== null;
}
