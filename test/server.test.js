'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const { createServer } = require('../server/index');

/**
 * Minimal RFC 6455 WebSocket client helper for Node tests (zero external deps)
 */
function connectWsClient(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/ws',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        ...headers,
      },
    });

    req.on('error', reject);
    req.on('upgrade', (res, socket, head) => {
      const messages = [];
      const waiters = [];
      let buf = head || Buffer.alloc(0);

      function dispatch(item) {
        if (waiters.length > 0) {
          const w = waiters.shift();
          w(item);
        } else {
          messages.push(item);
        }
      }

      function parseBuffer() {
        while (buf.length >= 2) {
          const opcode = buf[0] & 0x0f;
          let len = buf[1] & 0x7f;
          let offset = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            offset = 4;
          } else if (len === 127) {
            if (buf.length < 10) return;
            len = buf.readUInt32BE(6);
            offset = 10;
          }
          if (buf.length < offset + len) return;
          const payload = buf.subarray(offset, offset + len);
          buf = buf.subarray(offset + len);
          if (opcode === 1) dispatch({ type: 'text', data: JSON.parse(payload.toString('utf8')) });
          else if (opcode === 2) dispatch({ type: 'binary', data: Buffer.from(payload) });
          else if (opcode === 9) {
            const pong = Buffer.concat([Buffer.from([0x8a, 0x80, 0, 0, 0, 0])]);
            socket.write(pong);
          }
        }
      }

      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        parseBuffer();
      });
      parseBuffer();

      function sendJSON(obj) {
        const payload = Buffer.from(JSON.stringify(obj), 'utf8');
        const mask = crypto.randomBytes(4);
        let header;
        if (payload.length < 126) {
          header = Buffer.from([0x81, 0x80 | payload.length]);
        } else {
          header = Buffer.alloc(4);
          header[0] = 0x81;
          header[1] = 0x80 | 126;
          header.writeUInt16BE(payload.length, 2);
        }
        const masked = Buffer.allocUnsafe(payload.length);
        for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
        socket.write(Buffer.concat([header, mask, masked]));
      }

      function nextMessage(predicate = () => true, timeoutMs = 3000) {
        return new Promise((resMsg, rejMsg) => {
          const timer = setTimeout(() => rejMsg(new Error('WS timeout waiting for message')), timeoutMs);
          function check() {
            const idx = messages.findIndex(predicate);
            if (idx !== -1) {
              clearTimeout(timer);
              return resMsg(messages.splice(idx, 1)[0]);
            }
            waiters.push((m) => {
              if (predicate(m)) {
                clearTimeout(timer);
                resMsg(m);
              } else {
                messages.push(m);
                check();
              }
            });
          }
          check();
        });
      }

      resolve({
        sendJSON,
        nextMessage,
        close: () => socket.end(),
      });
    });

    req.end();
  });
}

test('Pixel War full integration suite (public MINITEL proxy mode)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-war-test-'));
  const app = createServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: tmpDir,
    adminPassword: 'secret-test-password',
  });

  const addr = await app.start();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  t.after(async () => {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. Health check & static HTML
  const healthRes = await fetch(`${baseUrl}/health`);
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health.status, 'ok');

  const htmlRes = await fetch(`${baseUrl}/`);
  assert.equal(htmlRes.status, 200);
  assert.match(await htmlRes.text(), /Pixel War/);

  // 2. Bootstrap behind Sakura Caddy (X-Forwarded-Proto: https, shared VPS IP 100.110.19.122)
  const proxyHeaders = {
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-For': '100.110.19.122',
  };
  const cfg1Res = await fetch(`${baseUrl}/api/config`, { headers: proxyHeaders });
  assert.equal(cfg1Res.status, 200);
  const setCookie1 = cfg1Res.headers.get('set-cookie');
  assert.ok(setCookie1 && setCookie1.includes('pw_cid=') && setCookie1.includes('Secure'), 'Should issue Secure cookie behind HTTPS proxy');
  const cookie1 = setCookie1.split(';')[0];

  // Second student behind the EXACT SAME VPS IP gets an independent session
  const cfg2Res = await fetch(`${baseUrl}/api/config`, { headers: proxyHeaders });
  const cookie2 = cfg2Res.headers.get('set-cookie').split(';')[0];
  assert.notEqual(cookie1, cookie2);

  // 3. Binary canvas download
  const canvasRes = await fetch(`${baseUrl}/api/canvas`);
  assert.equal(canvasRes.status, 200);
  const canvasW = parseInt(canvasRes.headers.get('x-canvas-width'), 10);
  const canvasH = parseInt(canvasRes.headers.get('x-canvas-height'), 10);
  const canvasBuf = Buffer.from(await canvasRes.arrayBuffer());
  assert.equal(canvasBuf.length, canvasW * canvasH);

  // 4. Two students behind the same VPS IP place pixels independently without IP conflict
  const ws1 = await connectWsClient(addr.port, { ...proxyHeaders, Cookie: cookie1 });
  const ws2 = await connectWsClient(addr.port, { ...proxyHeaders, Cookie: cookie2 });
  await ws1.nextMessage((m) => m.type === 'text' && m.data.type === 'hello');
  await ws2.nextMessage((m) => m.type === 'text' && m.data.type === 'hello');

  ws1.sendJSON({ type: 'place', x: 10, y: 12, color: 5, nickname: '[MINITEL] Alice' });
  const binBroadcast = await ws1.nextMessage((m) => m.type === 'binary');
  assert.equal(binBroadcast.data[0], 0x01);
  assert.equal(binBroadcast.data.readUInt16BE(1), 10);
  assert.equal(binBroadcast.data.readUInt16BE(3), 12);
  assert.equal(binBroadcast.data[5], 5);

  const placeOk1 = await ws1.nextMessage((m) => m.type === 'text' && m.data.type === 'place_ok');
  assert.equal(placeOk1.data.cooldown.charges, 0);

  // Student 1 is blocked by cooldown
  ws1.sendJSON({ type: 'place', x: 11, y: 12, color: 6, nickname: '[MINITEL] Alice' });
  const placeErr1 = await ws1.nextMessage((m) => m.type === 'text' && m.data.type === 'place_error');
  assert.equal(placeErr1.data.code, 'COOLDOWN');

  // Student 2 behind the SAME VPS IP can still place immediately!
  ws2.sendJSON({ type: 'place', x: 20, y: 20, color: 7, nickname: '[BDA] Bob' });
  const placeOk2 = await ws2.nextMessage((m) => m.type === 'text' && m.data.type === 'place_ok');
  assert.equal(placeOk2.data.x, 20);

  // 5. Failed login attempts from student 1 must NOT lock out admin on another session behind same VPS IP
  for (let i = 0; i < 9; i++) {
    await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { ...proxyHeaders, Cookie: cookie1, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
  }
  const lockedStudent = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { ...proxyHeaders, Cookie: cookie1, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'secret-test-password' }),
  });
  assert.equal(lockedStudent.status, 429);

  // Admin on cookie2 succeeds immediately despite same VPS IP
  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { ...proxyHeaders, Cookie: cookie2, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'secret-test-password' }),
  });
  assert.equal(loginRes.status, 200);
  const { token } = await loginRes.json();

  // Attempting to ban the VPS IP must be rejected!
  const ipBanRes = await fetch(`${baseUrl}/api/admin/bans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
    body: JSON.stringify({ action: 'ban', target: '100.110.19.122' }),
  });
  assert.equal(ipBanRes.status, 400);

  // 6. Live config update + non-destructive resize
  const updateRes = await fetch(`${baseUrl}/api/admin/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
    body: JSON.stringify({
      cooldownMs: 0,
      title: 'Promo ISMIN Rush!',
      announcement: 'GO GO GO!',
      width: 64,
      height: 64,
      resizeAnchor: 'top-left',
    }),
  });
  assert.equal(updateRes.status, 200);
  const cfgBroadcast = await ws1.nextMessage((m) => m.type === 'text' && m.data.type === 'config');
  assert.equal(cfgBroadcast.data.config.title, 'Promo ISMIN Rush!');

  const preserved = await (await fetch(`${baseUrl}/api/pixel?x=10&y=12`)).json();
  assert.equal(preserved.color, 5);

  // 7. Export crisp upscaled PNG
  const pngRes = await fetch(`${baseUrl}/api/export/png?scale=4`);
  assert.equal(pngRes.status, 200);
  const pngBuf = Buffer.from(await pngRes.arrayBuffer());
  assert.deepEqual(pngBuf.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(pngBuf.readUInt32BE(16), 64 * 4);
  assert.equal(pngBuf.readUInt32BE(20), 64 * 4);

  // 8. Snapshots create, clear & restore
  const { snapshot } = await (await fetch(`${baseUrl}/api/admin/snapshots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
    body: JSON.stringify({ label: 'checkpoint-1' }),
  })).json();

  await fetch(`${baseUrl}/api/admin/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
    body: JSON.stringify({ fillColor: 0 }),
  });
  assert.equal((await (await fetch(`${baseUrl}/api/pixel?x=10&y=12`)).json()).color, 0);

  await fetch(`${baseUrl}/api/admin/snapshots/${encodeURIComponent(snapshot.id)}/restore`, {
    method: 'POST',
    headers: { 'X-Admin-Token': token },
  });
  assert.equal((await (await fetch(`${baseUrl}/api/pixel?x=10&y=12`)).json()).color, 5);

  ws1.close();
  ws2.close();
});

test('Authentik forward-auth mode (per-account cooldown + auto admin group)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-war-ak-test-'));
  const app = createServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: tmpDir,
    trustAuthentik: true,
    authentikAdminGroups: 'admins-infra,MINITEL',
  });

  const addr = await app.start();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  t.after(async () => {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Switch to authentik mode using automatic admin group membership (no password login needed!)
  const adminAkHeaders = {
    'X-Authentik-Uid': 'uid-admin-1',
    'X-Authentik-Username': 'arthur',
    'X-Authentik-Groups': 'etudiants|admins-infra',
  };
  const cfgAdmin = await (await fetch(`${baseUrl}/api/config`, { headers: adminAkHeaders })).json();
  assert.equal(cfgAdmin.isAdmin, true);
  assert.equal(cfgAdmin.authentikUser.username, 'arthur');

  const modeRes = await fetch(`${baseUrl}/api/admin/config`, {
    method: 'POST',
    headers: { ...adminAkHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cooldownMode: 'authentik', cooldownMs: 10000 }),
  });
  assert.equal(modeRes.status, 200);

  // Student opens 2 different browsers (different cookies) with same Authentik UID -> cooldown is shared!
  const studentAkHeaders = {
    'X-Authentik-Uid': 'uid-student-42',
    'X-Authentik-Username': 'camille',
    'X-Authentik-Groups': 'etudiants',
  };
  const wsA = await connectWsClient(addr.port, studentAkHeaders);
  const wsB = await connectWsClient(addr.port, studentAkHeaders);
  await wsA.nextMessage((m) => m.type === 'text' && m.data.type === 'hello');
  await wsB.nextMessage((m) => m.type === 'text' && m.data.type === 'hello');

  wsA.sendJSON({ type: 'place', x: 5, y: 5, color: 2 });
  const okA = await wsA.nextMessage((m) => m.type === 'text' && m.data.type === 'place_ok');
  assert.equal(okA.data.x, 5);

  // Auto-filled nickname from X-Authentik-Username
  const pxInfo = await (await fetch(`${baseUrl}/api/pixel?x=5&y=5`)).json();
  assert.equal(pxInfo.author, 'camille');

  // Second browser with same Authentik account is blocked by cooldown!
  wsB.sendJSON({ type: 'place', x: 6, y: 5, color: 2 });
  const errB = await wsB.nextMessage((m) => m.type === 'text' && m.data.type === 'place_error');
  assert.equal(errB.data.code, 'COOLDOWN');

  wsA.close();
  wsB.close();
});
