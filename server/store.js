'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { encodeCanvasPNG } = require('./png');

const PALETTE_PRESETS = {
  rplace32: {
    name: 'r/place 2022 (32 couleurs)',
    colors: [
      '#FFFFFF', '#D4D7D9', '#898D90', '#515252', '#000000',
      '#6D001A', '#BE0039', '#FF4500', '#FFA800', '#FFD635', '#FFF8B8',
      '#00A368', '#00CC78', '#7EED56', '#00756F', '#009EAA', '#00CCC0',
      '#2450A4', '#3690EA', '#51E9F4', '#493AC1', '#6A5CFF', '#94B3FF',
      '#811E9F', '#B44AC0', '#E4ABFF', '#DE107F', '#FF3881', '#FF99AA',
      '#6D482F', '#9C6926', '#FFB470',
    ],
  },
  rplace16: {
    name: 'Classique (16 couleurs)',
    colors: [
      '#FFFFFF', '#E4E4E4', '#888888', '#222222',
      '#FFA7D1', '#E50000', '#E59500', '#A06A42',
      '#E5D900', '#94E044', '#02BE01', '#00D3DD',
      '#0083C7', '#0000EA', '#CF6EE4', '#820080',
    ],
  },
  pastel: {
    name: 'Pastel Doux (16 couleurs)',
    colors: [
      '#FFFFFF', '#F1F5F9', '#94A3B8', '#334155',
      '#FECDD3', '#FDA4AF', '#FDE68A', '#FED7AA',
      '#BBF7D0', '#86EFAC', '#99F6E4', '#BAE6FD',
      '#C7D2FE', '#DDD6FE', '#F5D0FE', '#FBCFE8',
    ],
  },
  neon: {
    name: 'Cyberpunk Néon (16 couleurs)',
    colors: [
      '#0B0E17', '#1E293B', '#64748B', '#F8FAFC',
      '#FF0055', '#FF3366', '#FF6B00', '#FFE600',
      '#00FF88', '#00E5FF', '#0066FF', '#6E00FF',
      '#BD00FF', '#FF00CC', '#39FF14', '#FF2A85',
    ],
  },
};

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

class PixelWarStore {
  constructor(options = {}) {
    this.dataDir = options.dataDir || process.env.DATA_DIR || path.join(process.cwd(), 'data');
    this.snapshotsDir = path.join(this.dataDir, 'snapshots');
    fs.mkdirSync(this.snapshotsDir, { recursive: true });

    this.statePath = path.join(this.dataDir, 'state.json');
    this.canvasPath = path.join(this.dataDir, 'canvas.bin');
    this.metaPath = path.join(this.dataDir, 'meta.json');
    this.historyPath = path.join(this.dataDir, 'history.ndjson');

    // Default dynamic configuration
    this.config = {
      title: process.env.EVENT_TITLE || 'Pixel War de la Promo',
      subtitle: process.env.EVENT_SUBTITLE || 'Pose ton pixel, défends ta faction !',
      width: clampInt(parseInt(process.env.CANVAS_WIDTH || '128', 10), 16, 1000),
      height: clampInt(parseInt(process.env.CANVAS_HEIGHT || '128', 10), 16, 1000),
      cooldownMs: clampInt(parseInt(process.env.COOLDOWN_MS || '5000', 10), 0, 3600000),
      maxCharges: clampInt(parseInt(process.env.MAX_CHARGES || '1', 10), 1, 25),
      cooldownMode: validateCooldownMode(process.env.COOLDOWN_MODE || 'client'),
      paused: false,
      allowSameColor: false,
      allowPublicExport: true,
      allowTimelapse: true,
      requireNickname: false,
      announcement: '',
      endTime: null, // ISO timestamp or null
      autoSnapshotMinutes: clampInt(parseInt(process.env.AUTO_SNAPSHOT_MINUTES || '15', 10), 0, 1440),
      palette: [...PALETTE_PRESETS.rplace32.colors],
    };

    // Runtime state
    this.pixels = new Uint8Array(this.config.width * this.config.height);
    this.pixelTimestamps = new Uint32Array(this.config.width * this.config.height); // seconds since epoch
    this.pixelAuthors = new Uint16Array(this.config.width * this.config.height); // index into authorList (0 = none)
    this.authorList = [''];
    this.authorIndexMap = new Map([['', 0]]);
    this.authorCounts = new Map(); // nickname -> total pixels placed
    this.totalPixelsPlaced = 0;

    // Cooldown tracking: key -> { charges: number, lastRefill: number }
    this.cooldownBuckets = new Map();
    // Per-session anti-flood guard (never by IP: all MINITEL traffic shares VPS IP)
    this.sessionFloodGuard = new Map();
    // Banned keys (clientIds, authentik UIDs, or nicknames)
    this.bannedSet = new Set();

    // History in memory (ring buffer / full list up to 250k events for fast timelapse API)
    this.historyCount = 0;
    this._dirty = false;
    this._saveTimer = null;
    this._snapshotTimer = null;

    this.loadFromDisk();
    this._setupAutoSnapshot();
  }

  loadFromDisk() {
    try {
      if (fs.existsSync(this.statePath)) {
        const saved = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        if (saved.config) {
          this.config = {
            ...this.config,
            ...saved.config,
            width: clampInt(saved.config.width, 16, 1000),
            height: clampInt(saved.config.height, 16, 1000),
            cooldownMs: clampInt(saved.config.cooldownMs, 0, 3600000),
            maxCharges: clampInt(saved.config.maxCharges || 1, 1, 25),
            cooldownMode: validateCooldownMode(saved.config.cooldownMode || 'client'),
          };
          if (!Array.isArray(this.config.palette) || this.config.palette.length < 2) {
            this.config.palette = [...PALETTE_PRESETS.rplace32.colors];
          }
        }
        if (typeof saved.totalPixelsPlaced === 'number') {
          this.totalPixelsPlaced = saved.totalPixelsPlaced;
        }
        if (Array.isArray(saved.banned)) {
          this.bannedSet = new Set(saved.banned);
        }
        if (saved.authorCounts && typeof saved.authorCounts === 'object') {
          for (const [k, v] of Object.entries(saved.authorCounts)) {
            this.authorCounts.set(k, v);
          }
        }
      }

      const expectedLen = this.config.width * this.config.height;
      this.pixels = new Uint8Array(expectedLen);
      this.pixelTimestamps = new Uint32Array(expectedLen);
      this.pixelAuthors = new Uint16Array(expectedLen);

      if (fs.existsSync(this.canvasPath)) {
        const buf = fs.readFileSync(this.canvasPath);
        if (buf.length === expectedLen) {
          this.pixels.set(buf);
        }
      }

      if (fs.existsSync(this.metaPath)) {
        const meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
        if (Array.isArray(meta.authorList)) {
          this.authorList = meta.authorList;
          this.authorIndexMap = new Map();
          this.authorList.forEach((name, idx) => this.authorIndexMap.set(name, idx));
        }
        if (typeof meta.authorsBase64 === 'string') {
          const abuf = Buffer.from(meta.authorsBase64, 'base64');
          if (abuf.length === expectedLen * 2) {
            this.pixelAuthors = new Uint16Array(abuf.buffer, abuf.byteOffset, expectedLen);
          }
        }
        if (typeof meta.timestampsBase64 === 'string') {
          const tbuf = Buffer.from(meta.timestampsBase64, 'base64');
          if (tbuf.length === expectedLen * 4) {
            this.pixelTimestamps = new Uint32Array(tbuf.buffer, tbuf.byteOffset, expectedLen);
          }
        }
      }

      if (fs.existsSync(this.historyPath)) {
        const stat = fs.statSync(this.historyPath);
        if (stat.size > 0) {
          const content = fs.readFileSync(this.historyPath, 'utf8');
          this.historyCount = content.split('\n').filter(Boolean).length;
        }
      }
    } catch (err) {
      console.error('[Store] Erreur lors du chargement disque, démarrage sur canvas vierge:', err.message);
    }
  }

  scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveNow();
    }, 1500);
    this._saveTimer.unref();
  }

  saveNow() {
    if (!this._dirty) return;
    this._dirty = false;
    try {
      const tmpCanvas = this.canvasPath + '.tmp';
      fs.writeFileSync(tmpCanvas, Buffer.from(this.pixels.buffer, this.pixels.byteOffset, this.pixels.byteLength));
      fs.renameSync(tmpCanvas, this.canvasPath);

      const stateObj = {
        config: this.config,
        totalPixelsPlaced: this.totalPixelsPlaced,
        banned: Array.from(this.bannedSet),
        authorCounts: Object.fromEntries(this.authorCounts),
        savedAt: new Date().toISOString(),
      };
      const tmpState = this.statePath + '.tmp';
      fs.writeFileSync(tmpState, JSON.stringify(stateObj, null, 2));
      fs.renameSync(tmpState, this.statePath);

      const metaObj = {
        authorList: this.authorList,
        authorsBase64: Buffer.from(this.pixelAuthors.buffer, this.pixelAuthors.byteOffset, this.pixelAuthors.byteLength).toString('base64'),
        timestampsBase64: Buffer.from(this.pixelTimestamps.buffer, this.pixelTimestamps.byteOffset, this.pixelTimestamps.byteLength).toString('base64'),
      };
      const tmpMeta = this.metaPath + '.tmp';
      fs.writeFileSync(tmpMeta, JSON.stringify(metaObj));
      fs.renameSync(tmpMeta, this.metaPath);
    } catch (err) {
      console.error('[Store] Erreur sauvegarde disque:', err.message);
      this._dirty = true;
    }
  }

  _setupAutoSnapshot() {
    if (this._snapshotTimer) {
      clearInterval(this._snapshotTimer);
      this._snapshotTimer = null;
    }
    const mins = this.config.autoSnapshotMinutes;
    if (!mins || mins <= 0) return;
    this._snapshotTimer = setInterval(() => {
      if (this.totalPixelsPlaced > 0) {
        try {
          this.createSnapshot('auto');
        } catch (err) {
          console.error('[Snapshot] Erreur auto-snapshot:', err.message);
        }
      }
    }, mins * 60 * 1000);
    this._snapshotTimer.unref();
  }

  _getAuthorIndex(nickname) {
    const clean = sanitizeNickname(nickname);
    if (!clean) return 0;
    let idx = this.authorIndexMap.get(clean);
    if (idx !== undefined) return idx;
    if (this.authorList.length >= 65530) {
      // Fallback if >65k unique nicknames
      return 0;
    }
    idx = this.authorList.length;
    this.authorList.push(clean);
    this.authorIndexMap.set(clean, idx);
    return idx;
  }

  getPublicConfig() {
    return {
      title: this.config.title,
      subtitle: this.config.subtitle,
      width: this.config.width,
      height: this.config.height,
      cooldownMs: this.config.cooldownMs,
      maxCharges: this.config.maxCharges,
      cooldownMode: this.config.cooldownMode,
      paused: this.isEffectivelyPaused(),
      manualPaused: this.config.paused,
      allowSameColor: this.config.allowSameColor,
      allowPublicExport: this.config.allowPublicExport,
      allowTimelapse: this.config.allowTimelapse,
      requireNickname: this.config.requireNickname,
      announcement: this.config.announcement,
      endTime: this.config.endTime,
      autoSnapshotMinutes: this.config.autoSnapshotMinutes,
      palette: this.config.palette,
      totalPixelsPlaced: this.totalPixelsPlaced,
    };
  }

  isEffectivelyPaused() {
    if (this.config.paused) return true;
    if (this.config.endTime) {
      const endMs = Date.parse(this.config.endTime);
      if (!Number.isNaN(endMs) && Date.now() >= endMs) {
        return true;
      }
    }
    return false;
  }

  _getBucketKeys(clientId, authentikUid = '') {
    const mode = this.config.cooldownMode;
    if (mode === 'authentik' && authentikUid) {
      return [`ak:${authentikUid}`];
    }
    if (authentikUid) {
      return [`ak:${authentikUid}`, `cid:${clientId}`];
    }
    return [`cid:${clientId}`];
  }

  _refillBucket(bucket, now) {
    const cd = this.config.cooldownMs;
    const maxC = this.config.maxCharges;
    if (cd <= 0) {
      bucket.charges = maxC;
      bucket.lastRefill = now;
      return;
    }
    if (bucket.charges >= maxC) {
      bucket.charges = maxC;
      bucket.lastRefill = now;
      return;
    }
    const elapsed = Math.max(0, now - bucket.lastRefill);
    const gained = Math.floor(elapsed / cd);
    if (gained > 0) {
      bucket.charges = Math.min(maxC, bucket.charges + gained);
      if (bucket.charges >= maxC) {
        bucket.lastRefill = now;
      } else {
        bucket.lastRefill += gained * cd;
      }
    }
  }

  getCooldownStatus(clientId, authentikUid = '', isAdminBypass = false) {
    const now = Date.now();
    const maxC = this.config.maxCharges;
    const cd = this.config.cooldownMs;
    if (isAdminBypass || cd <= 0) {
      return { charges: maxC, maxCharges: maxC, nextRefillMs: 0, cooldownMs: cd };
    }

    const keys = this._getBucketKeys(clientId, authentikUid);
    let minCharges = maxC;
    let maxWaitMs = 0;

    for (const key of keys) {
      let bucket = this.cooldownBuckets.get(key);
      if (!bucket) {
        bucket = { charges: maxC, lastRefill: now };
        this.cooldownBuckets.set(key, bucket);
      } else {
        this._refillBucket(bucket, now);
      }
      if (bucket.charges < minCharges) minCharges = bucket.charges;
      if (bucket.charges < maxC) {
        const wait = Math.max(0, cd - (now - bucket.lastRefill));
        if (wait > maxWaitMs) maxWaitMs = wait;
      }
    }

    return {
      charges: minCharges,
      maxCharges: maxC,
      nextRefillMs: minCharges > 0 ? (minCharges < maxC ? maxWaitMs : 0) : maxWaitMs,
      cooldownMs: cd,
    };
  }

  placePixel({ x, y, color, clientId, authentikUid = '', nickname = '', isAdminBypass = false }) {
    const now = Date.now();
    const cleanNick = sanitizeNickname(nickname);

    if (
      !isAdminBypass &&
      (this.bannedSet.has(clientId) ||
        (authentikUid && this.bannedSet.has(`ak:${authentikUid}`)) ||
        (authentikUid && this.bannedSet.has(authentikUid)) ||
        (cleanNick && this.bannedSet.has(`nick:${cleanNick.toLowerCase()}`)))
    ) {
      return { ok: false, code: 'BANNED', message: 'Vous avez été restreint par un administrateur.' };
    }

    if (!isAdminBypass && this.isEffectivelyPaused()) {
      return { ok: false, code: 'PAUSED', message: 'Le canvas est actuellement figé.' };
    }

    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= this.config.width || y < 0 || y >= this.config.height) {
      return { ok: false, code: 'OUT_OF_BOUNDS', message: 'Coordonnées hors du canvas.' };
    }

    if (!Number.isInteger(color) || color < 0 || color >= this.config.palette.length) {
      return { ok: false, code: 'INVALID_COLOR', message: 'Couleur invalide.' };
    }

    if (!isAdminBypass && this.config.requireNickname && !cleanNick) {
      return { ok: false, code: 'NICKNAME_REQUIRED', message: 'Un pseudo est requis pour poser un pixel.' };
    }

    const idx = y * this.config.width + x;
    if (!isAdminBypass && !this.config.allowSameColor && this.pixels[idx] === color) {
      return { ok: false, code: 'SAME_COLOR', message: 'Ce pixel a déjà cette couleur.' };
    }

    // Per-session anti-flood guard (max 25 req/s per session, never keyed by IP)
    if (!isAdminBypass) {
      const floodKey = authentikUid ? `ak:${authentikUid}` : `cid:${clientId}`;
      let guard = this.sessionFloodGuard.get(floodKey);
      if (!guard || now - guard.winStart > 1000) {
        guard = { winStart: now, count: 0 };
        this.sessionFloodGuard.set(floodKey, guard);
      }
      if (guard.count >= 25) {
        return { ok: false, code: 'RATE_LIMIT', message: 'Trop de requêtes rapides sur cette session.' };
      }
      guard.count++;
    }

    // Check cooldown
    if (!isAdminBypass && this.config.cooldownMs > 0) {
      const status = this.getCooldownStatus(clientId, authentikUid, false);
      if (status.charges <= 0) {
        return {
          ok: false,
          code: 'COOLDOWN',
          message: 'Cooldown en cours !',
          retryAfterMs: status.nextRefillMs,
          cooldown: status,
        };
      }

      // Consume 1 charge from each tracked key
      const keys = this._getBucketKeys(clientId, authentikUid);
      for (const key of keys) {
        const bucket = this.cooldownBuckets.get(key);
        if (bucket) {
          if (bucket.charges === this.config.maxCharges) {
            bucket.lastRefill = now;
          }
          bucket.charges = Math.max(0, bucket.charges - 1);
        }
      }
    }

    // Apply pixel
    this.pixels[idx] = color;
    const tsSec = Math.floor(now / 1000);
    this.pixelTimestamps[idx] = tsSec;
    const authorIdx = this._getAuthorIndex(cleanNick);
    this.pixelAuthors[idx] = authorIdx;
    this.totalPixelsPlaced++;

    if (cleanNick) {
      this.authorCounts.set(cleanNick, (this.authorCounts.get(cleanNick) || 0) + 1);
    }

    // Append to history file for timelapse
    this._appendHistory({ t: now, x, y, c: color, a: cleanNick || undefined });
    this.scheduleSave();

    const cooldown = this.getCooldownStatus(clientId, authentikUid, isAdminBypass);
    return {
      ok: true,
      pixel: { x, y, color, author: cleanNick, timestamp: tsSec },
      cooldown,
      totalPixelsPlaced: this.totalPixelsPlaced,
    };
  }

  applyBatchPixels(updates, author = 'Admin') {
    const now = Date.now();
    const tsSec = Math.floor(now / 1000);
    const authorIdx = this._getAuthorIndex(author);
    const applied = [];

    for (const u of updates) {
      const x = u.x | 0;
      const y = u.y | 0;
      const c = u.c | 0;
      if (x < 0 || x >= this.config.width || y < 0 || y >= this.config.height) continue;
      if (c < 0 || c >= this.config.palette.length) continue;
      const idx = y * this.config.width + x;
      this.pixels[idx] = c;
      this.pixelTimestamps[idx] = tsSec;
      this.pixelAuthors[idx] = authorIdx;
      applied.push([x, y, c]);
    }

    if (applied.length > 0) {
      this.totalPixelsPlaced += applied.length;
      this._appendHistory({ t: now, batch: applied, a: author });
      this.scheduleSave();
    }
    return applied.length;
  }

  getPixelInfo(x, y) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= this.config.width || y < 0 || y >= this.config.height) {
      return null;
    }
    const idx = y * this.config.width + x;
    const authorIdx = this.pixelAuthors[idx];
    return {
      x,
      y,
      color: this.pixels[idx],
      hex: this.config.palette[this.pixels[idx]] || '#FFFFFF',
      author: this.authorList[authorIdx] || '',
      timestamp: this.pixelTimestamps[idx] || 0,
    };
  }

  getLeaderboard(limit = 20) {
    const entries = Array.from(this.authorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name, count], i) => ({ rank: i + 1, name, count }));

    // Color usage stats
    const colorCounts = new Uint32Array(this.config.palette.length);
    for (let i = 0; i < this.pixels.length; i++) {
      const c = this.pixels[i];
      if (c < colorCounts.length) colorCounts[c]++;
    }
    const colors = this.config.palette.map((hex, index) => ({
      index,
      hex,
      count: colorCounts[index],
    }));

    return {
      totalPixelsPlaced: this.totalPixelsPlaced,
      leaderboard: entries,
      colors,
    };
  }

  updateConfig(patch) {
    let canvasResized = false;
    let paletteChanged = false;
    let cooldownChanged = false;

    if (typeof patch.title === 'string') {
      this.config.title = patch.title.trim().slice(0, 80) || 'Pixel War';
    }
    if (typeof patch.subtitle === 'string') {
      this.config.subtitle = patch.subtitle.trim().slice(0, 140);
    }
    if (typeof patch.announcement === 'string') {
      this.config.announcement = patch.announcement.trim().slice(0, 240);
    }
    if (typeof patch.paused === 'boolean') {
      this.config.paused = patch.paused;
    }
    if (typeof patch.allowSameColor === 'boolean') {
      this.config.allowSameColor = patch.allowSameColor;
    }
    if (typeof patch.allowPublicExport === 'boolean') {
      this.config.allowPublicExport = patch.allowPublicExport;
    }
    if (typeof patch.allowTimelapse === 'boolean') {
      this.config.allowTimelapse = patch.allowTimelapse;
    }
    if (typeof patch.requireNickname === 'boolean') {
      this.config.requireNickname = patch.requireNickname;
    }
    if (patch.endTime === null || patch.endTime === '') {
      this.config.endTime = null;
    } else if (typeof patch.endTime === 'string' && !Number.isNaN(Date.parse(patch.endTime))) {
      this.config.endTime = new Date(patch.endTime).toISOString();
    }

    if (typeof patch.cooldownMs === 'number' && Number.isFinite(patch.cooldownMs)) {
      const newCd = clampInt(patch.cooldownMs, 0, 3600000);
      if (newCd !== this.config.cooldownMs) {
        this.config.cooldownMs = newCd;
        cooldownChanged = true;
        // Adjust active buckets so reducing cooldown takes effect immediately
        const now = Date.now();
        for (const bucket of this.cooldownBuckets.values()) {
          if (newCd === 0) {
            bucket.charges = this.config.maxCharges;
            bucket.lastRefill = now;
          } else {
            this._refillBucket(bucket, now);
          }
        }
      }
    }

    if (typeof patch.maxCharges === 'number' && Number.isFinite(patch.maxCharges)) {
      const newMax = clampInt(patch.maxCharges, 1, 25);
      if (newMax !== this.config.maxCharges) {
        const diff = newMax - this.config.maxCharges;
        this.config.maxCharges = newMax;
        cooldownChanged = true;
        for (const bucket of this.cooldownBuckets.values()) {
          bucket.charges = Math.max(0, Math.min(newMax, bucket.charges + Math.max(0, diff)));
        }
      }
    }

    if (typeof patch.cooldownMode === 'string') {
      const valid = validateCooldownMode(patch.cooldownMode);
      if (valid !== this.config.cooldownMode) {
        this.config.cooldownMode = valid;
        cooldownChanged = true;
      }
    }

    if (typeof patch.autoSnapshotMinutes === 'number' && Number.isFinite(patch.autoSnapshotMinutes)) {
      this.config.autoSnapshotMinutes = clampInt(patch.autoSnapshotMinutes, 0, 1440);
      this._setupAutoSnapshot();
    }

    if (Array.isArray(patch.palette)) {
      const cleanPalette = patch.palette
        .map((c) => (typeof c === 'string' ? c.trim().toUpperCase() : ''))
        .filter((c) => HEX_RE.test(c))
        .slice(0, 64);
      if (cleanPalette.length >= 2) {
        this.config.palette = cleanPalette;
        paletteChanged = true;
        // Clamp any out-of-range pixel index to 0
        for (let i = 0; i < this.pixels.length; i++) {
          if (this.pixels[i] >= cleanPalette.length) this.pixels[i] = 0;
        }
      }
    }

    if (patch.width !== undefined || patch.height !== undefined) {
      const newW = clampInt(patch.width ?? this.config.width, 16, 1000);
      const newH = clampInt(patch.height ?? this.config.height, 16, 1000);
      if (newW !== this.config.width || newH !== this.config.height) {
        this.resizeCanvas(newW, newH, patch.resizeAnchor || 'center', patch.fillColor || 0);
        canvasResized = true;
      }
    }

    this.scheduleSave();
    return { config: this.getPublicConfig(), canvasResized, paletteChanged, cooldownChanged };
  }

  resizeCanvas(newW, newH, anchor = 'center', fillColor = 0) {
    const oldW = this.config.width;
    const oldH = this.config.height;
    const fill = clampInt(fillColor, 0, this.config.palette.length - 1);

    const newPixels = new Uint8Array(newW * newH);
    newPixels.fill(fill);
    const newTimestamps = new Uint32Array(newW * newH);
    const newAuthors = new Uint16Array(newW * newH);

    const offsetX = anchor === 'center' ? Math.floor((newW - oldW) / 2) : 0;
    const offsetY = anchor === 'center' ? Math.floor((newH - oldH) / 2) : 0;

    for (let y = 0; y < oldH; y++) {
      const ny = y + offsetY;
      if (ny < 0 || ny >= newH) continue;
      for (let x = 0; x < oldW; x++) {
        const nx = x + offsetX;
        if (nx < 0 || nx >= newW) continue;
        const oldIdx = y * oldW + x;
        const newIdx = ny * newW + nx;
        newPixels[newIdx] = this.pixels[oldIdx];
        newTimestamps[newIdx] = this.pixelTimestamps[oldIdx];
        newAuthors[newIdx] = this.pixelAuthors[oldIdx];
      }
    }

    this.config.width = newW;
    this.config.height = newH;
    this.pixels = newPixels;
    this.pixelTimestamps = newTimestamps;
    this.pixelAuthors = newAuthors;

    this._appendHistory({ t: Date.now(), resize: { w: newW, h: newH, anchor, fill } });
    this.scheduleSave();
  }

  clearCanvas(fillColor = 0, resetStats = false) {
    // Auto-backup before destructive clear
    if (this.totalPixelsPlaced > 0) {
      try {
        this.createSnapshot('pre-reset');
      } catch {
        // ignore backup error
      }
    }
    const fill = clampInt(fillColor, 0, this.config.palette.length - 1);
    this.pixels.fill(fill);
    this.pixelTimestamps.fill(0);
    this.pixelAuthors.fill(0);

    if (resetStats) {
      this.totalPixelsPlaced = 0;
      this.authorCounts.clear();
      this.authorList = [''];
      this.authorIndexMap = new Map([['', 0]]);
      try {
        fs.writeFileSync(this.historyPath, '');
        this.historyCount = 0;
      } catch {
        // ignore
      }
    } else {
      this._appendHistory({ t: Date.now(), clear: fill });
    }
    this.scheduleSave();
  }

  createSnapshot(label = 'manual') {
    const safeLabel = String(label || 'manual').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'snap';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const id = `${stamp}_${safeLabel}_${crypto.randomBytes(2).toString('hex')}`;

    const binFile = path.join(this.snapshotsDir, `${id}.bin`);
    const metaFile = path.join(this.snapshotsDir, `${id}.json`);
    const pngFile = path.join(this.snapshotsDir, `${id}.png`);

    fs.writeFileSync(binFile, Buffer.from(this.pixels.buffer, this.pixels.byteOffset, this.pixels.byteLength));
    const scale = Math.max(1, Math.min(8, Math.floor(1024 / Math.max(this.config.width, this.config.height))));
    const pngBuf = encodeCanvasPNG(this.pixels, this.config.width, this.config.height, this.config.palette, scale);
    fs.writeFileSync(pngFile, pngBuf);

    const meta = {
      id,
      label: safeLabel,
      createdAt: new Date().toISOString(),
      width: this.config.width,
      height: this.config.height,
      palette: [...this.config.palette],
      totalPixelsPlaced: this.totalPixelsPlaced,
      pngBytes: pngBuf.length,
    };
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    return meta;
  }

  listSnapshots() {
    if (!fs.existsSync(this.snapshotsDir)) return [];
    const files = fs.readdirSync(this.snapshotsDir).filter((f) => f.endsWith('.json'));
    const list = [];
    for (const f of files) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this.snapshotsDir, f), 'utf8'));
        list.push(meta);
      } catch {
        // skip corrupted
      }
    }
    return list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  getSnapshotPngPath(id) {
    const safeId = path.basename(id);
    if (!/^[a-zA-Z0-9._-]+$/.test(safeId)) return null;
    const p = path.join(this.snapshotsDir, `${safeId}.png`);
    return fs.existsSync(p) ? p : null;
  }

  restoreSnapshot(id) {
    const safeId = path.basename(id);
    if (!/^[a-zA-Z0-9._-]+$/.test(safeId)) {
      throw new Error('Identifiant de snapshot invalide.');
    }
    const metaPath = path.join(this.snapshotsDir, `${safeId}.json`);
    const binPath = path.join(this.snapshotsDir, `${safeId}.bin`);
    if (!fs.existsSync(metaPath) || !fs.existsSync(binPath)) {
      throw new Error('Snapshot introuvable.');
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const buf = fs.readFileSync(binPath);
    const expected = meta.width * meta.height;
    if (buf.length !== expected) {
      throw new Error('Données snapshot corrompues.');
    }
    this.config.width = meta.width;
    this.config.height = meta.height;
    if (Array.isArray(meta.palette) && meta.palette.length >= 2) {
      this.config.palette = [...meta.palette];
    }
    this.pixels = new Uint8Array(buf);
    this.pixelTimestamps = new Uint32Array(expected);
    this.pixelAuthors = new Uint16Array(expected);
    this.scheduleSave();
    return meta;
  }

  deleteSnapshot(id) {
    const safeId = path.basename(id);
    if (!/^[a-zA-Z0-9._-]+$/.test(safeId)) return false;
    for (const ext of ['.json', '.bin', '.png']) {
      const p = path.join(this.snapshotsDir, `${safeId}${ext}`);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    return true;
  }

  exportPNG(scale = 4) {
    return encodeCanvasPNG(this.pixels, this.config.width, this.config.height, this.config.palette, scale);
  }

  _appendHistory(entry) {
    try {
      fs.appendFileSync(this.historyPath, JSON.stringify(entry) + '\n');
      this.historyCount++;
    } catch {
      // ignore non-fatal log error
    }
  }

  readHistory(maxEvents = 100000) {
    if (!fs.existsSync(this.historyPath)) return [];
    const raw = fs.readFileSync(this.historyPath, 'utf8');
    if (!raw) return [];
    const lines = raw.split('\n').filter(Boolean);
    const slice = lines.length > maxEvents ? lines.slice(lines.length - maxEvents) : lines;
    const events = [];
    for (const line of slice) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // skip malformed line
      }
    }
    return events;
  }

  banTarget(target) {
    const clean = String(target || '').trim();
    // Garde-fou MINITEL : ne jamais bannir une IP (tout le trafic passe par le VPS / Sakura)
    if (!clean || /^(\d{1,3}\.){3}\d{1,3}$/.test(clean) || clean === '::1') {
      throw new Error('Le bannissement par IP est désactivé sur l\'infra MINITEL (IP partagée par le VPS). Utilisez un identifiant de session ou un compte Authentik.');
    }
    this.bannedSet.add(clean);
    this.scheduleSave();
  }

  unbanTarget(target) {
    const clean = String(target || '').trim();
    if (this.bannedSet.delete(clean)) {
      this.scheduleSave();
    }
  }

  destroy() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    if (this._snapshotTimer) clearInterval(this._snapshotTimer);
    this._dirty = true;
    this.saveNow();
  }
}

function clampInt(val, min, max) {
  const n = Math.round(Number(val));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function validateCooldownMode(mode) {
  return ['client', 'authentik'].includes(mode) ? mode : 'client';
}

function sanitizeNickname(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/[\r\n\t<>]/g, '').trim().slice(0, 24);
}

module.exports = { PixelWarStore, PALETTE_PRESETS, sanitizeNickname };
