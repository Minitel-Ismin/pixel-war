'use strict';

(() => {
  const viewport = document.getElementById('viewport');
  const ctx = viewport.getContext('2d', { alpha: false });

  const el = {
    connDot: document.getElementById('connDot'),
    eventTitle: document.getElementById('eventTitle'),
    onlineBadge: document.getElementById('onlineBadge'),
    canvasSizeBadge: document.getElementById('canvasSizeBadge'),
    pausedBadge: document.getElementById('pausedBadge'),
    startBadge: document.getElementById('startBadge'),
    countdownBadge: document.getElementById('countdownBadge'),
    announcementBar: document.getElementById('announcementBar'),
    announcementText: document.getElementById('announcementText'),
    nickLabel: document.getElementById('nickLabel'),
    coordText: document.getElementById('coordText'),
    pixelColorSwatch: document.getElementById('pixelColorSwatch'),
    pixelAuthorText: document.getElementById('pixelAuthorText'),
    btnPlace: document.getElementById('btnPlace'),
    placeProgress: document.getElementById('placeProgress'),
    selectedSwatch: document.getElementById('selectedSwatch'),
    placeBtnText: document.getElementById('placeBtnText'),
    chargesBadge: document.getElementById('chargesBadge'),
    paletteBar: document.getElementById('paletteBar'),
    toastContainer: document.getElementById('toastContainer'),
    adminQuickBar: document.getElementById('adminQuickBar'),
    btnAdminBypass: document.getElementById('btnAdminBypass'),
    btnBrushSize: document.getElementById('btnBrushSize'),
    btnBrushShape: document.getElementById('btnBrushShape'),
    btnDragPaint: document.getElementById('btnDragPaint'),
    btnLootbox: document.getElementById('btnLootbox'),
    lootBadge: document.getElementById('lootBadge'),
    activeBoostBar: document.getElementById('activeBoostBar'),
    activeBoostText: document.getElementById('activeBoostText'),
  };

  const state = {
    config: {
      title: 'Pixel War',
      width: 128,
      height: 128,
      cooldownMs: 5000,
      maxCharges: 1,
      cooldownMode: 'authentik',
      paused: false,
      manualPaused: false,
      beforeStart: false,
      replayRecording: true,
      allowSameColor: false,
      allowPublicExport: true,
      allowTimelapse: true,
      requireNickname: false,
      lockNicknameToAuthentik: false,
      announcement: '',
      startTime: null,
      lockBeforeStart: false,
      endTime: null,
      autoSnapshotMinutes: 15,
      maxAutoSnapshots: 48,
      nextAutoSnapshotAt: null,
      lootboxEnabled: true,
      lootboxIntervalMinutes: 60,
      palette: ['#FFFFFF', '#000000'],
      totalPixelsPlaced: 0,
    },
    presets: {},
    lootboxItems: {},
    nextLootboxDropAt: null,
    inventory: { lootboxes: 0, items: {}, activeBoost: null, bonusCharges: 0 },
    shields: [],
    paletteRgba: [],
    pixels: new Uint8Array(128 * 128),
    selectedColor: 1,
    selectedPixel: null,
    hoverPixel: null,
    online: 0,
    isAdmin: false,
    passwordLoginEnabled: false,
    authentikUser: null,
    adminToken: sessionStorage.getItem('pw_admin_token') || '',
    adminBypass: false,
    adminBrushSize: 1,
    adminBrushShape: 'square',
    dragPaintMode: false,
    nickname: localStorage.getItem('pw_nickname') || '',
    showGrid: true,
    eyedropperMode: false,
    directPlaceMode: false,
    soundEnabled: false,
    cooldown: {
      charges: 1,
      maxCharges: 1,
      bonusCharges: 0,
      nextRefillAt: 0,
      cooldownMs: 5000,
      activeBoost: null,
    },
    serverTimeOffset: 0,
    cam: { x: 64, y: 64, zoom: 6, minZoom: 0.5, maxZoom: 48 },
    pulses: [],
    bombFx: [],
    overlay: { img: null, visible: true, x: 0, y: 0, w: 32, opacity: 0.5 },
    offscreen: document.createElement('canvas'),
    offCtx: null,
    offImageData: null,
    needsRender: true,
    ws: null,
    wsConnected: false,
    reconnectDelay: 500,
    audioCtx: null,
    admPaletteDraft: [],
  };

  state.offCtx = state.offscreen.getContext('2d');

  // ─────────────────────────── Utilities ───────────────────────────
  function hexToRgba(hex) {
    const clean = (hex || '#FFFFFF').replace('#', '');
    const n = parseInt(clean, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
  }

  function showToast(msg, type = 'info') {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    el.toastContainer.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transition = 'opacity 0.25s';
      setTimeout(() => t.remove(), 260);
    }, 3200);
  }

  function playPopSound(freq = 520) {
    if (!state.soundEnabled) return;
    try {
      if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = state.audioCtx.createOscillator();
      const gain = state.audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, state.audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.4, state.audioCtx.currentTime + 0.06);
      gain.gain.setValueAtTime(0.08, state.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, state.audioCtx.currentTime + 0.08);
      osc.connect(gain);
      gain.connect(state.audioCtx.destination);
      osc.start();
      osc.stop(state.audioCtx.currentTime + 0.09);
    } catch {
      // ignore
    }
  }

  function formatTimeAgo(tsSec) {
    if (!tsSec) return '';
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - tsSec);
    if (diff < 5) return 'à l\'instant';
    if (diff < 60) return `il y a ${diff}s`;
    if (diff < 3600) return `il y a ${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `il y a ${Math.floor(diff / 3600)}h`;
    return `il y a ${Math.floor(diff / 86400)}j`;
  }

  function formatCountdown(ms) {
    if (ms <= 0) return '00:00';
    const totalSec = Math.ceil(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function toLocalInputValue(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }

  function adminHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (state.adminToken) h['X-Admin-Token'] = state.adminToken;
    return h;
  }

  function getActiveBoost() {
    const b = state.inventory?.activeBoost;
    if (!b) return null;
    const serverNow = Date.now() + state.serverTimeOffset;
    if (b.expiresAt && serverNow >= b.expiresAt) return null;
    if (typeof b.remainingUses === 'number' && b.remainingUses <= 0) return null;
    return b;
  }

  function canDragPaintNow() {
    if (state.isAdmin && state.adminBypass) return true;
    const boost = getActiveBoost();
    if (boost && (boost.type === 'frenzy' || boost.type === 'rainbow')) return true;
    if (state.config.cooldownMs === 0) return true;
    if ((state.cooldown.charges + (state.cooldown.bonusCharges || 0)) > 1) return true;
    return false;
  }

  // ─────────────────────────── Canvas Buffer & Rendering ───────────────────────────
  function rebuildPaletteRgba() {
    state.paletteRgba = state.config.palette.map(hexToRgba);
    if (state.selectedColor >= state.config.palette.length) {
      state.selectedColor = Math.min(1, state.config.palette.length - 1);
    }
  }

  function rebuildOffscreenCanvas() {
    const w = state.config.width;
    const h = state.config.height;
    state.offscreen.width = w;
    state.offscreen.height = h;
    state.offImageData = state.offCtx.createImageData(w, h);
    const data = state.offImageData.data;
    const fallback = state.paletteRgba[0] || [255, 255, 255, 255];
    for (let i = 0; i < state.pixels.length; i++) {
      const rgba = state.paletteRgba[state.pixels[i]] || fallback;
      const p = i * 4;
      data[p] = rgba[0];
      data[p + 1] = rgba[1];
      data[p + 2] = rgba[2];
      data[p + 3] = 255;
    }
    state.offCtx.putImageData(state.offImageData, 0, 0);
    state.needsRender = true;
  }

  function updateSinglePixelBuffer(x, y, colorIdx) {
    const w = state.config.width;
    const h = state.config.height;
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const idx = y * w + x;
    state.pixels[idx] = colorIdx;
    if (!state.offImageData) return;
    const rgba = state.paletteRgba[colorIdx] || [255, 255, 255, 255];
    const p = idx * 4;
    state.offImageData.data[p] = rgba[0];
    state.offImageData.data[p + 1] = rgba[1];
    state.offImageData.data[p + 2] = rgba[2];
    state.offImageData.data[p + 3] = 255;
    state.offCtx.putImageData(state.offImageData, 0, 0, x, y, 1, 1);
    state.pulses.push({ x, y, start: performance.now() });
    if (state.pulses.length > 80) state.pulses.shift();
    state.needsRender = true;
  }

  function resizeViewport() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    viewport.width = Math.floor(window.innerWidth * dpr);
    viewport.height = Math.floor(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.needsRender = true;
  }

  function centerCamera() {
    const w = state.config.width;
    const h = state.config.height;
    state.cam.x = w / 2;
    state.cam.y = h / 2;
    const availW = window.innerWidth * 0.84;
    const availH = (window.innerHeight - 210) * 0.84;
    state.cam.zoom = Math.max(0.8, Math.min(20, Math.min(availW / w, availH / h)));
    state.needsRender = true;
  }

  function screenToWorld(clientX, clientY) {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const wx = state.cam.x + (clientX - cx) / state.cam.zoom;
    const wy = state.cam.y + (clientY - cy) / state.cam.zoom;
    return { wx, wy, px: Math.floor(wx), py: Math.floor(wy) };
  }

  function worldToScreen(wx, wy) {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    return {
      sx: cx + (wx - state.cam.x) * state.cam.zoom,
      sy: cy + (wy - state.cam.y) * state.cam.zoom,
    };
  }

  function zoomAt(screenX, screenY, factor) {
    const before = screenToWorld(screenX, screenY);
    const nextZoom = Math.max(state.cam.minZoom, Math.min(state.cam.maxZoom, state.cam.zoom * factor));
    state.cam.zoom = nextZoom;
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    state.cam.x = before.wx - (screenX - cx) / nextZoom;
    state.cam.y = before.wy - (screenY - cy) / nextZoom;
    clampCamera();
    state.needsRender = true;
  }

  function clampCamera() {
    const margin = 40;
    state.cam.x = Math.max(-margin, Math.min(state.config.width + margin, state.cam.x));
    state.cam.y = Math.max(-margin, Math.min(state.config.height + margin, state.cam.y));
  }

  function renderFrame(now) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const hasAnim = state.pulses.length > 0 || state.bombFx.length > 0 || state.shields.length > 0;

    if (state.needsRender || hasAnim) {
      state.needsRender = false;
      ctx.fillStyle = '#090d16';
      ctx.fillRect(0, 0, vw, vh);

      const tl = worldToScreen(0, 0);
      const drawW = state.config.width * state.cam.zoom;
      const drawH = state.config.height * state.cam.zoom;

      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(tl.sx - 3, tl.sy - 3, drawW + 6, drawH + 6);

      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(state.offscreen, tl.sx, tl.sy, drawW, drawH);

      if (state.overlay.img && state.overlay.visible) {
        const aspect = state.overlay.img.height / Math.max(1, state.overlay.img.width);
        const ow = state.overlay.w * state.cam.zoom;
        const oh = Math.round(state.overlay.w * aspect) * state.cam.zoom;
        const opos = worldToScreen(state.overlay.x, state.overlay.y);
        ctx.save();
        ctx.globalAlpha = state.overlay.opacity;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(state.overlay.img, opos.sx, opos.sy, ow, oh);
        ctx.restore();
      }

      if (state.showGrid && state.cam.zoom >= 6) {
        const startX = Math.max(0, Math.floor(screenToWorld(0, 0).wx));
        const endX = Math.min(state.config.width, Math.ceil(screenToWorld(vw, 0).wx));
        const startY = Math.max(0, Math.floor(screenToWorld(0, 0).wy));
        const endY = Math.min(state.config.height, Math.ceil(screenToWorld(0, vh).wy));

        ctx.strokeStyle = state.cam.zoom >= 14 ? 'rgba(15, 23, 42, 0.22)' : 'rgba(15, 23, 42, 0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = startX; x <= endX; x++) {
          const sx = Math.round(tl.sx + x * state.cam.zoom) + 0.5;
          ctx.moveTo(sx, Math.max(tl.sy, 0));
          ctx.lineTo(sx, Math.min(tl.sy + drawH, vh));
        }
        for (let y = startY; y <= endY; y++) {
          const sy = Math.round(tl.sy + y * state.cam.zoom) + 0.5;
          ctx.moveTo(Math.max(tl.sx, 0), sy);
          ctx.lineTo(Math.min(tl.sx + drawW, vw), sy);
        }
        ctx.stroke();
      }

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(tl.sx, tl.sy, drawW, drawH);

      // Active Shield Zones (5x5 golden aura)
      const serverNow = Date.now() + state.serverTimeOffset;
      for (const sh of state.shields) {
        if (sh.expiresAt <= serverNow) continue;
        const pos = worldToScreen(sh.x - sh.radius, sh.y - sh.radius);
        const sz = (sh.radius * 2 + 1) * state.cam.zoom;
        ctx.save();
        ctx.fillStyle = 'rgba(251, 191, 36, 0.14)';
        ctx.fillRect(pos.sx, pos.sy, sz, sz);
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.9)';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(pos.sx, pos.sy, sz, sz);
        ctx.restore();
      }

      // Paint Bomb shockwave FX
      for (let i = state.bombFx.length - 1; i >= 0; i--) {
        const fx = state.bombFx[i];
        const t = (now - fx.start) / 650;
        if (t >= 1) {
          state.bombFx.splice(i, 1);
          continue;
        }
        const cPos = worldToScreen(fx.x + 0.5, fx.y + 0.5);
        const r = (1 + t * 5.2) * state.cam.zoom;
        ctx.save();
        ctx.beginPath();
        ctx.arc(cPos.sx, cPos.sy, r, 0, Math.PI * 2);
        ctx.strokeStyle = fx.colorHex || '#fbbf24';
        ctx.globalAlpha = (1 - t) * 0.9;
        ctx.lineWidth = Math.max(2, 5 * (1 - t));
        ctx.stroke();
        ctx.restore();
      }

      // Pixel placement ripples
      for (let i = state.pulses.length - 1; i >= 0; i--) {
        const p = state.pulses[i];
        const t = (now - p.start) / 380;
        if (t >= 1) {
          state.pulses.splice(i, 1);
          continue;
        }
        const pos = worldToScreen(p.x, p.y);
        const expand = t * Math.max(5, state.cam.zoom * 0.6);
        ctx.strokeStyle = `rgba(255, 255, 255, ${(1 - t) * 0.75})`;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(pos.sx - expand / 2, pos.sy - expand / 2, state.cam.zoom + expand, state.cam.zoom + expand);
      }

      // Hover highlight
      if (state.hoverPixel) {
        const { x, y } = state.hoverPixel;
        if (x >= 0 && x < state.config.width && y >= 0 && y < state.config.height) {
          const pos = worldToScreen(x, y);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(pos.sx + 0.5, pos.sy + 0.5, state.cam.zoom - 1, state.cam.zoom - 1);
        }
      }

      // Selected pixel / Boost / Wide Brush preview reticle
      if (state.selectedPixel) {
        const { x, y } = state.selectedPixel;
        const boost = !state.adminBypass ? getActiveBoost() : null;
        let brush = state.isAdmin && state.adminBypass ? state.adminBrushSize : 1;
        let shape = state.isAdmin && state.adminBypass ? state.adminBrushShape : 'square';

        if (boost?.type === 'brush3') { brush = 3; shape = 'square'; }
        else if (boost?.type === 'shield') { brush = 5; shape = 'square'; }
        else if (boost?.type === 'bomb') { brush = 9; shape = 'circle'; }

        const half = Math.floor(brush / 2);
        const pos = worldToScreen(x - half, y - half);
        const size = state.cam.zoom * brush;

        ctx.save();
        if (shape === 'circle' && brush > 1) {
          const cPos = worldToScreen(x + 0.5, y + 0.5);
          const rad = (brush / 2) * state.cam.zoom;
          ctx.beginPath();
          ctx.arc(cPos.sx, cPos.sy, rad, 0, Math.PI * 2);
          ctx.fillStyle = state.config.palette[state.selectedColor] || '#fff';
          ctx.globalAlpha = 0.35;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.strokeStyle = boost?.type === 'bomb' ? '#fbbf24' : '#fff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        } else {
          ctx.globalAlpha = boost?.type === 'shield' ? 0.25 : 0.5;
          ctx.fillStyle = boost?.type === 'shield' ? '#fbbf24' : (state.config.palette[state.selectedColor] || '#fff');
          ctx.fillRect(pos.sx + 1, pos.sy + 1, Math.max(1, size - 2), Math.max(1, size - 2));
          ctx.globalAlpha = 1;
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 3;
          ctx.strokeRect(pos.sx - 1, pos.sy - 1, size + 2, size + 2);
          ctx.strokeStyle = boost?.type === 'shield' ? '#fbbf24' : '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(pos.sx - 1, pos.sy - 1, size + 2, size + 2);
        }
        ctx.restore();
      }
    }

    updateCooldownUI(now);
    requestAnimationFrame(renderFrame);
  }

  // ─────────────────────────── Cooldown, Boost & HUD Updates ───────────────────────────
  function syncCooldownFromServer(cd) {
    if (!cd) return;
    state.cooldown.charges = cd.charges ?? 1;
    state.cooldown.maxCharges = cd.maxCharges ?? state.config.maxCharges;
    state.cooldown.bonusCharges = cd.bonusCharges ?? state.inventory?.bonusCharges ?? 0;
    state.cooldown.cooldownMs = cd.cooldownMs ?? state.config.cooldownMs;
    state.cooldown.activeBoost = cd.activeBoost || null;
    state.cooldown.nextRefillAt = cd.nextRefillMs > 0 ? performance.now() + cd.nextRefillMs : 0;
  }

  function syncInventory(inv) {
    if (!inv) return;
    state.inventory = inv;
    state.cooldown.bonusCharges = inv.bonusCharges || 0;
    const totalOwned = (inv.lootboxes || 0) + Object.values(inv.items || {}).reduce((s, n) => s + (n || 0), 0);
    el.lootBadge.textContent = String(totalOwned);
    el.lootBadge.classList.toggle('hidden', totalOwned === 0);
    el.btnLootbox.classList.toggle('has-loot', (inv.lootboxes || 0) > 0);
    renderLootboxModal();
    state.needsRender = true;
  }

  function updateCooldownUI(now) {
    const cd = state.cooldown;
    if (cd.charges < cd.maxCharges && cd.cooldownMs > 0 && cd.nextRefillAt > 0) {
      while (now >= cd.nextRefillAt && cd.charges < cd.maxCharges) {
        cd.charges++;
        cd.nextRefillAt = cd.charges < cd.maxCharges ? cd.nextRefillAt + cd.cooldownMs : 0;
      }
    }

    const serverNow = Date.now() + state.serverTimeOffset;

    // Start countdown badge (before official startTime)
    if (state.config.startTime && serverNow < Date.parse(state.config.startTime)) {
      const remStart = Date.parse(state.config.startTime) - serverNow;
      el.startBadge.classList.remove('hidden');
      el.startBadge.textContent = `⏳ Début ${formatCountdown(remStart)}`;
    } else {
      el.startBadge.classList.add('hidden');
    }

    // End countdown badge
    if (state.config.endTime) {
      const remain = Date.parse(state.config.endTime) - serverNow;
      el.countdownBadge.classList.remove('hidden');
      el.countdownBadge.textContent = remain > 0 ? `⏱ ${formatCountdown(remain)}` : '🏁 Terminé';
    } else {
      el.countdownBadge.classList.add('hidden');
    }

    // Active boost live banner
    const boost = getActiveBoost();
    if (boost) {
      const def = state.lootboxItems[boost.type] || { icon: '✨', name: boost.type };
      let detail = '';
      if (boost.expiresAt) {
        const remS = Math.max(0, (boost.expiresAt - serverNow) / 1000).toFixed(1);
        detail = ` — ${remS}s restantes !`;
      } else if (typeof boost.remainingUses === 'number') {
        detail = ` — ${boost.remainingUses} utilisation${boost.remainingUses > 1 ? 's' : ''}`;
      }
      el.activeBoostText.textContent = `${def.icon} ${def.name.toUpperCase()}${detail}`;
      el.activeBoostBar.classList.remove('hidden');
    } else {
      el.activeBoostBar.classList.add('hidden');
    }

    const hex = state.config.palette[state.selectedColor] || '#FFFFFF';
    el.selectedSwatch.style.backgroundColor = hex;

    const totalCharges = cd.charges + (cd.bonusCharges || 0);
    if ((cd.maxCharges > 1 || (cd.bonusCharges || 0) > 0) && !(state.isAdmin && state.adminBypass)) {
      el.chargesBadge.classList.remove('hidden');
      el.chargesBadge.textContent = cd.bonusCharges > 0
        ? `⚡ ${cd.charges}/${cd.maxCharges} (+${cd.bonusCharges}🎁)`
        : `⚡ ${cd.charges}/${cd.maxCharges}`;
    } else {
      el.chargesBadge.classList.add('hidden');
    }

    const isAdminFree = state.isAdmin && state.adminBypass;
    const isBoostInstant = boost && ['frenzy', 'bomb', 'brush3', 'shield'].includes(boost.type);

    if (state.config.paused && !isAdminFree) {
      el.btnPlace.disabled = true;
      el.btnPlace.classList.remove('cooldown');
      el.placeProgress.style.width = '0%';
      el.placeBtnText.textContent = state.config.beforeStart && state.config.lockBeforeStart
        ? '⏳ En attente du top départ'
        : '⏸ Canvas figé';
      return;
    }

    if (!isAdminFree && !isBoostInstant && totalCharges <= 0 && cd.cooldownMs > 0) {
      const rem = Math.max(0, cd.nextRefillAt - now);
      const pct = Math.max(0, Math.min(100, ((cd.cooldownMs - rem) / cd.cooldownMs) * 100));
      el.btnPlace.disabled = true;
      el.btnPlace.classList.add('cooldown');
      el.placeProgress.style.width = `${pct}%`;
      el.placeBtnText.textContent = `Attendez ${(rem / 1000).toFixed(1)}s`;
      return;
    }

    el.btnPlace.classList.remove('cooldown');
    el.placeProgress.style.width = '0%';

    if (!state.selectedPixel) {
      el.btnPlace.disabled = true;
      el.placeBtnText.textContent = state.dragPaintMode ? '🖌️ Glissez pour peindre !' : 'Touchez un pixel sur le canvas';
      return;
    }

    el.btnPlace.disabled = false;
    const { x, y } = state.selectedPixel;
    if (isAdminFree) {
      el.placeBtnText.textContent = `👑 Poser Admin ${state.adminBrushSize}× (${x}, ${y})`;
    } else if (boost?.type === 'bomb') {
      el.placeBtnText.textContent = `💣 Lancer la Bombe (${x}, ${y})`;
    } else if (boost?.type === 'brush3') {
      el.placeBtnText.textContent = `🖌️ Peindre 3×3 (${x}, ${y})`;
    } else if (boost?.type === 'shield') {
      el.placeBtnText.textContent = `🛡️ Poser Bouclier 5×5 (${x}, ${y})`;
    } else if (boost?.type === 'frenzy') {
      el.placeBtnText.textContent = `⚡ Poser Frénésie (${x}, ${y})`;
    } else {
      el.placeBtnText.textContent = `Poser le pixel (${x}, ${y})`;
    }
  }

  function applyConfigUI() {
    document.title = state.config.title;
    el.eventTitle.textContent = state.config.title;
    el.canvasSizeBadge.textContent = `${state.config.width}×${state.config.height}`;
    el.pausedBadge.classList.toggle('hidden', !state.config.paused);

    if (state.config.announcement) {
      el.announcementText.textContent = state.config.announcement;
      el.announcementBar.classList.remove('hidden');
    } else {
      el.announcementBar.classList.add('hidden');
    }

    el.nickLabel.textContent = state.nickname || state.authentikUser?.username || 'Pseudo';
    el.adminQuickBar.classList.toggle('hidden', !state.isAdmin);

    const btnAdmin = document.getElementById('btnAdmin');
    if (btnAdmin) {
      btnAdmin.classList.toggle('hidden', !state.isAdmin && !state.passwordLoginEnabled);
    }
    if (!state.isAdmin) {
      state.adminBypass = false;
      el.btnAdminBypass.classList.remove('active');
    }
    renderPaletteBar();
  }

  function renderPaletteBar() {
    el.paletteBar.innerHTML = '';
    state.config.palette.forEach((hex, idx) => {
      const btn = document.createElement('button');
      btn.className = 'swatch' + (idx === state.selectedColor ? ' selected' : '');
      btn.style.backgroundColor = hex;
      btn.title = `${hex} (#${idx + 1})`;
      btn.setAttribute('aria-label', `Couleur ${hex}`);
      btn.addEventListener('click', () => {
        state.selectedColor = idx;
        state.eyedropperMode = false;
        document.getElementById('btnEyedropper').classList.remove('active');
        renderPaletteBar();
        state.needsRender = true;
      });
      el.paletteBar.appendChild(btn);
    });
  }

  let inspectAbort = null;
  async function inspectPixel(x, y) {
    el.coordText.textContent = `(${x}, ${y})`;
    const idx = y * state.config.width + x;
    const cIdx = state.pixels[idx] ?? 0;
    const hex = state.config.palette[cIdx] || '#FFFFFF';
    el.pixelColorSwatch.style.backgroundColor = hex;
    el.pixelAuthorText.textContent = hex;

    if (inspectAbort) inspectAbort.abort();
    inspectAbort = new AbortController();
    try {
      const r = await fetch(`/api/pixel?x=${x}&y=${y}`, { signal: inspectAbort.signal });
      if (!r.ok) return;
      const info = await r.json();
      if (state.selectedPixel && state.selectedPixel.x === x && state.selectedPixel.y === y) {
        if (info.author) el.pixelAuthorText.textContent = `Par ${info.author} • ${formatTimeAgo(info.timestamp)}`;
        else if (info.timestamp) el.pixelAuthorText.textContent = `Anonyme • ${formatTimeAgo(info.timestamp)}`;
        else el.pixelAuthorText.textContent = 'Pixel vierge';
      }
    } catch {
      // ignore
    }
  }

  // ─────────────────────────── Placement & Drag-Paint (Bresenham) ───────────────────────────
  function sendPlaceAt(x, y) {
    if (!state.wsConnected || !state.ws) return;
    if (x < 0 || x >= state.config.width || y < 0 || y >= state.config.height) return;
    state.ws.send(JSON.stringify({
      type: 'place',
      x,
      y,
      color: state.selectedColor,
      nickname: state.nickname,
      adminBypass: state.isAdmin && state.adminBypass,
      brushSize: state.isAdmin && state.adminBypass ? state.adminBrushSize : 1,
      brushShape: state.isAdmin && state.adminBypass ? state.adminBrushShape : 'square',
    }));
  }

  function selectPixel(x, y, autoPlaceIfDirect = true) {
    if (x < 0 || x >= state.config.width || y < 0 || y >= state.config.height) return;

    if (state.eyedropperMode) {
      const cIdx = state.pixels[y * state.config.width + x];
      state.selectedColor = cIdx;
      state.eyedropperMode = false;
      document.getElementById('btnEyedropper').classList.remove('active');
      renderPaletteBar();
      showToast(`Couleur copiée : ${state.config.palette[cIdx]}`, 'info');
      state.needsRender = true;
      return;
    }

    state.selectedPixel = { x, y };
    state.needsRender = true;
    inspectPixel(x, y);

    if (autoPlaceIfDirect && state.directPlaceMode) {
      placeSelectedPixel();
    }
  }

  function placeSelectedPixel() {
    if (!state.selectedPixel) return;
    if (!state.wsConnected || !state.ws) {
      showToast('Reconnexion au serveur en cours...', 'error');
      return;
    }
    if (state.config.requireNickname && !state.nickname && !(state.isAdmin && state.adminBypass)) {
      showToast('Choisissez un pseudo avant de poser un pixel !', 'error');
      openModal('modalProfile');
      return;
    }
    sendPlaceAt(state.selectedPixel.x, state.selectedPixel.y);
  }

  function paintLineBresenham(x0, y0, x1, y1, visitedSet) {
    let dx = Math.abs(x1 - x0);
    let dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    while (true) {
      const key = `${x0},${y0}`;
      if (!visitedSet.has(key)) {
        visitedSet.add(key);
        sendPlaceAt(x0, y0);
      }
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  // ─────────────────────────── Network & WebSocket ───────────────────────────
  async function loadCanvasBinary() {
    const res = await fetch('/api/canvas', { cache: 'no-store' });
    if (!res.ok) throw new Error('Erreur chargement canvas');
    const w = parseInt(res.headers.get('X-Canvas-Width') || String(state.config.width), 10);
    const h = parseInt(res.headers.get('X-Canvas-Height') || String(state.config.height), 10);
    const buf = await res.arrayBuffer();
    state.config.width = w;
    state.config.height = h;
    state.pixels = new Uint8Array(buf);
    rebuildPaletteRgba();
    rebuildOffscreenCanvas();
    applyConfigUI();
  }

  async function bootstrap() {
    try {
      const res = await fetch('/api/config', { cache: 'no-store' });
      if (res.status === 401) {
        const err = await res.json().catch(() => ({}));
        showToast('Connexion Authentik requise...', 'error');
        if (err.loginUrl) window.location.href = err.loginUrl;
        return;
      }
      const data = await res.json();
      state.config = data.config;
      state.presets = data.presets || {};
      state.lootboxItems = data.lootboxItems || {};
      state.nextLootboxDropAt = data.nextLootboxDropAt || null;
      state.shields = data.shields || [];
      state.online = data.online || 0;
      state.isAdmin = Boolean(data.isAdmin);
      state.passwordLoginEnabled = Boolean(data.passwordLoginEnabled);
      state.authentikUser = data.authentikUser || null;
      if (data.authentikUser) {
        if (state.config.lockNicknameToAuthentik || !state.nickname) {
          state.nickname = data.authentikUser.username || data.authentikUser.name || '';
        }
      }
      state.serverTimeOffset = (data.serverTime || Date.now()) - Date.now();
      syncCooldownFromServer(data.cooldown);
      syncInventory(data.inventory);
      el.onlineBadge.textContent = `● ${state.online}`;

      await loadCanvasBinary();
      centerCamera();
      connectWS();
    } catch (err) {
      console.error(err);
      showToast('Impossible de contacter le serveur, nouvelle tentative...', 'error');
      setTimeout(bootstrap, 2000);
    }
  }

  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    state.ws = ws;

    ws.onopen = () => {
      state.wsConnected = true;
      state.reconnectDelay = 500;
      el.connDot.classList.add('online');
      el.connDot.classList.remove('offline');
      if (state.nickname) ws.send(JSON.stringify({ type: 'set_nickname', nickname: state.nickname }));
      if (state.adminToken) ws.send(JSON.stringify({ type: 'auth_admin', token: state.adminToken }));
    };

    ws.onclose = () => {
      state.wsConnected = false;
      el.connDot.classList.remove('online');
      el.connDot.classList.add('offline');
      setTimeout(() => {
        loadCanvasBinary().catch(() => {});
        connectWS();
      }, state.reconnectDelay);
      state.reconnectDelay = Math.min(8000, state.reconnectDelay * 1.5);
    };

    ws.onmessage = async (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const view = new DataView(ev.data);
        if (view.byteLength >= 6 && view.getUint8(0) === 0x01) {
          updateSinglePixelBuffer(view.getUint16(1, false), view.getUint16(3, false), view.getUint8(5));
        }
        return;
      }

      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'hello') {
        state.config = msg.config;
        state.online = msg.online;
        state.isAdmin = Boolean(msg.isAdmin);
        state.passwordLoginEnabled = Boolean(msg.passwordLoginEnabled);
        if (msg.authentikUser) state.authentikUser = msg.authentikUser;
        if (msg.shields) state.shields = msg.shields;
        if (msg.nextLootboxDropAt !== undefined) state.nextLootboxDropAt = msg.nextLootboxDropAt;
        state.serverTimeOffset = (msg.serverTime || Date.now()) - Date.now();
        el.onlineBadge.textContent = `● ${msg.online}`;
        syncCooldownFromServer(msg.cooldown);
        syncInventory(msg.inventory);
        rebuildPaletteRgba();
        rebuildOffscreenCanvas();
        applyConfigUI();
      } else if (msg.type === 'online') {
        state.online = msg.count;
        el.onlineBadge.textContent = `● ${msg.count}`;
      } else if (msg.type === 'config') {
        const prevW = state.config.width;
        const prevH = state.config.height;
        state.config = msg.config;
        if (msg.nextLootboxDropAt !== undefined) state.nextLootboxDropAt = msg.nextLootboxDropAt;
        if (msg.serverTime) state.serverTimeOffset = msg.serverTime - Date.now();
        rebuildPaletteRgba();
        applyConfigUI();
        if (msg.canvasResized || prevW !== state.config.width || prevH !== state.config.height) {
          await loadCanvasBinary();
          centerCamera();
          showToast(`Canvas redimensionné en ${state.config.width}×${state.config.height}`, 'info');
        } else {
          rebuildOffscreenCanvas();
        }
      } else if (msg.type === 'reload_canvas') {
        state.config = msg.config;
        await loadCanvasBinary();
        showToast('Canvas mis à jour par un administrateur', 'info');
      } else if (msg.type === 'cooldown') {
        syncCooldownFromServer(msg.cooldown);
        if (msg.inventory) syncInventory(msg.inventory);
      } else if (msg.type === 'inventory') {
        syncInventory(msg.inventory);
        if (msg.cooldown) syncCooldownFromServer(msg.cooldown);
      } else if (msg.type === 'shields') {
        state.shields = msg.shields || [];
        state.needsRender = true;
      } else if (msg.type === 'effect') {
        if (msg.effect?.type === 'bomb') {
          state.bombFx.push({ x: msg.effect.x, y: msg.effect.y, colorHex: msg.effect.colorHex, start: performance.now() });
          showToast(`💣 ${msg.effect.author || 'Un joueur'} a lancé une Bombe de Peinture !`, 'info');
          playPopSound(260);
        } else if (msg.effect?.type === 'shield') {
          showToast(`🛡️ ${msg.effect.author || 'Un joueur'} a posé un Bouclier 5×5 !`, 'info');
        }
        state.needsRender = true;
      } else if (msg.type === 'lootbox_drop') {
        if (msg.nextLootboxDropAt !== undefined) state.nextLootboxDropAt = msg.nextLootboxDropAt;
        showToast(`🎁 ${msg.winner} vient de recevoir une Lootbox mystère !`, 'success');
        playPopSound(740);
      } else if (msg.type === 'place_ok') {
        syncCooldownFromServer(msg.cooldown);
        if (msg.inventory) syncInventory(msg.inventory);
        playPopSound(560);
        if (navigator.vibrate) navigator.vibrate(10);
        if (state.selectedPixel && state.selectedPixel.x === msg.x && state.selectedPixel.y === msg.y) {
          inspectPixel(msg.x, msg.y);
        }
      } else if (msg.type === 'place_error') {
        if (msg.cooldown) syncCooldownFromServer(msg.cooldown);
        if (!isDraggingPaint) showToast(msg.message || 'Action impossible', 'error');
      } else if (msg.type === 'admin_status') {
        const wasAdmin = state.isAdmin;
        state.isAdmin = Boolean(msg.isAdmin);
        applyConfigUI();
        if (!state.isAdmin) {
          closeModal('modalAdmin');
          if (wasAdmin) showToast('Vos droits administrateur ont été retirés.', 'info');
        } else if (!wasAdmin) {
          showToast('👑 Vous disposez maintenant des droits administrateur !', 'success');
        }
      }
    };
  }

  // ─────────────────────────── Pointer / Touch / Drag-Paint / Keyboard ───────────────────────────
  const pointers = new Map();
  let dragStart = null;
  let hasDragged = false;
  let pinchStartDist = 0;
  let pinchStartMid = null;
  let pinchStartZoom = 1;
  let spacePressed = false;
  let isDraggingPaint = false;
  let lastPaintCell = null;
  let dragPaintedCells = new Set();

  viewport.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;
    viewport.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1) {
      if (state.dragPaintMode && !spacePressed) {
        isDraggingPaint = true;
        hasDragged = true;
        dragPaintedCells = new Set();
        const { px, py } = screenToWorld(e.clientX, e.clientY);
        lastPaintCell = { x: px, y: py };
        state.selectedPixel = { x: px, y: py };
        paintLineBresenham(px, py, px, py, dragPaintedCells);
        state.needsRender = true;
        return;
      }
      dragStart = { x: e.clientX, y: e.clientY, camX: state.cam.x, camY: state.cam.y };
      hasDragged = false;
    } else if (pointers.size === 2) {
      isDraggingPaint = false;
      hasDragged = true;
      const pts = Array.from(pointers.values());
      pinchStartDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      pinchStartMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      pinchStartZoom = state.cam.zoom;
      dragStart = { x: pinchStartMid.x, y: pinchStartMid.y, camX: state.cam.x, camY: state.cam.y };
    }
  });

  viewport.addEventListener('pointermove', (e) => {
    if (pointers.size === 0 && e.pointerType === 'mouse') {
      const w = screenToWorld(e.clientX, e.clientY);
      state.hoverPixel = { x: w.px, y: w.py };
      state.needsRender = true;
      return;
    }

    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1 && isDraggingPaint) {
      const { px, py } = screenToWorld(e.clientX, e.clientY);
      if (lastPaintCell && (px !== lastPaintCell.x || py !== lastPaintCell.y)) {
        paintLineBresenham(lastPaintCell.x, lastPaintCell.y, px, py, dragPaintedCells);
        lastPaintCell = { x: px, y: py };
        state.selectedPixel = { x: px, y: py };
        state.needsRender = true;
      }
      return;
    }

    if (pointers.size === 1 && dragStart) {
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      if (Math.hypot(dx, dy) > 5) hasDragged = true;
      if (hasDragged) {
        state.cam.x = dragStart.camX - dx / state.cam.zoom;
        state.cam.y = dragStart.camY - dy / state.cam.zoom;
        clampCamera();
        state.needsRender = true;
      }
    } else if (pointers.size === 2 && pinchStartDist > 0) {
      const pts = Array.from(pointers.values());
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const targetZoom = Math.max(state.cam.minZoom, Math.min(state.cam.maxZoom, pinchStartZoom * (dist / pinchStartDist)));
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      const worldMidX = dragStart.camX + (pinchStartMid.x - cx) / pinchStartZoom;
      const worldMidY = dragStart.camY + (pinchStartMid.y - cy) / pinchStartZoom;
      state.cam.zoom = targetZoom;
      state.cam.x = worldMidX - (mid.x - cx) / targetZoom;
      state.cam.y = worldMidY - (mid.y - cy) / targetZoom;
      clampCamera();
      state.needsRender = true;
    }
  });

  function onPointerEnd(e) {
    const wasSingle = pointers.size === 1;
    pointers.delete(e.pointerId);

    if (isDraggingPaint) {
      isDraggingPaint = false;
      lastPaintCell = null;
      dragPaintedCells.clear();
      return;
    }

    if (wasSingle && !hasDragged && !spacePressed && e.type === 'pointerup') {
      const { px, py } = screenToWorld(e.clientX, e.clientY);
      selectPixel(px, py, true);
    }

    if (pointers.size === 1) {
      const remaining = Array.from(pointers.values())[0];
      dragStart = { x: remaining.x, y: remaining.y, camX: state.cam.x, camY: state.cam.y };
      hasDragged = true;
    } else if (pointers.size === 0) {
      dragStart = null;
      pinchStartDist = 0;
    }
  }

  viewport.addEventListener('pointerup', onPointerEnd);
  viewport.addEventListener('pointercancel', onPointerEnd);
  viewport.addEventListener('pointerleave', () => { state.hoverPixel = null; state.needsRender = true; });

  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.18 : 1 / 1.18);
  }, { passive: false });

  viewport.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const { px, py } = screenToWorld(e.clientX, e.clientY);
    if (px >= 0 && px < state.config.width && py >= 0 && py < state.config.height) {
      const cIdx = state.pixels[py * state.config.width + px];
      state.selectedColor = cIdx;
      renderPaletteBar();
      showToast(`Pipette : ${state.config.palette[cIdx]}`, 'info');
      state.needsRender = true;
    }
  });

  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.code === 'Space') { spacePressed = true; return; }
    if (e.key === '+' || e.key === '=') zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.3);
    else if (e.key === '-' || e.key === '_') zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.3);
    else if (e.key === 'g' || e.key === 'G') toggleGrid();
    else if (e.key === 'i' || e.key === 'I') toggleEyedropper();
    else if (e.key === 'd' || e.key === 'D') toggleDragPaint();
    else if (e.key === 'Enter' && state.selectedPixel) placeSelectedPixel();
    else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      if (!state.selectedPixel) {
        selectPixel(Math.floor(state.config.width / 2), Math.floor(state.config.height / 2), false);
      } else {
        const dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        const dy = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
        selectPixel(
          Math.max(0, Math.min(state.config.width - 1, state.selectedPixel.x + dx)),
          Math.max(0, Math.min(state.config.height - 1, state.selectedPixel.y + dy)),
          false
        );
      }
    }
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') spacePressed = false; });

  // ─────────────────────────── Side Toolbar Actions ───────────────────────────
  function toggleGrid() {
    state.showGrid = !state.showGrid;
    document.getElementById('btnGrid').classList.toggle('active', state.showGrid);
    state.needsRender = true;
  }

  function toggleEyedropper() {
    state.eyedropperMode = !state.eyedropperMode;
    document.getElementById('btnEyedropper').classList.toggle('active', state.eyedropperMode);
    if (state.eyedropperMode) showToast('Pipette active : touchez un pixel pour copier sa couleur');
  }

  function toggleDragPaint() {
    state.dragPaintMode = !state.dragPaintMode;
    el.btnDragPaint.classList.toggle('active', state.dragPaintMode);
    if (state.dragPaintMode) {
      const hint = canDragPaintNow()
        ? '🖌️ Mode Click & Drag actif : glissez pour peindre ! (2 doigts pour zoom/pan)'
        : '🖌️ Mode Click & Drag actif (idéal avec Frénésie, Admin ou charges multiples !)';
      showToast(hint, 'info');
    } else {
      showToast('Navigation normale (glisser pour déplacer)');
    }
  }

  document.getElementById('btnZoomIn').addEventListener('click', () => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.4));
  document.getElementById('btnZoomOut').addEventListener('click', () => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.4));
  document.getElementById('btnResetView').addEventListener('click', centerCamera);
  document.getElementById('btnGrid').addEventListener('click', toggleGrid);
  document.getElementById('btnEyedropper').addEventListener('click', toggleEyedropper);
  el.btnDragPaint.addEventListener('click', toggleDragPaint);
  document.getElementById('btnDirectMode').addEventListener('click', () => {
    state.directPlaceMode = !state.directPlaceMode;
    document.getElementById('btnDirectMode').classList.toggle('active', state.directPlaceMode);
    showToast(state.directPlaceMode ? '⚡ Mode pose directe activé' : 'Mode confirmation activé (anti-missclick)');
  });
  document.getElementById('btnSound').addEventListener('click', (e) => {
    state.soundEnabled = !state.soundEnabled;
    e.currentTarget.textContent = state.soundEnabled ? '🔊' : '🔇';
    e.currentTarget.classList.toggle('active', state.soundEnabled);
    if (state.soundEnabled) playPopSound(660);
  });

  el.btnPlace.addEventListener('click', placeSelectedPixel);

  el.btnAdminBypass.addEventListener('click', () => {
    state.adminBypass = !state.adminBypass;
    el.btnAdminBypass.classList.toggle('active', state.adminBypass);
    showToast(state.adminBypass ? '👑 Mode Admin sans cooldown activé' : 'Mode joueur normal rétabli');
    state.needsRender = true;
  });

  el.btnBrushSize.addEventListener('click', () => {
    const sizes = [1, 3, 5, 7, 9];
    const next = sizes[(sizes.indexOf(state.adminBrushSize) + 1) % sizes.length];
    state.adminBrushSize = next;
    el.btnBrushSize.textContent = `${next}×`;
    state.needsRender = true;
  });

  el.btnBrushShape.addEventListener('click', () => {
    state.adminBrushShape = state.adminBrushShape === 'square' ? 'circle' : 'square';
    el.btnBrushShape.textContent = state.adminBrushShape === 'circle' ? '●' : '■';
    state.needsRender = true;
  });

  // ─────────────────────────── Modals System ───────────────────────────
  function openModal(id) { document.getElementById(id)?.classList.remove('hidden'); }
  function closeModal(id) {
    document.getElementById(id)?.classList.add('hidden');
    if (id === 'modalTimelapse') stopTimelapse();
  }
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close')));
  });
  document.querySelectorAll('.modal').forEach((modal) => {
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(modal.id); });
  });

  // ─────────────────────────── Lootbox & Inventory Modal ───────────────────────────
  function renderLootboxModal() {
    const inv = state.inventory || { lootboxes: 0, items: {}, activeBoost: null, bonusCharges: 0 };
    const count = inv.lootboxes || 0;
    document.getElementById('lootboxCountLabel').textContent =
      count === 0 ? 'Aucune lootbox en attente' : `${count} Lootbox${count > 1 ? 'es' : ''} prête${count > 1 ? 's' : ''} à ouvrir !`;
    document.getElementById('btnOpenLootbox').disabled = count <= 0;

    const dropInfo = document.getElementById('nextDropInfo');
    if (!state.config.lootboxEnabled) {
      dropInfo.textContent = 'Les drops automatiques sont actuellement désactivés.';
    } else if (state.nextLootboxDropAt) {
      const rem = Math.max(0, state.nextLootboxDropAt - (Date.now() + state.serverTimeOffset));
      dropInfo.textContent = `⏳ Prochain tirage aléatoire dans ${formatCountdown(rem)} (toutes les ${state.config.lootboxIntervalMinutes} min).`;
    } else {
      dropInfo.textContent = `🎁 1 lootbox aléatoire toutes les ${state.config.lootboxIntervalMinutes} min.`;
    }

    const adminBoostBar = document.getElementById('adminBoostBar');
    if (adminBoostBar) adminBoostBar.classList.toggle('hidden', !state.isAdmin);

    const listEl = document.getElementById('inventoryList');
    listEl.innerHTML = '';
    for (const def of Object.values(state.lootboxItems)) {
      const qty = inv.items?.[def.id] || 0;
      const card = document.createElement('div');
      card.className = 'inv-card' + (qty > 0 || state.isAdmin ? ' owned' : '');
      const actionsHtml = state.isAdmin
        ? `<div class="btn-row">
            <button class="btn btn-primary btn-sm" data-admin-act>⚡ Activer (∞)</button>
            <button class="btn btn-secondary btn-sm" data-admin-give>+99</button>
          </div>`
        : `<button class="btn ${qty > 0 ? 'btn-primary' : 'btn-secondary'} btn-sm" data-user-act ${qty <= 0 ? 'disabled' : ''}>
            ${qty > 0 ? 'Activer' : def.rarity}
          </button>`;
      card.innerHTML = `
        <div class="inv-head">
          <span class="inv-title">${def.icon} ${escapeHtml(def.name)}</span>
          <span class="pill ${qty > 0 ? 'pill-green' : ''}">×${qty}</span>
        </div>
        <div class="muted small">${escapeHtml(def.description)}</div>
        ${actionsHtml}
      `;
      const userBtn = card.querySelector('[data-user-act]');
      if (userBtn && qty > 0) {
        userBtn.addEventListener('click', async () => {
          const r = await fetch('/api/lootbox/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemId: def.id }),
          });
          const d = await r.json();
          if (!r.ok) { showToast(d.error || 'Activation impossible', 'error'); return; }
          syncInventory(d.inventory);
          syncCooldownFromServer(d.cooldown);
          closeModal('modalLootbox');
          showToast(`${def.icon} ${def.name} activé !`, 'success');
          if (def.id === 'frenzy' && !state.dragPaintMode) {
            showToast('💡 Astuce : active 🖌️ pour peindre en glissant pendant la Frénésie !', 'info');
          }
        });
      }
      const admActBtn = card.querySelector('[data-admin-act]');
      if (admActBtn && state.isAdmin) {
        admActBtn.addEventListener('click', async () => {
          const r = await fetch('/api/admin/boosts/activate', {
            method: 'POST',
            headers: adminHeaders(),
            body: JSON.stringify({ itemId: def.id }),
          });
          const d = await r.json();
          if (!r.ok) { showToast(d.error || 'Activation impossible', 'error'); return; }
          syncInventory(d.inventory);
          syncCooldownFromServer(d.cooldown);
          closeModal('modalLootbox');
          showToast(`👑 ${def.icon} ${def.name} activé (Admin ∞) !`, 'success');
        });
      }
      const admGiveBtn = card.querySelector('[data-admin-give]');
      if (admGiveBtn && state.isAdmin) {
        admGiveBtn.addEventListener('click', () => adminGiveBoost(def.id, 99));
      }
      listEl.appendChild(card);
    }
  }

  el.btnLootbox.addEventListener('click', () => {
    document.getElementById('lootRevealBox').classList.add('hidden');
    renderLootboxModal();
    openModal('modalLootbox');
  });

  document.getElementById('btnOpenLootbox').addEventListener('click', async () => {
    const chest = document.getElementById('lootChestAnim');
    const btn = document.getElementById('btnOpenLootbox');
    btn.disabled = true;
    chest.classList.add('shaking');
    playPopSound(440);
    await new Promise((r) => setTimeout(r, 450));
    try {
      const res = await fetch('/api/lootbox/open', { method: 'POST' });
      const data = await res.json();
      chest.classList.remove('shaking');
      if (!res.ok) {
        showToast(data.error || 'Impossible d\'ouvrir', 'error');
        renderLootboxModal();
        return;
      }
      const it = data.item;
      const box = document.getElementById('lootRevealBox');
      box.innerHTML = `<span style="font-size:2rem">${it.icon}</span><div><strong>Tu as gagné : ${escapeHtml(it.name)} !</strong><div class="muted small">${escapeHtml(it.description)}</div></div>`;
      box.classList.remove('hidden');
      playPopSound(820);
      syncInventory(data.inventory);
    } catch {
      chest.classList.remove('shaking');
      showToast('Erreur réseau', 'error');
    }
  });

  // ─────────────────────────── Profile Modal ───────────────────────────
  document.getElementById('btnProfile').addEventListener('click', () => {
    const info = document.getElementById('authentikIdentityInfo');
    if (state.authentikUser) {
      info.textContent = `Connecté via Authentik en tant que @${state.authentikUser.username}` +
        (state.authentikUser.groups?.length ? ` (${state.authentikUser.groups.join(', ')})` : '') +
        (state.config.lockNicknameToAuthentik ? ' — Pseudo verrouillé par l\'admin.' : '');
    } else {
      info.textContent = 'Votre pseudo s\'affiche sur vos pixels et dans le classement.';
    }
    const input = document.getElementById('inputNickname');
    input.value = state.nickname;
    input.disabled = Boolean(state.config.lockNicknameToAuthentik && state.authentikUser);
    openModal('modalProfile');
  });

  document.getElementById('btnSaveProfile').addEventListener('click', () => {
    if (state.config.lockNicknameToAuthentik && state.authentikUser) {
      closeModal('modalProfile');
      return;
    }
    const val = document.getElementById('inputNickname').value.trim().slice(0, 24);
    state.nickname = val;
    localStorage.setItem('pw_nickname', val);
    el.nickLabel.textContent = val || state.authentikUser?.username || 'Pseudo';
    if (state.wsConnected && state.ws) {
      state.ws.send(JSON.stringify({ type: 'set_nickname', nickname: val }));
    }
    closeModal('modalProfile');
    showToast(val ? `Pseudo enregistré : ${val}` : 'Pseudo réinitialisé', 'success');
  });

  // ─────────────────────────── Export Modal ───────────────────────────
  function refreshExportPreview() {
    const preview = document.getElementById('exportPreview');
    preview.width = state.config.width;
    preview.height = state.config.height;
    const pctx = preview.getContext('2d');
    pctx.imageSmoothingEnabled = false;
    pctx.drawImage(state.offscreen, 0, 0);
    const scale = parseInt(document.getElementById('selectExportScale').value, 10) || 4;
    document.getElementById('exportDimensionsInfo').textContent =
      `Dimensions de sortie : ${state.config.width * scale} × ${state.config.height * scale} px (PNG sans perte)`;
  }

  document.getElementById('btnExport').addEventListener('click', () => {
    if (!state.config.allowPublicExport && !state.isAdmin) {
      showToast('L\'export public est désactivé par l\'admin.', 'error');
      return;
    }
    refreshExportPreview();
    openModal('modalExport');
  });
  document.getElementById('selectExportScale').addEventListener('change', refreshExportPreview);
  document.getElementById('btnDownloadServerPng').addEventListener('click', () => {
    const scale = parseInt(document.getElementById('selectExportScale').value, 10) || 4;
    window.location.href = `/api/export/png?scale=${scale}`;
  });
  document.getElementById('btnDownloadClientPng').addEventListener('click', () => {
    const scale = parseInt(document.getElementById('selectExportScale').value, 10) || 4;
    const c = document.createElement('canvas');
    c.width = state.config.width * scale;
    c.height = state.config.height * scale;
    const cctx = c.getContext('2d');
    cctx.imageSmoothingEnabled = false;
    cctx.drawImage(state.offscreen, 0, 0, c.width, c.height);
    const a = document.createElement('a');
    a.download = `pixel-war-${state.config.width}x${state.config.height}-${scale}x.png`;
    a.href = c.toDataURL('image/png');
    a.click();
    showToast('Image PNG téléchargée !', 'success');
  });

  // ─────────────────────────── Stats Modal ───────────────────────────
  document.getElementById('btnStats').addEventListener('click', async () => {
    openModal('modalStats');
    try {
      const res = await fetch('/api/stats', { cache: 'no-store' });
      const data = await res.json();
      document.getElementById('statOnline').textContent = data.online;
      document.getElementById('statTotalPixels').textContent = data.totalPixelsPlaced.toLocaleString('fr-FR');
      document.getElementById('statDimensions').textContent = `${state.config.width}×${state.config.height}`;

      const list = document.getElementById('leaderboardList');
      list.innerHTML = !data.leaderboard.length
        ? '<div class="muted small">Aucun contributeur pour le moment.</div>'
        : data.leaderboard.map((row) => {
            const medal = row.rank === 1 ? '🥇' : row.rank === 2 ? '🥈' : row.rank === 3 ? '🥉' : `#${row.rank}`;
            return `<div class="list-row"><span><strong>${medal}</strong> ${escapeHtml(row.name)}</span><span class="mono">${row.count} px</span></div>`;
          }).join('');

      const totalCanvasPx = state.config.width * state.config.height;
      document.getElementById('colorStatsBar').innerHTML = data.colors
        .filter((c) => c.count > 0)
        .sort((a, b) => b.count - a.count)
        .map((c) => `<div style="width:${(c.count / totalCanvasPx) * 100}%;background:${c.hex}" title="${c.hex}: ${c.count} px"></div>`)
        .join('');
    } catch {
      showToast('Erreur chargement statistiques', 'error');
    }
  });

  // ─────────────────────────── Overlay Template Modal ───────────────────────────
  document.getElementById('btnOverlay').addEventListener('click', () => openModal('modalOverlay'));
  document.getElementById('inputOverlayFile').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        state.overlay.img = img;
        state.overlay.visible = true;
        document.getElementById('btnOverlay').classList.add('active');
        state.needsRender = true;
        showToast('Modèle chargé sur le canvas !', 'success');
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
  ['inputOverlayX', 'inputOverlayY', 'inputOverlayW', 'inputOverlayOpacity'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => {
      state.overlay.x = parseInt(document.getElementById('inputOverlayX').value, 10) || 0;
      state.overlay.y = parseInt(document.getElementById('inputOverlayY').value, 10) || 0;
      state.overlay.w = Math.max(1, parseInt(document.getElementById('inputOverlayW').value, 10) || 32);
      const op = parseInt(document.getElementById('inputOverlayOpacity').value, 10) || 50;
      state.overlay.opacity = op / 100;
      document.getElementById('overlayOpacityVal').textContent = `${op}%`;
      state.needsRender = true;
    });
  });
  document.getElementById('btnToggleOverlay').addEventListener('click', () => {
    state.overlay.visible = !state.overlay.visible;
    document.getElementById('btnOverlay').classList.toggle('active', Boolean(state.overlay.img && state.overlay.visible));
    state.needsRender = true;
  });
  document.getElementById('btnClearOverlay').addEventListener('click', () => {
    state.overlay.img = null;
    document.getElementById('btnOverlay').classList.remove('active');
    state.needsRender = true;
    showToast('Calque modèle retiré');
  });

  // ─────────────────────────── Timelapse Replay (with Baseline Support) ───────────────────────────
  const tl = {
    events: [],
    palette: [],
    baselineBytes: null,
    width: 128,
    height: 128,
    index: 0,
    playing: false,
    rafId: null,
    lastFrame: 0,
    carry: 0,
    recorder: null,
    recordedChunks: [],
  };

  function tlCanvas() { return document.getElementById('timelapseCanvas'); }

  function tlResetCanvas() {
    const c = tlCanvas();
    c.width = tl.width;
    c.height = tl.height;
    const tctx = c.getContext('2d');
    if (tl.baselineBytes && tl.baselineBytes.length === tl.width * tl.height) {
      const imgData = tctx.createImageData(tl.width, tl.height);
      const palRgba = tl.palette.map(hexToRgba);
      for (let i = 0; i < tl.baselineBytes.length; i++) {
        const rgba = palRgba[tl.baselineBytes[i]] || [255, 255, 255, 255];
        const p = i * 4;
        imgData.data[p] = rgba[0];
        imgData.data[p + 1] = rgba[1];
        imgData.data[p + 2] = rgba[2];
        imgData.data[p + 3] = 255;
      }
      tctx.putImageData(imgData, 0, 0);
    } else {
      tctx.fillStyle = tl.palette[0] || '#FFFFFF';
      tctx.fillRect(0, 0, tl.width, tl.height);
    }
    tl.index = 0;
    updateTlScrubber();
  }

  function tlApplyEvent(ev, tctx) {
    if (ev.clear !== undefined) {
      tctx.fillStyle = tl.palette[ev.clear] || '#FFFFFF';
      tctx.fillRect(0, 0, tl.width, tl.height);
    } else if (ev.batch) {
      for (const [x, y, c] of ev.batch) {
        tctx.fillStyle = tl.palette[c] || '#FFFFFF';
        tctx.fillRect(x, y, 1, 1);
      }
    } else if (typeof ev.x === 'number') {
      tctx.fillStyle = tl.palette[ev.c] || '#FFFFFF';
      tctx.fillRect(ev.x, ev.y, 1, 1);
    }
  }

  function tlSeekTo(targetIdx) {
    tlResetCanvas();
    const tctx = tlCanvas().getContext('2d');
    const clamped = Math.max(0, Math.min(tl.events.length, targetIdx));
    for (let i = 0; i < clamped; i++) tlApplyEvent(tl.events[i], tctx);
    tl.index = clamped;
    updateTlScrubber();
  }

  function updateTlScrubber() {
    const scrub = document.getElementById('tlScrubber');
    scrub.max = Math.max(1, tl.events.length);
    scrub.value = tl.index;
    document.getElementById('tlCounter').textContent = `${tl.index} / ${tl.events.length}`;
  }

  function tlStep(now) {
    if (!tl.playing) return;
    const dt = Math.min(0.1, (now - tl.lastFrame) / 1000);
    tl.lastFrame = now;
    const speed = parseInt(document.getElementById('selectTlSpeed').value, 10) || 200;
    tl.carry += speed * dt;
    const steps = Math.floor(tl.carry);
    tl.carry -= steps;
    if (steps > 0) {
      const tctx = tlCanvas().getContext('2d');
      const end = Math.min(tl.events.length, tl.index + steps);
      for (let i = tl.index; i < end; i++) tlApplyEvent(tl.events[i], tctx);
      tl.index = end;
      updateTlScrubber();
    }
    if (tl.index >= tl.events.length) { stopTimelapse(); return; }
    tl.rafId = requestAnimationFrame(tlStep);
  }

  function startTimelapse() {
    if (tl.index >= tl.events.length) tlResetCanvas();
    tl.playing = true;
    tl.lastFrame = performance.now();
    tl.carry = 0;
    document.getElementById('btnTlPlay').textContent = '⏸ Pause';
    tl.rafId = requestAnimationFrame(tlStep);
  }

  function stopTimelapse() {
    tl.playing = false;
    if (tl.rafId) cancelAnimationFrame(tl.rafId);
    tl.rafId = null;
    document.getElementById('btnTlPlay').textContent = '▶ Lire';
    if (tl.recorder && tl.recorder.state === 'recording') tl.recorder.stop();
  }

  document.getElementById('btnTimelapse').addEventListener('click', async () => {
    if (!state.config.allowTimelapse && !state.isAdmin) {
      showToast('Le timelapse est désactivé par l\'admin.', 'error');
      return;
    }
    openModal('modalTimelapse');
    try {
      const res = await fetch('/api/history', { cache: 'no-store' });
      if (!res.ok) throw new Error('Accès refusé');
      const data = await res.json();
      tl.width = data.width;
      tl.height = data.height;
      tl.palette = data.palette;
      tl.events = data.events || [];
      if (data.baselineBase64) {
        const bin = atob(data.baselineBase64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        tl.baselineBytes = arr;
      } else {
        tl.baselineBytes = null;
      }
      document.getElementById('tlStartInfo').textContent = data.startTime
        ? `🎬 Enregistrement démarré le ${new Date(data.startTime).toLocaleString('fr-FR')} (${tl.events.length} actions enregistrées).`
        : `🎬 Historique complet (${tl.events.length} actions enregistrées).`;
      tlResetCanvas();
      if (tl.events.length > 0) startTimelapse();
    } catch {
      showToast('Impossible de charger l\'historique', 'error');
    }
  });

  document.getElementById('btnTlPlay').addEventListener('click', () => tl.playing ? stopTimelapse() : startTimelapse());
  document.getElementById('btnTlRestart').addEventListener('click', () => { stopTimelapse(); tlResetCanvas(); startTimelapse(); });
  document.getElementById('tlScrubber').addEventListener('input', (e) => { stopTimelapse(); tlSeekTo(parseInt(e.target.value, 10) || 0); });
  document.getElementById('btnTlRecord').addEventListener('click', () => {
    const c = tlCanvas();
    if (!c.captureStream || typeof MediaRecorder === 'undefined') {
      showToast('Enregistrement vidéo non supporté sur ce navigateur.', 'error');
      return;
    }
    stopTimelapse();
    tlResetCanvas();
    const stream = c.captureStream(30);
    tl.recordedChunks = [];
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    tl.recorder = new MediaRecorder(stream, { mimeType: mime });
    tl.recorder.ondataavailable = (ev) => { if (ev.data.size > 0) tl.recordedChunks.push(ev.data); };
    tl.recorder.onstop = () => {
      const blob = new Blob(tl.recordedChunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'pixel-war-timelapse.webm';
      a.click();
      URL.revokeObjectURL(url);
      showToast('Vidéo Timelapse WebM téléchargée !', 'success');
    };
    tl.recorder.start();
    showToast('⏺ Enregistrement du timelapse en cours...', 'info');
    startTimelapse();
  });

  // ─────────────────────────── Admin Panel ───────────────────────────
  function populateAdminForm() {
    const c = state.config;
    document.getElementById('admCooldownSec').value = (c.cooldownMs / 1000).toString();
    document.getElementById('admMaxCharges').value = c.maxCharges;
    document.getElementById('admCooldownMode').value = c.cooldownMode;
    document.getElementById('admTitle').value = c.title;
    document.getElementById('admAnnouncement').value = c.announcement || '';
    document.getElementById('admPaused').checked = Boolean(c.manualPaused);
    document.getElementById('admLockBeforeStart').checked = Boolean(c.lockBeforeStart);
    document.getElementById('admLockNick').checked = Boolean(c.lockNicknameToAuthentik);
    document.getElementById('admRequireNick').checked = Boolean(c.requireNickname);
    document.getElementById('admAllowSameColor').checked = Boolean(c.allowSameColor);
    document.getElementById('admAllowExport').checked = Boolean(c.allowPublicExport);
    document.getElementById('admAllowTimelapse').checked = Boolean(c.allowTimelapse);
    document.getElementById('admWidth').value = c.width;
    document.getElementById('admHeight').value = c.height;
    document.getElementById('admStartTime').value = toLocalInputValue(c.startTime);
    document.getElementById('admEndTime').value = toLocalInputValue(c.endTime);
    document.getElementById('admAutoSnapMin').value = c.autoSnapshotMinutes ?? 15;
    document.getElementById('admMaxAutoSnaps').value = c.maxAutoSnapshots ?? 48;
    document.getElementById('admLootEnabled').checked = Boolean(c.lootboxEnabled);
    document.getElementById('admLootInterval').value = c.lootboxIntervalMinutes ?? 60;

    state.admPaletteDraft = [...c.palette];
    renderAdminPaletteEditor();
    renderPalettePresets();
  }

  function renderPalettePresets() {
    const row = document.getElementById('palettePresetsRow');
    row.innerHTML = '';
    for (const preset of Object.values(state.presets)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.textContent = preset.name;
      btn.addEventListener('click', () => {
        state.admPaletteDraft = [...preset.colors];
        renderAdminPaletteEditor();
      });
      row.appendChild(btn);
    }
  }

  function renderAdminPaletteEditor() {
    const grid = document.getElementById('admPaletteEditor');
    grid.innerHTML = '';
    state.admPaletteDraft.forEach((hex, idx) => {
      const item = document.createElement('div');
      item.className = 'adm-color-item';
      item.innerHTML = `<span class="dot" style="background:${hex}"></span><span class="mono small">${hex}</span><button type="button" title="Supprimer">✕</button>`;
      item.querySelector('button').addEventListener('click', () => {
        if (state.admPaletteDraft.length <= 2) {
          showToast('Minimum 2 couleurs dans la palette.', 'error');
          return;
        }
        state.admPaletteDraft.splice(idx, 1);
        renderAdminPaletteEditor();
      });
      grid.appendChild(item);
    });
  }

  async function refreshSnapshotsList() {
    const res = await fetch('/api/admin/snapshots', { headers: adminHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const infoEl = document.getElementById('snapScheduleInfo');
    if (data.autoSnapshotMinutes > 0 && data.nextAutoSnapshotAt) {
      const rem = Math.max(0, data.nextAutoSnapshotAt - Date.now());
      infoEl.textContent = `⏱ Auto-snapshot actif toutes les ${data.autoSnapshotMinutes} min (prochain dans ${formatCountdown(rem)}) • ${data.snapshots.length} snapshot(s) enregistrés.`;
    } else {
      infoEl.textContent = `Auto-snapshots désactivés • ${data.snapshots.length} snapshot(s) enregistrés.`;
    }

    const container = document.getElementById('snapshotsList');
    if (!data.snapshots.length) {
      container.innerHTML = '<div class="muted small">Aucun snapshot sauvegardé pour l\'instant.</div>';
      return;
    }
    container.innerHTML = '';
    for (const snap of data.snapshots) {
      const row = document.createElement('div');
      row.className = 'list-row';
      row.innerHTML = `
        <div>
          <strong>${escapeHtml(snap.label)}</strong> <span class="muted small">(${snap.width}×${snap.height})</span><br/>
          <span class="muted small">${new Date(snap.createdAt).toLocaleString('fr-FR')} • ${snap.totalPixelsPlaced} px</span>
        </div>
        <div class="btn-row">
          <a class="btn btn-secondary btn-sm" href="/api/admin/snapshots/${encodeURIComponent(snap.id)}/png">⬇ PNG</a>
          <button class="btn btn-primary btn-sm" data-restore>↺ Restaurer</button>
          <button class="btn btn-danger btn-sm" data-del>🗑</button>
        </div>
      `;
      row.querySelector('[data-restore]').addEventListener('click', async () => {
        if (!confirm(`Restaurer "${snap.label}" ? Le canvas actuel sera remplacé.`)) return;
        const r = await fetch(`/api/admin/snapshots/${encodeURIComponent(snap.id)}/restore`, { method: 'POST', headers: adminHeaders() });
        if (r.ok) showToast('Snapshot restauré !', 'success');
      });
      row.querySelector('[data-del]').addEventListener('click', async () => {
        await fetch(`/api/admin/snapshots/${encodeURIComponent(snap.id)}`, { method: 'DELETE', headers: adminHeaders() });
        refreshSnapshotsList();
      });
      container.appendChild(row);
    }
  }

  async function refreshAdminsList() {
    const res = await fetch('/api/admin/admins', { headers: adminHeaders() });
    if (!res.ok) return;
    const data = await res.json();

    document.getElementById('admGroupsList').innerHTML = data.adminGroups.length
      ? data.adminGroups.map((g) => `<span class="pill pill-amber">${escapeHtml(g)}</span>`).join('')
      : '<span class="muted small">Aucun groupe configuré</span>';

    document.getElementById('admEnvUsersList').innerHTML = data.envAdminUsers.length
      ? data.envAdminUsers.map((u) => `<span class="pill pill-green">${escapeHtml(u)}</span>`).join('')
      : '<span class="muted small">Aucun utilisateur fixe configuré</span>';

    const dynEl = document.getElementById('admDynamicList');
    if (!data.dynamicAdmins.length) {
      dynEl.innerHTML = '<div class="muted small">Aucun admin ajouté manuellement.</div>';
    } else {
      dynEl.innerHTML = '';
      for (const username of data.dynamicAdmins) {
        const row = document.createElement('div');
        row.className = 'list-row';
        row.innerHTML = `<span class="mono">👑 ${escapeHtml(username)}</span><button class="btn btn-danger btn-sm">Retirer</button>`;
        row.querySelector('button').addEventListener('click', async () => {
          const r = await fetch('/api/admin/admins', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ action: 'remove', username }) });
          if (!r.ok) { showToast((await r.json().catch(() => ({}))).error || 'Action impossible', 'error'); return; }
          showToast(`Droits admin retirés à ${username}`, 'info');
          refreshAdminsList();
        });
        dynEl.appendChild(row);
      }
    }

    const connEl = document.getElementById('admConnectedUsersList');
    if (!data.activeUsers.length) {
      connEl.innerHTML = '<div class="muted small">Aucun utilisateur Authentik connecté.</div>';
    } else {
      connEl.innerHTML = '';
      for (const u of data.activeUsers) {
        const row = document.createElement('div');
        row.className = 'list-row';
        const roleTag = u.isStaticAdmin
          ? '<span class="pill pill-amber">Admin fixe/groupe</span>'
          : u.isDynamicAdmin
            ? '<button class="btn btn-danger btn-sm" data-act="remove">Retirer admin</button>'
            : '<button class="btn btn-primary btn-sm" data-act="add">+ Promouvoir admin</button>';
        row.innerHTML = `<span class="small"><strong>${escapeHtml(u.username)}</strong> ${u.groups.length ? `<span class="muted">(${escapeHtml(u.groups.join(', '))})</span>` : ''}</span><span>${roleTag}</span>`;
        const btn = row.querySelector('button[data-act]');
        if (btn) {
          btn.addEventListener('click', async () => {
            const action = btn.getAttribute('data-act');
            const r = await fetch('/api/admin/admins', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ action, username: u.usernameNorm || u.username }) });
            if (!r.ok) { showToast((await r.json().catch(() => ({}))).error || 'Action impossible', 'error'); return; }
            showToast(action === 'add' ? `👑 ${u.username} est maintenant admin !` : `Droits retirés à ${u.username}`, 'success');
            refreshAdminsList();
          });
        }
        connEl.appendChild(row);
      }
    }
  }

  async function refreshBansList() {
    const res = await fetch('/api/admin/bans', { headers: adminHeaders() });
    if (!res.ok) return;
    const data = await res.json();

    const bansEl = document.getElementById('bansList');
    if (!data.banned.length) {
      bansEl.innerHTML = '<div class="muted small">Aucune restriction active.</div>';
    } else {
      bansEl.innerHTML = '';
      for (const target of data.banned) {
        const row = document.createElement('div');
        row.className = 'list-row';
        row.innerHTML = `<span class="mono">${escapeHtml(target)}</span><button class="btn btn-secondary btn-sm">Lever</button>`;
        row.querySelector('button').addEventListener('click', async () => {
          await fetch('/api/admin/bans', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ action: 'unban', target }) });
          refreshBansList();
        });
        bansEl.appendChild(row);
      }
    }

    const clientsEl = document.getElementById('activeClientsList');
    clientsEl.innerHTML = '';
    for (const c of data.activeClients) {
      const row = document.createElement('div');
      row.className = 'list-row';
      const targetId = c.authentikUid ? `ak:${c.authentikUid}` : c.clientId;
      const badge = c.authentikUsername ? `Authentik: ${c.authentikUsername}` : c.clientId.slice(0, 12);
      row.innerHTML = `<span class="small"><strong>${escapeHtml(c.nickname || 'Anonyme')}</strong> • <span class="mono">${escapeHtml(badge)}</span></span><button class="btn btn-danger btn-sm">Restreindre</button>`;
      row.querySelector('button').addEventListener('click', async () => {
        const r = await fetch('/api/admin/bans', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ action: 'ban', target: targetId }) });
        if (r.ok) { showToast('Utilisateur restreint.', 'info'); refreshBansList(); }
      });
      clientsEl.appendChild(row);
    }
  }

  let botPollTimer = null;

  async function adminGiveBoost(itemId = 'all', amount = 99) {
    const res = await fetch('/api/admin/boosts/give', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ itemId, amount }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(d.error || 'Give refusé', 'error');
      return;
    }
    syncInventory(d.inventory);
    showToast(itemId === 'all' ? '👑 +99 de tous les boosts ajoutés !' : `👑 +${amount} ${itemId} ajoutés !`, 'success');
  }

  function renderAdminQuickGiveRow() {
    const row = document.getElementById('admQuickGiveRow');
    if (!row) return;
    row.innerHTML = '';
    for (const def of Object.values(state.lootboxItems)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.textContent = `+99 ${def.icon} ${def.name}`;
      btn.addEventListener('click', () => adminGiveBoost(def.id, 99));
      row.appendChild(btn);
    }
  }

  async function refreshBotJobs() {
    if (!state.isAdmin) return;
    const res = await fetch('/api/admin/bot', { headers: adminHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const list = document.getElementById('botJobsList');
    if (!list) return;
    if (!data.jobs || data.jobs.length === 0) {
      list.innerHTML = '<div class="muted small">Aucun bot actif en ce moment.</div>';
      return;
    }
    list.innerHTML = '';
    for (const job of data.jobs) {
      const row = document.createElement('div');
      row.className = 'list-row';
      const statusBadge = job.status === 'paused'
        ? '<span class="pill pill-amber">⏸ Pause</span>'
        : job.status === 'defending'
          ? '<span class="pill pill-green">🛡️ Défense</span>'
          : '<span class="pill pill-blue">🤖 En cours</span>';
      row.innerHTML = `
        <div style="flex:1;min-width:0">
          <div><strong>${escapeHtml(job.name)}</strong> ${statusBadge} <span class="muted small">${job.ratePerSec} px/s</span></div>
          <div class="muted small">${job.completedPixels} / ${job.totalPixels} px (${job.percent}%) • Par ${escapeHtml(job.author)}</div>
          <div class="bot-progress"><span style="width:${job.percent}%"></span></div>
        </div>
        <div class="btn-row">
          <button class="btn btn-secondary btn-sm" data-bot-toggle>${job.paused ? '▶' : '⏸'}</button>
          <button class="btn ${job.maintain ? 'btn-primary' : 'btn-secondary'} btn-sm" data-bot-def title="Mode Défense">🛡️</button>
          <button class="btn btn-danger btn-sm" data-bot-stop>🛑</button>
        </div>
      `;
      row.querySelector('[data-bot-toggle]').addEventListener('click', async () => {
        await fetch('/api/admin/bot/control', {
          method: 'POST',
          headers: adminHeaders(),
          body: JSON.stringify({ id: job.id, action: job.paused ? 'resume' : 'pause' }),
        });
        refreshBotJobs();
      });
      row.querySelector('[data-bot-def]').addEventListener('click', async () => {
        await fetch('/api/admin/bot/control', {
          method: 'POST',
          headers: adminHeaders(),
          body: JSON.stringify({ id: job.id, action: 'toggle_maintain' }),
        });
        refreshBotJobs();
      });
      row.querySelector('[data-bot-stop]').addEventListener('click', async () => {
        await fetch('/api/admin/bot/control', {
          method: 'POST',
          headers: adminHeaders(),
          body: JSON.stringify({ id: job.id, action: 'stop' }),
        });
        refreshBotJobs();
      });
      list.appendChild(row);
    }
  }

  function showAdminView() {
    document.getElementById('adminLoginView').classList.toggle('hidden', state.isAdmin || !state.passwordLoginEnabled);
    document.getElementById('adminPanelView').classList.toggle('hidden', !state.isAdmin);
    document.getElementById('btnAdmLogout').classList.toggle('hidden', !state.passwordLoginEnabled);
    if (botPollTimer) { clearInterval(botPollTimer); botPollTimer = null; }
    if (state.isAdmin) {
      populateAdminForm();
      renderAdminQuickGiveRow();
      refreshSnapshotsList();
      refreshBotJobs();
      refreshAdminsList();
      refreshBansList();
      botPollTimer = setInterval(() => {
        if (!document.getElementById('modalAdmin').classList.contains('hidden')) {
          refreshBotJobs();
        } else {
          clearInterval(botPollTimer);
          botPollTimer = null;
        }
      }, 1500);
    }
  }

  document.getElementById('btnAdmin').addEventListener('click', () => {
    if (!state.isAdmin && !state.passwordLoginEnabled) {
      showToast('Accès réservé aux administrateurs.', 'error');
      return;
    }
    showAdminView();
    openModal('modalAdmin');
  });

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.getAttribute('data-tab')).classList.add('active');
    });
  });

  document.querySelectorAll('[data-cd]').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.getElementById('admCooldownSec').value = (parseInt(chip.getAttribute('data-cd'), 10) / 1000).toString();
    });
  });
  document.querySelectorAll('[data-snap-min]').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.getElementById('admAutoSnapMin').value = chip.getAttribute('data-snap-min');
    });
  });
  document.querySelectorAll('[data-loot-min]').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.getElementById('admLootInterval').value = chip.getAttribute('data-loot-min');
    });
  });

  document.getElementById('adminLoginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('adminLoginError');
    errEl.classList.add('hidden');
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('inputAdminPassword').value }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Connexion refusée'; errEl.classList.remove('hidden'); return; }
    state.isAdmin = true;
    state.adminToken = data.token;
    sessionStorage.setItem('pw_admin_token', data.token);
    if (state.wsConnected && state.ws) state.ws.send(JSON.stringify({ type: 'auth_admin', token: data.token }));
    applyConfigUI();
    showAdminView();
    showToast('Connecté en administrateur !', 'success');
  });

  document.getElementById('btnAdmLogout').addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST', headers: adminHeaders() });
    state.isAdmin = false;
    state.adminBypass = false;
    state.adminToken = '';
    sessionStorage.removeItem('pw_admin_token');
    applyConfigUI();
    showAdminView();
  });

  async function postAdminConfig(patch) {
    const res = await fetch('/api/admin/config', { method: 'POST', headers: adminHeaders(), body: JSON.stringify(patch) });
    if (!res.ok) {
      showToast((await res.json().catch(() => ({}))).error || 'Erreur mise à jour', 'error');
      return false;
    }
    showToast('✅ Réglages appliqués en direct !', 'success');
    return true;
  }

  document.getElementById('btnAdmSaveRules').addEventListener('click', () => {
    const cdSec = parseFloat(document.getElementById('admCooldownSec').value);
    const startRaw = document.getElementById('admStartTime').value;
    const endRaw = document.getElementById('admEndTime').value;
    postAdminConfig({
      cooldownMs: Number.isFinite(cdSec) ? Math.round(cdSec * 1000) : 5000,
      maxCharges: parseInt(document.getElementById('admMaxCharges').value, 10) || 1,
      cooldownMode: document.getElementById('admCooldownMode').value,
      title: document.getElementById('admTitle').value,
      announcement: document.getElementById('admAnnouncement').value,
      paused: document.getElementById('admPaused').checked,
      lockBeforeStart: document.getElementById('admLockBeforeStart').checked,
      lockNicknameToAuthentik: document.getElementById('admLockNick').checked,
      requireNickname: document.getElementById('admRequireNick').checked,
      allowSameColor: document.getElementById('admAllowSameColor').checked,
      allowPublicExport: document.getElementById('admAllowExport').checked,
      allowTimelapse: document.getElementById('admAllowTimelapse').checked,
      startTime: startRaw ? new Date(startRaw).toISOString() : null,
      endTime: endRaw ? new Date(endRaw).toISOString() : null,
    });
  });

  document.getElementById('btnAdmStartNow').addEventListener('click', async () => {
    const res = await fetch('/api/admin/start-now', { method: 'POST', headers: adminHeaders() });
    if (res.ok) {
      const d = await res.json();
      document.getElementById('admStartTime').value = toLocalInputValue(d.startTime);
      showToast('🚀 Top départ lancé ! L\'enregistrement du replay commence maintenant.', 'success');
      refreshSnapshotsList();
    }
  });
  document.getElementById('btnAdmClearStartTime').addEventListener('click', () => {
    document.getElementById('admStartTime').value = '';
    postAdminConfig({ startTime: null });
  });
  document.getElementById('btnAdmClearEndTime').addEventListener('click', () => {
    document.getElementById('admEndTime').value = '';
    postAdminConfig({ endTime: null });
  });

  document.getElementById('btnAdmResize').addEventListener('click', () => {
    postAdminConfig({
      width: parseInt(document.getElementById('admWidth').value, 10),
      height: parseInt(document.getElementById('admHeight').value, 10),
      resizeAnchor: document.getElementById('admAnchor').value,
    });
  });

  document.getElementById('btnAdmAddColor').addEventListener('click', () => {
    const hex = document.getElementById('admNewColor').value.toUpperCase();
    if (!state.admPaletteDraft.includes(hex)) {
      state.admPaletteDraft.push(hex);
      renderAdminPaletteEditor();
    }
  });
  document.getElementById('btnAdmSavePalette').addEventListener('click', () => postAdminConfig({ palette: state.admPaletteDraft }));

  document.getElementById('btnAdmClearCanvas').addEventListener('click', async () => {
    if (!confirm('Effacer tout le canvas ? (Un snapshot de secours sera créé avant.)')) return;
    await fetch('/api/admin/clear', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ fillColor: 0, resetStats: false }) });
    refreshSnapshotsList();
  });
  document.getElementById('btnAdmFullReset').addEventListener('click', async () => {
    if (!confirm('RESET COMPLET : effacer le canvas, le classement et tout l\'historique timelapse ?')) return;
    await fetch('/api/admin/clear', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ fillColor: 0, resetStats: true }) });
    refreshSnapshotsList();
  });

  document.getElementById('btnAdmSaveAutoSnap').addEventListener('click', async () => {
    const ok = await postAdminConfig({
      autoSnapshotMinutes: parseInt(document.getElementById('admAutoSnapMin').value, 10) || 0,
      maxAutoSnapshots: parseInt(document.getElementById('admMaxAutoSnaps').value, 10) || 0,
    });
    if (ok) refreshSnapshotsList();
  });
  document.getElementById('btnAdmCreateSnap').addEventListener('click', async () => {
    const label = document.getElementById('admSnapLabel').value.trim() || 'manual';
    const res = await fetch('/api/admin/snapshots', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ label }) });
    if (res.ok) {
      document.getElementById('admSnapLabel').value = '';
      showToast('📸 Snapshot créé !', 'success');
      refreshSnapshotsList();
    }
  });

  document.getElementById('btnAdmSaveLoot').addEventListener('click', () => {
    postAdminConfig({
      lootboxEnabled: document.getElementById('admLootEnabled').checked,
      lootboxIntervalMinutes: parseInt(document.getElementById('admLootInterval').value, 10) || 60,
    });
  });

  async function triggerLootDrop(username = '') {
    const res = await fetch('/api/admin/lootbox/drop', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ username }),
    });
    const d = await res.json();
    if (!res.ok) { showToast(d.error || 'Drop impossible', 'error'); return; }
    showToast(`🎁 Lootbox envoyée à ${d.winner} !`, 'success');
  }
  document.getElementById('btnAdmDropRandom').addEventListener('click', () => triggerLootDrop(''));
  document.getElementById('btnAdmDropTarget').addEventListener('click', () => {
    const u = document.getElementById('admLootTargetInput').value.trim();
    if (!u) return;
    triggerLootDrop(u);
    document.getElementById('admLootTargetInput').value = '';
  });

  document.querySelectorAll('[data-bot-rate]').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.getElementById('admBotRate').value = chip.getAttribute('data-bot-rate');
    });
  });

  document.getElementById('btnAdminGiveAll')?.addEventListener('click', () => adminGiveBoost('all', 99));
  document.getElementById('btnAdmGiveAllBoosts')?.addEventListener('click', () => adminGiveBoost('all', 99));

  async function quantizeSelectedAdminImage() {
    const file = document.getElementById('admImportFile').files?.[0];
    if (!file) { showToast('Sélectionnez une image d\'abord.', 'error'); return null; }
    const startX = parseInt(document.getElementById('admImportX').value, 10) || 0;
    const startY = parseInt(document.getElementById('admImportY').value, 10) || 0;
    const targetW = Math.max(4, Math.min(500, parseInt(document.getElementById('admImportW').value, 10) || 48));

    const img = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = r.result; };
      r.readAsDataURL(file);
    });
    const targetH = Math.max(1, Math.round(targetW * (img.height / Math.max(1, img.width))));
    const tmp = document.createElement('canvas');
    tmp.width = targetW;
    tmp.height = targetH;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(img, 0, 0, targetW, targetH);
    const imgData = tctx.getImageData(0, 0, targetW, targetH).data;

    const pixels = [];
    for (let y = 0; y < targetH; y++) {
      for (let x = 0; x < targetW; x++) {
        const p = (y * targetW + x) * 4;
        if (imgData[p + 3] < 128) continue;
        const r = imgData[p], g = imgData[p + 1], b = imgData[p + 2];
        let bestIdx = 0, bestDist = Infinity;
        for (let ci = 0; ci < state.paletteRgba.length; ci++) {
          const pr = state.paletteRgba[ci];
          const d = (r - pr[0]) ** 2 + (g - pr[1]) ** 2 + (b - pr[2]) ** 2;
          if (d < bestDist) { bestDist = d; bestIdx = ci; }
        }
        pixels.push({ x: startX + x, y: startY + y, c: bestIdx });
      }
    }
    return { name: file.name, pixels };
  }

  document.getElementById('btnAdmImportImg').addEventListener('click', async () => {
    const data = await quantizeSelectedAdminImage();
    if (!data) return;
    const res = await fetch('/api/admin/import', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ pixels: data.pixels, author: state.nickname || 'Admin' }),
    });
    if (res.ok) showToast(`Image importée (${(await res.json()).applied} pixels) !`, 'success');
    else showToast('Erreur import.', 'error');
  });

  document.getElementById('btnAdmStartBot').addEventListener('click', async () => {
    const data = await quantizeSelectedAdminImage();
    if (!data) return;
    const ratePerSec = parseFloat(document.getElementById('admBotRate').value) || 5;
    const order = document.getElementById('admBotOrder').value || 'random';
    const maintain = document.getElementById('admBotMaintain').checked;
    const author = document.getElementById('admBotAuthor').value.trim() || 'PixelBot';

    const res = await fetch('/api/admin/bot/start', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        name: data.name,
        pixels: data.pixels,
        ratePerSec,
        order,
        maintain,
        author,
      }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(d.error || 'Impossible de lancer le bot', 'error');
      return;
    }
    showToast(`🤖 Bot "${d.job.name}" lancé (${d.job.totalPixels} px à ${d.job.ratePerSec} px/s) !`, 'success');
    refreshBotJobs();
  });

  document.getElementById('btnAdmStopAllBots').addEventListener('click', async () => {
    await fetch('/api/admin/bot/control', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ action: 'stop_all' }),
    });
    showToast('🛑 Tous les bots ont été arrêtés.');
    refreshBotJobs();
  });

  document.getElementById('btnAdmAddAdmin').addEventListener('click', async () => {
    const input = document.getElementById('admAddAdminInput');
    const username = input.value.trim();
    if (!username) return;
    const res = await fetch('/api/admin/admins', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ action: 'add', username }) });
    if (!res.ok) { showToast((await res.json().catch(() => ({}))).error || 'Erreur ajout admin', 'error'); return; }
    input.value = '';
    showToast(`👑 ${username} ajouté comme administrateur !`, 'success');
    refreshAdminsList();
  });
  document.getElementById('btnAdmRefreshAdmins').addEventListener('click', refreshAdminsList);

  document.getElementById('btnAdmBan').addEventListener('click', async () => {
    const target = document.getElementById('admBanInput').value.trim();
    if (!target) return;
    const res = await fetch('/api/admin/bans', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ action: 'ban', target }) });
    if (!res.ok) { showToast((await res.json().catch(() => ({}))).error || 'Restriction refusée', 'error'); return; }
    document.getElementById('admBanInput').value = '';
    refreshBansList();
  });
  document.getElementById('btnAdmRefreshBans').addEventListener('click', refreshBansList);

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  window.addEventListener('resize', resizeViewport);
  resizeViewport();
  requestAnimationFrame(renderFrame);
  bootstrap();
})();
