const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const localAppData = process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local');
const appDataBin = path.join(localAppData, 'TurboDownloader', 'bin');
const localBin = path.join(__dirname, '..', 'bin');

function resolveBinDir() {
  const candidates = [
    appDataBin,
    path.join(process.resourcesPath || '', 'bin'),
    localBin,
    path.join(__dirname, '..', '..', 'bin')
  ];
  for (const dir of candidates) {
    if (dir && fs.existsSync(dir)) {
      const hasYt = fs.existsSync(path.join(dir, 'yt-dlp.exe'));
      const hasFfmpeg = fs.existsSync(path.join(dir, 'ffmpeg.exe')) || fs.existsSync(path.join(dir, 'ffmpeg_bin.exe'));
      if (hasYt && hasFfmpeg) return dir;
    }
  }
  return appDataBin;
}

const BIN_DIR = resolveBinDir();
const YTDLP_PATH = path.join(BIN_DIR, 'yt-dlp.exe');
const FFMPEG_PATH = fs.existsSync(path.join(BIN_DIR, 'ffmpeg.exe'))
  ? path.join(BIN_DIR, 'ffmpeg.exe')
  : (fs.existsSync(path.join(BIN_DIR, 'ffmpeg_bin.exe')) ? path.join(BIN_DIR, 'ffmpeg_bin.exe') : path.join(BIN_DIR, 'ffmpeg.exe'));
const TEMP_DIR = path.join(localAppData, 'TurboDownloader', 'temp');

class MediaTask extends EventEmitter {
  constructor({ id, url, saveFolder, fileName }) {
    super();
    this.id = id || Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    this.url = url;
    this.saveFolder = saveFolder;
    this.fileName = fileName || 'Resolving Media...';
    this.savePath = '';
    this.category = 'Video';
    this.threads = 16;
    this.status = 'queued'; // 'queued', 'probing', 'downloading', 'completed', 'error', 'canceled'
    this.percent = 0;
    this.speed = 0;
    this.eta = 0;
    this.totalBytes = 0;
    this.downloadedBytes = 0;
    this.errorMessage = null;
    this.childProcess = null;
  }

  static isSupported(url) {
    if (!url) return false;
    const u = url.toLowerCase();
    return u.includes('youtube.com') || u.includes('youtu.be') ||
           u.includes('tiktok.com') || u.includes('twitter.com') ||
           u.includes('x.com') || u.includes('instagram.com/reel') ||
           u.includes('vimeo.com') || u.includes('reddit.com');
  }

  static async probeMetadata(url) {
    return new Promise((resolve) => {
      const proc = spawn(YTDLP_PATH, [
        '--dump-json',
        '--no-warnings',
        '--no-playlist',
        url
      ]);

      let stdout = '';
      proc.stdout.on('data', chunk => { stdout += chunk; });

      proc.on('close', (code) => {
        if (code === 0 && stdout) {
          try {
            const data = JSON.parse(stdout);
            return resolve({
              success: true,
              fileName: `${data.title || 'Video'}.mp4`,
              size: data.filesize || data.filesize_approx || 0,
              resumable: true,
              category: 'Video'
            });
          } catch (e) {}
        }
        resolve({
          success: true,
          fileName: 'YouTube_Video.mp4',
          size: 0,
          resumable: true,
          category: 'Video'
        });
      });

      proc.on('error', () => {
        resolve({
          success: false,
          error: 'Could not probe video'
        });
      });
    });
  }

  start() {
    if (this.status === 'downloading') return;

    this.status = 'probing';
    this.emit('status', this.getSnapshot());

    if (!fs.existsSync(this.saveFolder)) {
      fs.mkdirSync(this.saveFolder, { recursive: true });
    }

    if (!fs.existsSync(TEMP_DIR)) {
      try { fs.mkdirSync(TEMP_DIR, { recursive: true }); } catch (e) {}
    }

    // Best video + best audio merged into single MP4 with audio and video combined
    const args = [
      '--ffmpeg-location', BIN_DIR,
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--newline',
      '--no-playlist',
      '--no-warnings',
      '--paths', `home:${this.saveFolder}`,
      '--paths', `temp:${TEMP_DIR}`,
      '--progress-template', 'download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress._total_bytes_str)s',
      '-o', '%(title)s.%(ext)s',
      this.url
    ];

    try {
      this.childProcess = spawn(YTDLP_PATH, args);
      this.status = 'downloading';
      this.emit('status', this.getSnapshot());

      this.childProcess.stdout.on('data', (data) => {
        const text = data.toString();
        const lines = text.split('\n');

        for (const line of lines) {
          // Detect destination output file or moved final merged file
          if (line.includes('[MoveFiles] Moving file')) {
            const moveMatch = line.match(/Moving file\s+"([^"]+)"\s+to\s+"([^"]+)"/);
            if (moveMatch && moveMatch[2]) {
              const fullPath = moveMatch[2].trim();
              this.savePath = fullPath;
              this.fileName = path.basename(fullPath);
              this.emit('status', this.getSnapshot());
            }
          } else if (line.includes('[Merger] Merging formats into')) {
            const mergeMatch = line.match(/Merging formats into\s+"([^"]+)"/);
            if (mergeMatch && mergeMatch[1]) {
              const fullPath = mergeMatch[1].trim();
              const destPath = path.join(this.saveFolder, path.basename(fullPath));
              this.savePath = destPath;
              this.fileName = path.basename(destPath);
              this.emit('status', this.getSnapshot());
            }
          } else if (line.includes('[download] Destination:')) {
            const destMatch = line.match(/Destination:\s*(.+)$/);
            if (destMatch && destMatch[1]) {
              const candidate = destMatch[1].trim();
              // Ignore temporary intermediate tracks (e.g., .f395.mp4 or .f140.m4a)
              if (!/\.f\d+\./.test(candidate) && candidate.endsWith('.mp4')) {
                this.savePath = candidate;
                this.fileName = path.basename(candidate);
                this.emit('status', this.getSnapshot());
              }
            }
          }

          // Parse progress template
          if (line.startsWith('download:')) {
            const raw = line.substring(9).trim();
            const parts = raw.split('|');
            if (parts.length >= 3) {
              const rawPct = parts[0].replace('%', '').trim();
              const pct = parseFloat(rawPct);
              if (!isNaN(pct)) this.percent = pct;

              const speedStr = parts[1].trim();
              this.speed = this.parseSpeed(speedStr);

              const etaStr = parts[2].trim();
              this.eta = this.parseEta(etaStr);

              this.emit('progress', this.getSnapshot());
            }
          }
        }
      });

      this.childProcess.stderr.on('data', (data) => {
        console.error('[MediaEngine Stderr]:', data.toString());
      });

      this.childProcess.on('close', (code) => {
        if (this.status === 'canceled') return;

        if (code === 0) {
          // If savePath is not set or missing, find the newest .mp4 file in saveFolder
          if (!this.savePath || !fs.existsSync(this.savePath)) {
            try {
              const files = fs.readdirSync(this.saveFolder)
                .map(f => ({ name: f, full: path.join(this.saveFolder, f), stat: fs.statSync(path.join(this.saveFolder, f)) }))
                .filter(f => f.stat.isFile() && f.name.endsWith('.mp4') && !f.name.includes('.f'))
                .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
              if (files.length > 0) {
                this.savePath = files[0].full;
                this.fileName = files[0].name;
              }
            } catch (e) {}
          }

          if (this.savePath && fs.existsSync(this.savePath)) {
            try {
              const stats = fs.statSync(this.savePath);
              this.totalBytes = stats.size;
              this.downloadedBytes = stats.size;
            } catch (e) {}
          }

          this.status = 'completed';
          this.percent = 100;
          this.emit('completed', this.getSnapshot());
          this.emit('status', this.getSnapshot());
        } else {
          this.status = 'error';
          this.errorMessage = `Media engine exited with code ${code}`;
          this.emit('error', this.errorMessage);
          this.emit('status', this.getSnapshot());
        }
      });

      this.childProcess.on('error', (err) => {
        this.status = 'error';
        this.errorMessage = err.message;
        this.emit('error', this.errorMessage);
        this.emit('status', this.getSnapshot());
      });

    } catch (err) {
      this.status = 'error';
      this.errorMessage = err.message;
      this.emit('error', this.errorMessage);
      this.emit('status', this.getSnapshot());
    }
  }

  parseSpeed(str) {
    if (!str || str === 'Unknown') return 0;
    const match = str.match(/([0-9.]+)\s*([KMGTP]?i?B)\/s/i);
    if (!match) return 0;
    const val = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    if (unit.startsWith('K')) return Math.round(val * 1024);
    if (unit.startsWith('M')) return Math.round(val * 1024 * 1024);
    if (unit.startsWith('G')) return Math.round(val * 1024 * 1024 * 1024);
    return Math.round(val);
  }

  parseEta(str) {
    if (!str || str === 'Unknown') return 0;
    const parts = str.split(':').map(p => parseInt(p, 10));
    if (parts.length === 2) return (parts[0] * 60) + parts[1];
    if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
    return 0;
  }

  pause() {
    // Media stream download pause terminates process gracefully
    if (this.childProcess) {
      this.status = 'paused';
      this.childProcess.kill();
      this.emit('status', this.getSnapshot());
    }
  }

  resume() {
    if (this.status === 'paused') {
      this.start();
    }
  }

  cancel() {
    this.status = 'canceled';
    if (this.childProcess) {
      try { this.childProcess.kill(); } catch (e) {}
    }
    if (this.savePath && fs.existsSync(this.savePath)) {
      try { fs.unlinkSync(this.savePath); } catch (e) {}
    }
    this.emit('status', this.getSnapshot());
  }

  getSnapshot() {
    return {
      id: this.id,
      url: this.url,
      savePath: this.savePath,
      fileName: this.fileName || 'YouTube Video.mp4',
      status: this.status,
      totalBytes: this.totalBytes,
      downloadedBytes: this.downloadedBytes,
      percent: this.percent,
      speed: this.speed,
      eta: this.eta,
      threads: 16,
      resumable: true,
      category: 'Video',
      segments: [
        { id: 0, start: 0, end: 100, total: 100, downloaded: this.percent, percent: this.percent, status: this.status }
      ],
      error: this.errorMessage
    };
  }
}

module.exports = { MediaTask };
