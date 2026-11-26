'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const { WebSocketServer } = require('./ws');
const { PixelWarStore, PALETTE_PRESETS, LOOTBOX_ITEMS, sanitizeNickname, normalizeUsername } = require('./store');

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

function renderAuthRequiredHTML(loginUrl) {
  const safeUrl = String(loginUrl || 'https://auth.minitel.dev').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Connexion Authentik requise — Pixel War</title>
  <style>
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #090d16; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 20px; }
    .card { max-width: 440px; width: 100%; background: rgba(15,23,42,0.94); border: 1px solid rgba(255,255,255,0.14); border-radius: 16px; padding: 28px; text-align: center; box-shadow: 0 12px 32px rgba(0,0,0,0.5); }
    h1 { margin: 0 0 12px; font-size: 1.3rem; }
    p { margin: 0 0 20px; color: #94a3b8; line-height: 1.5; font-size: 0.95rem; }
    a { display: inline-block; background: #2563eb; color: #fff; text-decoration: none; font-weight: 600; padding: 11px 18px; border-radius: 10px; }
    a:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🔒 Connexion Authentik requise</h1>
    <p>L'accès à la Pixel War est réservé aux utilisateurs authentifiés via <strong>Authentik MINITEL</strong>. Connectez-vous avec votre compte pour accéder au canvas.</p>
    <a href="${safeUrl}">Se connecter avec Authentik</a>
  </div>
</body>
</html>`;
}

function createServer(options = {}) {
  const port = options.port ?? parseInt(process.env.PORT || '3000', 10);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  const trustProxy = options.trustProxy ?? (process.env.TRUST_PROXY !== 'false');

  const requireAuthentik = options.requireAuthentik ?? (process.env.REQUIRE_AUTHENTIK !== 'false');
  const trustAuthentik = options.trustAuthentik ?? (requireAuthentik || process.env.TRUST_AUTHENTIK_HEADERS === 'true');
  const authentikLoginUrl = options.authentikLoginUrl ?? process.env.AUTHENTIK_LOGIN_URL ?? 'https://auth.minitel.dev/if/user/';

  const authentikAdminGroups = new Set(
    String(options.authentikAdminGroups ?? process.env.AUTHENTIK_ADMIN_GROUPS ?? 'admins-infra')
      .split(',')
      .map((g) => g.trim().toLowerCase())
      .filter(Boolean)
  );

  const envAdminUsers = new Set(
    String(options.adminUsers ?? process.env.ADMIN_USERS ?? '')
      .split(',')
      .map((u) => normalizeUsername(u))
      .filter(Boolean)
  );

  const rawAdminPw = options.adminPassword !== undefined ? options.adminPassword : (process.env.ADMIN_PASSWORD || '');
  const adminPassword = String(rawAdminPw || '').trim();
  const passwordLoginEnabled = adminPassword.length > 0;

  const sessionSecret = options.sessionSecret ?? process.env.SESSION_SECRET ?? crypto.randomBytes(32).toString('hex');
  const publicDir = options.publicDir || path.join(__dirname, '..', 'public');

  const store = new PixelWarStore({ dataDir: options.dataDir });

  const adminSessions = new Map();
  const loginAttempts = new Map();

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
    const rawUsername = String(req.headers['x-authentik-username'] || '').trim();
    const username = sanitizeNickname(rawUsername);
    if (!uid && !username) return null;

    const name = sanitizeNickname(String(req.headers['x-authentik-name'] || '')) || username;
    const email = String(req.headers['x-authentik-email'] || '').trim().slice(0, 120);
    const rawGroups = String(req.headers['x-authentik-groups'] || '');
    const groups = rawGroups
      .split(/[|,]/)
      .map((g) => g.trim())
      .filter(Boolean);

    return {
      uid: uid || normalizeUsername(rawUsername),
      username: username || name,
      usernameNorm: normalizeUsername(rawUsername || username),
      name,
      email,
      groups,
    };
  }

  function isStaticAuthentikAdmin(ak) {
    if (!ak) return false;
    if (ak.groups.some((g) => authentikAdminGroups.has(g.toLowerCase()))) return true;
    if (ak.usernameNorm && envAdminUsers.has(ak.usernameNorm)) return true;
    if (ak.uid && envAdminUsers.has(normalizeUsername(ak.uid))) return true;
    return false;
  }

  function isDynamicAuthentikAdmin(ak) {
    if (!ak) return false;
    if (ak.usernameNorm && store.hasExtraAdmin(ak.usernameNorm)) return true;
    if (ak.uid && store.hasExtraAdmin(ak.uid)) return true;
    return false;
  }

  function hasValidAdminToken(token) {
    if (!passwordLoginEnabled || !token) return false;
    const exp = adminSessions.get(token);
    if (!exp) return false;
    if (Date.now() > exp) {
      adminSessions.delete(token);
      return false;
    }
    return true;
  }

  function isIdentityAdmin(ak, token) {
    if (isStaticAuthentikAdmin(ak) || isDynamicAuthentikAdmin(ak)) return true;
    if (hasValidAdminToken(token)) return true;
    return false;
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
    return isIdentityAdmin(getAuthentikIdentity(req), getAdminToken(req));
  }

  function notifyUserAdminStatus(targetUsernameNorm) {
    for (const client of wss.clients) {
      if (!client.meta || !client.meta.authentik) continue;
      const ak = client.meta.authentik;
      if (ak.usernameNorm === targetUsernameNorm || normalizeUsername(ak.uid) === targetUsernameNorm) {
        const nowAdmin = isIdentityAdmin(ak, client.meta.adminToken);
        client.meta.isAdmin = nowAdmin;
        client.sendJSON({ type: 'admin_status', isAdmin: nowAdmin });
      }
    }
  }

  function pushInventoryToUser(userKey) {
    const inv = store.getInventory(userKey);
    for (const client of wss.clients) {
      if (client.meta && client.meta.userKey === userKey) {
        client.sendJSON({
          type: 'inventory',
          inventory: inv,
          cooldown: store.getCooldownStatus(client.meta.clientId, client.meta.authentikUid, false),
        });
      }
    }
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

  // ─── Random Hourly Lootbox Drop Scheduler ───
  let lootboxTimer = null;
  let nextLootboxDropAt = null;

  function dropLootboxToTarget(targetUsername = '') {
    // Deduplicate connected players by userKey so multiple tabs never multiply odds
    const uniquePlayers = new Map();
    for (const c of wss.clients) {
      if (!c.meta) continue;
      if (!uniquePlayers.has(c.meta.userKey)) {
        uniquePlayers.set(c.meta.userKey, {
          userKey: c.meta.userKey,
          username: c.meta.authentikUsername || c.meta.nickname || 'Un joueur',
          usernameNorm: normalizeUsername(c.meta.authentikUsername || c.meta.nickname || ''),
        });
      }
    }

    let winner = null;
    if (targetUsername) {
      const targetNorm = normalizeUsername(targetUsername);
      for (const p of uniquePlayers.values()) {
        if (p.usernameNorm === targetNorm) {
          winner = p;
          break;
        }
      }
      if (!winner && targetNorm) {
        // Grant offline by authentik username key if not currently connected
        winner = { userKey: `ak:${targetNorm}`, username: targetUsername.trim(), usernameNorm: targetNorm };
      }
    } else {
      const pool = Array.from(uniquePlayers.values());
      if (pool.length === 0) return null;
      winner = pool[crypto.randomInt(0, pool.length)];
    }

    if (!winner) return null;
    store.grantLootbox(winner.userKey, 1);
    pushInventoryToUser(winner.userKey);
    wss.broadcastJSON({
      type: 'lootbox_drop',
      winner: winner.username,
      nextLootboxDropAt,
    });
    return winner;
  }

  function setupLootboxScheduler() {
    if (lootboxTimer) {
      clearInterval(lootboxTimer);
      lootboxTimer = null;
    }
    if (!store.config.lootboxEnabled) {
      nextLootboxDropAt = null;
      return;
    }
    const intervalMs = Math.max(1, store.config.lootboxIntervalMinutes) * 60 * 1000;
    nextLootboxDropAt = Date.now() + intervalMs;
    lootboxTimer = setInterval(() => {
      nextLootboxDropAt = Date.now() + intervalMs;
      if (!store.isEffectivelyPaused()) {
        dropLootboxToTarget('');
      }
    }, intervalMs);
    lootboxTimer.unref();
  }

  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname;
      const method = req.method || 'GET';

      // 1. Health check (unique route publique pour Coolify/Docker)
      if (pathname === '/health' || pathname === '/api/health') {
        return sendJSON(res, 200, {
          status: 'ok',
          uptime: Math.floor(process.uptime()),
          online: wss.clients.size,
          width: store.config.width,
          height: store.config.height,
          totalPixelsPlaced: store.totalPixelsPlaced,
          requireAuthentik,
        });
      }

      if (pathname === '/favicon.svg' && (method === 'GET' || method === 'HEAD')) {
        const favPath = path.join(publicDir, 'favicon.svg');
        if (fs.existsSync(favPath)) {
          const data = fs.readFileSync(favPath);
          res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': data.length });
          return res.end(method === 'HEAD' ? undefined : data);
        }
      }

      // 2. Verrouillage global Authentik
      const ak = getAuthentikIdentity(req);
      if (requireAuthentik && !ak) {
        if (pathname.startsWith('/api/')) {
          return sendJSON(res, 401, {
            error: 'Connexion via votre compte Authentik requise.',
            code: 'AUTH_REQUIRED',
            loginUrl: authentikLoginUrl,
          });
        }
        const html = renderAuthRequiredHTML(authentikLoginUrl);
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(method === 'HEAD' ? undefined : html);
      }

      // 3. Routes API utilisateur authentifié
      if (pathname === '/api/config' && method === 'GET') {
        const clientId = ensureClientId(req, res);
        const userKey = store.getUserKey(clientId, ak?.uid || '');
        const admin = isAdmin(req);
        return sendJSON(res, 200, {
          config: store.getPublicConfig(),
          presets: PALETTE_PRESETS,
          lootboxItems: LOOTBOX_ITEMS,
          nextLootboxDropAt,
          shields: store.getActiveShields(),
          inventory: store.getInventory(userKey),
          online: wss.clients.size,
          cooldown: store.getCooldownStatus(clientId, ak?.uid || '', false),
          isAdmin: admin,
          passwordLoginEnabled,
          requireAuthentik,
          authentikUser: ak ? { uid: ak.uid, username: ak.username, name: ak.name, groups: ak.groups } : null,
          serverTime: Date.now(),
        });
      }

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

      if (pathname === '/api/pixel' && method === 'GET') {
        const x = parseInt(parsedUrl.searchParams.get('x') || '-1', 10);
        const y = parseInt(parsedUrl.searchParams.get('y') || '-1', 10);
        const info = store.getPixelInfo(x, y);
        if (!info) return sendJSON(res, 404, { error: 'Pixel hors limites' });
        return sendJSON(res, 200, info);
      }

      if (pathname === '/api/stats' && method === 'GET') {
        return sendJSON(res, 200, {
          ...store.getLeaderboard(25),
          online: wss.clients.size,
          historyCount: store.historyCount,
        });
      }

      if (pathname === '/api/history' && method === 'GET') {
        if (!store.config.allowTimelapse && !isAdmin(req)) {
          return sendJSON(res, 403, { error: 'Timelapse désactivé par l\'administrateur.' });
        }
        const hist = store.readHistory(150000);
        const body = JSON.stringify({
          width: store.config.width,
          height: store.config.height,
          palette: store.config.palette,
          startTime: hist.startTime,
          baselineBase64: hist.baselineBase64,
          events: hist.events,
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

      // Lootbox user actions (open / activate boost)
      if (pathname === '/api/lootbox/open' && method === 'POST') {
        const clientId = ensureClientId(req, res);
        const userKey = store.getUserKey(clientId, ak?.uid || '');
        try {
          const result = store.openLootbox(userKey);
          pushInventoryToUser(userKey);
          return sendJSON(res, 200, { ok: true, ...result });
        } catch (err) {
          return sendJSON(res, 400, { error: err.message });
        }
      }

      if (pathname === '/api/lootbox/activate' && method === 'POST') {
        const clientId = ensureClientId(req, res);
        const userKey = store.getUserKey(clientId, ak?.uid || '');
        const body = await readJsonBody(req, 8192);
        try {
          const result = store.activateBoost(userKey, String(body.itemId || ''));
          pushInventoryToUser(userKey);
          return sendJSON(res, 200, {
            ok: true,
            ...result,
            cooldown: store.getCooldownStatus(clientId, ak?.uid || '', false),
          });
        } catch (err) {
          return sendJSON(res, 400, { error: err.message });
        }
      }

      // 4. Connexion admin mot de passe de secours (UNIQUEMENT si ADMIN_PASSWORD défini)
      if (pathname === '/api/admin/login' && method === 'POST') {
        if (!passwordLoginEnabled) {
          return sendJSON(res, 403, {
            error: 'La connexion par mot de passe est désactivée. Les droits administrateur sont gérés via Authentik.',
          });
        }
        const key = ak?.uid || ensureClientId(req, res);
        const now = Date.now();
        let attempt = loginAttempts.get(key);
        if (!attempt || now > attempt.resetAt) {
          attempt = { count: 0, resetAt: now + 60_000 };
          loginAttempts.set(key, attempt);
        }
        if (attempt.count >= 8) {
          return sendJSON(res, 429, { error: 'Trop de tentatives. Réessayez dans une minute.' });
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

      // 5. TOUTES les routes /api/admin/* : strictement réservées aux admins (403 sinon)
      if (pathname.startsWith('/api/admin/')) {
        if (!isAdmin(req)) {
          return sendJSON(res, 403, { error: 'Accès refusé : droits administrateur requis.' });
        }

        if (pathname === '/api/admin/config' && method === 'POST') {
          const body = await readJsonBody(req, 64_000);
          const result = store.updateConfig(body);
          if (result.lootboxScheduleChanged) {
            setupLootboxScheduler();
          }
          wss.broadcastJSON({
            type: 'config',
            config: result.config,
            canvasResized: result.canvasResized,
            nextLootboxDropAt,
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
          return sendJSON(res, 200, { ok: true, ...result, nextLootboxDropAt });
        }

        // Top départ immédiat : fixe startTime = maintenant, capture l'état initial du replay et déverrouille !
        if (pathname === '/api/admin/start-now' && method === 'POST') {
          const nowIso = new Date().toISOString();
          store.updateConfig({ startTime: nowIso, paused: false });
          const baseline = store.captureReplayBaseline(true);
          wss.broadcastJSON({
            type: 'config',
            config: store.getPublicConfig(),
            nextLootboxDropAt,
            serverTime: Date.now(),
          });
          return sendJSON(res, 200, { ok: true, startTime: nowIso, baseline, config: store.getPublicConfig() });
        }

        // Envoyer une lootbox immédiatement (aléatoire ou ciblée)
        if (pathname === '/api/admin/lootbox/drop' && method === 'POST') {
          const body = await readJsonBody(req, 8192);
          const winner = dropLootboxToTarget(String(body.username || '').trim());
          if (!winner) {
            return sendJSON(res, 400, { error: 'Aucun joueur connecté pour recevoir une lootbox.' });
          }
          return sendJSON(res, 200, { ok: true, winner: winner.username });
        }

        if (pathname === '/api/admin/clear' && method === 'POST') {
          const body = await readJsonBody(req, 16_384);
          store.clearCanvas(body.fillColor ?? 0, Boolean(body.resetStats));
          wss.broadcastJSON({ type: 'reload_canvas', config: store.getPublicConfig(), reason: 'clear' });
          wss.broadcastJSON({ type: 'shields', shields: store.getActiveShields() });
          return sendJSON(res, 200, { ok: true, config: store.getPublicConfig() });
        }

        if (pathname === '/api/admin/import' && method === 'POST') {
          const body = await readJsonBody(req, 8 * 1024 * 1024);
          if (!Array.isArray(body.pixels)) {
            return sendJSON(res, 400, { error: 'Format pixels invalide.' });
          }
          const author = ak?.username || sanitizeNickname(body.author || 'Admin');
          const count = store.applyBatchPixels(body.pixels, author);
          wss.broadcastJSON({ type: 'reload_canvas', config: store.getPublicConfig(), reason: 'import' });
          return sendJSON(res, 200, { ok: true, applied: count });
        }

        if (pathname === '/api/admin/snapshots' && method === 'GET') {
          return sendJSON(res, 200, {
            snapshots: store.listSnapshots(),
            autoSnapshotMinutes: store.config.autoSnapshotMinutes,
            maxAutoSnapshots: store.config.maxAutoSnapshots,
            nextAutoSnapshotAt: store.nextAutoSnapshotAt,
          });
        }

        if (pathname === '/api/admin/snapshots' && method === 'POST') {
          const body = await readJsonBody(req, 16_384);
          const meta = store.createSnapshot(body.label || 'manual');
          return sendJSON(res, 200, { ok: true, snapshot: meta });
        }

        if (pathname.startsWith('/api/admin/snapshots/') && pathname.endsWith('/restore') && method === 'POST') {
          const id = pathname.slice('/api/admin/snapshots/'.length, -'/restore'.length);
          const meta = store.restoreSnapshot(decodeURIComponent(id));
          wss.broadcastJSON({ type: 'reload_canvas', config: store.getPublicConfig(), reason: 'restore' });
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

        if (pathname === '/api/admin/admins' && method === 'GET') {
          const connectedMap = new Map();
          for (const c of wss.clients) {
            if (c.meta && c.meta.authentik) {
              const u = c.meta.authentik;
              connectedMap.set(u.usernameNorm || u.uid, {
                username: u.username,
                usernameNorm: u.usernameNorm,
                name: u.name,
                uid: u.uid,
                groups: u.groups,
                isStaticAdmin: isStaticAuthentikAdmin(u),
                isDynamicAdmin: isDynamicAuthentikAdmin(u),
                isAdmin: isIdentityAdmin(u, c.meta.adminToken),
              });
            }
          }
          return sendJSON(res, 200, {
            adminGroups: Array.from(authentikAdminGroups),
            envAdminUsers: Array.from(envAdminUsers).sort(),
            dynamicAdmins: store.listExtraAdmins(),
            activeUsers: Array.from(connectedMap.values()),
            currentUser: ak ? ak.usernameNorm : null,
          });
        }

        if (pathname === '/api/admin/admins' && method === 'POST') {
          const body = await readJsonBody(req, 16_384);
          const action = body.action === 'remove' ? 'remove' : 'add';
          const norm = normalizeUsername(body.username || '');
          if (!norm) {
            return sendJSON(res, 400, { error: 'Veuillez renseigner un identifiant Authentik valide.' });
          }

          if (action === 'add') {
            store.addExtraAdmin(norm);
            notifyUserAdminStatus(norm);
          } else {
            if (envAdminUsers.has(norm)) {
              return sendJSON(res, 400, { error: 'Cet administrateur est défini dans les variables Coolify (ADMIN_USERS).' });
            }
            if (ak && ak.usernameNorm === norm && !isStaticAuthentikAdmin(ak)) {
              return sendJSON(res, 400, { error: 'Vous ne pouvez pas retirer vos propres droits administrateur.' });
            }
            store.removeExtraAdmin(norm);
            notifyUserAdminStatus(norm);
          }

          return sendJSON(res, 200, { ok: true, dynamicAdmins: store.listExtraAdmins() });
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
          return sendJSON(res, 200, { banned: Array.from(store.bannedSet), activeClients });
        }

        if (pathname === '/api/admin/bans' && method === 'POST') {
          const body = await readJsonBody(req, 16_384);
          try {
            if (body.action === 'unban') store.unbanTarget(body.target);
            else store.banTarget(body.target);
          } catch (err) {
            return sendJSON(res, 400, { error: err.message });
          }
          return sendJSON(res, 200, { ok: true, banned: Array.from(store.bannedSet) });
        }

        return sendJSON(res, 404, { error: 'Route admin inconnue.' });
      }

      // 6. Static files from public/
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
      if (err.message === 'BODY_TOO_LARGE') return sendJSON(res, 413, { error: 'Requête trop volumineuse.' });
      if (err.message === 'INVALID_JSON') return sendJSON(res, 400, { error: 'JSON invalide.' });
      console.error('[HTTP] Erreur:', err);
      return sendJSON(res, 500, { error: 'Erreur interne du serveur.' });
    }
  });

  const wss = new WebSocketServer(server, {
    path: '/ws',
    pingIntervalMs: 25000,
    verifyClient: (req) => {
      if (requireAuthentik) {
        const ak = getAuthentikIdentity(req);
        if (!ak) return { ok: false, status: 401 };
      }
      return { ok: true };
    },
  });

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
    const adminToken = getAdminToken(req);
    const admin = isIdentityAdmin(ak, adminToken);
    const userKey = store.getUserKey(clientId, ak?.uid || '');

    client.meta = {
      clientId,
      userKey,
      authentik: ak,
      authentikUid: ak?.uid || '',
      authentikUsername: ak?.username || '',
      adminToken,
      isAdmin: admin,
      nickname: ak?.username || '',
    };

    client.sendJSON({
      type: 'hello',
      online: wss.clients.size,
      config: store.getPublicConfig(),
      cooldown: store.getCooldownStatus(clientId, client.meta.authentikUid, false),
      inventory: store.getInventory(userKey),
      shields: store.getActiveShields(),
      nextLootboxDropAt,
      isAdmin: admin,
      passwordLoginEnabled,
      authentikUser: ak ? { uid: ak.uid, username: ak.username, name: ak.name, groups: ak.groups } : null,
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
        if (store.config.lockNicknameToAuthentik && client.meta.authentikUsername) {
          client.meta.nickname = client.meta.authentikUsername;
        } else {
          client.meta.nickname = sanitizeNickname(data.nickname) || client.meta.authentikUsername;
        }
        return;
      }

      if (data.type === 'auth_admin') {
        const token = String(data.token || '');
        if (hasValidAdminToken(token)) client.meta.adminToken = token;
        const nowAdmin = isIdentityAdmin(client.meta.authentik, client.meta.adminToken);
        client.meta.isAdmin = nowAdmin;
        client.sendJSON({ type: 'admin_status', isAdmin: nowAdmin });
        return;
      }

      if (data.type === 'place') {
        const currentlyAdmin = isIdentityAdmin(client.meta.authentik, client.meta.adminToken);
        client.meta.isAdmin = currentlyAdmin;

        const useBypass = Boolean(currentlyAdmin && data.adminBypass);
        const nick = store.config.lockNicknameToAuthentik && client.meta.authentikUsername
          ? client.meta.authentikUsername
          : sanitizeNickname(data.nickname || client.meta.nickname || client.meta.authentikUsername);
        client.meta.nickname = nick;

        const brush = useBypass ? Math.max(1, Math.min(9, parseInt(data.brushSize || '1', 10) || 1)) : 1;
        const brushShape = useBypass && data.brushShape === 'circle' ? 'circle' : 'square';

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

          if (Array.isArray(result.pixels)) {
            for (const [px, py, pc] of result.pixels) {
              wss.broadcastBinary(encodePixelBinary(px, py, pc));
            }
          }
          if (result.shieldsUpdated) {
            wss.broadcastJSON({ type: 'shields', shields: store.getActiveShields() });
          }
          if (result.effect) {
            wss.broadcastJSON({
              type: 'effect',
              effect: {
                ...result.effect,
                colorHex: store.config.palette[result.effect.color] || '#ffffff',
              },
            });
          }

          client.sendJSON({
            type: 'place_ok',
            x: data.x,
            y: data.y,
            color: result.pixel ? result.pixel.color : data.color,
            cooldown: result.cooldown,
            inventory: result.inventory || store.getInventory(client.meta.userKey),
            totalPixelsPlaced: result.totalPixelsPlaced,
          });
        } else {
          // Admin wide brush (square or circle)
          const half = Math.floor(brush / 2);
          const radius = brush / 2;
          const batch = [];
          for (let dy = -half; dy <= half; dy++) {
            for (let dx = -half; dx <= half; dx++) {
              if (brushShape === 'circle' && Math.hypot(dx, dy) > radius) continue;
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
          inventory: store.getInventory(client.meta.userKey),
          serverTime: Date.now(),
        });
      }
    });

    client.on('close', () => {
      broadcastOnlineCount();
    });
  });

  // Watchers: auto-start replay baseline, auto-freeze at endTime, shield expiration
  let lastFrozenState = store.isEffectivelyPaused();
  let lastBeforeStart = store.isBeforeStart();
  const stateWatcher = setInterval(() => {
    const now = Date.now();
    const beforeStart = store.isBeforeStart(now);
    let broadcastCfg = false;

    if (lastBeforeStart && !beforeStart) {
      // Exact transition into Pixel War startTime -> capture replay baseline!
      store.captureReplayBaseline(true);
      broadcastCfg = true;
    }
    lastBeforeStart = beforeStart;

    const frozen = store.isEffectivelyPaused(now);
    if (frozen !== lastFrozenState) {
      lastFrozenState = frozen;
      if (frozen && store.config.endTime && now >= Date.parse(store.config.endTime)) {
        try {
          store.createSnapshot('fin-evenement');
        } catch {
          // ignore
        }
      }
      broadcastCfg = true;
    }

    if (broadcastCfg) {
      wss.broadcastJSON({
        type: 'config',
        config: store.getPublicConfig(),
        nextLootboxDropAt,
        serverTime: now,
      });
    }

    if (store.pruneExpiredShields(now)) {
      wss.broadcastJSON({ type: 'shields', shields: store.getActiveShields(now) });
    }
  }, 1000);
  stateWatcher.unref();

  setupLootboxScheduler();

  return {
    server,
    wss,
    store,
    start() {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    stop() {
      clearInterval(stateWatcher);
      if (lootboxTimer) clearInterval(lootboxTimer);
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
    const reqAk = process.env.REQUIRE_AUTHENTIK !== 'false';
    console.log(`[Pixel War] Serveur HTTP+WS démarré sur http://${addr.address}:${addr.port} (Authentik obligatoire: ${reqAk ? 'OUI' : 'NON'})`);
  });

  const shutdown = () => {
    console.log('[Pixel War] Arrêt propre et sauvegarde du canvas...');
    app.stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer };
