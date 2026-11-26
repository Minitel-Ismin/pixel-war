'use strict';

(() => {
  // ─────────────────────────── DOM Elements ───────────────────────────
  const viewport = document.getElementById('viewport');
  const ctx = viewport.getContext('2d', { alpha: false });

  const el = {
    connDot: document.getElementById('connDot'),
    eventTitle: document.getElementById('eventTitle'),
    onlineBadge: document.getElementById('onlineBadge'),
    canvasSizeBadge: document.getElementById('canvasSizeBadge'),
    pausedBadge: document.getElementById('pausedBadge'),
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
  };

  // ─────────────────────────── Application State ───────────────────────────
  const state = {
    config: {
      title: 'Pixel War',
      width: 128,
      height: 128,
      cooldownMs: 5000,
      maxCharges: 1,
      cooldownMode: 'client',
      paused: false,
      manualPaused: false,
      allowSameColor: false,
      allowPublicExport: true,
      allowTimelapse: true,
      requireNickname: false,
      announcement: '',
      endTime: null,
      autoSnapshotMinutes: 15,
      palette: ['#FFFFFF', '#000000'],
      totalPixelsPlaced: 0,
    },
    presets: {},
    paletteRgba: [], // [ [r,g,b,255], ... ]
    pixels: new Uint8Array(128 * 128),
    selectedColor: 1,
    selectedPixel: null, // { x, y }
    hoverPixel: null,
    online: 0,
    isAdmin: false,
    adminToken: sessionStorage.getItem('pw_admin_token') || '',
    adminBypass: false,
    adminBrushSize: 1,
    nickname: localStorage.getItem('pw_nickname') || '',
    showGrid: true,
    eyedropperMode: false,
    directPlaceMode: false,
    soundEnabled: false,
    // Cooldown synced from server
    cooldown: {
      charges: 1,
      maxCharges: 1,
      nextRefillAt: 0, // performance.now() timestamp when next charge refills
      cooldownMs: 5000,
    },
    serverTimeOffset: 0,
    // Camera (world pixel coordinates)
    cam: {
      x: 64,
      y: 64,
      zoom: 6, // screen CSS pixels per canvas pixel
      minZoom: 0.5,
      maxZoom: 48,
    },
    // Visual placement pulses
    pulses: [], // { x, y, colorHex, start }
    // Client-side guide overlay
    overlay: {
      img: null,
      visible: true,
      x: 0,
      y: 0,
      w: 32,
      opacity: 0.5,
    },
    // Offscreen canvas buffer (1:1 pixel resolution)
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
    }, 3000);
  }

  function playPopSound(freq = 520) {
    if (!state.soundEnabled) return;
    try {
      if (!state.audioCtx) {
        state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
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
      // ignore audio restrictions
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

  function adminHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (state.adminToken) h['X-Admin-Token'] = state.adminToken;
    return h;
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
    state.pulses.push({
      x,
      y,
      colorHex: state.config.palette[colorIdx] || '#fff',
      start: performance.now(),
    });
    if (state.pulses.length > 60) state.pulses.shift();
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
    const fitZoom = Math.min(availW / w, availH / h);
    state.cam.zoom = Math.max(0.8, Math.min(20, fitZoom));
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
    const hasPulses = state.pulses.length > 0;

    if (state.needsRender || hasPulses) {
      state.needsRender = false;
      ctx.fillStyle = '#090d16';
      ctx.fillRect(0, 0, vw, vh);

      const tl = worldToScreen(0, 0);
      const drawW = state.config.width * state.cam.zoom;
      const drawH = state.config.height * state.cam.zoom;

      // Subtle canvas drop shadow & frame
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(tl.sx - 3, tl.sy - 3, drawW + 6, drawH + 6);

      // Draw pixel-perfect canvas
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(state.offscreen, tl.sx, tl.sy, drawW, drawH);

      // Optional user template overlay
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

      // Pixel grid (when zoomed in enough)
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

      // Outer border
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(tl.sx, tl.sy, drawW, drawH);

      // Placement ripple animations
      if (hasPulses) {
        for (let i = state.pulses.length - 1; i >= 0; i--) {
          const p = state.pulses[i];
          const t = (now - p.start) / 420;
          if (t >= 1) {
            state.pulses.splice(i, 1);
            continue;
          }
          const pos = worldToScreen(p.x, p.y);
          const expand = t * Math.max(6, state.cam.zoom * 0.7);
          ctx.strokeStyle = `rgba(255, 255, 255, ${(1 - t) * 0.85})`;
          ctx.lineWidth = 2;
          ctx.strokeRect(
            pos.sx - expand / 2,
            pos.sy - expand / 2,
            state.cam.zoom + expand,
            state.cam.zoom + expand
          );
        }
      }

      // Hover highlight (desktop)
      if (state.hoverPixel) {
        const { x, y } = state.hoverPixel;
        if (x >= 0 && x < state.config.width && y >= 0 && y < state.config.height) {
          const pos = worldToScreen(x, y);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(pos.sx + 0.5, pos.sy + 0.5, state.cam.zoom - 1, state.cam.zoom - 1);
        }
      }

      // Selected pixel reticle + color preview
      if (state.selectedPixel) {
        const { x, y } = state.selectedPixel;
        const brush = state.isAdmin && state.adminBypass ? state.adminBrushSize : 1;
        const half = Math.floor(brush / 2);
        const pos = worldToScreen(x - half, y - half);
        const size = state.cam.zoom * brush;

        // Subtle inner preview of selected color
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = state.config.palette[state.selectedColor] || '#fff';
        ctx.fillRect(pos.sx + 1, pos.sy + 1, Math.max(1, size - 2), Math.max(1, size - 2));
        ctx.restore();

        // Crisp double border reticle
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 3;
        ctx.strokeRect(pos.sx - 1, pos.sy - 1, size + 2, size + 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(pos.sx - 1, pos.sy - 1, size + 2, size + 2);
      }
    }

    updateCooldownUI(now);
    requestAnimationFrame(renderFrame);
  }

  // ─────────────────────────── Cooldown & HUD Updates ───────────────────────────
  function syncCooldownFromServer(cd) {
    if (!cd) return;
    state.cooldown.charges = cd.charges ?? 1;
    state.cooldown.maxCharges = cd.maxCharges ?? state.config.maxCharges;
    state.cooldown.cooldownMs = cd.cooldownMs ?? state.config.cooldownMs;
    if (cd.nextRefillMs > 0) {
      state.cooldown.nextRefillAt = performance.now() + cd.nextRefillMs;
    } else {
      state.cooldown.nextRefillAt = 0;
    }
  }

  function updateCooldownUI(now) {
    // Advance local refill timer smoothly
    const cd = state.cooldown;
    if (cd.charges < cd.maxCharges && cd.cooldownMs > 0 && cd.nextRefillAt > 0) {
      while (now >= cd.nextRefillAt && cd.charges < cd.maxCharges) {
        cd.charges++;
        if (cd.charges < cd.maxCharges) {
          cd.nextRefillAt += cd.cooldownMs;
        } else {
          cd.nextRefillAt = 0;
        }
      }
    }

    // Countdown badge if endTime is set
    if (state.config.endTime) {
      const serverNow = Date.now() + state.serverTimeOffset;
      const remain = Date.parse(state.config.endTime) - serverNow;
      el.countdownBadge.classList.remove('hidden');
      el.countdownBadge.textContent = remain > 0 ? `⏱ ${formatCountdown(remain)}` : '🏁 Terminé';
    } else {
      el.countdownBadge.classList.add('hidden');
    }

    // Selected color swatch
    const hex = state.config.palette[state.selectedColor] || '#FFFFFF';
    el.selectedSwatch.style.backgroundColor = hex;

    // Charges badge (shown when stacking > 1)
    if (cd.maxCharges > 1 && !(state.isAdmin && state.adminBypass)) {
      el.chargesBadge.classList.remove('hidden');
      el.chargesBadge.textContent = `⚡ ${cd.charges}/${cd.maxCharges}`;
    } else {
      el.chargesBadge.classList.add('hidden');
    }

    // Place button state
    const isAdminFree = state.isAdmin && state.adminBypass;
    if (state.config.paused && !isAdminFree) {
      el.btnPlace.disabled = true;
      el.btnPlace.classList.remove('cooldown');
      el.placeProgress.style.width = '0%';
      el.placeBtnText.textContent = '⏸ Canvas figé';
      return;
    }

    if (!isAdminFree && cd.charges <= 0 && cd.cooldownMs > 0) {
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
      el.placeBtnText.textContent = 'Touchez un pixel sur le canvas';
      return;
    }

    el.btnPlace.disabled = false;
    const { x, y } = state.selectedPixel;
    if (isAdminFree) {
      el.placeBtnText.textContent = `👑 Poser Admin (${x}, ${y})`;
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

    el.nickLabel.textContent = state.nickname || 'Pseudo';
    el.adminQuickBar.classList.toggle('hidden', !state.isAdmin);
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
        if (info.author) {
          el.pixelAuthorText.textContent = `Par ${info.author} • ${formatTimeAgo(info.timestamp)}`;
        } else if (info.timestamp) {
          el.pixelAuthorText.textContent = `Anonyme • ${formatTimeAgo(info.timestamp)}`;
        } else {
          el.pixelAuthorText.textContent = 'Pixel vierge';
        }
      }
    } catch {
      // aborted or network error
    }
  }

  // ─────────────────────────── Placement Logic ───────────────────────────
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

    const { x, y } = state.selectedPixel;
    state.ws.send(JSON.stringify({
      type: 'place',
      x,
      y,
      color: state.selectedColor,
      nickname: state.nickname,
      adminBypass: state.isAdmin && state.adminBypass,
      brushSize: state.isAdmin && state.adminBypass ? state.adminBrushSize : 1,
    }));
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
      const data = await res.json();
      state.config = data.config;
      state.presets = data.presets || {};
      state.online = data.online || 0;
      state.isAdmin = Boolean(data.isAdmin);
      if (data.authentikUser && !state.nickname) {
        state.nickname = data.authentikUser.username || data.authentikUser.name || '';
      }
      state.serverTimeOffset = (data.serverTime || Date.now()) - Date.now();
      syncCooldownFromServer(data.cooldown);
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
      if (state.nickname) {
        ws.send(JSON.stringify({ type: 'set_nickname', nickname: state.nickname }));
      }
      if (state.adminToken) {
        ws.send(JSON.stringify({ type: 'auth_admin', token: state.adminToken }));
      }
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
      // Compact 6-byte binary pixel update: [0x01, x_hi, x_lo, y_hi, y_lo, color]
      if (ev.data instanceof ArrayBuffer) {
        const view = new DataView(ev.data);
        if (view.byteLength >= 6 && view.getUint8(0) === 0x01) {
          const x = view.getUint16(1, false);
          const y = view.getUint16(3, false);
          const c = view.getUint8(5);
          updateSinglePixelBuffer(x, y, c);
        }
        return;
      }

      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg.type === 'hello') {
        state.config = msg.config;
        state.online = msg.online;
        state.isAdmin = Boolean(msg.isAdmin || state.isAdmin);
        state.serverTimeOffset = (msg.serverTime || Date.now()) - Date.now();
        el.onlineBadge.textContent = `● ${msg.online}`;
        syncCooldownFromServer(msg.cooldown);
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
      } else if (msg.type === 'place_ok') {
        syncCooldownFromServer(msg.cooldown);
        playPopSound(560);
        if (navigator.vibrate) navigator.vibrate(12);
        if (state.selectedPixel && state.selectedPixel.x === msg.x && state.selectedPixel.y === msg.y) {
          inspectPixel(msg.x, msg.y);
        }
      } else if (msg.type === 'place_error') {
        if (msg.cooldown) syncCooldownFromServer(msg.cooldown);
        showToast(msg.message || 'Action impossible', 'error');
      } else if (msg.type === 'admin_status') {
        state.isAdmin = Boolean(msg.isAdmin);
        applyConfigUI();
      }
    };
  }

  // ─────────────────────────── Pointer / Touch / Keyboard Controls ───────────────────────────
  const pointers = new Map(); // pointerId -> { x, y }
  let dragStart = null;
  let hasDragged = false;
  let pinchStartDist = 0;
  let pinchStartMid = null;
  let pinchStartZoom = 1;
  let spacePressed = false;

  viewport.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return; // right click handled by contextmenu
    viewport.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1) {
      dragStart = { x: e.clientX, y: e.clientY, camX: state.cam.x, camY: state.cam.y };
      hasDragged = false;
    } else if (pointers.size === 2) {
      hasDragged = true; // prevent tap on pinch release
      const pts = Array.from(pointers.values());
      pinchStartDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      pinchStartMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      pinchStartZoom = state.cam.zoom;
      dragStart = { x: pinchStartMid.x, y: pinchStartMid.y, camX: state.cam.x, camY: state.cam.y };
    }
  });

  viewport.addEventListener('pointermove', (e) => {
    // Update desktop hover preview
    if (pointers.size === 0 && e.pointerType === 'mouse') {
      const w = screenToWorld(e.clientX, e.clientY);
      state.hoverPixel = { x: w.px, y: w.py };
      state.needsRender = true;
      return;
    }

    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

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
      // Keep world point under initial pinch midpoint aligned with current midpoint
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

    if (wasSingle && !hasDragged && !spacePressed && e.type === 'pointerup') {
      const { px, py } = screenToWorld(e.clientX, e.clientY);
      selectPixel(px, py, true);
    }

    if (pointers.size === 1) {
      const remaining = Array.from(pointers.values())[0];
      dragStart = { x: remaining.x, y: remaining.y, camX: state.cam.x, camY: state.cam.y };
      hasDragged = true; // avoid accidental tap after lifting 1 finger from pinch
    } else if (pointers.size === 0) {
      dragStart = null;
      pinchStartDist = 0;
    }
  }

  viewport.addEventListener('pointerup', onPointerEnd);
  viewport.addEventListener('pointercancel', onPointerEnd);
  viewport.addEventListener('pointerleave', () => {
    state.hoverPixel = null;
    state.needsRender = true;
  });

  // Mouse wheel zoom centered on cursor
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    zoomAt(e.clientX, e.clientY, factor);
  }, { passive: false });

  // Right-click eyedropper
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

  // Keyboard shortcuts (desktop)
  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.code === 'Space') {
      spacePressed = true;
      return;
    }
    if (e.key === '+' || e.key === '=') {
      zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.3);
    } else if (e.key === '-' || e.key === '_') {
      zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.3);
    } else if (e.key === 'g' || e.key === 'G') {
      toggleGrid();
    } else if (e.key === 'i' || e.key === 'I') {
      toggleEyedropper();
    } else if (e.key === 'Enter' && state.selectedPixel) {
      placeSelectedPixel();
    } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      if (!state.selectedPixel) {
        selectPixel(Math.floor(state.config.width / 2), Math.floor(state.config.height / 2), false);
      } else {
        const dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        const dy = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
        const nx = Math.max(0, Math.min(state.config.width - 1, state.selectedPixel.x + dx));
        const ny = Math.max(0, Math.min(state.config.height - 1, state.selectedPixel.y + dy));
        selectPixel(nx, ny, false);
      }
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') spacePressed = false;
  });

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

  document.getElementById('btnZoomIn').addEventListener('click', () => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.4));
  document.getElementById('btnZoomOut').addEventListener('click', () => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.4));
  document.getElementById('btnResetView').addEventListener('click', centerCamera);
  document.getElementById('btnGrid').addEventListener('click', toggleGrid);
  document.getElementById('btnEyedropper').addEventListener('click', toggleEyedropper);
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
    const sizes = [1, 3, 5];
    const next = sizes[(sizes.indexOf(state.adminBrushSize) + 1) % sizes.length];
    state.adminBrushSize = next;
    el.btnBrushSize.textContent = `${next}×`;
    state.needsRender = true;
  });

  // ─────────────────────────── Modals System ───────────────────────────
  function openModal(id) {
    document.getElementById(id)?.classList.remove('hidden');
  }
  function closeModal(id) {
    document.getElementById(id)?.classList.add('hidden');
    if (id === 'modalTimelapse') stopTimelapse();
  }

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close')));
  });
  document.querySelectorAll('.modal').forEach((modal) => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal(modal.id);
    });
  });

  // ─────────────────────────── Profile Modal ───────────────────────────
  document.getElementById('btnProfile').addEventListener('click', () => {
    document.getElementById('inputNickname').value = state.nickname;
    openModal('modalProfile');
  });

  document.getElementById('btnSaveProfile').addEventListener('click', () => {
    const val = document.getElementById('inputNickname').value.trim().slice(0, 24);
    state.nickname = val;
    localStorage.setItem('pw_nickname', val);
    el.nickLabel.textContent = val || 'Pseudo';
    if (state.wsConnected && state.ws) {
      state.ws.send(JSON.stringify({ type: 'set_nickname', nickname: val }));
    }
    closeModal('modalProfile');
    showToast(val ? `Pseudo enregistré : ${val}` : 'Pseudo effacé', 'success');
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
      if (!data.leaderboard.length) {
        list.innerHTML = '<div class="muted small">Aucun contributeur nommé pour le moment.</div>';
      } else {
        list.innerHTML = data.leaderboard
          .map((row) => {
            const medal = row.rank === 1 ? '🥇' : row.rank === 2 ? '🥈' : row.rank === 3 ? '🥉' : `#${row.rank}`;
            return `<div class="list-row"><span><strong>${medal}</strong> ${escapeHtml(row.name)}</span><span class="mono">${row.count} px</span></div>`;
          })
          .join('');
      }

      const totalCanvasPx = state.config.width * state.config.height;
      const bar = document.getElementById('colorStatsBar');
      bar.innerHTML = data.colors
        .filter((c) => c.count > 0)
        .sort((a, b) => b.count - a.count)
        .map((c) => {
          const pct = (c.count / totalCanvasPx) * 100;
          return `<div style="width:${pct}%;background:${c.hex}" title="${c.hex}: ${c.count} px (${pct.toFixed(1)}%)"></div>`;
        })
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

  // ─────────────────────────── Timelapse Replay & WebM Export ───────────────────────────
  const tl = {
    events: [],
    palette: [],
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
    tctx.fillStyle = tl.palette[0] || '#FFFFFF';
    tctx.fillRect(0, 0, tl.width, tl.height);
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
    for (let i = 0; i < clamped; i++) {
      tlApplyEvent(tl.events[i], tctx);
    }
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
      for (let i = tl.index; i < end; i++) {
        tlApplyEvent(tl.events[i], tctx);
      }
      tl.index = end;
      updateTlScrubber();
    }

    if (tl.index >= tl.events.length) {
      stopTimelapse();
      return;
    }
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
    if (tl.recorder && tl.recorder.state === 'recording') {
      tl.recorder.stop();
    }
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
      tlResetCanvas();
      if (tl.events.length > 0) startTimelapse();
    } catch {
      showToast('Impossible de charger l\'historique', 'error');
    }
  });

  document.getElementById('btnTlPlay').addEventListener('click', () => {
    if (tl.playing) stopTimelapse();
    else startTimelapse();
  });

  document.getElementById('btnTlRestart').addEventListener('click', () => {
    stopTimelapse();
    tlResetCanvas();
    startTimelapse();
  });

  document.getElementById('tlScrubber').addEventListener('input', (e) => {
    stopTimelapse();
    tlSeekTo(parseInt(e.target.value, 10) || 0);
  });

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
    tl.recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) tl.recordedChunks.push(ev.data);
    };
    tl.recorder.onstop = () => {
      const blob = new Blob(tl.recordedChunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pixel-war-timelapse.webm`;
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
    document.getElementById('admRequireNick').checked = Boolean(c.requireNickname);
    document.getElementById('admAllowSameColor').checked = Boolean(c.allowSameColor);
    document.getElementById('admAllowExport').checked = Boolean(c.allowPublicExport);
    document.getElementById('admAllowTimelapse').checked = Boolean(c.allowTimelapse);
    document.getElementById('admWidth').value = c.width;
    document.getElementById('admHeight').value = c.height;
    document.getElementById('admAutoSnapMin').value = c.autoSnapshotMinutes ?? 15;

    if (c.endTime) {
      const d = new Date(c.endTime);
      const localIso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      document.getElementById('admEndTime').value = localIso;
    } else {
      document.getElementById('admEndTime').value = '';
    }

    state.admPaletteDraft = [...c.palette];
    renderAdminPaletteEditor();
    renderPalettePresets();
  }

  function renderPalettePresets() {
    const row = document.getElementById('palettePresetsRow');
    row.innerHTML = '';
    for (const [key, preset] of Object.entries(state.presets)) {
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
    const container = document.getElementById('snapshotsList');
    if (!data.snapshots.length) {
      container.innerHTML = '<div class="muted small">Aucun snapshot sauvegardé pour l\'instant.</div>';
      return;
    }
    container.innerHTML = '';
    for (const snap of data.snapshots) {
      const row = document.createElement('div');
      row.className = 'list-row';
      const dateStr = new Date(snap.createdAt).toLocaleString('fr-FR');
      row.innerHTML = `
        <div>
          <strong>${escapeHtml(snap.label)}</strong> <span class="muted small">(${snap.width}×${snap.height})</span><br/>
          <span class="muted small">${dateStr} • ${snap.totalPixelsPlaced} px</span>
        </div>
        <div class="btn-row">
          <a class="btn btn-secondary btn-sm" href="/api/admin/snapshots/${encodeURIComponent(snap.id)}/png">⬇ PNG</a>
          <button class="btn btn-primary btn-sm" data-restore>↺ Restaurer</button>
          <button class="btn btn-danger btn-sm" data-del>🗑</button>
        </div>
      `;
      row.querySelector('[data-restore]').addEventListener('click', async () => {
        if (!confirm(`Restaurer le snapshot "${snap.label}" ? Le canvas actuel sera remplacé.`)) return;
        const r = await fetch(`/api/admin/snapshots/${encodeURIComponent(snap.id)}/restore`, {
          method: 'POST',
          headers: adminHeaders(),
        });
        if (r.ok) showToast('Snapshot restauré !', 'success');
      });
      row.querySelector('[data-del]').addEventListener('click', async () => {
        await fetch(`/api/admin/snapshots/${encodeURIComponent(snap.id)}`, {
          method: 'DELETE',
          headers: adminHeaders(),
        });
        refreshSnapshotsList();
      });
      container.appendChild(row);
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
          await fetch('/api/admin/bans', {
            method: 'POST',
            headers: adminHeaders(),
            body: JSON.stringify({ action: 'unban', target }),
          });
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
      row.innerHTML = `
        <span class="small"><strong>${escapeHtml(c.nickname || 'Anonyme')}</strong> • <span class="mono">${escapeHtml(badge)}</span></span>
        <button class="btn btn-danger btn-sm">Restreindre</button>
      `;
      row.querySelector('button').addEventListener('click', async () => {
        const r = await fetch('/api/admin/bans', {
          method: 'POST',
          headers: adminHeaders(),
          body: JSON.stringify({ action: 'ban', target: targetId }),
        });
        if (r.ok) {
          showToast('Utilisateur restreint.', 'info');
          refreshBansList();
        }
      });
      clientsEl.appendChild(row);
    }
  }

  function showAdminView() {
    document.getElementById('adminLoginView').classList.toggle('hidden', state.isAdmin);
    document.getElementById('adminPanelView').classList.toggle('hidden', !state.isAdmin);
    if (state.isAdmin) {
      populateAdminForm();
      refreshSnapshotsList();
      refreshBansList();
    }
  }

  document.getElementById('btnAdmin').addEventListener('click', () => {
    showAdminView();
    openModal('modalAdmin');
  });

  // Admin Tabs
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.getAttribute('data-tab')).classList.add('active');
    });
  });

  // Cooldown preset chips
  document.querySelectorAll('[data-cd]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const ms = parseInt(chip.getAttribute('data-cd'), 10);
      document.getElementById('admCooldownSec').value = (ms / 1000).toString();
    });
  });

  // Admin login submit
  document.getElementById('adminLoginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('adminLoginError');
    errEl.classList.add('hidden');
    const password = document.getElementById('inputAdminPassword').value;
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'Connexion refusée';
      errEl.classList.remove('hidden');
      return;
    }
    state.isAdmin = true;
    state.adminToken = data.token;
    sessionStorage.setItem('pw_admin_token', data.token);
    if (state.wsConnected && state.ws) {
      state.ws.send(JSON.stringify({ type: 'auth_admin', token: data.token }));
    }
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
    showToast('Déconnecté.');
  });

  async function postAdminConfig(patch) {
    const res = await fetch('/api/admin/config', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Erreur mise à jour', 'error');
      return false;
    }
    showToast('✅ Réglages appliqués en direct à tous les joueurs !', 'success');
    return true;
  }

  document.getElementById('btnAdmSaveRules').addEventListener('click', () => {
    const cdSec = parseFloat(document.getElementById('admCooldownSec').value);
    const endRaw = document.getElementById('admEndTime').value;
    postAdminConfig({
      cooldownMs: Number.isFinite(cdSec) ? Math.round(cdSec * 1000) : 5000,
      maxCharges: parseInt(document.getElementById('admMaxCharges').value, 10) || 1,
      cooldownMode: document.getElementById('admCooldownMode').value,
      title: document.getElementById('admTitle').value,
      announcement: document.getElementById('admAnnouncement').value,
      paused: document.getElementById('admPaused').checked,
      requireNickname: document.getElementById('admRequireNick').checked,
      allowSameColor: document.getElementById('admAllowSameColor').checked,
      allowPublicExport: document.getElementById('admAllowExport').checked,
      allowTimelapse: document.getElementById('admAllowTimelapse').checked,
      endTime: endRaw ? new Date(endRaw).toISOString() : null,
    });
  });

  document.getElementById('btnAdmClearEndTime').addEventListener('click', () => {
    document.getElementById('admEndTime').value = '';
    postAdminConfig({ endTime: null });
  });

  document.getElementById('btnAdmResize').addEventListener('click', () => {
    const w = parseInt(document.getElementById('admWidth').value, 10);
    const h = parseInt(document.getElementById('admHeight').value, 10);
    const anchor = document.getElementById('admAnchor').value;
    postAdminConfig({ width: w, height: h, resizeAnchor: anchor });
  });

  document.getElementById('btnAdmAddColor').addEventListener('click', () => {
    const hex = document.getElementById('admNewColor').value.toUpperCase();
    if (!state.admPaletteDraft.includes(hex)) {
      state.admPaletteDraft.push(hex);
      renderAdminPaletteEditor();
    }
  });

  document.getElementById('btnAdmSavePalette').addEventListener('click', () => {
    postAdminConfig({ palette: state.admPaletteDraft });
  });

  document.getElementById('btnAdmClearCanvas').addEventListener('click', async () => {
    if (!confirm('Effacer tout le canvas ? (Un snapshot de sauvegarde sera créé avant.)')) return;
    await fetch('/api/admin/clear', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ fillColor: 0, resetStats: false }),
    });
    refreshSnapshotsList();
  });

  document.getElementById('btnAdmFullReset').addEventListener('click', async () => {
    if (!confirm('RESET COMPLET : effacer le canvas, le classement et tout l\'historique timelapse ?')) return;
    await fetch('/api/admin/clear', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ fillColor: 0, resetStats: true }),
    });
    refreshSnapshotsList();
  });

  document.getElementById('btnAdmCreateSnap').addEventListener('click', async () => {
    const label = document.getElementById('admSnapLabel').value.trim() || 'manual';
    const res = await fetch('/api/admin/snapshots', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ label }),
    });
    if (res.ok) {
      document.getElementById('admSnapLabel').value = '';
      showToast('📸 Snapshot créé sur le serveur !', 'success');
      refreshSnapshotsList();
    }
  });

  document.getElementById('btnAdmSaveAutoSnap').addEventListener('click', () => {
    const mins = parseInt(document.getElementById('admAutoSnapMin').value, 10) || 0;
    postAdminConfig({ autoSnapshotMinutes: mins });
  });

  // Admin Image Import (quantizes to active palette and sends patch)
  document.getElementById('btnAdmImportImg').addEventListener('click', async () => {
    const file = document.getElementById('admImportFile').files?.[0];
    if (!file) {
      showToast('Sélectionnez une image d\'abord.', 'error');
      return;
    }
    const startX = parseInt(document.getElementById('admImportX').value, 10) || 0;
    const startY = parseInt(document.getElementById('admImportY').value, 10) || 0;
    const targetW = Math.max(4, Math.min(500, parseInt(document.getElementById('admImportW').value, 10) || 48));

    const img = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = r.result;
      };
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
        const a = imgData[p + 3];
        if (a < 128) continue; // skip transparent pixels
        const r = imgData[p], g = imgData[p + 1], b = imgData[p + 2];
        // Find nearest palette color
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let ci = 0; ci < state.paletteRgba.length; ci++) {
          const pr = state.paletteRgba[ci];
          const d = (r - pr[0]) ** 2 + (g - pr[1]) ** 2 + (b - pr[2]) ** 2;
          if (d < bestDist) {
            bestDist = d;
            bestIdx = ci;
          }
        }
        pixels.push({ x: startX + x, y: startY + y, c: bestIdx });
      }
    }

    const res = await fetch('/api/admin/import', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ pixels, author: state.nickname || 'Admin' }),
    });
    if (res.ok) {
      const d = await res.json();
      showToast(`Image importée (${d.applied} pixels dessinés) !`, 'success');
    } else {
      showToast('Erreur lors de l\'import.', 'error');
    }
  });

  document.getElementById('btnAdmBan').addEventListener('click', async () => {
    const target = document.getElementById('admBanInput').value.trim();
    if (!target) return;
    const res = await fetch('/api/admin/bans', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ action: 'ban', target }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Restriction refusée', 'error');
      return;
    }
    document.getElementById('admBanInput').value = '';
    refreshBansList();
  });

  document.getElementById('btnAdmRefreshBans').addEventListener('click', refreshBansList);

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  // ─────────────────────────── Init ───────────────────────────
  window.addEventListener('resize', resizeViewport);
  resizeViewport();
  requestAnimationFrame(renderFrame);
  bootstrap();
})();
