const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('turboAPI', {
  getTasks: () => ipcRenderer.invoke('get-tasks'),
  getDefaultFolder: () => ipcRenderer.invoke('get-default-folder'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  probeUrl: (url) => ipcRenderer.invoke('probe-url', url),
  addDownload: (options) => ipcRenderer.invoke('add-download', options),
  pauseDownload: (id) => ipcRenderer.invoke('pause-download', id),
  resumeDownload: (id) => ipcRenderer.invoke('resume-download', id),
  cancelDownload: (id) => ipcRenderer.invoke('cancel-download', id),
  openFile: (path) => ipcRenderer.invoke('open-file', path),
  showInFolder: (path) => ipcRenderer.invoke('show-in-folder', path),

  // Power features
  toggleAutoShutdown: (enabled) => ipcRenderer.invoke('toggle-auto-shutdown', enabled),
  cancelShutdown: () => ipcRenderer.invoke('cancel-shutdown'),
  toggleClipboardMonitor: (enabled) => ipcRenderer.invoke('toggle-clipboard-monitor', enabled),
  toggleSmartCategory: (enabled) => ipcRenderer.invoke('toggle-smart-category', enabled),
  getStartupSetting: () => ipcRenderer.invoke('get-startup-setting'),
  setStartupSetting: (enabled) => ipcRenderer.invoke('set-startup-setting', enabled),

  // Chrome Extension helpers
  openChromeExtensions: () => ipcRenderer.invoke('open-chrome-extensions'),
  openExtensionFolder: () => ipcRenderer.invoke('open-extension-folder'),
  installExtensionHelper: () => ipcRenderer.invoke('install-extension-helper'),

  // Event Listeners
  onDownloadCreated: (callback) => ipcRenderer.on('download-created', (_e, data) => callback(data)),
  onProgress: (callback) => ipcRenderer.on('download-progress', (_e, data) => callback(data)),
  onStatus: (callback) => ipcRenderer.on('download-status', (_e, data) => callback(data)),
  onCompleted: (callback) => ipcRenderer.on('download-completed', (_e, data) => callback(data)),
  onError: (callback) => ipcRenderer.on('download-error', (_e, data) => callback(data)),
  onClipboardDetected: (callback) => ipcRenderer.on('clipboard-url-detected', (_e, data) => callback(data)),
  onShutdownCountdown: (callback) => ipcRenderer.on('shutdown-countdown', (_e, data) => callback(data)),
  onShutdownCancelled: (callback) => ipcRenderer.on('shutdown-cancelled', (_e, data) => callback(data)),
  onStartupSettingChanged: (callback) => ipcRenderer.on('startup-setting-changed', (_e, data) => callback(data)),
  onOpenExtensionModal: (callback) => ipcRenderer.on('open-extension-modal', () => callback())
});
