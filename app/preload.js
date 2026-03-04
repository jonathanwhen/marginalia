/**
 * Preload script: bridges chrome.* APIs to Electron IPC.
 *
 * Since window.chrome already exists in Chromium, we can't use
 * contextBridge.exposeInMainWorld('chrome', ...). Instead we expose
 * the polyfill as __marginaliaChrome and remap it to window.chrome
 * in the main world via webFrame.executeJavaScript.
 */

const { contextBridge, ipcRenderer, webFrame } = require('electron');

// ── Storage polyfill ─────────────────────────────────────────────────
function makeStorageArea(area) {
  return {
    get(keys, callback) {
      const result = ipcRenderer.sendSync('storage-get', area, keys);
      if (callback) callback(result);
      return Promise.resolve(result);
    },
    set(items, callback) {
      ipcRenderer.sendSync('storage-set', area, items);
      if (callback) callback();
      return Promise.resolve();
    },
    remove(keys, callback) {
      ipcRenderer.sendSync('storage-remove', area, keys);
      if (callback) callback();
      return Promise.resolve();
    }
  };
}

// ── OnChanged stub ───────────────────────────────────────────────────
const changeListeners = [];
const onChanged = {
  addListener(fn) { changeListeners.push(fn); },
  removeListener(fn) {
    const idx = changeListeners.indexOf(fn);
    if (idx >= 0) changeListeners.splice(idx, 1);
  }
};

// ── Runtime polyfill ─────────────────────────────────────────────────
const messageListeners = [];

const runtime = {
  id: 'marginalia-electron',
  lastError: null,

  getURL(path) {
    return ipcRenderer.sendSync('runtime-get-url', path);
  },

  openOptionsPage() {
    ipcRenderer.send('navigate', 'options.html');
  },

  sendMessage(msg, callback) {
    const promise = ipcRenderer.invoke('runtime-send-message', msg).then(result => {
      if (callback) callback(result);
      return result;
    });
    return promise;
  },

  onMessage: {
    addListener(fn) { messageListeners.push(fn); },
    removeListener(fn) {
      const idx = messageListeners.indexOf(fn);
      if (idx >= 0) messageListeners.splice(idx, 1);
    }
  }
};

// ── Action polyfill (badge — no-op in Electron) ─────────────────────
const action = {
  setBadgeText() {},
  setBadgeBackgroundColor() {}
};

// ── Tabs polyfill ────────────────────────────────────────────────────
const tabs = {
  async query() { return []; },
  async create({ url }) {
    if (url.startsWith('http')) {
      require('electron').shell.openExternal(url);
    } else {
      ipcRenderer.send('navigate', url);
    }
  },
  async sendMessage() { return null; }
};

// ── Scripting polyfill (no-op in Electron) ───────────────────────────
const scripting = {
  async executeScript() { return []; },
  async insertCSS() {}
};

// ── Alarms polyfill (no-op — sync uses setInterval) ──────────────────
const alarms = {
  async create() {},
  async clear() {},
  onAlarm: { addListener() {} }
};

// ── Context menus polyfill (no-op) ───────────────────────────────────
const contextMenus = {
  create() {},
  onClicked: { addListener() {} }
};

// ── Expose as __marginaliaChrome (contextBridge-safe name) ───────────
contextBridge.exposeInMainWorld('__marginaliaChrome', {
  storage: {
    local: makeStorageArea('local'),
    sync: makeStorageArea('sync'),
    onChanged
  },
  runtime,
  action,
  tabs,
  scripting,
  alarms,
  contextMenus,
  webNavigation: { onBeforeNavigate: { addListener() {} } }
});

// ── Library storage (file-based, replaces IndexedDB) ─────────────────
contextBridge.exposeInMainWorld('__marginaliaLibrary', {
  getAllTranscriptsMeta: () => ipcRenderer.invoke('library-get-all-meta'),
  getTranscript: (pageKey) => ipcRenderer.invoke('library-get', pageKey),
  putTranscript: (transcript) => ipcRenderer.invoke('library-put', transcript),
  deleteTranscript: (pageKey) => ipcRenderer.invoke('library-delete', pageKey),
  updateTranscriptField: (pageKey, field, value) => ipcRenderer.invoke('library-update-field', pageKey, field, value),
  hasTranscript: (pageKey) => ipcRenderer.invoke('library-has', pageKey),
  searchTranscripts: (query) => ipcRenderer.invoke('library-search', query)
});

// ── Remap to window.chrome in the main world ─────────────────────────
// This runs before page scripts, overwriting the built-in chrome object.
webFrame.executeJavaScript(`
  window.chrome = window.__marginaliaChrome;
  delete window.__marginaliaChrome;
`);
