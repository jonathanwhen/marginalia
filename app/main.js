/**
 * Electron main process for Marginalia.
 *
 * Loads the same extension HTML/CSS/JS via file:// and bridges
 * chrome.* API calls through IPC to a local JSON storage engine.
 */

const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const storage = require('./storage');
const sync = require('./sync');

// Extension root — one level up from app/
const EXT_ROOT = path.resolve(__dirname, '..');

let mainWindow = null;
let syncInterval = null;

// ── App lifecycle ───────────────────────────────────────────────────

app.whenReady().then(() => {
  storage.init();
  createWindow();
  buildMenu();
  startSyncTimer();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (syncInterval) clearInterval(syncInterval);
  storage.flushSync();
});

// macOS: open PDF files via Finder / file association
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow) {
    openPdfFile(filePath);
  } else {
    // Window not ready yet — defer
    app.once('browser-window-created', () => openPdfFile(filePath));
  }
});

// ── Window ──────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#1e1e2e',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false // needed for contextBridge require('electron')
    }
  });

  mainWindow.loadFile(path.join(EXT_ROOT, 'library.html'));

  mainWindow.on('closed', () => { mainWindow = null; });

  // Open external URLs in system browser, allow local navigation
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) return; // allow local navigation
    event.preventDefault();
    shell.openExternal(url);
  });

  // Handle new-window requests (e.g., target="_blank" links)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('file://')) {
      mainWindow.loadURL(url);
    } else {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

// ── IPC: Storage ────────────────────────────────────────────────────

ipcMain.on('storage-get', (event, area, keys) => {
  event.returnValue = storage.get(area, keys);
});

ipcMain.on('storage-set', (event, area, items) => {
  storage.set(area, items);
  event.returnValue = true;
});

ipcMain.on('storage-remove', (event, area, keys) => {
  storage.remove(area, keys);
  event.returnValue = true;
});

// ── IPC: Runtime ────────────────────────────────────────────────────

ipcMain.on('runtime-get-url', (event, relativePath) => {
  // Resolve extension-relative path to file:// URL
  const absPath = path.join(EXT_ROOT, relativePath);
  event.returnValue = 'file://' + absPath;
});

ipcMain.handle('runtime-send-message', async (_event, msg) => {
  return sync.handleMessage(msg);
});

// ── IPC: Navigation ─────────────────────────────────────────────────

ipcMain.on('navigate', (_event, url) => {
  if (!mainWindow) return;
  // url is a chrome.runtime.getURL() result — already resolved to file://
  if (url.startsWith('file://')) {
    mainWindow.loadURL(url);
  } else {
    // Relative path from extension root
    mainWindow.loadFile(path.join(EXT_ROOT, url));
  }
});

// ── Open PDF ────────────────────────────────────────────────────────

function openPdfFile(filePath) {
  if (!mainWindow) return;
  const encodedPath = encodeURIComponent(filePath);
  const readerUrl = `file://${path.join(EXT_ROOT, 'library-reader.html')}?file=${encodedPath}`;
  mainWindow.loadURL(readerUrl);
}

async function openPdfDialog() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open PDF',
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    properties: ['openFile']
  });

  if (!result.canceled && result.filePaths.length > 0) {
    openPdfFile(result.filePaths[0]);
  }
}

// ── Sync timer (replaces chrome.alarms) ─────────────────────────────

function startSyncTimer() {
  // Sync every 5 minutes
  syncInterval = setInterval(async () => {
    try {
      await sync.syncReadings();
    } catch (e) {
      console.error('Auto-sync failed:', e);
    }
  }, 5 * 60 * 1000);
}

// ── Menu bar ────────────────────────────────────────────────────────

function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    // App menu (macOS only)
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),

    // File
    {
      label: 'File',
      submenu: [
        {
          label: 'Open PDF...',
          accelerator: 'CmdOrCtrl+O',
          click: () => openPdfDialog()
        },
        { type: 'separator' },
        {
          label: 'Library',
          accelerator: 'CmdOrCtrl+1',
          click: () => mainWindow?.loadFile(path.join(EXT_ROOT, 'library.html'))
        },
        {
          label: 'Dashboard',
          accelerator: 'CmdOrCtrl+2',
          click: () => mainWindow?.loadFile(path.join(EXT_ROOT, 'dashboard.html'))
        },
        {
          label: 'Knowledge Graph',
          accelerator: 'CmdOrCtrl+3',
          click: () => mainWindow?.loadFile(path.join(EXT_ROOT, 'graph.html'))
        },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow?.loadFile(path.join(EXT_ROOT, 'options.html'))
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },

    // Edit
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },

    // View
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },

    // Sync
    {
      label: 'Sync',
      submenu: [
        {
          label: 'Sync Now',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: async () => {
            try {
              const result = await sync.syncReadings();
              if (result.error) {
                dialog.showErrorBox('Sync', result.error);
              } else if (result.synced > 0) {
                dialog.showMessageBox(mainWindow, {
                  type: 'info',
                  message: `Synced ${result.synced} reading${result.synced > 1 ? 's' : ''}.`
                });
              } else {
                dialog.showMessageBox(mainWindow, {
                  type: 'info',
                  message: 'Nothing to sync.'
                });
              }
            } catch (e) {
              dialog.showErrorBox('Sync Error', e.message);
            }
          }
        }
      ]
    },

    // Window (macOS)
    ...(isMac ? [{
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }] : [])
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
