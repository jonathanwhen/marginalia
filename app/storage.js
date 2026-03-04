/**
 * File-based storage engine for Electron.
 * Replaces chrome.storage.local and chrome.storage.sync.
 * Single JSON file at ~/.marginalia/data.json with two sections: local and sync.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.marginalia');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

let cache = { local: {}, sync: {} };
let writeTimer = null;
const WRITE_DEBOUNCE = 500; // ms

// ── Initialize ───────────────────────────────────────────────────────
function init() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      cache = JSON.parse(raw);
      if (!cache.local) cache.local = {};
      if (!cache.sync) cache.sync = {};
    } catch (e) {
      console.error('Failed to read data file, starting fresh:', e);
      cache = { local: {}, sync: {} };
    }
  }
}

// ── Read ─────────────────────────────────────────────────────────────
function get(area, keys) {
  const section = cache[area] || {};
  if (!keys) return { ...section };

  const keyList = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys));
  const result = {};

  for (const key of keyList) {
    if (key in section) {
      result[key] = section[key];
    } else if (typeof keys === 'object' && !Array.isArray(keys) && key in keys) {
      // Default value from object-style keys
      result[key] = keys[key];
    }
  }
  return result;
}

// ── Write ────────────────────────────────────────────────────────────
function set(area, items) {
  if (!cache[area]) cache[area] = {};
  Object.assign(cache[area], items);
  scheduleSave();
}

// ── Remove ───────────────────────────────────────────────────────────
function remove(area, keys) {
  const keyList = Array.isArray(keys) ? keys : [keys];
  for (const key of keyList) {
    delete cache[area]?.[key];
  }
  scheduleSave();
}

// ── Persist to disk (debounced) ──────────────────────────────────────
function scheduleSave() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => writeToDisk(), WRITE_DEBOUNCE);
}

function writeToDisk() {
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('Failed to write data file:', e);
  }
}

// ── Flush synchronously (for app quit) ───────────────────────────────
function flushSync() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  writeToDisk();
}

module.exports = { init, get, set, remove, flushSync };
