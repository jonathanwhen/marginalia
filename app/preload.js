/**
 * Preload script: bridges chrome.* APIs to Electron IPC.
 * Exposed via contextBridge so extension HTML/JS works unmodified.
 */

const { contextBridge, ipcRenderer } = require('electron');

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

  sendMessage(msg, callback) {
    ipcRenderer.invoke('runtime-send-message', msg).then(result => {
      if (callback) callback(result);
    });
    return true;
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

// ── Expose chrome.* API ──────────────────────────────────────────────
contextBridge.exposeInMainWorld('chrome', {
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
