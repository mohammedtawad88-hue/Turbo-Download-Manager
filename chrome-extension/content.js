/**
 * Turbo Downloader — Content Script (Floating Media Grabber & YouTube Integration)
 * High-performance video sniffer with immediate clickability and zero latency.
 */

(function () {
  const processedContainers = new WeakSet();
  const processedVideos = new WeakSet();

  function sanitizeFileName(name) {
    if (!name) return 'video.mp4';
    let clean = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim();
    if (clean.length > 80) clean = clean.substring(0, 80);
    return clean ? `${clean}.mp4` : 'video.mp4';
  }

  function getPageVideoTitle() {
    // 1. YouTube specific title selectors
    const ytTitle = document.querySelector(
      'h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string, ytd-watch-metadata #title yt-formatted-string, h1.title'
    );
    if (ytTitle && ytTitle.textContent && ytTitle.textContent.trim()) {
      return ytTitle.textContent.trim();
    }

    // 2. Generic video title or page title
    let title = document.title || 'Video';
    title = title.replace(/\s*-\s*YouTube$/i, '').trim();
    return title;
  }

  function getMediaUrl(video) {
    const isYouTube = window.location.hostname.includes('youtube.com') || window.location.hostname.includes('youtu.be');
    if (isYouTube) {
      return window.location.href;
    }

    if (video) {
      if (video.currentSrc && !video.currentSrc.startsWith('blob:')) return video.currentSrc;
      if (video.src && !video.src.startsWith('blob:')) return video.src;
      const sources = video.querySelectorAll('source');
      for (const s of sources) {
        if (s.src && !s.src.startsWith('blob:')) return s.src;
      }
    }

    return window.location.href;
  }

  function triggerDownload(btn, video) {
    const mediaUrl = getMediaUrl(video);
    const rawTitle = getPageVideoTitle();
    const cleanFileName = sanitizeFileName(rawTitle);

    const originalHtml = btn.innerHTML;
    btn.innerHTML = `<span class="turbo-btn-icon">⏳</span><span class="turbo-btn-text">Sending to Turbo...</span>`;
    btn.style.pointerEvents = 'none';

    chrome.runtime.sendMessage({
      action: 'turbo_download_media',
      url: mediaUrl,
      title: cleanFileName
    }, (res) => {
      btn.style.pointerEvents = 'auto';
      if (chrome.runtime.lastError || (res && !res.success)) {
        btn.innerHTML = `<span class="turbo-btn-icon">❌</span><span class="turbo-btn-text">Check Turbo App</span>`;
        setTimeout(() => {
          btn.innerHTML = originalHtml;
        }, 3000);
      } else {
        btn.classList.add('turbo-btn-success');
        btn.innerHTML = `<span class="turbo-btn-icon">✓</span><span class="turbo-btn-text">Accelerating!</span>`;
        setTimeout(() => {
          btn.classList.remove('turbo-btn-success');
          btn.innerHTML = originalHtml;
        }, 3500);
      }
    });
  }

  function createSnifferButton(video) {
    const btn = document.createElement('div');
    btn.className = 'turbo-media-sniffer-btn';
    btn.setAttribute('role', 'button');
    btn.setAttribute('title', 'Instant Download with Turbo Download Manager');
    btn.innerHTML = `
      <span class="turbo-btn-icon">⚡</span>
      <span class="turbo-btn-text">Download Video</span>
    `;

    // Intercept in capture phase so host player (e.g. YouTube) never swallows the click or toggles play/pause
    ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(evtName => {
      btn.addEventListener(evtName, (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (evtName === 'click') {
          e.preventDefault();
          triggerDownload(btn, video);
        }
      }, true);
    });

    return btn;
  }

  function attachToPlayerContainer(container, video) {
    if (!container || processedContainers.has(container)) return;
    processedContainers.add(container);

    const style = window.getComputedStyle(container);
    if (style.position === 'static') {
      container.style.position = 'relative';
    }

    // Check if button already exists in container
    if (container.querySelector('.turbo-media-sniffer-btn')) return;

    const btn = createSnifferButton(video);
    container.appendChild(btn);
  }

  // YouTube Action Bar Integration (#top-level-buttons-computed)
  function injectYouTubeActionBarButton() {
    if (!window.location.hostname.includes('youtube.com')) return;

    const targetRow = document.querySelector(
      '#top-level-buttons-computed, ytd-watch-metadata #actions #top-level-buttons-computed'
    );
    if (!targetRow || targetRow.querySelector('.turbo-yt-action-btn')) return;

    const ytBtn = document.createElement('button');
    ytBtn.className = 'turbo-yt-action-btn';
    ytBtn.innerHTML = `<span>⚡</span><span>Turbo Download</span>`;
    ytBtn.setAttribute('title', 'Download 1080p/4K Video + Audio with Turbo');

    ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(evtName => {
      ytBtn.addEventListener(evtName, (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (evtName === 'click') {
          e.preventDefault();
          triggerDownload(ytBtn, null);
        }
      }, true);
    });

    targetRow.prepend(ytBtn);
  }

  function scanMedia() {
    // 1. YouTube Player direct attachment
    const ytPlayer = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    if (ytPlayer) {
      const ytVideo = ytPlayer.querySelector('video');
      attachToPlayerContainer(ytPlayer, ytVideo);
      injectYouTubeActionBarButton();
    }

    // 2. Generic HTML5 Video scan
    const videos = document.querySelectorAll('video');
    videos.forEach(video => {
      if (processedVideos.has(video)) return;
      processedVideos.add(video);

      // Skip tiny video elements (thumbnails, tracking pixels, avatars)
      if (video.offsetWidth > 0 && video.offsetWidth < 180 && video.offsetHeight < 130) {
        return;
      }

      const playerContainer = video.closest('#movie_player, .html5-video-player, ytd-player, .video-js, [data-player], .player-container') || video.parentElement;
      if (playerContainer) {
        attachToPlayerContainer(playerContainer, video);
      }
    });
  }

  // Scan immediately
  scanMedia();

  // YouTube SPA navigation events
  window.addEventListener('yt-navigate-finish', () => {
    setTimeout(scanMedia, 300);
    setTimeout(scanMedia, 1000);
  });

  window.addEventListener('popstate', () => {
    setTimeout(scanMedia, 400);
  });

  // Watch DOM mutations for dynamic video players
  const observer = new MutationObserver(() => {
    scanMedia();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
