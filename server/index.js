'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const { WebSocketServer } = require('./ws');
const { PixelWarStore, PALETTE_PRESETS, sanitizeNickname } = require('./store');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function createServer(options = {}) {
  const port = options.port ?? parseInt(process.env.PORT || '3000', 10);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  const trustProxy = options.trustProxy ?? (process.env.TRUST_PROXY !== 'false');
  const trustAuthentik = options.trustAuthentik ?? (process.env.TRUST_AUTHENTIK_HEADERS === 'true');
  const authentikAdminGroups = new Set(
    String(options.authentikAdminGroups ?? process.env.AUTHENTIK_ADMIN_GROUPS ?? 'admins-infra')
      .split(',')
      .map((g) => g.trim().toLowerCase())
      .filter(Boolean)
  );
  const adminPassword = options.adminPassword ?? process.env.ADMIN_PASSWORD ?? 'promo-admin-2026';
  const sessionSecret = options.sessionSecret ?? process.env.SESSION_SECRET ?? crypto.randomBytes(32).toString('hex');
  const publicDir = options.publicDir || path.join(__dirname, '..', 'public');

  const store = new PixelWarStore({ dataDir: options.dataDir });

  // Active admin sessions: token -> expiresAt
  const adminSessions = new Map();
  // Rate-limit admin login by signed clientId (NEVER by IP: all MINITEL traffic shares VPS IP)
  const loginAttempts = new Map();

  // Binary WS frame: [0x01, x_hi, x_lo, y_hi, y_lo, colorIndex]
  function encodePixelBinary(x, y, color) {
    const buf = Buffer.allocUnsafe(6);
    buf[0] = 0x01;
    buf.writeUInt16BE(x, 1);
    buf.writeUInt16BE(y, 3);
    buf[5] = color & 0xff;
    return buf;
  }

  function isHttpsRequest(req) {
    if (!trustProxy) return false;
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    return proto === 'https';
  }

  function getAuthentikIdentity(req) {
    if (!trustAuthentik) return null;
    const uid = String(req.headers['x-authentik-uid'] || '').trim();
    const username = sanitizeNickname(String(req.headers['x-authentik-username'] || ''));
    if (!uid && !username) return null;
    const name = sanitizeNickname(String(req.headers['x-authentik-name'] || '')) || username;
    const rawGroups = String(req.headers['x-authentik-groups'] || '');
    const groups = rawGroups
      .split(/[|,]/)
      .map((g) => g.trim())
      .filter(Boolean);
    const isAdminGroup = groups.some((g) => authentikAdminGroups.has(g.toLowerCase()));
    return {
      uid: uid || username,
      username: username || name,
      name,
      groups,
      isAdmin: isAdminGroup,
    };
  }

  function parseCookies(req) {
    const out = {};
    const raw = req.headers.cookie;
    if (!raw) return out;
    for (const part of raw.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      out[k] = decodeURIComponent(v);
    }
    return out;
  }

  function signClientId(id) {
    const sig = crypto.createHmac('sha256', sessionSecret).update(id).digest('base64url').slice(0, 16);
    return `${id}.${sig}`;
  }

  function verifySignedClientId(token) {
    if (typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot === -1) return null;
    const id = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!/^[a-f0-9]{16,32}$/.test(id)) return null;
    const expected = crypto.createHmac('sha256', sessionSecret).update(id).digest('base64url').slice(0, 16);
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    return id;
  }

  function ensureClientId(req, res) {
    const cookies = parseCookies(req);
    const existing = verifySignedClientId(cookies.pw_cid);
    if (existing) return existing;
    const newId = crypto.randomBytes(12).toString('hex');
    const signed = signClientId(newId);
    if (res) {
      const secure = isHttpsRequest(req) ? '; Secure' : '';
      res.setHeader('Set-Cookie', `pw_cid=${signed}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
    }
    return newId;
  }

  function getAdminToken(req) {
    const hdr = req.headers['x-admin-token'];
    if (typeof hdr === 'string' && hdr.length > 0) return hdr;
    const cookies = parseCookies(req);
    return cookies.pw_admin || null;
  }

  function isAdmin(req) {
    const ak = getAuthentikIdentity(req);
    if (ak && ak.isAdmin) return true;
    const token = getAdminToken(req);
    if (!token) return false;
    const exp = adminSessions.get(token);
    if (!exp) return false;
    if (Date.now() > exp) {
      adminSessions.delete(token);
      return false;
    }
    return true;
  }

  function sendJSON(res, status, data, extraHeaders = {}) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    res.end(body);
  }

  async function readJsonBody(req, maxBytes = 4 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          reject(new Error('BODY_TOO_LARGE'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (chunks.length === 0) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('INVALID_JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname;
      const method = req.method || 'GET';

      // Health check for Coolify / Docker
      if (pathname === '/health' || pathname === '/api/health') {
        return sendJSON(res, 200, {
          status: 'ok',
          uptime: Math.floor(process.uptime()),
          online: wss.clients.size,
          width: store.config.width,
          height: store.config.height,
          totalPixelsPlaced: store.totalPixelsPlaced,
        });
      }

      // Public API: bootstrap config + signed client cookie (+ optional Authentik identity)
      if (pathname === '/api/config' && method === 'GET') {
        const clientId = ensureClientId(req, res);
        const ak = getAuthentikIdentity(req);
        const admin = isAdmin(req);
        return sendJSON(res, 200, {
          config: store.getPublicConfig(),
          presets: PALETTE_PRESETS,
          online: wss.clients.size,
          cooldown: store.getCooldownStatus(clientId, ak?.uid || '', false),
          isAdmin: admin,
          authentikUser: ak ? { username: ak.username, name: ak.name, groups: ak.groups } : null,
          serverTime: Date.now(),
        });
      }

      // Public API: binary canvas download (gzipped if supported)
      if (pathname === '/api/canvas' && method === 'GET') {
        const rawBuf = Buffer.from(store.pixels.buffer, store.pixels.byteOffset, store.pixels.byteLength);
        const acceptEncoding = String(req.headers['accept-encoding'] || '');
        const headers = {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-store',
          'X-Canvas-Width': String(store.config.width),
          'X-Canvas-Height': String(store.config.height),
        };
        if (acceptEncoding.includes('gzip')) {
          const gz = zlib.gzipSync(rawBuf, { level: 6 });
          res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
          return res.end(gz);
        }
        res.writeHead(200, { ...headers, 'Content-Length': rawBuf.length });
        return res.end(rawBuf);
      }

      // Public API: inspect single pixel author/timestamp
      if (pathname === '/api/pixel' && method === 'GET') {
        const x = parseInt(parsedUrl.searchParams.get('x') || '-1', 10);
        const y = parseInt(parsedUrl.searchParams.get('y') || '-1', 10);
        const info = store.getPixelInfo(x, y);
        if (!info) return sendJSON(res, 404, { error: 'Pixel hors limites' });
        return sendJSON(res, 200, info);
      }

      // Public API: leaderboard & color stats
      if (pathname === '/api/stats' && method === 'GET') {
        return sendJSON(res, 200, {
          ...store.getLeaderboard(25),
          online: wss.clients.size,
          historyCount: store.historyCount,
        });
      }

      // Public API: timelapse history
      if (pathname === '/api/history' && method === 'GET') {
        if (!store.config.allowTimelapse && !isAdmin(req)) {
          return sendJSON(res, 403, { error: 'Timelapse désactivé par l\'administrateur.' });
        }
        const events = store.readHistory(150000);
        const body = JSON.stringify({
          width: store.config.width,
          height: store.config.height,
          palette: store.config.palette,
          events,
        });
        const acceptEncoding = String(req.headers['accept-encoding'] || '');
        if (acceptEncoding.includes('gzip')) {
          const gz = zlib.gzipSync(Buffer.from(body, 'utf8'));
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Encoding': 'gzip',
            'Cache-Control': 'no-store',
          });
          return res.end(gz);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(body);
      }

      // Public/Admin API: export crisp PNG
      if (pathname === '/api/export/png' && method === 'GET') {
        if (!store.config.allowPublicExport && !isAdmin(req)) {
          return sendJSON(res, 403, { error: 'Export désactivé par l\'administrateur.' });
        }
        const scale = parseInt(parsedUrl.searchParams.get('scale') || '4', 10);
        try {
          const png = store.exportPNG(scale);
          const safeTitle = store.config.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'pixel-war';
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': png.length,
            'Content-Disposition': `attachment; filename="${safeTitle}-${stamp}.png"`,
            'Cache-Control': 'no-store',
          });
          return res.end(png);
        } catch (err) {
          return sendJSON(res, 400, { error: err.message });
        }
      }

      // Admin login (rate-limited per signed clientId, NOT by IP!)
      if (pathname === '/api/admin/login' && method === 'POST') {
        const clientId = ensureClientId(req, res);
        const now = Date.now();
        let attempt = loginAttempts.get(clientId);
        if (!attempt || now > attempt.resetAt) {
          attempt = { count: 0, resetAt: now + 60_000 };
          loginAttempts.set(clientId, attempt);
        }
        if (attempt.count >= 8) {
          return sendJSON(res, 429, { error: 'Trop de tentatives sur cette session. Réessayez dans une minute.' });
        }

        const body = await readJsonBody(req, 16_384);
        const pw = String(body.password || '');
        const a = Buffer.from(pw, 'utf8');
        const b = Buffer.from(adminPassword, 'utf8');
        const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
        if (!valid) {
          attempt.count++;
          return sendJSON(res, 401, { error: 'Mot de passe incorrect.' });
        }

        const token = crypto.randomBytes(24).toString('hex');
        adminSessions.set(token, now + 24 * 60 * 60 * 1000);
        const secure = isHttpsRequest(req) ? '; Secure' : '';
        return sendJSON(
          res,
          200,
          { ok: true, token },
          { 'Set-Cookie': `pw_admin=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure}` }
        );
      }

      if (pathname === '/api/admin/logout' && method === 'POST') {
        const token = getAdminToken(req);
        if (token) adminSessions.delete(token);
        const secure = isHttpsRequest(req) ? '; Secure' : '';
        return sendJSON(
          res,
          200,
          { ok: true },
          { 'Set-Cookie': `pw_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}` }
        );
      }

      // All other /api/admin/* endpoints require auth
      if (pathname.startsWith('/api/admin/')) {
        if (!isAdmin(req)) {
          return sendJSON(res, 401, { error: 'Authentification administrateur requise.' });
        }

        if (pathname === '/api/admin/config' && method === 'POST') {
          const body = await readJsonBody(req, 64_000);
          const result = store.updateConfig(body);
          wss.broadcastJSON({
            type: 'config',
            config: result.config,
            canvasResized: result.canvasResized,
            serverTime: Date.now(),
          });
          if (result.cooldownChanged) {
            for (const client of wss.clients) {
              if (client.meta) {
                client.sendJSON({
                  type: 'cooldown',
                  cooldown: store.getCooldownStatus(client.meta.clientId, client.meta.authentikUid, false),
                });
              }
            }
          }
          return sendJSON(res, 200, { ok: true, ...result });
        }

        if (pathname === '/api/admin/clear' && method === 'POST') {
          const body = await readJsonBody(req, 16_384);
          store.clearCanvas(body.fillColor ?? 0, Boolean(body.resetStats));
          wss.broadcastJSON({
            type: 'reload_canvas',
            config: store.getPublicConfig(),
            reason: 'clear',
          });
          return sendJSON(res, 200, { ok: true, config: store.getPublicConfig() });
        }

        if (pathname === '/api/admin/import' && method === 'POST') {
          const body = await readJsonBody(req, 8 * 1024 * 1024);
          if (!Array.isArray(body.pixels)) {
            return sendJSON(res, 400, { error: 'Format pixels invalide.' });
          }
          const count = store.applyBatchPixels(body.pixels, sanitizeNickname(body.author || 'Admin'));
          wss.broadcastJSON({
            type: 'reload_canvas',
            config: store.getPublicConfig(),
            reason: 'import',
          });
          return sendJSON(res, 200, { ok: true, applied: count });
        }

        if (pathname === '/api/admin/snapshots' && method === 'GET') {
          return sendJSON(res, 200, { snapshots: store.listSnapshots() });
        }

        if (pathname === '/api/admin/snapshots' && method === 'POST') {
          const body = await readJsonBody(req, 16_384);
          const meta = store.createSnapshot(body.label || 'manual');
          return sendJSON(res, 200, { ok: true, snapshot: meta });
        }

        if (pathname.startsWith('/api/admin/snapshots/') && pathname.endsWith('/restore') && method === 'POST') {
          const id = pathname.slice('/api/admin/snapshots/'.length, -'/restore'.length);
          const meta = store.restoreSnapshot(decodeURIComponent(id));
          wss.broadcastJSON({
            type: 'reload_canvas',
            config: store.getPublicConfig(),
            reason: 'restore',
          });
          return sendJSON(res, 200, { ok: true, snapshot: meta, config: store.getPublicConfig() });
        }

        if (pathname.startsWith('/api/admin/snapshots/') && pathname.endsWith('/png') && method === 'GET') {
          const id = pathname.slice('/api/admin/snapshots/'.length, -'/png'.length);
          const filePath = store.getSnapshotPngPath(decodeURIComponent(id));
          if (!filePath) return sendJSON(res, 404, { error: 'Snapshot introuvable.' });
          const png = fs.readFileSync(filePath);
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': png.length,
            'Content-Disposition': `attachment; filename="${path.basename(filePath)}"`,
          });
          return res.end(png);
        }

        if (pathname.startsWith('/api/admin/snapshots/') && method === 'DELETE') {
          const id = pathname.slice('/api/admin/snapshots/'.length);
          store.deleteSnapshot(decodeURIComponent(id));
          return sendJSON(res, 200, { ok: true });
        }

        if (pathname === '/api/admin/bans' && method === 'GET') {
          const activeClients = [];
          for (const c of wss.clients) {
            if (c.meta) {
              activeClients.push({
                clientId: c.meta.clientId,
                authentikUid: c.meta.authentikUid || '',
                authentikUsername: c.meta.authentikUsername || '',
                nickname: c.meta.nickname || '',
              });
            }
          }
          return sendJSON(res, 200, {
            banned: Array.from(store.bannedSet),
            activeClients,
          });
        }

        if (pathname === '/api/admin/bans' && method === 'POST') {
          const body = await readJsonBody(req, 16_384);
          try {
            if (body.action === 'unban') {
              store.unbanTarget(body.target);
            } else {
              store.banTarget(body.target);
            }
          } catch (err) {
            return sendJSON(res, 400, { error: err.message });
          }
          return sendJSON(res, 200, { ok: true, banned: Array.from(store.bannedSet) });
        }

        return sendJSON(res, 404, { error: 'Route admin inconnue.' });
      }

      // Static files from public/
      if (method === 'GET' || method === 'HEAD') {
        const relPath = pathname === '/' ? '/index.html' : pathname;
        const resolved = path.normalize(path.join(publicDir, relPath));
        if (!resolved.startsWith(publicDir)) {
          res.writeHead(403);
          return res.end('Forbidden');
        }
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
          const ext = path.extname(resolved).toLowerCase();
          const mime = MIME_TYPES[ext] || 'application/octet-stream';
          const data = fs.readFileSync(resolved);
          res.writeHead(200, {
            'Content-Type': mime,
            'Content-Length': data.length,
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
          });
          return res.end(method === 'HEAD' ? undefined : data);
        }
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
    } catch (err) {
      if (err.message === 'BODY_TOO_LARGE') {
        return sendJSON(res, 413, { error: 'Requête trop volumineuse.' });
      }
      if (err.message === 'INVALID_JSON') {
        return sendJSON(res, 400, { error: 'JSON invalide.' });
      }
      console.error('[HTTP] Erreur:', err);
      return sendJSON(res, 500, { error: 'Erreur interne du serveur.' });
    }
  });

  // WebSocket server (same HTTP port 3000, zero extra VPS/firewall ports needed)
  const wss = new WebSocketServer(server, { path: '/ws', pingIntervalMs: 25000 });

  let onlineBroadcastTimer = null;
  function broadcastOnlineCount() {
    if (onlineBroadcastTimer) return;
    onlineBroadcastTimer = setTimeout(() => {
      onlineBroadcastTimer = null;
      wss.broadcastJSON({ type: 'online', count: wss.clients.size });
    }, 300);
    onlineBroadcastTimer.unref();
  }

  wss.on('connection', (client, req) => {
    const cookies = parseCookies(req);
    const existingCid = verifySignedClientId(cookies.pw_cid);
    const clientId = existingCid || `ws_${crypto.randomBytes(8).toString('hex')}`;
    const ak = getAuthentikIdentity(req);
    const admin = isAdmin(req);

    client.meta = {
      clientId,
      authentikUid: ak?.uid || '',
      authentikUsername: ak?.username || '',
      isAdmin: admin,
      nickname: ak?.username || '',
      adminBrush: false,
    };

    client.sendJSON({
      type: 'hello',
      online: wss.clients.size,
      config: store.getPublicConfig(),
      cooldown: store.getCooldownStatus(clientId, client.meta.authentikUid, false),
      isAdmin: admin,
      authentikUser: ak ? { username: ak.username, name: ak.name, groups: ak.groups } : null,
      serverTime: Date.now(),
    });

    broadcastOnlineCount();

    client.on('message', (msg, isBinary) => {
      if (isBinary) return;
      let data;
      try {
        data = JSON.parse(msg);
      } catch {
        return;
      }

      if (data.type === 'set_nickname') {
        client.meta.nickname = sanitizeNickname(data.nickname) || client.meta.authentikUsername;
        return;
      }

      if (data.type === 'auth_admin') {
        if (ak && ak.isAdmin) {
          client.meta.isAdmin = true;
          client.sendJSON({ type: 'admin_status', isAdmin: true });
          return;
        }
        const token = String(data.token || '');
        const exp = adminSessions.get(token);
        if (exp && Date.now() <= exp) {
          client.meta.isAdmin = true;
          client.sendJSON({ type: 'admin_status', isAdmin: true });
        } else {
          client.meta.isAdmin = false;
          client.sendJSON({ type: 'admin_status', isAdmin: false });
        }
        return;
      }

      if (data.type === 'place') {
        const useBypass = Boolean(client.meta.isAdmin && data.adminBypass);
        const nick = sanitizeNickname(data.nickname || client.meta.nickname || client.meta.authentikUsername);
        client.meta.nickname = nick;

        const brush = useBypass ? Math.max(1, Math.min(9, parseInt(data.brushSize || '1', 10) || 1)) : 1;

        if (brush === 1) {
          const result = store.placePixel({
            x: data.x,
            y: data.y,
            color: data.color,
            clientId: client.meta.clientId,
            authentikUid: client.meta.authentikUid,
            nickname: nick,
            isAdminBypass: useBypass,
          });

          if (!result.ok) {
            client.sendJSON({
              type: 'place_error',
              code: result.code,
              message: result.message,
              retryAfterMs: result.retryAfterMs,
              cooldown: result.cooldown,
            });
            return;
          }

          wss.broadcastBinary(encodePixelBinary(result.pixel.x, result.pixel.y, result.pixel.color));
          client.sendJSON({
            type: 'place_ok',
            x: result.pixel.x,
            y: result.pixel.y,
            color: result.pixel.color,
            cooldown: result.cooldown,
            totalPixelsPlaced: result.totalPixelsPlaced,
          });
        } else {
          const half = Math.floor(brush / 2);
          const batch = [];
          for (let dy = -half; dy <= half; dy++) {
            for (let dx = -half; dx <= half; dx++) {
              const px = (data.x | 0) + dx;
              const py = (data.y | 0) + dy;
              if (px >= 0 && px < store.config.width && py >= 0 && py < store.config.height) {
                batch.push({ x: px, y: py, c: data.color | 0 });
              }
            }
          }
          store.applyBatchPixels(batch, nick || 'Admin');
          for (const p of batch) {
            wss.broadcastBinary(encodePixelBinary(p.x, p.y, p.c));
          }
          client.sendJSON({
            type: 'place_ok',
            x: data.x,
            y: data.y,
            color: data.color,
            cooldown: store.getCooldownStatus(client.meta.clientId, client.meta.authentikUid, true),
            totalPixelsPlaced: store.totalPixelsPlaced,
          });
        }
        return;
      }

      if (data.type === 'ping_sync') {
        client.sendJSON({
          type: 'cooldown',
          cooldown: store.getCooldownStatus(client.meta.clientId, client.meta.authentikUid, false),
          serverTime: Date.now(),
        });
      }
    });

    client.on('close', () => {
      broadcastOnlineCount();
    });
  });

  // Auto-freeze watcher when endTime is reached
  let lastFrozenState = store.isEffectivelyPaused();
  const freezeWatcher = setInterval(() => {
    const frozen = store.isEffectivelyPaused();
    if (frozen !== lastFrozenState) {
      lastFrozenState = frozen;
      if (frozen) {
        try {
          store.createSnapshot('fin-evenement');
        } catch {
          // ignore
        }
      }
      wss.broadcastJSON({
        type: 'config',
        config: store.getPublicConfig(),
        serverTime: Date.now(),
      });
    }
  }, 1000);
  freezeWatcher.unref();

  return {
    server,
    wss,
    store,
    start() {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address();
          resolve(addr);
        });
      });
    },
    stop() {
      clearInterval(freezeWatcher);
      if (onlineBroadcastTimer) clearTimeout(onlineBroadcastTimer);
      wss.close();
      store.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

if (require.main === module) {
  const app = createServer();
  app.start().then((addr) => {
    console.log(`[Pixel War] Serveur HTTP+WS démarré sur http://${addr.address}:${addr.port}`);
    if (!process.env.ADMIN_PASSWORD) {
      console.warn('[Pixel War] ⚠️  ADMIN_PASSWORD non défini — configurez-le dans Coolify !');
    }
  });

  const shutdown = () => {
    console.log('[Pixel War] Arrêt propre et sauvegarde du canvas...');
    app.stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer };
