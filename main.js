const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { exec } = require('child_process');
const { DownloadTask } = require('./engine/downloader.js');
const { MediaTask } = require('./engine/mediaDownloader.js');

app.name = 'TurboDownloadManager';
const userDataPath = path.join(os.homedir(), 'AppData', 'Local', 'TurboDownloader', 'userData');
if (!fs.existsSync(userDataPath)) {
  fs.mkdirSync(userDataPath, { recursive: true });
}
app.setPath('userData', userDataPath);

// Enforce Single-Instance Application (prevents duplicate zombie processes from hijacking API port 18888)
const gotTheLock = app.requestSingleInstanceLock();
console.log(`[Lock Check] gotTheLock = ${gotTheLock}, pid = ${process.pid}`);
if (!gotTheLock) {
  console.log(`[Lock Check] Exiting because single-instance lock was not acquired.`);
  app.quit();
  process.exit(0);
}

let mainWindow;
let tray = null;
let isQuitting = false;
let hasShownTrayNotification = false;
const activeTasks = new Map(); // id -> DownloadTask
const defaultDownloadDir = path.join(os.homedir(), 'Downloads');
const API_PORT = 18888;

// Persistent Download Storage
const TASKS_FILE = path.join(os.homedir(), 'AppData', 'Local', 'TurboDownloader', 'tasks_history.json');
const savedTaskSnapshots = new Map();

function loadStoredTasks() {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
      if (Array.isArray(data)) {
        data.forEach(t => {
          if (t && t.id) {
            if (t.status === 'downloading' || t.status === 'probing' || t.status === 'queued') {
              t.status = 'paused';
              t.speed = 0;
              t.eta = 0;
            }
            savedTaskSnapshots.set(t.id, t);
          }
        });
      }
    }
  } catch (e) {
    console.error('Failed to load stored tasks:', e);
  }

  // Auto-scan Downloads/Video for recently downloaded files not yet in history
  try {
    const videoDir = path.join(defaultDownloadDir, 'Video');
    if (fs.existsSync(videoDir)) {
      const files = fs.readdirSync(videoDir);
      const existingPaths = new Set(Array.from(savedTaskSnapshots.values()).map(t => t.savePath));
      for (const file of files) {
        if (file.endsWith('.mp4') && !file.includes('.f')) {
          const fullPath = path.join(videoDir, file);
          if (!existingPaths.has(fullPath)) {
            const stat = fs.statSync(fullPath);
            const id = 'imported_' + Buffer.from(file).toString('hex').slice(0, 10);
            savedTaskSnapshots.set(id, {
              id,
              url: 'YouTube / Media Stream',
              savePath: fullPath,
              fileName: file,
              status: 'completed',
              totalBytes: stat.size,
              downloadedBytes: stat.size,
              percent: 100,
              speed: 0,
              eta: 0,
              threads: 16,
              resumable: true,
              category: 'Video',
              segments: [{ id: 0, start: 0, end: 100, total: 100, downloaded: 100, percent: 100, status: 'completed' }],
              error: null
            });
            existingPaths.add(fullPath);
          }
        }
      }
    }
  } catch (e) {}
}

let persistTimer = null;
function persistTasks() {
  try {
    const dir = path.dirname(TASKS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const list = Array.from(savedTaskSnapshots.values());
    fs.writeFileSync(TASKS_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to persist tasks:', e);
  }
}

function persistTasksDebounced() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistTasks();
  }, 2000);
}

function recordTaskSnapshot(snapshot, immediate = false) {
  if (!snapshot || !snapshot.id) return;
  savedTaskSnapshots.set(snapshot.id, snapshot);
  if (immediate || snapshot.status === 'completed' || snapshot.status === 'error' || snapshot.status === 'paused') {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    persistTasks();
  } else {
    persistTasksDebounced();
  }
}

loadStoredTasks();

// Feature Settings
let autoShutdownEnabled = false;
let shutdownTimer = null;
let clipboardMonitorEnabled = true;
let smartCategoryEnabled = true;
let lastClipboardText = '';

// Smart Categories Mapping
const CATEGORY_MAP = {
  Compressed: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso', '.dmg', '.tgz'],
  Video: ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.wmv', '.m4v', '.ts'],
  Music: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma', '.opus'],
  Images: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tiff', '.tif', '.avif', '.jfif', '.heic'],
  Programs: ['.exe', '.msi', '.bat', '.cmd', '.apk', '.appimage'],
  Documents: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.epub', '.csv']
};

function getCategoryForFile(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  for (const [category, extensions] of Object.entries(CATEGORY_MAP)) {
    if (extensions.includes(ext)) return category;
  }
  return 'General';
}

function createWindow() {
  const iconIco = path.join(__dirname, 'assets', 'icon.ico');
  const iconPng = path.join(__dirname, 'assets', 'icon.png');
  const iconPath = fs.existsSync(iconIco) ? iconIco : (fs.existsSync(iconPng) ? iconPng : undefined);

  mainWindow = new BrowserWindow({
    width: 1150,
    height: 780,
    minWidth: 850,
    minHeight: 580,
    title: 'Turbo Download Manager (IDM Clean-Room Edition)',
    icon: iconPath,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.on('console-message', (_e, _level, msg) => {
    console.log('[Renderer]', msg);
  });

  mainWindow.loadFile('index.html');

  const isStartMinimized = process.argv.includes('--minimized') || process.argv.includes('--hidden');
  mainWindow.once('ready-to-show', () => {
    console.log(`[Window] ready-to-show event fired (isStartMinimized = ${isStartMinimized})`);
    if (!isStartMinimized) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      if (tray && !hasShownTrayNotification) {
        hasShownTrayNotification = true;
        try {
          tray.displayBalloon({
            title: 'Turbo Download Manager',
            content: 'Running in the background. Right-click the tray icon to exit.',
            iconType: 'info'
          });
        } catch (e) {}
      }
      return false;
    }
  });

  mainWindow.on('closed', () => {
    console.log('[Window] closed event fired');
    mainWindow = null;
  });
}

// Core Task Creator (Shared between UI and Chrome Extension)
async function createDownloadTask({ url, saveFolder, fileName, threads, category, mime }) {
  // 1. Check if streaming media platform (YouTube, TikTok, Twitter, Vimeo, Reddit, etc.)
  if (MediaTask.isSupported(url)) {
    const videoDir = saveFolder || path.join(defaultDownloadDir, 'Video');
    if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });

    const task = new MediaTask({
      url,
      saveFolder: videoDir,
      fileName
    });

    activeTasks.set(task.id, task);
    recordTaskSnapshot(task.getSnapshot());
    cancelAutoShutdown();

    task.on('progress', (snapshot) => {
      recordTaskSnapshot(snapshot);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-progress', snapshot);
      }
    });

    task.on('status', (snapshot) => {
      recordTaskSnapshot(snapshot);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-status', snapshot);
      }
    });

    task.on('completed', (snapshot) => {
      recordTaskSnapshot(snapshot);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-completed', snapshot);
      }
      checkAutoShutdown();
    });

    task.on('error', (err) => {
      recordTaskSnapshot({ ...task.getSnapshot(), status: 'error', error: err });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-error', { id: task.id, error: err });
      }
      checkAutoShutdown();
    });

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-created', task.getSnapshot());
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }

    task.start();
    return task.getSnapshot();
  }

  // 2. Standard direct file download (HTTP Range multi-stream)
  let finalName = fileName ? path.basename(fileName) : '';
  if (!finalName || !path.extname(finalName)) {
    const dummyTask = new DownloadTask({ url, savePath: 'dummy' });
    try {
      const res = await dummyTask.followRedirects(url);
      const finalUrl = res.finalUrl || url;
      const headers = res.headers || {};
      if (mime) {
        if (!headers['content-type'] || headers['content-type'].includes('octet-stream')) {
          headers['content-type'] = mime;
        }
      }
      const probedName = dummyTask.determineFileName(headers, finalUrl);
      if (probedName && (!finalName || path.extname(probedName))) {
        finalName = probedName;
      }
    } catch (e) {}
    if (!finalName) finalName = 'downloaded_file_' + Date.now().toString(36);
  }

  // Smart Category Subfolder Routing
  const fileCategory = category || getCategoryForFile(finalName);
  let targetFolder = saveFolder || defaultDownloadDir;

  if (smartCategoryEnabled && !saveFolder) {
    targetFolder = path.join(defaultDownloadDir, fileCategory);
  }

  if (!fs.existsSync(targetFolder)) fs.mkdirSync(targetFolder, { recursive: true });

  // Handle duplicate filenames gracefully
  let savePath = path.join(targetFolder, finalName);
  let counter = 1;
  const ext = path.extname(finalName);
  const base = path.basename(finalName, ext);
  while (fs.existsSync(savePath)) {
    savePath = path.join(targetFolder, `${base}_(${counter})${ext}`);
    counter++;
  }

  const task = new DownloadTask({
    url,
    savePath,
    threads: threads || 8
  });

  task.category = fileCategory;
  activeTasks.set(task.id, task);
  recordTaskSnapshot({ ...task.getSnapshot(), category: task.category });

  // If a shutdown countdown was active, cancel it when new downloads arrive
  cancelAutoShutdown();

  task.on('progress', (snapshot) => {
    recordTaskSnapshot({ ...snapshot, category: task.category });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-progress', { ...snapshot, category: task.category });
    }
  });

  task.on('status', (snapshot) => {
    recordTaskSnapshot({ ...snapshot, category: task.category });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-status', { ...snapshot, category: task.category });
    }
  });

  task.on('completed', (snapshot) => {
    recordTaskSnapshot({ ...snapshot, category: task.category });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-completed', { ...snapshot, category: task.category });
    }
    checkAutoShutdown();
  });

  task.on('error', (err) => {
    recordTaskSnapshot({ ...task.getSnapshot(), status: 'error', error: err, category: task.category });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-error', { id: task.id, error: err });
    }
    checkAutoShutdown();
  });

  // Notify UI of task creation immediately
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('download-created', { ...task.getSnapshot(), category: task.category });
  }

  task.start();

  // Bring window to front when extension triggers a download
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  return { ...task.getSnapshot(), category: task.category };
}

// Auto-Shutdown Countdown
function checkAutoShutdown() {
  if (!autoShutdownEnabled) return;
  if (activeTasks.size === 0) return;

  let hasPending = false;
  for (const task of activeTasks.values()) {
    if (task.status === 'downloading' || task.status === 'connecting' || task.status === 'queued' || task.status === 'probing') {
      hasPending = true;
      break;
    }
  }

  if (!hasPending && !shutdownTimer) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('shutdown-countdown', { seconds: 30 });
    }

    shutdownTimer = setTimeout(() => {
      if (process.platform === 'win32') {
        exec('shutdown /s /t 0', (err) => {
          if (err) console.error('Shutdown error:', err);
        });
      }
    }, 30000);
  }
}

function cancelAutoShutdown() {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('shutdown-cancelled');
  }
}

// Clipboard URL Auto-Detection Monitor
function startClipboardMonitor() {
  setInterval(() => {
    if (!clipboardMonitorEnabled) return;
    try {
      const text = clipboard.readText().trim();
      if (!text || text === lastClipboardText) return;
      lastClipboardText = text;

      // Check if text is a valid HTTP/HTTPS URL
      if (/^https?:\/\/[^\s$.?#].[^\s]*$/i.test(text)) {
        const urlClean = text.split('?')[0].toLowerCase();
        const allExts = [].concat(...Object.values(CATEGORY_MAP));
        const isDownloadable = allExts.some(ext => urlClean.endsWith(ext)) ||
                               urlClean.includes('/download') ||
                               urlClean.includes('media') ||
                               urlClean.includes('file');

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('clipboard-url-detected', {
            url: text,
            isDownloadable,
            category: getCategoryForFile(text)
          });
        }
      }
    } catch (e) {
      // Ignore clipboard read errors
    }
  }, 750);
}

// Local Integration Server for Chrome Extension
function startIntegrationServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/api/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', app: 'TurboDownloadManager', version: '1.1.0' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/download') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          if (!data.url) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'URL is required' }));
            return;
          }

          const snapshot = await createDownloadTask({
            url: data.url,
            fileName: data.fileName,
            mime: data.mime,
            threads: data.threads || 8
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, task: snapshot }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(API_PORT, '127.0.0.1', () => {
    console.log(`Browser integration server listening on http://127.0.0.1:${API_PORT}`);
  });

  server.on('error', (err) => {
    console.error('Integration server error:', err);
  });
}

// IPC Handlers for UI
ipcMain.handle('get-tasks', () => {
  const merged = new Map();
  for (const snap of savedTaskSnapshots.values()) {
    merged.set(snap.id, snap);
  }
  for (const task of activeTasks.values()) {
    merged.set(task.id, { ...task.getSnapshot(), category: task.category });
  }
  return Array.from(merged.values());
});

ipcMain.handle('get-default-folder', () => {
  return defaultDownloadDir;
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Destination Folder',
    defaultPath: defaultDownloadDir,
    properties: ['openDirectory', 'createDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('probe-url', async (_event, url) => {
  try {
    if (MediaTask.isSupported(url)) {
      return await MediaTask.probeMetadata(url);
    }
    const dummyTask = new DownloadTask({ url, savePath: 'dummy' });
    const { finalUrl, headers } = await dummyTask.followRedirects(url);
    const fileName = dummyTask.determineFileName(headers, finalUrl);
    const size = headers['content-length'] ? parseInt(headers['content-length'], 10) : 0;
    const resumable = headers['accept-ranges'] === 'bytes' && size > 0;
    const category = getCategoryForFile(fileName);
    return {
      success: true,
      fileName,
      size,
      resumable,
      finalUrl,
      category
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('add-download', async (_event, params) => {
  try {
    const snapshot = await createDownloadTask(params);
    return { success: true, task: snapshot };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('pause-download', (_event, id) => {
  const task = activeTasks.get(id);
  if (task) {
    task.pause();
    return true;
  }
  const snapshot = savedTaskSnapshots.get(id);
  if (snapshot) {
    snapshot.status = 'paused';
    snapshot.speed = 0;
    snapshot.eta = 0;
    recordTaskSnapshot(snapshot, true);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-status', snapshot);
    }
    return true;
  }
  return false;
});

ipcMain.handle('resume-download', async (_event, id) => {
  let task = activeTasks.get(id);
  if (task) {
    task.start();
    return true;
  }

  // Restore task from saved snapshots
  const snapshot = savedTaskSnapshots.get(id);
  if (!snapshot) return false;

  if (MediaTask.isSupported(snapshot.url)) {
    task = new MediaTask({
      id: snapshot.id,
      url: snapshot.url,
      saveFolder: path.dirname(snapshot.savePath),
      fileName: snapshot.fileName
    });
  } else {
    task = new DownloadTask({
      id: snapshot.id,
      url: snapshot.url,
      savePath: snapshot.savePath,
      threads: snapshot.threads || 16
    });
  }

  task.category = snapshot.category || getCategoryForFile(snapshot.fileName || '');
  activeTasks.set(task.id, task);
  cancelAutoShutdown();

  task.on('progress', (snap) => {
    recordTaskSnapshot({ ...snap, category: task.category });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-progress', { ...snap, category: task.category });
    }
  });

  task.on('status', (snap) => {
    recordTaskSnapshot({ ...snap, category: task.category });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-status', { ...snap, category: task.category });
    }
  });

  task.on('completed', (snap) => {
    recordTaskSnapshot({ ...snap, category: task.category });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-completed', { ...snap, category: task.category });
    }
    checkAutoShutdown();
  });

  task.on('error', (err) => {
    recordTaskSnapshot({ ...task.getSnapshot(), status: 'error', error: err, category: task.category });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-error', { id: task.id, error: err });
    }
    checkAutoShutdown();
  });

  task.start();
  return true;
});

ipcMain.handle('cancel-download', (_event, id) => {
  const task = activeTasks.get(id);
  if (task) {
    task.cancel();
    activeTasks.delete(id);
  }
  const snapshot = savedTaskSnapshots.get(id);
  if (snapshot) {
    try {
      if (fs.existsSync(snapshot.savePath + '.tdm.json')) fs.unlinkSync(snapshot.savePath + '.tdm.json');
      if (fs.existsSync(snapshot.savePath)) fs.unlinkSync(snapshot.savePath);
    } catch (e) {}
    savedTaskSnapshots.delete(id);
    persistTasks();
  }
  checkAutoShutdown();
  return true;
});

ipcMain.handle('open-file', (_event, filePath) => {
  if (fs.existsSync(filePath)) {
    shell.openPath(filePath);
    return true;
  }
  return false;
});

ipcMain.handle('show-in-folder', (_event, filePath) => {
  if (fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath);
    return true;
  }
  return false;
});

// Auto-Shutdown IPC
ipcMain.handle('toggle-auto-shutdown', (_event, enabled) => {
  autoShutdownEnabled = enabled;
  if (!autoShutdownEnabled) cancelAutoShutdown();
  return autoShutdownEnabled;
});

ipcMain.handle('cancel-shutdown', () => {
  cancelAutoShutdown();
  return true;
});

// Clipboard Monitor IPC
ipcMain.handle('toggle-clipboard-monitor', (_event, enabled) => {
  clipboardMonitorEnabled = enabled;
  return clipboardMonitorEnabled;
});

// Smart Category Toggle IPC
ipcMain.handle('toggle-smart-category', (_event, enabled) => {
  smartCategoryEnabled = enabled;
  return smartCategoryEnabled;
});

// Windows Startup Setting IPC
ipcMain.handle('get-startup-setting', () => {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('set-startup-setting', (_event, enabled) => {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: ['--minimized']
    });
    if (tray) updateTrayContextMenu();
    return app.getLoginItemSettings().openAtLogin;
  } catch (e) {
    return false;
  }
});

// Chrome Extension IPC Handlers
ipcMain.handle('open-chrome-extensions', () => {
  try {
    clipboard.writeText('chrome://extensions');
    exec('start chrome chrome://extensions', (err) => {
      if (err) {
        shell.openExternal('chrome://extensions');
      }
    });
  } catch (e) {
    shell.openExternal('chrome://extensions');
  }
  return true;
});

ipcMain.handle('open-extension-folder', () => {
  const packagedExt = path.join(process.resourcesPath || '', 'chrome-extension');
  const localExt = fs.existsSync(packagedExt) ? packagedExt : path.join(__dirname, 'chrome-extension');
  const appDataExt = path.join(os.homedir(), 'AppData', 'Local', 'TurboDownloader', 'chrome-extension');
  const target = fs.existsSync(appDataExt) ? appDataExt : localExt;
  if (fs.existsSync(target)) {
    shell.openPath(target);
    return true;
  }
  return false;
});

ipcMain.handle('install-extension-helper', () => {
  const targetDir = path.join(os.homedir(), 'AppData', 'Local', 'TurboDownloader', 'chrome-extension');
  const packagedExt = path.join(process.resourcesPath || '', 'chrome-extension');
  const sourceDir = fs.existsSync(packagedExt) ? packagedExt : path.join(__dirname, 'chrome-extension');
  try {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    if (fs.existsSync(sourceDir)) {
      fs.cpSync(sourceDir, targetDir, { recursive: true });
    }
    clipboard.writeText('chrome://extensions');
    shell.openPath(targetDir);
    exec('start chrome chrome://extensions');
    return { success: true, path: targetDir };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

let updateTrayContextMenu = () => {};

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  const trayIcon = nativeImage.createFromPath(iconPath);
  tray = new Tray(trayIcon);
  tray.setToolTip('Turbo Download Manager (IDM Edition)');

  updateTrayContextMenu = () => {
    let isStartup = false;
    try {
      isStartup = app.getLoginItemSettings().openAtLogin;
    } catch (e) {}

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '⚡ Open Turbo Downloader',
        click: () => {
          if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      { type: 'separator' },
      {
        label: '▶ Resume All Downloads',
        click: () => {
          for (const task of activeTasks.values()) {
            if (task.status === 'paused' || task.status === 'error') {
              task.start();
            }
          }
        }
      },
      {
        label: '⏸ Pause All Downloads',
        click: () => {
          for (const task of activeTasks.values()) {
            if (task.status === 'downloading' || task.status === 'probing') {
              task.pause();
            }
          }
        }
      },
      { type: 'separator' },
      {
        label: '⚙ Launch on Windows Startup',
        type: 'checkbox',
        checked: isStartup,
        click: (item) => {
          app.setLoginItemSettings({
            openAtLogin: item.checked,
            path: process.execPath,
            args: ['--minimized']
          });
          updateTrayContextMenu();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('startup-setting-changed', item.checked);
          }
        }
      },
      {
        label: '🧩 Chrome Extension Setup',
        click: () => {
          if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
            mainWindow.webContents.send('open-extension-modal');
          }
        }
      },
      { type: 'separator' },
      {
        label: '❌ Exit Turbo Downloader',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);

    tray.setContextMenu(contextMenu);
  };

  updateTrayContextMenu();

  tray.on('double-click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });

  tray.on('click', () => {
    if (mainWindow && !mainWindow.isVisible()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  startIntegrationServer();
  startClipboardMonitor();

  // Auto-sync extension files to permanent AppData path
  try {
    const targetDir = path.join(os.homedir(), 'AppData', 'Local', 'TurboDownloader', 'chrome-extension');
    const packagedExt = path.join(process.resourcesPath || '', 'chrome-extension');
    const sourceDir = fs.existsSync(packagedExt) ? packagedExt : path.join(__dirname, 'chrome-extension');
    if (fs.existsSync(sourceDir)) {
      fs.cpSync(sourceDir, targetDir, { recursive: true });
    }
  } catch (e) {}

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('window-all-closed', () => {
  console.log(`[App] window-all-closed event fired (isQuitting = ${isQuitting})`);
  if (isQuitting || process.platform === 'darwin') {
    app.quit();
  }
});
