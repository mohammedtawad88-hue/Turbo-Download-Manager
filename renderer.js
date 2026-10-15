// Turbo Download Manager Renderer Logic
const tasks = new Map(); // id -> task data
let currentFilterType = 'status'; // 'status' or 'category'
let currentFilterValue = 'all';

// Feature States
let clipboardMonitorActive = true;
let autoShutdownActive = false;
let startupActive = false;
let shutdownInterval = null;
let lastDetectedClipboardUrl = '';

// DOM Elements
const elements = {
  btnOpenAddModal: document.getElementById('btnOpenAddModal'),
  btnEmptyAdd: document.getElementById('btnEmptyAdd'),
  modalAdd: document.getElementById('modalAdd'),
  btnCloseAddModal: document.getElementById('btnCloseAddModal'),
  btnCancelAdd: document.getElementById('btnCancelAdd'),
  btnStartDownload: document.getElementById('btnStartDownload'),
  btnProbeUrl: document.getElementById('btnProbeUrl'),
  btnBrowseFolder: document.getElementById('btnBrowseFolder'),
  inputUrl: document.getElementById('inputUrl'),
  inputFileName: document.getElementById('inputFileName'),
  inputSaveFolder: document.getElementById('inputSaveFolder'),
  selectThreads: document.getElementById('selectThreads'),
  probeFeedback: document.getElementById('probeFeedback'),
  probeSize: document.getElementById('probeSize'),
  probeResumable: document.getElementById('probeResumable'),
  probeCategory: document.getElementById('probeCategory'),
  downloadsList: document.getElementById('downloadsList'),
  emptyState: document.getElementById('emptyState'),
  totalSpeedVal: document.getElementById('totalSpeedVal'),
  countAll: document.getElementById('countAll'),
  countDownloading: document.getElementById('countDownloading'),
  countCompleted: document.getElementById('countCompleted'),
  countPaused: document.getElementById('countPaused'),

  // Power Tool Elements
  btnToggleClipboard: document.getElementById('btnToggleClipboard'),
  statusClipboard: document.getElementById('statusClipboard'),
  btnToggleShutdown: document.getElementById('btnToggleShutdown'),
  statusShutdown: document.getElementById('statusShutdown'),
  btnToggleStartup: document.getElementById('btnToggleStartup'),
  statusStartup: document.getElementById('statusStartup'),
  btnOpenExtensionModal: document.getElementById('btnOpenExtensionModal'),
  clipboardBanner: document.getElementById('clipboardBanner'),
  clipboardDetectedUrl: document.getElementById('clipboardDetectedUrl'),
  btnClipboardDownload: document.getElementById('btnClipboardDownload'),
  btnClipboardDismiss: document.getElementById('btnClipboardDismiss'),
  modalShutdown: document.getElementById('modalShutdown'),
  shutdownCountdownVal: document.getElementById('shutdownCountdownVal'),
  btnCancelShutdown: document.getElementById('btnCancelShutdown'),

  // Chrome Extension Modal Elements
  modalExtension: document.getElementById('modalExtension'),
  btnCloseExtensionModal: document.getElementById('btnCloseExtensionModal'),
  btnLaunchChromeExt: document.getElementById('btnLaunchChromeExt'),
  btnCopyChromeUrl: document.getElementById('btnCopyChromeUrl'),
  btnOpenExtFolder: document.getElementById('btnOpenExtFolder'),
  btnRunExtHelper: document.getElementById('btnRunExtHelper'),
  btnDoneExtension: document.getElementById('btnDoneExtension')
};

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  setupIPCListeners();

  if (window.turboAPI) {
    const defaultFolder = await window.turboAPI.getDefaultFolder();
    elements.inputSaveFolder.value = defaultFolder;

    try {
      const isStartup = await window.turboAPI.getStartupSetting();
      startupActive = !!isStartup;
      elements.btnToggleStartup.classList.toggle('active', startupActive);
      elements.statusStartup.textContent = startupActive ? 'ON' : 'OFF';
    } catch (e) {}

    // Load any existing tasks immediately upon startup
    const refreshTasks = async () => {
      try {
        const existing = await window.turboAPI.getTasks();
        if (existing && existing.length > 0) {
          existing.forEach(task => updateTask(task));
        }
      } catch (e) {}
    };

    await refreshTasks();

    // Auto-sync polling every 1 second ensures live cards even across window minimizations
    setInterval(refreshTasks, 1000);

    // Sync on window focus
    window.addEventListener('focus', refreshTasks);
  }
});

function setupEventListeners() {
  // Modal open/close
  elements.btnOpenAddModal.addEventListener('click', () => showAddModal());
  elements.btnEmptyAdd.addEventListener('click', () => showAddModal());
  elements.btnCloseAddModal.addEventListener('click', hideAddModal);
  elements.btnCancelAdd.addEventListener('click', hideAddModal);

  // Windows Startup Toggle
  elements.btnToggleStartup.addEventListener('click', async () => {
    startupActive = !startupActive;
    if (window.turboAPI) {
      await window.turboAPI.setStartupSetting(startupActive);
    }
    elements.btnToggleStartup.classList.toggle('active', startupActive);
    elements.statusStartup.textContent = startupActive ? 'ON' : 'OFF';
  });

  // Chrome Extension Modal
  elements.btnOpenExtensionModal.addEventListener('click', () => {
    elements.modalExtension.classList.add('visible');
  });

  elements.btnCloseExtensionModal.addEventListener('click', () => {
    elements.modalExtension.classList.remove('visible');
  });

  elements.btnDoneExtension.addEventListener('click', () => {
    elements.modalExtension.classList.remove('visible');
  });

  elements.btnLaunchChromeExt.addEventListener('click', () => {
    if (window.turboAPI) window.turboAPI.openChromeExtensions();
  });

  elements.btnCopyChromeUrl.addEventListener('click', () => {
    navigator.clipboard.writeText('chrome://extensions');
    elements.btnCopyChromeUrl.textContent = 'Copied!';
    setTimeout(() => { elements.btnCopyChromeUrl.textContent = 'Copy URL'; }, 2000);
  });

  elements.btnOpenExtFolder.addEventListener('click', () => {
    if (window.turboAPI) window.turboAPI.openExtensionFolder();
  });

  elements.btnRunExtHelper.addEventListener('click', async () => {
    if (window.turboAPI) {
      elements.btnRunExtHelper.textContent = 'Setting up...';
      const res = await window.turboAPI.installExtensionHelper();
      if (res && res.success) {
        elements.btnRunExtHelper.textContent = 'Ready! Drop in Chrome';
      } else {
        elements.btnRunExtHelper.textContent = 'Folder Opened';
      }
      setTimeout(() => { elements.btnRunExtHelper.textContent = '⚡ 1-Click Auto Setup Helper'; }, 3000);
    }
  });

  // Probe URL
  elements.btnProbeUrl.addEventListener('click', probeUrl);
  elements.inputUrl.addEventListener('change', probeUrl);

  // Browse folder
  elements.btnBrowseFolder.addEventListener('click', async () => {
    if (window.turboAPI) {
      const selected = await window.turboAPI.selectFolder();
      if (selected) elements.inputSaveFolder.value = selected;
    }
  });

  // Start Download
  elements.btnStartDownload.addEventListener('click', startNewDownload);

  // Clipboard Monitor Toggle
  elements.btnToggleClipboard.addEventListener('click', async () => {
    clipboardMonitorActive = !clipboardMonitorActive;
    if (window.turboAPI) {
      await window.turboAPI.toggleClipboardMonitor(clipboardMonitorActive);
    }
    elements.btnToggleClipboard.classList.toggle('active', clipboardMonitorActive);
    elements.statusClipboard.textContent = clipboardMonitorActive ? 'ON' : 'OFF';
  });

  // Clipboard Banner Actions
  elements.btnClipboardDismiss.addEventListener('click', () => {
    elements.clipboardBanner.classList.remove('visible');
  });

  elements.btnClipboardDownload.addEventListener('click', () => {
    elements.clipboardBanner.classList.remove('visible');
    showAddModal(lastDetectedClipboardUrl);
  });

  // Auto-Shutdown Toggle
  elements.btnToggleShutdown.addEventListener('click', async () => {
    autoShutdownActive = !autoShutdownActive;
    if (window.turboAPI) {
      await window.turboAPI.toggleAutoShutdown(autoShutdownActive);
    }
    elements.btnToggleShutdown.classList.toggle('active', autoShutdownActive);
    elements.statusShutdown.textContent = autoShutdownActive ? 'ON' : 'OFF';
  });

  // Cancel Auto-Shutdown Modal Button
  elements.btnCancelShutdown.addEventListener('click', async () => {
    if (shutdownInterval) clearInterval(shutdownInterval);
    elements.modalShutdown.classList.remove('visible');
    autoShutdownActive = false;
    elements.btnToggleShutdown.classList.remove('active');
    elements.statusShutdown.textContent = 'OFF';
    if (window.turboAPI) {
      await window.turboAPI.cancelShutdown();
      await window.turboAPI.toggleAutoShutdown(false);
    }
  });

  // Sidebar Filter Tabs (Status and Category)
  document.querySelectorAll('.filter-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      if (btn.hasAttribute('data-filter')) {
        currentFilterType = 'status';
        currentFilterValue = btn.getAttribute('data-filter');
      } else if (btn.hasAttribute('data-category')) {
        currentFilterType = 'category';
        currentFilterValue = btn.getAttribute('data-category');
      }
      applyFilter();
    });
  });
}

function setupIPCListeners() {
  if (!window.turboAPI) return;

  window.turboAPI.onDownloadCreated((data) => {
    updateTask(data);
  });

  window.turboAPI.onProgress((data) => {
    updateTask(data);
  });

  window.turboAPI.onStatus((data) => {
    updateTask(data);
  });

  window.turboAPI.onCompleted((data) => {
    updateTask(data);
  });

  window.turboAPI.onError(({ id, error }) => {
    const task = tasks.get(id);
    if (task) {
      task.status = 'error';
      task.error = error;
      updateTask(task);
    }
  });

  // Clipboard URL detected from system clipboard
  window.turboAPI.onClipboardDetected(({ url, isDownloadable, category }) => {
    if (!clipboardMonitorActive) return;
    lastDetectedClipboardUrl = url;
    elements.clipboardDetectedUrl.textContent = url;
    elements.clipboardBanner.classList.add('visible');

    setTimeout(() => {
      if (lastDetectedClipboardUrl === url) {
        elements.clipboardBanner.classList.remove('visible');
      }
    }, 12000);
  });

  // Auto-Shutdown Countdown Trigger
  window.turboAPI.onShutdownCountdown(({ seconds }) => {
    let remaining = seconds;
    elements.shutdownCountdownVal.textContent = `${remaining}s`;
    elements.modalShutdown.classList.add('visible');

    if (shutdownInterval) clearInterval(shutdownInterval);
    shutdownInterval = setInterval(() => {
      remaining--;
      if (remaining >= 0) {
        elements.shutdownCountdownVal.textContent = `${remaining}s`;
      } else {
        clearInterval(shutdownInterval);
      }
    }, 1000);
  });

  window.turboAPI.onShutdownCancelled(() => {
    if (shutdownInterval) clearInterval(shutdownInterval);
    elements.modalShutdown.classList.remove('visible');
  });

  window.turboAPI.onStartupSettingChanged((enabled) => {
    startupActive = enabled;
    elements.btnToggleStartup.classList.toggle('active', startupActive);
    elements.statusStartup.textContent = startupActive ? 'ON' : 'OFF';
  });

  window.turboAPI.onOpenExtensionModal(() => {
    elements.modalExtension.classList.add('visible');
  });
}

function showAddModal(prefillUrl = '') {
  elements.modalAdd.classList.add('visible');
  if (prefillUrl) {
    elements.inputUrl.value = prefillUrl;
    probeUrl();
  } else {
    elements.inputUrl.focus();
  }
}

function hideAddModal() {
  elements.modalAdd.classList.remove('visible');
  elements.inputUrl.value = '';
  elements.inputFileName.value = '';
  elements.probeFeedback.style.display = 'none';
}

async function probeUrl() {
  const url = elements.inputUrl.value.trim();
  if (!url || !url.startsWith('http')) return;

  elements.btnProbeUrl.textContent = 'Probing...';
  elements.btnProbeUrl.disabled = true;

  try {
    const res = await window.turboAPI.probeUrl(url);
    if (res && res.success) {
      elements.inputFileName.value = res.fileName;
      elements.probeSize.textContent = res.size > 0 ? formatBytes(res.size) : 'Unknown (Stream)';
      elements.probeResumable.textContent = res.resumable ? 'Yes (Byte-Range Supported)' : 'No (Single-Stream)';
      if (elements.probeCategory) {
        elements.probeCategory.textContent = res.category || 'General';
      }
      elements.probeFeedback.style.display = 'flex';
      if (!res.resumable) {
        elements.selectThreads.value = '1';
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    elements.btnProbeUrl.textContent = 'Probe';
    elements.btnProbeUrl.disabled = false;
  }
}

async function startNewDownload() {
  const url = elements.inputUrl.value.trim();
  if (!url) {
    alert('Please enter a valid download URL');
    return;
  }

  const fileName = elements.inputFileName.value.trim();
  const saveFolder = elements.inputSaveFolder.value.trim();
  const threads = parseInt(elements.selectThreads.value, 10);

  const res = await window.turboAPI.addDownload({
    url,
    fileName,
    saveFolder,
    threads
  });

  if (res && res.success) {
    tasks.set(res.task.id, res.task);
    renderTaskCard(res.task);
    hideAddModal();
    updateCounts();
  } else {
    alert(`Could not start download:\n${res ? res.error : 'Unknown error'}`);
  }
}

function updateTask(data) {
  tasks.set(data.id, data);
  let card = document.getElementById(`task-${data.id}`);
  if (!card) {
    renderTaskCard(data);
  } else {
    updateCardDOM(card, data);
  }
  updateCounts();
  updateGlobalSpeed();
}

function renderTaskCard(data) {
  elements.emptyState.classList.add('hidden');

  const card = document.createElement('div');
  card.className = 'task-card';
  card.id = `task-${data.id}`;
  card.setAttribute('data-status', data.status);
  card.setAttribute('data-category', data.category || 'General');

  card.innerHTML = `
    <div class="task-top">
      <div class="task-file-info">
        <div class="file-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
        </div>
        <div class="file-title-wrap">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="file-name" title="${data.fileName || 'Downloading file'}">${data.fileName || 'Downloading file'}</span>
            <span class="badge-category">${data.category || 'General'}</span>
          </div>
          <span class="file-url" title="${data.url}">${data.url}</span>
        </div>
      </div>
      <div class="task-status-badge badge-${data.status}">
        ${(data.status || 'CONNECTING').toUpperCase()}
      </div>
    </div>

    <!-- Overall Progress Bar -->
    <div class="task-progress-wrap">
      <div class="progress-track">
        <div class="progress-fill ${data.status === 'completed' ? 'completed' : ''}" style="width: ${data.percent || 0}%"></div>
      </div>
      <div class="task-stats">
        <span class="stat-primary">${formatBytes(data.downloadedBytes || 0)} / ${data.totalBytes > 0 ? formatBytes(data.totalBytes) : 'Unknown'} (${data.percent || 0}%)</span>
        <span class="stat-speed">${data.status === 'downloading' && data.speed ? formatBytes(data.speed) + '/s' : ''}</span>
        <span class="stat-eta">${data.status === 'downloading' && data.eta > 0 ? 'ETA: ' + formatSeconds(data.eta) : ''}</span>
      </div>
    </div>

    <!-- IDM Segment Visualizer -->
    <div class="segments-container" id="segments-${data.id}">
      <div class="segments-header">
        <span>Parallel Byte-Range Streams (${data.threads || 8} Active Channels)</span>
        <span>Zero-Merge Disk Offsets</span>
      </div>
      <div class="segments-grid" id="segments-grid-${data.id}"></div>
    </div>

    <!-- Actions & Controls -->
    <div class="task-bottom">
      <button class="btn-toggle-segments" onclick="toggleSegments('${data.id}')">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
        <span>Toggle 16-Stream Visualizer</span>
      </button>

      <div class="task-actions" id="actions-${data.id}">
        <!-- Rendered dynamically in updateCardDOM -->
      </div>
    </div>
  `;

  elements.downloadsList.prepend(card);
  updateCardDOM(card, data);
  applyFilter();
}

function updateCardDOM(card, data) {
  const currentStatus = card.getAttribute('data-status');
  const statusChanged = currentStatus !== data.status;

  card.setAttribute('data-status', data.status);
  card.setAttribute('data-category', data.category || 'General');

  const nameEl = card.querySelector('.file-name');
  if (nameEl && data.fileName && nameEl.textContent !== data.fileName) {
    nameEl.textContent = data.fileName;
    nameEl.setAttribute('title', data.fileName);
  }

  const badge = card.querySelector('.task-status-badge');
  if (badge && statusChanged) {
    badge.className = `task-status-badge badge-${data.status}`;
    badge.textContent = (data.status || 'CONNECTING').toUpperCase();
    if (data.status === 'error' && data.error) {
      badge.setAttribute('title', data.error);
    }
  }

  const pfill = card.querySelector('.progress-fill');
  if (pfill) {
    pfill.style.width = `${data.percent || 0}%`;
    pfill.classList.toggle('completed', data.status === 'completed');
  }

  const statPrimary = card.querySelector('.stat-primary');
  if (statPrimary) {
    statPrimary.textContent = `${formatBytes(data.downloadedBytes || 0)} / ${data.totalBytes > 0 ? formatBytes(data.totalBytes) : 'Unknown'} (${data.percent || 0}%)`;
  }

  const statSpeed = card.querySelector('.stat-speed');
  if (statSpeed) {
    statSpeed.textContent = (data.status === 'downloading' && data.speed) ? `${formatBytes(data.speed)}/s` : '';
  }

  const statEta = card.querySelector('.stat-eta');
  if (statEta) {
    statEta.textContent = (data.status === 'downloading' && data.eta > 0) ? `ETA: ${formatSeconds(data.eta)}` : '';
  }

  // Update Dynamic Action Buttons only when status changes
  const actionsContainer = card.querySelector('.task-actions');
  if (actionsContainer && (statusChanged || actionsContainer.children.length === 0)) {
    let btns = '';
    if (data.status === 'downloading' || data.status === 'probing') {
      btns += `
        <button class="btn-action" title="Pause" onclick="pauseTask('${data.id}')">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>
        </button>
      `;
    } else if (data.status === 'paused' || data.status === 'error') {
      btns += `
        <button class="btn-action" title="${data.status === 'error' ? 'Retry Download' : 'Resume Download'}" onclick="resumeTask('${data.id}')">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
        </button>
      `;
    } else if (data.status === 'completed') {
      btns += `
        <button class="btn-action" title="Open File" onclick="openFile('${escapePath(data.savePath)}')">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
        </button>
        <button class="btn-action" title="Show in Folder" onclick="showFolder('${escapePath(data.savePath)}')">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
        </button>
      `;
    }
    btns += `
      <button class="btn-action" title="Cancel/Delete" onclick="cancelTask('${data.id}')">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    `;
    actionsContainer.innerHTML = btns;
  }

  // Update Segments
  if (data.segments && data.segments.length > 0) {
    const grid = document.getElementById(`segments-grid-${data.id}`);
    if (grid && grid.children.length === 0) {
      data.segments.forEach(seg => {
        const pill = document.createElement('div');
        pill.className = 'segment-pill';
        pill.id = `seg-${data.id}-${seg.id}`;
        pill.innerHTML = `
          <div class="segment-top">
            <span>Part #${seg.id + 1}</span>
            <span class="seg-pct">${seg.percent}%</span>
          </div>
          <div class="segment-track">
            <div class="segment-fill ${seg.status === 'completed' ? 'completed' : ''}" style="width: ${seg.percent}%"></div>
          </div>
        `;
        grid.appendChild(pill);
      });
    } else if (grid) {
      data.segments.forEach(seg => {
        const pill = document.getElementById(`seg-${data.id}-${seg.id}`);
        if (pill) {
          pill.querySelector('.seg-pct').textContent = `${seg.percent}%`;
          const sfill = pill.querySelector('.segment-fill');
          sfill.style.width = `${seg.percent}%`;
          sfill.classList.toggle('completed', seg.status === 'completed');
        }
      });
    }
  }
}

// Global actions called from HTML onclick
window.toggleSegments = (id) => {
  const panel = document.getElementById(`segments-${id}`);
  if (panel) panel.classList.toggle('open');
};

window.pauseTask = (id) => {
  if (window.turboAPI) window.turboAPI.pauseDownload(id);
};

window.resumeTask = (id) => {
  if (window.turboAPI) window.turboAPI.resumeDownload(id);
};

window.cancelTask = (id) => {
  if (window.turboAPI) {
    window.turboAPI.cancelDownload(id);
    tasks.delete(id);
    const card = document.getElementById(`task-${id}`);
    if (card) card.remove();
    updateCounts();
    updateGlobalSpeed();
    if (tasks.size === 0) elements.emptyState.classList.remove('hidden');
  }
};

window.openFile = (path) => {
  if (window.turboAPI) window.turboAPI.openFile(path);
};

window.showFolder = (path) => {
  if (window.turboAPI) window.turboAPI.showInFolder(path);
};

function updateCounts() {
  let all = 0, downloading = 0, completed = 0, paused = 0;
  tasks.forEach(t => {
    all++;
    if (t.status === 'downloading' || t.status === 'probing') downloading++;
    if (t.status === 'completed') completed++;
    if (t.status === 'paused') paused++;
  });

  elements.countAll.textContent = all;
  elements.countDownloading.textContent = downloading;
  elements.countCompleted.textContent = completed;
  elements.countPaused.textContent = paused;

  if (all > 0) {
    elements.emptyState.classList.add('hidden');
  } else {
    elements.emptyState.classList.remove('hidden');
  }
}

function updateGlobalSpeed() {
  let totalSpeed = 0;
  tasks.forEach(t => {
    if (t.status === 'downloading' && t.speed) totalSpeed += t.speed;
  });
  elements.totalSpeedVal.textContent = totalSpeed > 0 ? `${formatBytes(totalSpeed)}/s` : '0 KB/s';
}

function applyFilter() {
  const cards = document.querySelectorAll('.task-card');
  cards.forEach(card => {
    const status = card.getAttribute('data-status');
    const category = card.getAttribute('data-category');

    if (currentFilterType === 'status') {
      if (currentFilterValue === 'all') {
        card.style.display = 'flex';
      } else if (currentFilterValue === 'downloading' && (status === 'downloading' || status === 'probing')) {
        card.style.display = 'flex';
      } else if (currentFilterValue === status) {
        card.style.display = 'flex';
      } else {
        card.style.display = 'none';
      }
    } else if (currentFilterType === 'category') {
      if (currentFilterValue === category) {
        card.style.display = 'flex';
      } else {
        card.style.display = 'none';
      }
    }
  });
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatSeconds(secs) {
  if (!secs || secs <= 0) return '00:00';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function escapePath(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
