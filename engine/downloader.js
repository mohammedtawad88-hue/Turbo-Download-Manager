const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { URL } = require('url');

class DownloadTask extends EventEmitter {
  constructor({ id, url, savePath, threads = 8 }) {
    super();
    this.id = id || Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    this.url = url;
    this.savePath = savePath;
    this.threads = Math.max(1, Math.min(32, threads));
    this.metaPath = savePath + '.tdm.json';

    this.status = 'queued'; // 'queued', 'probing', 'downloading', 'paused', 'completed', 'error'
    this.totalBytes = 0;
    this.downloadedBytes = 0;
    this.resumable = false;
    this.segments = [];
    this.activeRequests = [];
    this.fd = null;
    this.speed = 0;
    this.eta = 0;
    this.lastSpeedCheck = Date.now();
    this.bytesSinceLastCheck = 0;
    this.speedInterval = null;
    this.errorMessage = null;
  }

  getProtocol(targetUrl) {
    return targetUrl.startsWith('https:') ? https : http;
  }

  setSparseFlag() {
    if (process.platform === 'win32' && this.savePath) {
      try {
        const { execSync } = require('child_process');
        execSync(`fsutil sparse setflag "${this.savePath}"`, { stdio: 'ignore', windowsHide: true });
      } catch (e) {}
    }
  }

  followRedirects(currentUrl, maxRedirects = 10) {
    return new Promise((resolve, reject) => {
      if (maxRedirects <= 0) return reject(new Error('Too many redirects'));

      try {
        const parsedUrl = new URL(currentUrl);
        const client = this.getProtocol(currentUrl);

        const req = client.request(parsedUrl, {
          method: 'HEAD',
          rejectUnauthorized: false,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*'
          }
        }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            const nextUrl = new URL(res.headers.location, currentUrl).href;
            resolve(this.followRedirects(nextUrl, maxRedirects - 1));
          } else {
            resolve({ finalUrl: currentUrl, headers: res.headers, statusCode: res.statusCode });
          }
        });

        req.on('error', (err) => {
          // If HEAD fails, try GET with range: bytes=0-0 to probe headers
          const getReq = client.request(parsedUrl, {
            method: 'GET',
            rejectUnauthorized: false,
            headers: {
              'Range': 'bytes=0-0',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          }, (res) => {
            getReq.abort();
            resolve({ finalUrl: currentUrl, headers: res.headers, statusCode: res.statusCode });
          });
          getReq.on('error', reject);
          getReq.end();
        });

        req.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  determineFileName(headers, finalUrl) {
    const MIME_MAP = {
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'image/svg+xml': '.svg',
      'image/bmp': '.bmp',
      'image/x-icon': '.ico',
      'image/vnd.microsoft.icon': '.ico',
      'image/avif': '.avif',
      'image/heic': '.heic',
      'image/tiff': '.tiff',
      'application/pdf': '.pdf',
      'application/zip': '.zip',
      'application/x-rar-compressed': '.rar',
      'application/x-7z-compressed': '.7z',
      'application/x-tar': '.tar',
      'application/gzip': '.gz',
      'audio/mpeg': '.mp3',
      'audio/wav': '.wav',
      'audio/ogg': '.ogg',
      'audio/aac': '.aac',
      'video/mp4': '.mp4',
      'video/webm': '.webm',
      'video/x-matroska': '.mkv'
    };

    let name = '';
    const cd = headers ? headers['content-disposition'] : null;
    if (cd) {
      const utfMatch = cd.match(/filename\*=UTF-8''([^;]+)/i);
      if (utfMatch) name = decodeURIComponent(utfMatch[1]);
      if (!name) {
        const match = cd.match(/filename=["']?([^"';]+)["']?/i);
        if (match) name = match[1].trim();
      }
    }

    if (!name) {
      try {
        const parsed = new URL(finalUrl);
        const formatParam = parsed.searchParams.get('format') || parsed.searchParams.get('ext');
        const fileParam = parsed.searchParams.get('file') || parsed.searchParams.get('filename') || parsed.searchParams.get('name');
        if (fileParam && path.extname(fileParam)) {
          name = path.basename(fileParam);
        } else {
          const pathname = parsed.pathname;
          const basename = path.basename(pathname);
          if (basename && basename.length > 0 && basename.includes('.')) {
            name = basename;
          } else if (basename && basename.length > 0 && formatParam) {
            name = `${basename}.${formatParam.replace(/^\./, '')}`;
          }
        }
      } catch (e) {}
    }

    // Determine extension from Content-Type if available
    let mimeExt = '';
    if (headers && headers['content-type']) {
      const rawMime = headers['content-type'].split(';')[0].trim().toLowerCase();
      mimeExt = MIME_MAP[rawMime] || '';
    }

    if (name) {
      // If filename has no extension, append the detected MIME extension
      if (!path.extname(name) && mimeExt) {
        name = name + mimeExt;
      }
      return name;
    }

    // Fallback: prefix with category name if MIME is known
    const isImage = mimeExt && (mimeExt === '.jpg' || mimeExt === '.png' || mimeExt === '.webp' || mimeExt === '.gif' || mimeExt === '.svg' || mimeExt === '.avif');
    const prefix = isImage ? 'image_' : 'downloaded_file_';
    return prefix + Date.now().toString(36) + (mimeExt || '');
  }

  async start() {
    if (this.status === 'downloading') return;

    this.status = 'probing';
    this.emit('status', this.getSnapshot());

    try {
      // 1. Check if existing resume state exists
      if (fs.existsSync(this.metaPath) && fs.existsSync(this.savePath)) {
        try {
          const rawMeta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
          if (rawMeta.totalBytes && rawMeta.segments && rawMeta.segments.length > 0) {
            this.totalBytes = rawMeta.totalBytes;
            this.resumable = rawMeta.resumable;
            this.segments = rawMeta.segments;
            this.finalUrl = rawMeta.finalUrl || this.url;
            this.downloadedBytes = this.segments.reduce((acc, seg) => acc + seg.downloaded, 0);
            return this.resumeSegments();
          }
        } catch (e) {
          // invalid metadata, start fresh
        }
      }

      // 2. Probe server capabilities
      const { finalUrl, headers } = await this.followRedirects(this.url);
      this.finalUrl = finalUrl;

      // Extract file size & range support
      const acceptRanges = headers['accept-ranges'];
      const contentLengthHeader = headers['content-length'];
      const contentRange = headers['content-range'];

      let size = 0;
      if (contentLengthHeader) {
        size = parseInt(contentLengthHeader, 10);
      } else if (contentRange) {
        const parts = contentRange.split('/');
        if (parts[1]) size = parseInt(parts[1], 10);
      }

      this.totalBytes = size;
      this.resumable = (acceptRanges === 'bytes' || !!contentRange) && size > 0;

      // Adjust thread count if not resumable or file is small
      if (!this.resumable || size <= 1024 * 64) {
        this.threads = 1;
      }

      // If savePath has no extension, update it with detected filename/extension
      if (!path.extname(this.savePath)) {
        const detectedName = this.determineFileName(headers, finalUrl);
        if (path.extname(detectedName)) {
          const dir = path.dirname(this.savePath);
          this.savePath = path.join(dir, detectedName);
          this.metaPath = this.savePath + '.tdm.json';
        }
      }

      // Create target directory if needed
      const dir = path.dirname(this.savePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // Open file for read/write
      this.fd = fs.openSync(this.savePath, 'w+');
      this.setSparseFlag();

      // Create Segment plan
      this.segments = [];
      if (this.threads > 1 && this.totalBytes > 0) {
        const chunkSize = Math.floor(this.totalBytes / this.threads);
        for (let i = 0; i < this.threads; i++) {
          const start = i * chunkSize;
          const end = (i === this.threads - 1) ? this.totalBytes - 1 : (start + chunkSize - 1);
          this.segments.push({
            id: i,
            start,
            end,
            total: end - start + 1,
            downloaded: 0,
            status: 'waiting'
          });
        }
      } else {
        this.segments.push({
          id: 0,
          start: 0,
          end: this.totalBytes > 0 ? this.totalBytes - 1 : -1,
          total: this.totalBytes,
          downloaded: 0,
          status: 'waiting'
        });
      }

      this.saveMetadata(true);
      this.resumeSegments();
    } catch (err) {
      this.status = 'error';
      this.errorMessage = err.message;
      this.emit('error', this.errorMessage);
      this.emit('status', this.getSnapshot());
    }
  }

  saveMetadata(immediate = false) {
    if (immediate) {
      if (this.metaSaveTimer) {
        clearTimeout(this.metaSaveTimer);
        this.metaSaveTimer = null;
      }
      this._writeMeta();
      return;
    }
    if (this.metaSaveTimer) return;
    this.metaSaveTimer = setTimeout(() => {
      this.metaSaveTimer = null;
      this._writeMeta();
    }, 2000);
  }

  _writeMeta() {
    try {
      const meta = {
        id: this.id,
        url: this.url,
        finalUrl: this.finalUrl || this.url,
        savePath: this.savePath,
        totalBytes: this.totalBytes,
        resumable: this.resumable,
        threads: this.threads,
        segments: this.segments
      };
      fs.writeFileSync(this.metaPath, JSON.stringify(meta, null, 2), 'utf8');
    } catch (e) {}
  }

  resumeSegments() {
    this.status = 'downloading';
    this.activeRequests = [];
    if (!this.fd) {
      const dir = path.dirname(this.savePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const mode = fs.existsSync(this.savePath) ? 'r+' : 'w+';
      this.fd = fs.openSync(this.savePath, mode);
      this.setSparseFlag();
    }

    this.startSpeedTracker();

    let completedSegments = 0;
    const totalSegments = this.segments.length;
    const remainingSegments = [];

    this.segments.forEach((segment) => {
      if (segment.downloaded >= segment.total && segment.total > 0) {
        segment.status = 'completed';
        completedSegments++;
      } else {
        segment.retries = 0;
        segment.status = 'waiting';
        remainingSegments.push(segment);
      }
    });

    if (completedSegments === totalSegments) {
      this.onAllCompleted();
      return;
    }

    remainingSegments.forEach((segment) => {
      this.downloadSegment(segment, () => {
        completedSegments++;
        if (completedSegments === totalSegments) {
          this.onAllCompleted();
        }
      });
    });

    this.emit('status', this.getSnapshot());
  }

  downloadSegment(segment, onDone) {
    if (this.status !== 'downloading') return;
    if (segment.downloaded >= segment.total && segment.total > 0) {
      segment.status = 'completed';
      onDone();
      return;
    }

    segment.status = 'downloading';
    segment.retries = segment.retries || 0;
    const client = this.getProtocol(this.finalUrl || this.url);
    const parsedUrl = new URL(this.finalUrl || this.url);

    const startByte = segment.start + segment.downloaded;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Connection': 'keep-alive'
    };

    if (this.resumable && segment.end >= 0) {
      headers['Range'] = `bytes=${startByte}-${segment.end}`;
    }

    let bufferQueue = [];
    let bufferedBytes = 0;
    let writeInProgress = false;
    let streamRes = null;
    let isCleanedUp = false;
    const FLUSH_THRESHOLD = 128 * 1024; // 128 KB buffer per stream for maximum throughput

    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      const idx = this.activeRequests.indexOf(req);
      if (idx !== -1) this.activeRequests.splice(idx, 1);
    };

    const scheduleRetry = (errReason) => {
      cleanup();
      if (this.status !== 'downloading') return;

      if (segment.retries < 10) {
        segment.retries++;
        segment.status = 'retrying';
        const delay = Math.min(1000 * segment.retries, 5000);
        console.warn(`[Segment #${segment.id}] Reconnecting (attempt ${segment.retries}/10) in ${delay}ms: ${errReason}`);
        setTimeout(() => {
          if (this.status === 'downloading') {
            this.downloadSegment(segment, onDone);
          }
        }, delay);
      } else {
        segment.status = 'error';
        this.status = 'error';
        this.errorMessage = `Segment #${segment.id} failed after 10 retries: ${errReason}`;
        this.emit('error', this.errorMessage);
        this.emit('status', this.getSnapshot());
      }
    };

    const flushBuffer = (onFlushed) => {
      if (writeInProgress || bufferQueue.length === 0) {
        if (onFlushed) onFlushed();
        return;
      }
      if (this.status !== 'downloading' && this.status !== 'completed') return;

      writeInProgress = true;
      const combined = Buffer.concat(bufferQueue);
      bufferQueue = [];
      const len = combined.length;
      bufferedBytes = 0;

      const writeOffset = segment.start + segment.downloaded;

      fs.write(this.fd, combined, 0, combined.length, writeOffset, (writeErr) => {
        writeInProgress = false;
        if (writeErr) {
          if (this.status === 'downloading') {
            try { req.destroy(writeErr); } catch (e) {}
            scheduleRetry(writeErr.message);
          }
          return;
        }

        segment.downloaded += len;
        this.downloadedBytes += len;
        this.bytesSinceLastCheck += len;

        // Drain pending queue or resume stream if paused
        if (bufferQueue.length > 0) {
          flushBuffer(onFlushed);
        } else {
          if (streamRes && streamRes.isPaused()) {
            streamRes.resume();
          }
          if (onFlushed) onFlushed();
        }

        // Throttle progress events to max ~5-6 times/sec (every 180ms)
        const now = Date.now();
        if (now - (this.lastProgressEmit || 0) >= 180) {
          this.lastProgressEmit = now;
          this.emit('progress', this.getSnapshot());
        }
      });
    };

    const req = client.request(parsedUrl, { method: 'GET', headers, rejectUnauthorized: false }, (res) => {
      streamRes = res;

      // Check HTTP Status
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        try { res.destroy(); } catch (e) {}
        scheduleRetry(`HTTP status ${res.statusCode}`);
        return;
      }

      // Reset retry count on successful connection
      segment.retries = 0;

      res.on('data', (chunk) => {
        if (this.status !== 'downloading') {
          try { res.destroy(); } catch (e) {}
          cleanup();
          return;
        }

        bufferQueue.push(chunk);
        bufferedBytes += chunk.length;

        // Per-stream backpressure: if buffer exceeds 1.5MB while disk is writing, pause socket
        if (bufferedBytes > 1536 * 1024) {
          res.pause();
        }

        if (bufferedBytes >= FLUSH_THRESHOLD && !writeInProgress) {
          flushBuffer();
        }
      });

      res.on('end', () => {
        const drain = () => {
          if (bufferQueue.length > 0 || writeInProgress) {
            flushBuffer(drain);
          } else {
            cleanup();
            if (segment.total > 0 && segment.downloaded < segment.total) {
              scheduleRetry(`Incomplete stream: received ${segment.downloaded}/${segment.total} bytes`);
              return;
            }

            segment.status = 'completed';
            this.saveMetadata();
            onDone();
          }
        };
        drain();
      });

      res.on('error', (err) => {
        if (this.status === 'paused') {
          cleanup();
          return;
        }
        scheduleRetry(err.message);
      });
    });

    req.on('error', (err) => {
      if (this.status === 'paused') {
        cleanup();
        return;
      }
      scheduleRetry(err.message);
    });

    // Set socket timeout of 30 seconds
    req.setTimeout(30000, () => {
      try { req.destroy(new Error('Socket timeout (30s)')); } catch (e) {}
    });

    this.activeRequests.push(req);
    req.end();
  }

  startSpeedTracker() {
    if (this.speedInterval) clearInterval(this.speedInterval);
    this.lastSpeedCheck = Date.now();
    this.bytesSinceLastCheck = 0;

    this.speedInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = (now - this.lastSpeedCheck) / 1000;
      if (elapsed > 0) {
        this.speed = Math.round(this.bytesSinceLastCheck / elapsed);
        this.bytesSinceLastCheck = 0;
        this.lastSpeedCheck = now;

        if (this.speed > 0 && this.totalBytes > 0) {
          const remaining = Math.max(0, this.totalBytes - this.downloadedBytes);
          this.eta = Math.round(remaining / this.speed);
        } else {
          this.eta = 0;
        }
        this.emit('progress', this.getSnapshot());
      }
    }, 400);
  }

  pause() {
    if (this.status !== 'downloading') return;
    this.status = 'paused';
    this.stopRequests();
    this.saveMetadata(true);
    this.emit('status', this.getSnapshot());
  }

  stopRequests() {
    if (this.metaSaveTimer) {
      clearTimeout(this.metaSaveTimer);
      this.metaSaveTimer = null;
    }
    if (this.speedInterval) {
      clearInterval(this.speedInterval);
      this.speedInterval = null;
    }
    this.activeRequests.forEach(req => {
      try { req.destroy(); } catch (e) {}
    });
    this.activeRequests = [];
    if (this.fd) {
      try { fs.closeSync(this.fd); } catch (e) {}
      this.fd = null;
    }
    this.speed = 0;
    this.eta = 0;
  }

  cancel() {
    this.status = 'canceled';
    this.stopRequests();
    try {
      if (fs.existsSync(this.metaPath)) fs.unlinkSync(this.metaPath);
      if (fs.existsSync(this.savePath)) fs.unlinkSync(this.savePath);
    } catch (e) {}
    this.emit('status', this.getSnapshot());
  }

  onAllCompleted() {
    this.status = 'completed';
    this.stopRequests();
    try {
      if (fs.existsSync(this.metaPath)) fs.unlinkSync(this.metaPath);
    } catch (e) {}
    this.emit('completed', this.getSnapshot());
    this.emit('status', this.getSnapshot());
  }

  getSnapshot() {
    const percent = this.totalBytes > 0 
      ? Math.min(100, (this.downloadedBytes / this.totalBytes) * 100) 
      : 0;

    return {
      id: this.id,
      url: this.url,
      savePath: this.savePath,
      fileName: path.basename(this.savePath),
      status: this.status,
      totalBytes: this.totalBytes,
      downloadedBytes: this.downloadedBytes,
      percent: parseFloat(percent.toFixed(1)),
      speed: this.speed,
      eta: this.eta,
      threads: this.threads,
      resumable: this.resumable,
      segments: this.segments.map(s => ({
        id: s.id,
        start: s.start,
        end: s.end,
        total: s.total,
        downloaded: s.downloaded,
        percent: s.total > 0 ? parseFloat(Math.min(100, (s.downloaded / s.total) * 100).toFixed(1)) : 0,
        status: s.status
      })),
      error: this.errorMessage
    };
  }
}

module.exports = { DownloadTask };
