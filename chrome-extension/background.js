const API_BASE = 'http://127.0.0.1:18888';

// Set default settings
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['autoIntercept', 'interceptImages', 'threads'], (res) => {
    const toSet = {};
    if (res.autoIntercept === undefined) toSet.autoIntercept = true;
    if (res.interceptImages === undefined) toSet.interceptImages = true;
    if (res.threads === undefined) toSet.threads = 8;
    if (Object.keys(toSet).length > 0) chrome.storage.local.set(toSet);
  });

  // Create Context Menus
  chrome.contextMenus.create({
    id: 'turbo_download_link',
    title: 'Download with Turbo Downloader',
    contexts: ['link']
  });

  chrome.contextMenus.create({
    id: 'turbo_download_media',
    title: 'Download media with Turbo Downloader',
    contexts: ['image', 'video', 'audio']
  });
});

// Check if Desktop App is running
async function isAppRunning() {
  try {
    const res = await fetch(`${API_BASE}/api/ping`, { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      return data.status === 'ok';
    }
  } catch (err) {
    return false;
  }
  return false;
}

// Send Download to Desktop App
async function sendToApp(url, fileName = '', referrer = '', mime = '') {
  try {
    const { threads = 8 } = await chrome.storage.local.get(['threads']);
    const response = await fetch(`${API_BASE}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        fileName,
        referrer,
        mime,
        threads
      })
    });
    return await response.json();
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Download Interception (Chrome Downloads API)
chrome.downloads.onCreated.addListener(async (downloadItem) => {
  // Ignore data: or blob: urls, or internal chrome urls
  const url = downloadItem.finalUrl || downloadItem.url;
  if (!url || url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('chrome:')) {
    return;
  }

  // Check if auto-intercept is enabled
  const { autoIntercept = true, interceptImages = true } = await chrome.storage.local.get(['autoIntercept', 'interceptImages']);
  if (!autoIntercept) return;

  // Check if this is an image download
  const isImage = (downloadItem.mime && downloadItem.mime.startsWith('image/')) ||
                  /\.(jpe?g|png|gif|webp|bmp|svg|avif|ico|tiff?|jfif|heic)$/i.test(url.split('?')[0]) ||
                  /\.(jpe?g|png|gif|webp|bmp|svg|avif|ico|tiff?|jfif|heic)$/i.test(downloadItem.filename || '');

  // If user disabled image interception, let Chrome download images natively
  if (isImage && !interceptImages) {
    return;
  }

  // Check if Turbo Download Manager desktop app is running
  const running = await isAppRunning();
  if (!running) return;

  // Intercept: Cancel the Chrome browser download
  chrome.downloads.cancel(downloadItem.id, () => {
    // Erase the cancelled entry from Chrome download history
    chrome.downloads.erase({ id: downloadItem.id });
  });

  // Forward to Turbo Download Manager with filename and mime
  const result = await sendToApp(url, downloadItem.filename, downloadItem.referrer, downloadItem.mime);

  if (result.success) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Turbo Downloader',
      message: `Accelerated download started: ${result.task.fileName}`
    });
  }
});

// Context Menu Click Handling
chrome.contextMenus.onClicked.addListener(async (info) => {
  let targetUrl = info.linkUrl || info.srcUrl;
  if (!targetUrl) return;

  const running = await isAppRunning();
  if (!running) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Turbo Downloader',
      message: 'Please start Turbo Download Manager on your PC first.'
    });
    return;
  }

  const result = await sendToApp(targetUrl);
  if (result.success) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Turbo Downloader',
      message: `Download started: ${result.task.fileName}`
    });
  }
});

// Handle Messages from Floating Video Sniffer (content.js)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'turbo_download_media') {
    isAppRunning().then(async (running) => {
      if (!running) {
        sendResponse({ success: false, error: 'App not running' });
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'Turbo Downloader',
          message: 'Turbo Download Manager is not running. Please start the app.'
        });
        return;
      }

      const result = await sendToApp(message.url, message.title, sender.tab ? sender.tab.url : '');
      sendResponse(result);

      if (result.success) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'Video Stream Captured',
          message: `Accelerating video download: ${message.title}`
        });
      }
    });
    return true; // Keep channel open for async sendResponse
  }
});
