const API_BASE = 'http://127.0.0.1:18888';

document.addEventListener('DOMContentLoaded', async () => {
  const badge = document.getElementById('appStatusBadge');
  const text = document.getElementById('appStatusText');
  const toggle = document.getElementById('toggleAutoIntercept');
  const toggleImages = document.getElementById('toggleInterceptImages');
  const selectThreads = document.getElementById('selectDefaultThreads');
  const inputUrl = document.getElementById('inputQuickUrl');
  const btnDownload = document.getElementById('btnQuickDownload');

  // Load saved settings
  const settings = await chrome.storage.local.get(['autoIntercept', 'interceptImages', 'threads']);
  if (settings.autoIntercept !== undefined) toggle.checked = settings.autoIntercept;
  if (settings.interceptImages !== undefined) toggleImages.checked = settings.interceptImages;
  if (settings.threads !== undefined) selectThreads.value = settings.threads;

  // Toggle Auto Intercept
  toggle.addEventListener('change', () => {
    chrome.storage.local.set({ autoIntercept: toggle.checked });
  });

  // Toggle Image Intercept
  toggleImages.addEventListener('change', () => {
    chrome.storage.local.set({ interceptImages: toggleImages.checked });
  });

  // Threads change
  selectThreads.addEventListener('change', () => {
    chrome.storage.local.set({ threads: parseInt(selectThreads.value, 10) });
  });

  // Check connection to desktop app
  try {
    const res = await fetch(`${API_BASE}/api/ping`);
    if (res.ok) {
      badge.className = 'status-badge status-connected';
      text.textContent = 'Connected';
    } else {
      badge.className = 'status-badge status-disconnected';
      text.textContent = 'Disconnected';
    }
  } catch (err) {
    badge.className = 'status-badge status-disconnected';
    text.textContent = 'App Offline';
  }

  // Quick Download button
  btnDownload.addEventListener('click', async () => {
    const url = inputUrl.value.trim();
    if (!url || !url.startsWith('http')) {
      alert('Please enter a valid HTTP/HTTPS link');
      return;
    }

    try {
      btnDownload.textContent = 'Sending...';
      const threads = parseInt(selectThreads.value, 10);
      const res = await fetch(`${API_BASE}/api/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, threads })
      });
      const data = await res.json();
      if (data.success) {
        inputUrl.value = '';
        btnDownload.textContent = 'Started!';
        setTimeout(() => { btnDownload.textContent = 'Download'; }, 1500);
      } else {
        alert('Failed to start: ' + data.error);
        btnDownload.textContent = 'Download';
      }
    } catch (e) {
      alert('Could not connect to Turbo Download Manager desktop app. Ensure it is running.');
      btnDownload.textContent = 'Download';
    }
  });
});
