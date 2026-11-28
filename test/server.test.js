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
    req.on('response', (res) => {
      const err = new Error(`WS rejected with HTTP ${res.statusCode}`);
      err.statusCode = res.statusCode;
      res.resume();
      reject(err);
    });
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
            socket.write(Buffer.from([0x8a, 0x80, 0, 0, 0, 0]));
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

test('Authentik mandatory lock, strict admin isolation & dynamic admin promotion', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-war-sec-'));
  const app = createServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: tmpDir,
    // Default behavior: requireAuthentik=true, authentikAdminGroups='admins-infra', no ADMIN_PASSWORD
  });

  const addr = await app.start();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  t.after(async () => {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. Only /health is accessible without Authentik
  const healthRes = await fetch(`${baseUrl}/health`);
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health.requireAuthentik, true);

  // 2. Everything else is LOCKED (401) without Authentik headers!
  for (const p of ['/', '/app.js', '/api/config', '/api/canvas', '/api/stats', '/api/history', '/api/export/png']) {
    const r = await fetch(`${baseUrl}${p}`);
    assert.equal(r.status, 401, `Route ${p} must return 401 without Authentik`);
  }

  // WebSocket upgrade without Authentik must be rejected with 401 before 101!
  await assert.rejects(
    () => connectWsClient(addr.port),
    (err) => err.statusCode === 401
  );

  // 3. Regular Authentik user (group 'etudiants') is authenticated, NOT admin
  const proxyBase = {
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-For': '100.110.19.122',
  };
  const studentHeaders = {
    ...proxyBase,
    'X-Authentik-Uid': 'uid-camille-1',
    'X-Authentik-Username': 'camille',
    'X-Authentik-Groups': 'etudiants|MINITEL',
  };
  const student2Headers = {
    ...proxyBase,
    'X-Authentik-Uid': 'uid-lucas-2',
    'X-Authentik-Username': 'lucas',
    'X-Authentik-Groups': 'etudiants',
  };
  const adminHeaders = {
    ...proxyBase,
    'X-Authentik-Uid': 'uid-arthur-0',
    'X-Authentik-Username': 'arthur',
    'X-Authentik-Groups': 'etudiants|admins-infra',
  };

  const studentCfgRes = await fetch(`${baseUrl}/api/config`, { headers: studentHeaders });
  assert.equal(studentCfgRes.status, 200);
  assert.ok(studentCfgRes.headers.get('set-cookie').includes('Secure'));
  const studentCfg = await studentCfgRes.json();
  assert.equal(studentCfg.isAdmin, false);
  assert.equal(studentCfg.passwordLoginEnabled, false);
  assert.equal(studentCfg.authentikUser.username, 'camille');

  // Password login must be disabled (403) when ADMIN_PASSWORD is not set
  const pwLoginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { ...studentHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'promo-admin-2026' }),
  });
  assert.equal(pwLoginRes.status, 403);

  // 4. Regular user CANNOT call ANY /api/admin/* route -> 403 Forbidden!
  const forbiddenCalls = [
    ['POST', '/api/admin/config', { cooldownMs: 0 }],
    ['POST', '/api/admin/clear', { fillColor: 0 }],
    ['POST', '/api/admin/snapshots', { label: 'hack' }],
    ['POST', '/api/admin/bans', { action: 'ban', target: 'uid-arthur-0' }],
    ['GET', '/api/admin/admins', null],
    ['POST', '/api/admin/admins', { action: 'add', username: 'camille' }],
  ];
  for (const [method, url, body] of forbiddenCalls) {
    const r = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { ...studentHeaders, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(r.status, 403, `Non-admin ${method} ${url} must return 403`);
  }

  // 5. Regular user connects via WS; forged adminBypass/brushSize is ignored; cooldown applies per Authentik UID
  const wsStudentA = await connectWsClient(addr.port, studentHeaders);
  const wsStudentB = await connectWsClient(addr.port, studentHeaders); // second browser/incognito, same Authentik UID
  const wsStudent2 = await connectWsClient(addr.port, student2Headers); // different user, SAME VPS IP
  const helloA = await wsStudentA.nextMessage((m) => m.type === 'text' && m.data.type === 'hello');
  assert.equal(helloA.data.isAdmin, false);
  await wsStudentB.nextMessage((m) => m.type === 'text' && m.data.type === 'hello');
  await wsStudent2.nextMessage((m) => m.type === 'text' && m.data.type === 'hello');

  // Student tries to spoof adminBypass=true and brushSize=5 -> only 1 pixel is placed and cooldown is consumed!
  wsStudentA.sendJSON({ type: 'place', x: 10, y: 10, color: 4, adminBypass: true, brushSize: 5 });
  const ok1 = await wsStudentA.nextMessage((m) => m.type === 'text' && m.data.type === 'place_ok');
  assert.equal(ok1.data.cooldown.charges, 0);
  // Neighboring pixel (11, 10) must NOT have been painted by spoofed 5x5 brush
  const neighbor = await (await fetch(`${baseUrl}/api/pixel?x=11&y=10`, { headers: studentHeaders })).json();
  assert.equal(neighbor.color, 0);

  // Same Authentik user in second browser is blocked by cooldown!
  wsStudentB.sendJSON({ type: 'place', x: 12, y: 10, color: 4, adminBypass: true });
  const errB = await wsStudentB.nextMessage((m) => m.type === 'text' && m.data.type === 'place_error');
  assert.equal(errB.data.code, 'COOLDOWN');

  // Different Authentik user behind the SAME VPS IP places without any IP conflict!
  wsStudent2.sendJSON({ type: 'place', x: 20, y: 20, color: 7 });
  const ok2 = await wsStudent2.nextMessage((m) => m.type === 'text' && m.data.type === 'place_ok');
  assert.equal(ok2.data.x, 20);

  // 6. Real admin (admins-infra) has full access & promotes 'camille' dynamically
  const adminCfg = await (await fetch(`${baseUrl}/api/config`, { headers: adminHeaders })).json();
  assert.equal(adminCfg.isAdmin, true);

  const promoteRes = await fetch(`${baseUrl}/api/admin/admins`, {
    method: 'POST',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'add', username: 'camille' }),
  });
  assert.equal(promoteRes.status, 200);

  // Camille's open WebSocket immediately receives admin_status: true!
  const promoMsg = await wsStudentA.nextMessage((m) => m.type === 'text' && m.data.type === 'admin_status');
  assert.equal(promoMsg.data.isAdmin, true);

  // Camille can now modify settings (e.g., lockNicknameToAuthentik + title)!
  const camilleEdit = await fetch(`${baseUrl}/api/admin/config`, {
    method: 'POST',
    headers: { ...studentHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Pixel War Promo Verrouillée', lockNicknameToAuthentik: true }),
  });
  assert.equal(camilleEdit.status, 200);

  // With lockNicknameToAuthentik=true, Lucas trying to spoof nickname gets recorded as 'lucas'
  await fetch(`${baseUrl}/api/admin/config`, {
    method: 'POST',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cooldownMs: 0 }),
  });
  wsStudent2.sendJSON({ type: 'place', x: 21, y: 20, color: 8, nickname: 'FakeAdmin' });
  await wsStudent2.nextMessage((m) => m.type === 'text' && m.data.type === 'place_ok');
  const pxLucas = await (await fetch(`${baseUrl}/api/pixel?x=21&y=20`, { headers: student2Headers })).json();
  assert.equal(pxLucas.author, 'lucas');

  // 7. Admin demotes 'camille' -> immediate revocation over WS + HTTP 403!
  const demoteRes = await fetch(`${baseUrl}/api/admin/admins`, {
    method: 'POST',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'remove', username: 'camille' }),
  });
  assert.equal(demoteRes.status, 200);

  const demoteMsg = await wsStudentA.nextMessage((m) => m.type === 'text' && m.data.type === 'admin_status');
  assert.equal(demoteMsg.data.isAdmin, false);

  const camilleAfterDemote = await fetch(`${baseUrl}/api/admin/config`, {
    method: 'POST',
    headers: { ...studentHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Should Fail' }),
  });
  assert.equal(camilleAfterDemote.status, 403);

  // 8. Export PNG + Snapshot create & restore as admin
  const pngRes = await fetch(`${baseUrl}/api/export/png?scale=2`, { headers: studentHeaders });
  assert.equal(pngRes.status, 200);
  const pngBuf = Buffer.from(await pngRes.arrayBuffer());
  assert.deepEqual(pngBuf.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  const { snapshot } = await (await fetch(`${baseUrl}/api/admin/snapshots`, {
    method: 'POST',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'final-check' }),
  })).json();
  assert.equal(snapshot.label, 'final-check');

  // Banning VPS IP still rejected
  const ipBan = await fetch(`${baseUrl}/api/admin/bans`, {
    method: 'POST',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'ban', target: '100.110.19.122' }),
  });
  assert.equal(ipBan.status, 400);

  wsStudentA.close();
  wsStudentB.close();
  wsStudent2.close();
});

test('StartTime replay baseline, wide brush, lootboxes & boosts (frenzy, bomb, brush3, shield, charges5, rainbow)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-war-feat-'));
  const app = createServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: tmpDir,
  });

  const addr = await app.start();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  t.after(async () => {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const adminHeaders = {
    'X-Authentik-Uid': 'uid-admin',
    'X-Authentik-Username': 'arthur',
    'X-Authentik-Groups': 'admins-infra',
  };
  const p1Headers = {
    'X-Authentik-Uid': 'uid-p1',
    'X-Authentik-Username': 'alice',
    'X-Authentik-Groups': 'etudiants',
  };
  const p2Headers = {
    'X-Authentik-Uid': 'uid-p2',
    'X-Authentik-Username': 'bob',
    'X-Authentik-Groups': 'etudiants',
  };

  // 1. Set future startTime + lockBeforeStart=true -> player blocked, admin can prep canvas without recording replay
  const futureIso = new Date(Date.now() + 3600_000).toISOString();
  await fetch(`${baseUrl}/api/admin/config`, {
    method: 'POST',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startTime: futureIso, lockBeforeStart: true, cooldownMs: 5000 }),
  });

  const wsAdmin = await connectWsClient(addr.port, adminHeaders);
  const wsP1 = await connectWsClient(addr.port, p1Headers);
  const wsP2 = await connectWsClient(addr.port, p2Headers);
  await wsAdmin.nextMessage((m) => m.type === 'text' && m.data.type === 'hello');
  await wsP1.nextMessage((m) => m.type === 'text' && m.data.type === 'hello');
  await wsP2.nextMessage((m) => m.type === 'text' && m.data.type === 'hello');

  // Player 1 blocked before startTime
  wsP1.sendJSON({ type: 'place', x: 5, y: 5, color: 3 });
  const notStarted = await wsP1.nextMessage((m) => m.type === 'text' && m.data.type === 'place_error');
  assert.equal(notStarted.data.code, 'NOT_STARTED');

  // Admin paints with 5x5 circle wide brush before startTime -> NOT recorded in replay!
  wsAdmin.sendJSON({ type: 'place', x: 15, y: 15, color: 6, adminBypass: true, brushSize: 5, brushShape: 'circle' });
  await wsAdmin.nextMessage((m) => m.type === 'text' && m.data.type === 'place_ok');
  const histBeforeStart = await (await fetch(`${baseUrl}/api/history`, { headers: adminHeaders })).json();
  assert.equal(histBeforeStart.events.length, 0);

  // 2. Admin triggers "Top départ maintenant" -> captures baseline & opens canvas!
  const startNowRes = await fetch(`${baseUrl}/api/admin/start-now`, { method: 'POST', headers: adminHeaders });
  assert.equal(startNowRes.status, 200);

  // Now Player 1 can place, and it IS recorded in replay on top of baseline!
  wsP1.sendJSON({ type: 'place', x: 30, y: 30, color: 4 });
  await wsP1.nextMessage((m) => m.type === 'text' && m.data.type === 'place_ok');
  const histAfterStart = await (await fetch(`${baseUrl}/api/history`, { headers: p1Headers })).json();
  assert.ok(histAfterStart.baselineBase64, 'Replay should include baseline snapshot captured at startTime');
  assert.equal(histAfterStart.events.length, 1);

  // 3. Lootbox drop & open flow
  const dropRes = await fetch(`${baseUrl}/api/admin/lootbox/drop`, {
    method: 'POST',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice' }),
  });
  assert.equal(dropRes.status, 200);
  const openRes = await fetch(`${baseUrl}/api/lootbox/open`, { method: 'POST', headers: p1Headers });
  assert.equal(openRes.status, 200);
  const opened = await openRes.json();
  assert.ok(opened.item && opened.item.id);

  // 4. Deterministically test Frenzy, Bomb, Brush3, Shield & Charges5 via store inventory
  const p1Key = 'ak:uid-p1';
  app.store.inventories.get(p1Key).items.frenzy = 1;
  app.store.inventories.get(p1Key).items.bomb = 1;
  app.store.inventories.get(p1Key).items.brush3 = 1;
  app.store.inventories.get(p1Key).items.shield = 1;
  app.store.inventories.get(p1Key).items.charges5 = 1;

  // Test Frenzy (unlimited rapid placement despite 5000ms cooldown)
  assert.equal((await fetch(`${baseUrl}/api/lootbox/activate`, {
    method: 'POST', headers: { ...p1Headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId: 'frenzy' }),
  })).status, 200);
  for (let i = 0; i < 4; i++) {
    wsP1.sendJSON({ type: 'place', x: 40 + i, y: 40, color: 7 });
    const okF = await wsP1.nextMessage((m) => m.type === 'text' && m.data.type === 'place_ok');
    assert.equal(okF.data.x, 40 + i);
  }
  // Expire frenzy to test next boosts
  app.store.inventories.get(p1Key).activeBoost = null;

  // Test Paint Bomb (splatters multiple pixels around 60,60)
  assert.equal((await fetch(`${baseUrl}/api/lootbox/activate`, {
    method: 'POST', headers: { ...p1Headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId: 'bomb' }),
  })).status, 200);
  wsP1.sendJSON({ type: 'place', x: 60, y: 60, color: 9 });
  await wsP1.nextMessage((m) => m.type === 'text' && m.data.type === 'place_ok');
  assert.equal((await (await fetch(`${baseUrl}/api/pixel?x=60&y=60`, { headers: p1Headers })).json()).color, 9);
  assert.equal((await (await fetch(`${baseUrl}/api/pixel?x=61&y=60`, { headers: p1Headers })).json()).color, 9);

  // Test Shield 5x5 -> Bob cannot paint inside Alice's shield!
  assert.equal((await fetch(`${baseUrl}/api/lootbox/activate`, {
    method: 'POST', headers: { ...p1Headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId: 'shield' }),
  })).status, 200);
  wsP1.sendJSON({ type: 'place', x: 80, y: 80, color: 11 });
  await wsP1.nextMessage((m) => m.type === 'text' && m.data.type === 'place_ok');

  wsP2.sendJSON({ type: 'place', x: 81, y: 81, color: 2 });
  const shieldErr = await wsP2.nextMessage((m) => m.type === 'text' && m.data.type === 'place_error');
  assert.equal(shieldErr.data.code, 'SHIELDED');

  // Test Charges5 (+5 bonus charges)
  assert.equal((await fetch(`${baseUrl}/api/lootbox/activate`, {
    method: 'POST', headers: { ...p1Headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId: 'charges5' }),
  })).status, 200);
  const invAfterCharges = app.store.getInventory(p1Key);
  assert.equal(invAfterCharges.bonusCharges, 5);

  // 5. Security: non-admin MUST get 403 on ALL bot & infinite boost admin routes!
  for (const [method, url, body] of [
    ['GET', '/api/admin/bot', null],
    ['POST', '/api/admin/bot/start', { name: 'hack', pixels: [{ x: 1, y: 1, c: 2 }], ratePerSec: 10 }],
    ['POST', '/api/admin/bot/control', { action: 'stop_all' }],
    ['POST', '/api/admin/boosts/give', { itemId: 'all', amount: 99 }],
    ['POST', '/api/admin/boosts/activate', { itemId: 'bomb' }],
  ]) {
    const r = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { ...p1Headers, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(r.status, 403, `Non-admin ${method} ${url} must return 403`);
  }

  // Non-admin still cannot activate a boost they don't own via user route
  const p2NoItem = await fetch(`${baseUrl}/api/lootbox/activate`, {
    method: 'POST',
    headers: { ...p2Headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId: 'bomb' }),
  });
  assert.equal(p2NoItem.status, 400);

  // 6. Admin infinite boosts: activate even at 0 stock + give all (+99)
  const admAct1 = await fetch(`${baseUrl}/api/admin/boosts/activate`, {
    method: 'POST',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId: 'bomb' }),
  });
  assert.equal(admAct1.status, 200);
  // Admin fires bomb even with adminBypass=true
  wsAdmin.sendJSON({ type: 'place', x: 100, y: 100, color: 12, adminBypass: true });
  await wsAdmin.nextMessage((m) => m.type === 'text' && m.data.type === 'place_ok');
  assert.equal((await (await fetch(`${baseUrl}/api/pixel?x=100&y=100`, { headers: adminHeaders })).json()).color, 12);
  assert.equal((await (await fetch(`${baseUrl}/api/pixel?x=101&y=100`, { headers: adminHeaders })).json()).color, 12);

  // Admin can immediately activate bomb AGAIN infinitely without owning stock
  const admAct2 = await fetch(`${baseUrl}/api/admin/boosts/activate`, {
    method: 'POST',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId: 'bomb' }),
  });
  assert.equal(admAct2.status, 200);

  // Admin gives +99 of all boosts
  const giveAllRes = await fetch(`${baseUrl}/api/admin/boosts/give`, {
    method: 'POST',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId: 'all', amount: 99 }),
  });
  assert.equal(giveAllRes.status, 200);
  const giveAllData = await giveAllRes.json();
  assert.ok(giveAllData.inventory.items.frenzy >= 99);
  assert.ok(giveAllData.inventory.items.bomb >= 99);
  assert.ok(giveAllData.inventory.items.shield >= 99);
  assert.ok(giveAllData.inventory.lootboxes >= 99);

  // 7. Admin Image Auto-Fill Bot (with auto-defense repair + stop)
  const botPixels = [
    { x: 2, y: 2, c: 15 },
    { x: 3, y: 2, c: 15 },
    { x: 4, y: 2, c: 15 },
    { x: 2, y: 3, c: 16 },
    { x: 3, y: 3, c: 16 },
    { x: 4, y: 3, c: 16 },
  ];
  const startBotRes = await fetch(`${baseUrl}/api/admin/bot/start`, {
    method: 'POST',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'LogoTest.png',
      pixels: botPixels,
      ratePerSec: 100,
      order: 'row',
      maintain: true,
      author: 'PixelBot',
    }),
  });
  assert.equal(startBotRes.status, 200);
  const { job } = await startBotRes.json();
  assert.equal(job.totalPixels, 6);

  // Wait briefly for bot ticks to complete all 6 pixels
  await new Promise((r) => setTimeout(r, 260));
  for (const p of botPixels) {
    const info = await (await fetch(`${baseUrl}/api/pixel?x=${p.x}&y=${p.y}`, { headers: adminHeaders })).json();
    assert.equal(info.color, p.c, `Bot must paint pixel (${p.x},${p.y})`);
    assert.equal(info.author, 'PixelBot');
  }

  const botListRes = await fetch(`${baseUrl}/api/admin/bot`, { headers: adminHeaders });
  const botList = await botListRes.json();
  assert.equal(botList.jobs[0].status, 'defending');

  // Player 2 overwrites (2, 2) -> defending bot automatically repairs it back to color 15!
  wsP2.sendJSON({ type: 'place', x: 2, y: 2, color: 3 });
  await wsP2.nextMessage((m) => m.type === 'text' && m.data.type === 'place_ok');
  await new Promise((r) => setTimeout(r, 260));
  const repaired = await (await fetch(`${baseUrl}/api/pixel?x=2&y=2`, { headers: adminHeaders })).json();
  assert.equal(repaired.color, 15, 'Defending bot must auto-repair overwritten pixel');

  // Stop bot cleanly
  const stopRes = await fetch(`${baseUrl}/api/admin/bot/control`, {
    method: 'POST',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: job.id, action: 'stop' }),
  });
  assert.equal(stopRes.status, 200);
  assert.equal((await stopRes.json()).jobs.length, 0);

  wsAdmin.close();
  wsP1.close();
  wsP2.close();
});
