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

const LOOTBOX_ITEMS = {
  frenzy: {
    id: 'frenzy',
    name: 'Frénésie Illimitée',
    icon: '⚡',
    rarity: 'Épique',
    weight: 20,
    durationMs: 5000,
    description: 'Cooldown à 0 pendant 5 secondes ! Peins à toute vitesse (et en glissant) !',
  },
  bomb: {
    id: 'bomb',
    name: 'Bombe de Peinture',
    icon: '💣',
    rarity: 'Épique',
    weight: 22,
    radius: 4,
    description: 'Ton prochain pixel déclenche un éclat organique de ta couleur (rayon 4 px) !',
  },
  brush3: {
    id: 'brush3',
    name: 'Pinceau Large 3×3',
    icon: '🖌️',
    rarity: 'Rare',
    weight: 22,
    uses: 3,
    description: 'Tes 3 prochaines poses peignent un carré de 3×3 pixels d\'un coup !',
  },
  shield: {
    id: 'shield',
    name: 'Bouclier de Zone 5×5',
    icon: '🛡️',
    rarity: 'Rare',
    weight: 16,
    radius: 2,
    durationMs: 120_000,
    description: 'Protège une zone 5×5 autour de ton prochain pixel pendant 2 minutes !',
  },
  charges5: {
    id: 'charges5',
    name: 'Pack +5 Pixels',
    icon: '🔋',
    rarity: 'Commun',
    weight: 25,
    charges: 5,
    description: 'Ajoute instantanément 5 pixels bonus prêts à poser sans attendre !',
  },
  rainbow: {
    id: 'rainbow',
    name: 'Pinceau Arc-en-Ciel',
    icon: '🌈',
    rarity: 'Fun',
    weight: 18,
    durationMs: 5000,
    cooldownMs: 350,
    description: 'Pose ultra-rapide (0,35s) pendant 5s avec dégradé arc-en-ciel automatique !',
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
    this.baselinePath = path.join(this.dataDir, 'replay-baseline.bin');

    // Default dynamic configuration
    this.config = {
      title: process.env.EVENT_TITLE || 'Pixel War ISMIN',
      subtitle: process.env.EVENT_SUBTITLE || 'Pose ton pixel, défends ta faction !',
      width: clampInt(parseInt(process.env.CANVAS_WIDTH || '128', 10), 16, 1000),
      height: clampInt(parseInt(process.env.CANVAS_HEIGHT || '128', 10), 16, 1000),
      cooldownMs: clampInt(parseInt(process.env.COOLDOWN_MS || '5000', 10), 0, 3600000),
      maxCharges: clampInt(parseInt(process.env.MAX_CHARGES || '1', 10), 1, 25),
      cooldownMode: validateCooldownMode(process.env.COOLDOWN_MODE || 'authentik'),
      paused: false,
      allowSameColor: false,
      allowPublicExport: true,
      allowTimelapse: true,
      requireNickname: false,
      lockNicknameToAuthentik: false,
      announcement: '',
      startTime: null, // ISO timestamp: replay recording begins at startTime
      lockBeforeStart: false, // if true, non-admin players cannot draw before startTime
      endTime: null, // ISO timestamp or null
      autoSnapshotMinutes: clampInt(parseInt(process.env.AUTO_SNAPSHOT_MINUTES || '15', 10), 0, 1440),
      maxAutoSnapshots: clampInt(parseInt(process.env.MAX_AUTO_SNAPSHOTS || '48', 10), 0, 500),
      lootboxEnabled: process.env.LOOTBOX_ENABLED !== 'false',
      lootboxIntervalMinutes: clampInt(parseInt(process.env.LOOTBOX_INTERVAL_MINUTES || '60', 10), 1, 1440),
      palette: [...PALETTE_PRESETS.rplace32.colors],
    };

    // Runtime state
    this.pixels = new Uint8Array(this.config.width * this.config.height);
    this.pixelTimestamps = new Uint32Array(this.config.width * this.config.height);
    this.pixelAuthors = new Uint16Array(this.config.width * this.config.height);
    this.authorList = [''];
    this.authorIndexMap = new Map([['', 0]]);
    this.authorCounts = new Map();
    this.totalPixelsPlaced = 0;

    // Replay baseline metadata
    this.replayBaselineMeta = null; // { capturedAt, width, height }

    // Cooldown tracking
    this.cooldownBuckets = new Map();
    this.sessionFloodGuard = new Map();
    this.bannedSet = new Set();
    this.extraAdmins = new Set();

    // Lootboxes & Boosts
    this.inventories = new Map(); // userKey -> { lootboxes, items, activeBoost, bonusCharges }
    this.shields = []; // [{ id, x, y, radius, ownerKey, ownerName, expiresAt }]
    this.nextAutoSnapshotAt = null;

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
            cooldownMode: validateCooldownMode(saved.config.cooldownMode || 'authentik'),
            autoSnapshotMinutes: clampInt(saved.config.autoSnapshotMinutes ?? 15, 0, 1440),
            maxAutoSnapshots: clampInt(saved.config.maxAutoSnapshots ?? 48, 0, 500),
            lootboxIntervalMinutes: clampInt(saved.config.lootboxIntervalMinutes ?? 60, 1, 1440),
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
        if (Array.isArray(saved.extraAdmins)) {
          this.extraAdmins = new Set(saved.extraAdmins.map((u) => normalizeUsername(u)).filter(Boolean));
        }
        if (saved.authorCounts && typeof saved.authorCounts === 'object') {
          for (const [k, v] of Object.entries(saved.authorCounts)) {
            this.authorCounts.set(k, v);
          }
        }
        if (saved.replayBaselineMeta) {
          this.replayBaselineMeta = saved.replayBaselineMeta;
        }
        if (saved.inventories && typeof saved.inventories === 'object') {
          for (const [k, inv] of Object.entries(saved.inventories)) {
            this.inventories.set(k, normalizeInventory(inv));
          }
        }
        if (Array.isArray(saved.shields)) {
          const now = Date.now();
          this.shields = saved.shields.filter((s) => s && s.expiresAt > now);
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

      this.pruneExpiredShields();
      const stateObj = {
        config: this.config,
        totalPixelsPlaced: this.totalPixelsPlaced,
        banned: Array.from(this.bannedSet),
        extraAdmins: Array.from(this.extraAdmins),
        authorCounts: Object.fromEntries(this.authorCounts),
        replayBaselineMeta: this.replayBaselineMeta,
        inventories: Object.fromEntries(this.inventories),
        shields: this.shields,
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
    if (!mins || mins <= 0) {
      this.nextAutoSnapshotAt = null;
      return;
    }
    const intervalMs = mins * 60 * 1000;
    this.nextAutoSnapshotAt = Date.now() + intervalMs;
    this._snapshotTimer = setInterval(() => {
      this.nextAutoSnapshotAt = Date.now() + intervalMs;
      if (this.totalPixelsPlaced > 0) {
        try {
          this.createSnapshot('auto');
          this._pruneAutoSnapshots();
        } catch (err) {
          console.error('[Snapshot] Erreur auto-snapshot:', err.message);
        }
      }
    }, intervalMs);
    this._snapshotTimer.unref();
  }

  _pruneAutoSnapshots() {
    const max = this.config.maxAutoSnapshots;
    if (!max || max <= 0) return;
    const autos = this.listSnapshots().filter((s) => s.label === 'auto');
    if (autos.length <= max) return;
    for (const old of autos.slice(max)) {
      this.deleteSnapshot(old.id);
    }
  }

  _getAuthorIndex(nickname) {
    const clean = sanitizeNickname(nickname);
    if (!clean) return 0;
    let idx = this.authorIndexMap.get(clean);
    if (idx !== undefined) return idx;
    if (this.authorList.length >= 65530) return 0;
    idx = this.authorList.length;
    this.authorList.push(clean);
    this.authorIndexMap.set(clean, idx);
    return idx;
  }

  isBeforeStart(now = Date.now()) {
    if (!this.config.startTime) return false;
    const ms = Date.parse(this.config.startTime);
    return !Number.isNaN(ms) && now < ms;
  }

  isReplayRecordingActive(now = Date.now()) {
    if (!this.config.startTime) return true;
    const ms = Date.parse(this.config.startTime);
    return Number.isNaN(ms) || now >= ms;
  }

  isEffectivelyPaused(now = Date.now()) {
    if (this.config.paused) return true;
    if (this.config.lockBeforeStart && this.isBeforeStart(now)) return true;
    if (this.config.endTime) {
      const endMs = Date.parse(this.config.endTime);
      if (!Number.isNaN(endMs) && now >= endMs) return true;
    }
    return false;
  }

  captureReplayBaseline(resetHistoryBeforeNow = true) {
    const now = Date.now();
    const tmp = this.baselinePath + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(this.pixels.buffer, this.pixels.byteOffset, this.pixels.byteLength));
    fs.renameSync(tmp, this.baselinePath);
    this.replayBaselineMeta = {
      capturedAt: new Date(now).toISOString(),
      width: this.config.width,
      height: this.config.height,
    };
    if (resetHistoryBeforeNow) {
      try {
        fs.writeFileSync(this.historyPath, '');
        this.historyCount = 0;
      } catch {
        // ignore
      }
    }
    try {
      this.createSnapshot('debut-evenement');
    } catch {
      // ignore
    }
    this.scheduleSave();
    return this.replayBaselineMeta;
  }

  getPublicConfig() {
    const now = Date.now();
    return {
      title: this.config.title,
      subtitle: this.config.subtitle,
      width: this.config.width,
      height: this.config.height,
      cooldownMs: this.config.cooldownMs,
      maxCharges: this.config.maxCharges,
      cooldownMode: this.config.cooldownMode,
      paused: this.isEffectivelyPaused(now),
      manualPaused: this.config.paused,
      beforeStart: this.isBeforeStart(now),
      replayRecording: this.isReplayRecordingActive(now),
      allowSameColor: this.config.allowSameColor,
      allowPublicExport: this.config.allowPublicExport,
      allowTimelapse: this.config.allowTimelapse,
      requireNickname: this.config.requireNickname,
      lockNicknameToAuthentik: this.config.lockNicknameToAuthentik,
      announcement: this.config.announcement,
      startTime: this.config.startTime,
      lockBeforeStart: this.config.lockBeforeStart,
      endTime: this.config.endTime,
      autoSnapshotMinutes: this.config.autoSnapshotMinutes,
      maxAutoSnapshots: this.config.maxAutoSnapshots,
      nextAutoSnapshotAt: this.nextAutoSnapshotAt,
      lootboxEnabled: this.config.lootboxEnabled,
      lootboxIntervalMinutes: this.config.lootboxIntervalMinutes,
      palette: this.config.palette,
      totalPixelsPlaced: this.totalPixelsPlaced,
    };
  }

  // ─────────────────────────── Lootboxes, Inventory & Shields ───────────────────────────
  getUserKey(clientId, authentikUid = '') {
    return authentikUid ? `ak:${authentikUid}` : `cid:${clientId}`;
  }

  getInventory(userKey) {
    let inv = this.inventories.get(userKey);
    if (!inv) {
      inv = normalizeInventory(null);
      this.inventories.set(userKey, inv);
    }
    this._cleanupActiveBoost(inv);
    return {
      lootboxes: inv.lootboxes,
      items: { ...inv.items },
      activeBoost: inv.activeBoost ? { ...inv.activeBoost } : null,
      bonusCharges: inv.bonusCharges,
    };
  }

  _cleanupActiveBoost(inv, now = Date.now()) {
    if (!inv.activeBoost) return;
    if (inv.activeBoost.expiresAt && now >= inv.activeBoost.expiresAt) {
      inv.activeBoost = null;
    } else if (typeof inv.activeBoost.remainingUses === 'number' && inv.activeBoost.remainingUses <= 0) {
      inv.activeBoost = null;
    }
  }

  grantLootbox(userKey, count = 1) {
    let inv = this.inventories.get(userKey);
    if (!inv) {
      inv = normalizeInventory(null);
      this.inventories.set(userKey, inv);
    }
    inv.lootboxes += Math.max(1, Math.min(10, count | 0));
    this.scheduleSave();
    return this.getInventory(userKey);
  }

  openLootbox(userKey) {
    const inv = this.inventories.get(userKey);
    if (!inv || inv.lootboxes <= 0) {
      throw new Error('Vous n\'avez aucune lootbox à ouvrir.');
    }
    inv.lootboxes--;

    // Weighted random draw
    const pool = Object.values(LOOTBOX_ITEMS);
    const totalWeight = pool.reduce((sum, it) => sum + it.weight, 0);
    let roll = crypto.randomInt(0, totalWeight);
    let picked = pool[0];
    for (const item of pool) {
      if (roll < item.weight) {
        picked = item;
        break;
      }
      roll -= item.weight;
    }

    inv.items[picked.id] = (inv.items[picked.id] || 0) + 1;
    this.scheduleSave();
    return { item: picked, inventory: this.getInventory(userKey) };
  }

  activateBoost(userKey, itemId) {
    const def = LOOTBOX_ITEMS[itemId];
    if (!def) throw new Error('Objet inconnu.');
    const inv = this.inventories.get(userKey);
    if (!inv || (inv.items[itemId] || 0) <= 0) {
      throw new Error('Vous ne possédez pas cet objet.');
    }
    const now = Date.now();
    this._cleanupActiveBoost(inv, now);

    if (itemId === 'charges5') {
      inv.items[itemId]--;
      inv.bonusCharges = Math.min(50, (inv.bonusCharges || 0) + def.charges);
      this.scheduleSave();
      return { item: def, inventory: this.getInventory(userKey) };
    }

    if (inv.activeBoost) {
      throw new Error(`Un boost (${LOOTBOX_ITEMS[inv.activeBoost.type]?.name || inv.activeBoost.type}) est déjà actif !`);
    }

    inv.items[itemId]--;
    if (itemId === 'frenzy') {
      inv.activeBoost = { type: 'frenzy', expiresAt: now + def.durationMs };
    } else if (itemId === 'rainbow') {
      inv.activeBoost = { type: 'rainbow', expiresAt: now + def.durationMs, lastPlaceAt: 0, rainbowStep: 0 };
    } else if (itemId === 'bomb') {
      inv.activeBoost = { type: 'bomb', remainingUses: 1 };
    } else if (itemId === 'brush3') {
      inv.activeBoost = { type: 'brush3', remainingUses: def.uses };
    } else if (itemId === 'shield') {
      inv.activeBoost = { type: 'shield', remainingUses: 1 };
    }

    this.scheduleSave();
    return { item: def, inventory: this.getInventory(userKey) };
  }

  pruneExpiredShields(now = Date.now()) {
    const before = this.shields.length;
    this.shields = this.shields.filter((s) => s.expiresAt > now);
    return this.shields.length !== before;
  }

  getActiveShields(now = Date.now()) {
    this.pruneExpiredShields(now);
    return this.shields.map((s) => ({
      id: s.id,
      x: s.x,
      y: s.y,
      radius: s.radius,
      ownerName: s.ownerName,
      expiresAt: s.expiresAt,
    }));
  }

  findBlockingShield(x, y, userKey, now = Date.now()) {
    this.pruneExpiredShields(now);
    for (const s of this.shields) {
      if (s.ownerKey === userKey) continue;
      if (Math.abs(x - s.x) <= s.radius && Math.abs(y - s.y) <= s.radius) {
        return s;
      }
    }
    return null;
  }

  // ─────────────────────────── Cooldown & Placement ───────────────────────────
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
    const userKey = this.getUserKey(clientId, authentikUid);
    const inv = this.inventories.get(userKey);
    if (inv) this._cleanupActiveBoost(inv, now);
    const bonusCharges = inv?.bonusCharges || 0;
    const activeBoost = inv?.activeBoost || null;

    const maxC = this.config.maxCharges;
    const cd = this.config.cooldownMs;

    if (isAdminBypass || (activeBoost && activeBoost.type === 'frenzy') || cd <= 0) {
      return { charges: maxC, maxCharges: maxC, bonusCharges, nextRefillMs: 0, cooldownMs: 0, activeBoost };
    }

    if (activeBoost && activeBoost.type === 'rainbow') {
      const rCd = LOOTBOX_ITEMS.rainbow.cooldownMs;
      const wait = Math.max(0, rCd - (now - (activeBoost.lastPlaceAt || 0)));
      return {
        charges: wait === 0 ? 1 : 0,
        maxCharges: 1,
        bonusCharges,
        nextRefillMs: wait,
        cooldownMs: rCd,
        activeBoost,
      };
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
      bonusCharges,
      nextRefillMs: minCharges > 0 ? (minCharges < maxC ? maxWaitMs : 0) : maxWaitMs,
      cooldownMs: cd,
      activeBoost,
    };
  }

  placePixel({ x, y, color, clientId, authentikUid = '', nickname = '', isAdminBypass = false }) {
    const now = Date.now();
    const cleanNick = sanitizeNickname(nickname);
    const userKey = this.getUserKey(clientId, authentikUid);

    if (
      !isAdminBypass &&
      (this.bannedSet.has(clientId) ||
        (authentikUid && this.bannedSet.has(`ak:${authentikUid}`)) ||
        (authentikUid && this.bannedSet.has(authentikUid)) ||
        (cleanNick && this.bannedSet.has(`nick:${cleanNick.toLowerCase()}`)))
    ) {
      return { ok: false, code: 'BANNED', message: 'Vous avez été restreint par un administrateur.' };
    }

    if (!isAdminBypass && this.isEffectivelyPaused(now)) {
      if (this.config.lockBeforeStart && this.isBeforeStart(now)) {
        return { ok: false, code: 'NOT_STARTED', message: 'La Pixel War n\'a pas encore démarré !' };
      }
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

    let inv = this.inventories.get(userKey);
    if (inv) this._cleanupActiveBoost(inv, now);
    const activeBoost = !isAdminBypass && inv ? inv.activeBoost : null;

    // Anti-flood per session (generous limit so Frenzy + Drag Paint works super smoothly!)
    if (!isAdminBypass) {
      const limitPerSec = activeBoost?.type === 'frenzy' ? 120 : 40;
      let guard = this.sessionFloodGuard.get(userKey);
      if (!guard || now - guard.winStart > 1000) {
        guard = { winStart: now, count: 0 };
        this.sessionFloodGuard.set(userKey, guard);
      }
      if (guard.count >= limitPerSec) {
        return { ok: false, code: 'RATE_LIMIT', message: 'Trop de requêtes rapides sur cette session.' };
      }
      guard.count++;
    }

    // ─── Special Boost: Paint Bomb (organic splatter radius 4) ───
    if (activeBoost && activeBoost.type === 'bomb') {
      const r = LOOTBOX_ITEMS.bomb.radius;
      const targets = [];
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const px = x + dx;
          const py = y + dy;
          if (px < 0 || px >= this.config.width || py < 0 || py >= this.config.height) continue;
          const dist = Math.hypot(dx, dy);
          if (dist > r + 0.3) continue;
          // Core guaranteed + organic paint splatter outer edge
          if (dist <= 2.2 || (dist <= r && ((Math.abs(dx * 7 + dy * 13 + x + y) + crypto.randomInt(0, 10)) % 10 < 5))) {
            if (!this.findBlockingShield(px, py, userKey, now)) {
              targets.push({ x: px, y: py, c: color });
            }
          }
        }
      }
      inv.activeBoost.remainingUses--;
      this._cleanupActiveBoost(inv, now);
      const placed = this._commitPixels(targets, cleanNick, now);
      return {
        ok: true,
        pixels: placed,
        effect: { type: 'bomb', x, y, color, author: cleanNick },
        cooldown: this.getCooldownStatus(clientId, authentikUid, false),
        inventory: this.getInventory(userKey),
        totalPixelsPlaced: this.totalPixelsPlaced,
      };
    }

    // ─── Special Boost: 3x3 Brush ───
    if (activeBoost && activeBoost.type === 'brush3') {
      const targets = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const px = x + dx;
          const py = y + dy;
          if (px < 0 || px >= this.config.width || py < 0 || py >= this.config.height) continue;
          if (!this.findBlockingShield(px, py, userKey, now)) {
            targets.push({ x: px, y: py, c: color });
          }
        }
      }
      inv.activeBoost.remainingUses--;
      this._cleanupActiveBoost(inv, now);
      const placed = this._commitPixels(targets, cleanNick, now);
      return {
        ok: true,
        pixels: placed,
        effect: { type: 'brush3', x, y, color, author: cleanNick },
        cooldown: this.getCooldownStatus(clientId, authentikUid, false),
        inventory: this.getInventory(userKey),
        totalPixelsPlaced: this.totalPixelsPlaced,
      };
    }

    // ─── Special Boost: 5x5 Shield (2 min) ───
    if (activeBoost && activeBoost.type === 'shield') {
      const shieldDef = LOOTBOX_ITEMS.shield;
      const newShield = {
        id: crypto.randomBytes(4).toString('hex'),
        x,
        y,
        radius: shieldDef.radius,
        ownerKey: userKey,
        ownerName: cleanNick || 'Joueur',
        expiresAt: now + shieldDef.durationMs,
      };
      this.shields.push(newShield);
      if (this.shields.length > 30) this.shields.shift();
      inv.activeBoost.remainingUses--;
      this._cleanupActiveBoost(inv, now);
      const placed = this._commitPixels([{ x, y, c: color }], cleanNick, now);
      return {
        ok: true,
        pixels: placed,
        shieldsUpdated: true,
        effect: { type: 'shield', x, y, author: cleanNick },
        cooldown: this.getCooldownStatus(clientId, authentikUid, false),
        inventory: this.getInventory(userKey),
        totalPixelsPlaced: this.totalPixelsPlaced,
      };
    }

    // Check shield protection for single pixel
    if (!isAdminBypass) {
      const blocker = this.findBlockingShield(x, y, userKey, now);
      if (blocker) {
        return {
          ok: false,
          code: 'SHIELDED',
          message: `🛡️ Zone protégée par le bouclier de ${blocker.ownerName} !`,
        };
      }
    }

    // Resolve color for Rainbow boost
    let finalColor = color;
    if (activeBoost && activeBoost.type === 'rainbow') {
      const vividIndices = [];
      for (let i = 0; i < this.config.palette.length; i++) {
        const hex = this.config.palette[i];
        if (!['#FFFFFF', '#000000', '#D4D7D9', '#898D90', '#515252'].includes(hex)) {
          vividIndices.push(i);
        }
      }
      const pool = vividIndices.length >= 3 ? vividIndices : this.config.palette.map((_, i) => i);
      finalColor = pool[activeBoost.rainbowStep % pool.length];
      activeBoost.rainbowStep++;
    }

    const idx = y * this.config.width + x;
    if (!isAdminBypass && !this.config.allowSameColor && this.pixels[idx] === finalColor && !(activeBoost && activeBoost.type === 'frenzy')) {
      return { ok: false, code: 'SAME_COLOR', message: 'Ce pixel a déjà cette couleur.' };
    }

    // Check & consume cooldown (skip for adminBypass or Frenzy)
    const isFrenzy = Boolean(activeBoost && activeBoost.type === 'frenzy');
    const isRainbow = Boolean(activeBoost && activeBoost.type === 'rainbow');

    if (!isAdminBypass && !isFrenzy) {
      if (isRainbow) {
        const rCd = LOOTBOX_ITEMS.rainbow.cooldownMs;
        const wait = Math.max(0, rCd - (now - (activeBoost.lastPlaceAt || 0)));
        if (wait > 0) {
          return {
            ok: false,
            code: 'COOLDOWN',
            message: 'Arc-en-ciel en recharge...',
            retryAfterMs: wait,
            cooldown: this.getCooldownStatus(clientId, authentikUid, false),
          };
        }
        activeBoost.lastPlaceAt = now;
      } else if (this.config.cooldownMs > 0) {
        const status = this.getCooldownStatus(clientId, authentikUid, false);
        if (status.charges > 0) {
          const keys = this._getBucketKeys(clientId, authentikUid);
          for (const key of keys) {
            const bucket = this.cooldownBuckets.get(key);
            if (bucket) {
              if (bucket.charges === this.config.maxCharges) bucket.lastRefill = now;
              bucket.charges = Math.max(0, bucket.charges - 1);
            }
          }
        } else if (inv && inv.bonusCharges > 0) {
          inv.bonusCharges--;
        } else {
          return {
            ok: false,
            code: 'COOLDOWN',
            message: 'Cooldown en cours !',
            retryAfterMs: status.nextRefillMs,
            cooldown: status,
          };
        }
      }
    }

    const placed = this._commitPixels([{ x, y, c: finalColor }], cleanNick, now);
    const cooldown = this.getCooldownStatus(clientId, authentikUid, isAdminBypass);
    return {
      ok: true,
      pixel: { x, y, color: finalColor, author: cleanNick, timestamp: Math.floor(now / 1000) },
      pixels: placed,
      cooldown,
      inventory: inv ? this.getInventory(userKey) : null,
      totalPixelsPlaced: this.totalPixelsPlaced,
    };
  }

  _commitPixels(updates, author, now) {
    const tsSec = Math.floor(now / 1000);
    const authorIdx = this._getAuthorIndex(author);
    const applied = [];

    for (const u of updates) {
      const px = u.x | 0;
      const py = u.y | 0;
      const pc = u.c | 0;
      if (px < 0 || px >= this.config.width || py < 0 || py >= this.config.height) continue;
      if (pc < 0 || pc >= this.config.palette.length) continue;
      const idx = py * this.config.width + px;
      this.pixels[idx] = pc;
      this.pixelTimestamps[idx] = tsSec;
      this.pixelAuthors[idx] = authorIdx;
      applied.push([px, py, pc]);
    }

    if (applied.length > 0) {
      this.totalPixelsPlaced += applied.length;
      if (author) {
        this.authorCounts.set(author, (this.authorCounts.get(author) || 0) + applied.length);
      }
      if (this.isReplayRecordingActive(now)) {
        if (applied.length === 1) {
          this._appendHistory({ t: now, x: applied[0][0], y: applied[0][1], c: applied[0][2], a: author || undefined });
        } else {
          this._appendHistory({ t: now, batch: applied, a: author || undefined });
        }
      }
      this.scheduleSave();
    }
    return applied;
  }

  applyBatchPixels(updates, author = 'Admin') {
    const applied = this._commitPixels(updates, sanitizeNickname(author), Date.now());
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
    let lootboxScheduleChanged = false;

    if (typeof patch.title === 'string') {
      this.config.title = patch.title.trim().slice(0, 80) || 'Pixel War';
    }
    if (typeof patch.subtitle === 'string') {
      this.config.subtitle = patch.subtitle.trim().slice(0, 140);
    }
    if (typeof patch.announcement === 'string') {
      this.config.announcement = patch.announcement.trim().slice(0, 240);
    }
    if (typeof patch.paused === 'boolean') this.config.paused = patch.paused;
    if (typeof patch.allowSameColor === 'boolean') this.config.allowSameColor = patch.allowSameColor;
    if (typeof patch.allowPublicExport === 'boolean') this.config.allowPublicExport = patch.allowPublicExport;
    if (typeof patch.allowTimelapse === 'boolean') this.config.allowTimelapse = patch.allowTimelapse;
    if (typeof patch.requireNickname === 'boolean') this.config.requireNickname = patch.requireNickname;
    if (typeof patch.lockNicknameToAuthentik === 'boolean') this.config.lockNicknameToAuthentik = patch.lockNicknameToAuthentik;
    if (typeof patch.lockBeforeStart === 'boolean') this.config.lockBeforeStart = patch.lockBeforeStart;

    if (patch.startTime === null || patch.startTime === '') {
      this.config.startTime = null;
    } else if (typeof patch.startTime === 'string' && !Number.isNaN(Date.parse(patch.startTime))) {
      this.config.startTime = new Date(patch.startTime).toISOString();
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

    if (typeof patch.maxAutoSnapshots === 'number' && Number.isFinite(patch.maxAutoSnapshots)) {
      this.config.maxAutoSnapshots = clampInt(patch.maxAutoSnapshots, 0, 500);
      this._pruneAutoSnapshots();
    }

    if (typeof patch.lootboxEnabled === 'boolean' && patch.lootboxEnabled !== this.config.lootboxEnabled) {
      this.config.lootboxEnabled = patch.lootboxEnabled;
      lootboxScheduleChanged = true;
    }

    if (typeof patch.lootboxIntervalMinutes === 'number' && Number.isFinite(patch.lootboxIntervalMinutes)) {
      const nextInt = clampInt(patch.lootboxIntervalMinutes, 1, 1440);
      if (nextInt !== this.config.lootboxIntervalMinutes) {
        this.config.lootboxIntervalMinutes = nextInt;
        lootboxScheduleChanged = true;
      }
    }

    if (Array.isArray(patch.palette)) {
      const cleanPalette = patch.palette
        .map((c) => (typeof c === 'string' ? c.trim().toUpperCase() : ''))
        .filter((c) => HEX_RE.test(c))
        .slice(0, 64);
      if (cleanPalette.length >= 2) {
        this.config.palette = cleanPalette;
        paletteChanged = true;
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
    return { config: this.getPublicConfig(), canvasResized, paletteChanged, cooldownChanged, lootboxScheduleChanged };
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

    if (this.isReplayRecordingActive()) {
      this._appendHistory({ t: Date.now(), resize: { w: newW, h: newH, anchor, fill } });
    }
    this.scheduleSave();
  }

  clearCanvas(fillColor = 0, resetStats = false) {
    if (this.totalPixelsPlaced > 0) {
      try {
        this.createSnapshot('pre-reset');
      } catch {
        // ignore
      }
    }
    const fill = clampInt(fillColor, 0, this.config.palette.length - 1);
    this.pixels.fill(fill);
    this.pixelTimestamps.fill(0);
    this.pixelAuthors.fill(0);
    this.shields = [];

    if (resetStats) {
      this.totalPixelsPlaced = 0;
      this.authorCounts.clear();
      this.authorList = [''];
      this.authorIndexMap = new Map([['', 0]]);
      this.replayBaselineMeta = null;
      try {
        if (fs.existsSync(this.baselinePath)) fs.unlinkSync(this.baselinePath);
        fs.writeFileSync(this.historyPath, '');
        this.historyCount = 0;
      } catch {
        // ignore
      }
    } else if (this.isReplayRecordingActive()) {
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
        list.push(JSON.parse(fs.readFileSync(path.join(this.snapshotsDir, f), 'utf8')));
      } catch {
        // skip
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
    if (!/^[a-zA-Z0-9._-]+$/.test(safeId)) throw new Error('Identifiant de snapshot invalide.');
    const metaPath = path.join(this.snapshotsDir, `${safeId}.json`);
    const binPath = path.join(this.snapshotsDir, `${safeId}.bin`);
    if (!fs.existsSync(metaPath) || !fs.existsSync(binPath)) throw new Error('Snapshot introuvable.');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const buf = fs.readFileSync(binPath);
    const expected = meta.width * meta.height;
    if (buf.length !== expected) throw new Error('Données snapshot corrompues.');
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
      // ignore
    }
  }

  readHistory(maxEvents = 100000) {
    const startMs = this.config.startTime ? Date.parse(this.config.startTime) : NaN;
    let baselineBase64 = null;
    if (
      this.replayBaselineMeta &&
      this.replayBaselineMeta.width === this.config.width &&
      this.replayBaselineMeta.height === this.config.height &&
      fs.existsSync(this.baselinePath)
    ) {
      try {
        const b = fs.readFileSync(this.baselinePath);
        if (b.length === this.config.width * this.config.height) {
          baselineBase64 = b.toString('base64');
        }
      } catch {
        // ignore
      }
    }

    if (!fs.existsSync(this.historyPath)) {
      return { events: [], baselineBase64, startTime: this.config.startTime };
    }
    const raw = fs.readFileSync(this.historyPath, 'utf8');
    if (!raw) return { events: [], baselineBase64, startTime: this.config.startTime };
    const lines = raw.split('\n').filter(Boolean);
    const slice = lines.length > maxEvents ? lines.slice(lines.length - maxEvents) : lines;
    const events = [];
    for (const line of slice) {
      try {
        const ev = JSON.parse(line);
        if (!Number.isNaN(startMs) && typeof ev.t === 'number' && ev.t < startMs) continue;
        events.push(ev);
      } catch {
        // skip
      }
    }
    return { events, baselineBase64, startTime: this.config.startTime };
  }

  banTarget(target) {
    const clean = String(target || '').trim();
    if (!clean || /^(\d{1,3}\.){3}\d{1,3}$/.test(clean) || clean === '::1') {
      throw new Error('Le bannissement par IP est désactivé sur l\'infra MINITEL (IP partagée par le VPS). Utilisez un identifiant de session ou un compte Authentik.');
    }
    this.bannedSet.add(clean);
    this.scheduleSave();
  }

  unbanTarget(target) {
    const clean = String(target || '').trim();
    if (this.bannedSet.delete(clean)) this.scheduleSave();
  }

  addExtraAdmin(username) {
    const norm = normalizeUsername(username);
    if (!norm) throw new Error('Identifiant utilisateur Authentik invalide.');
    this.extraAdmins.add(norm);
    this.scheduleSave();
    return norm;
  }

  removeExtraAdmin(username) {
    const norm = normalizeUsername(username);
    if (norm && this.extraAdmins.delete(norm)) {
      this.scheduleSave();
      return true;
    }
    return false;
  }

  hasExtraAdmin(username) {
    const norm = normalizeUsername(username);
    return Boolean(norm && this.extraAdmins.has(norm));
  }

  listExtraAdmins() {
    return Array.from(this.extraAdmins).sort();
  }

  destroy() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    if (this._snapshotTimer) clearInterval(this._snapshotTimer);
    this._dirty = true;
    this.saveNow();
  }
}

function normalizeInventory(inv) {
  const baseItems = {};
  for (const key of Object.keys(LOOTBOX_ITEMS)) {
    baseItems[key] = Math.max(0, parseInt(inv?.items?.[key] || 0, 10) || 0);
  }
  return {
    lootboxes: Math.max(0, parseInt(inv?.lootboxes || 0, 10) || 0),
    items: baseItems,
    activeBoost: inv?.activeBoost || null,
    bonusCharges: Math.max(0, parseInt(inv?.bonusCharges || 0, 10) || 0),
  };
}

function clampInt(val, min, max) {
  const n = Math.round(Number(val));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function validateCooldownMode(mode) {
  return ['client', 'authentik'].includes(mode) ? mode : 'authentik';
}

function sanitizeNickname(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/[\r\n\t<>]/g, '').trim().slice(0, 24);
}

function normalizeUsername(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/[\r\n\t<>\s]/g, '').trim().toLowerCase().slice(0, 64);
}

module.exports = { PixelWarStore, PALETTE_PRESETS, LOOTBOX_ITEMS, sanitizeNickname, normalizeUsername };
