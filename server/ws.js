'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2 MiB max per WS frame

class WebSocketClient extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.readyState = 1; // 1 = OPEN, 2 = CLOSING, 3 = CLOSED
    this.isAlive = true;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = 0;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._cleanup());
    socket.on('error', (err) => {
      this.emit('error', err);
      this._cleanup();
    });
  }

  _cleanup() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this.emit('close');
  }

  _onData(chunk) {
    if (this.readyState !== 1) return;
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;

    while (this._buffer.length >= 2) {
      const b0 = this._buffer[0];
      const b1 = this._buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this._buffer.length < 4) return;
        payloadLen = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) return;
        const hi = this._buffer.readUInt32BE(2);
        const lo = this._buffer.readUInt32BE(6);
        payloadLen = hi * 0x100000000 + lo;
        offset = 10;
      }

      if (payloadLen > MAX_PAYLOAD_BYTES) {
        this.close(1009, 'Message too large');
        return;
      }

      const maskSize = masked ? 4 : 0;
      const totalLen = offset + maskSize + payloadLen;
      if (this._buffer.length < totalLen) return;

      let payload;
      if (masked) {
        const mask = this._buffer.subarray(offset, offset + 4);
        payload = Buffer.allocUnsafe(payloadLen);
        const start = offset + 4;
        for (let i = 0; i < payloadLen; i++) {
          payload[i] = this._buffer[start + i] ^ mask[i & 3];
        }
      } else {
        payload = Buffer.from(this._buffer.subarray(offset, offset + payloadLen));
      }

      this._buffer = this._buffer.subarray(totalLen);

      // Control frames (opcode >= 0x8)
      if (opcode === 0x8) {
        // Close
        this.close(1000);
        return;
      } else if (opcode === 0x9) {
        // Ping -> reply Pong
        this._sendFrame(0x0a, payload);
        continue;
      } else if (opcode === 0x0a) {
        // Pong
        this.isAlive = true;
        continue;
      }

      // Data frames
      if (opcode !== 0x0) {
        this._fragmentOpcode = opcode;
        this._fragments = [payload];
      } else {
        this._fragments.push(payload);
      }

      if (fin) {
        const full = this._fragments.length === 1 ? this._fragments[0] : Buffer.concat(this._fragments);
        const op = this._fragmentOpcode;
        this._fragments = [];
        this._fragmentOpcode = 0;
        if (op === 0x1) {
          this.emit('message', full.toString('utf8'), false);
        } else if (op === 0x2) {
          this.emit('message', full, true);
        }
      }
    }
  }

  _sendFrame(opcode, payloadBuffer) {
    if (this.readyState !== 1 || this.socket.destroyed) return false;
    const len = payloadBuffer.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
      header.writeUInt32BE(len >>> 0, 6);
    }
    try {
      this.socket.write(Buffer.concat([header, payloadBuffer]));
      return true;
    } catch {
      this._cleanup();
      return false;
    }
  }

  sendText(str) {
    return this._sendFrame(0x1, Buffer.from(str, 'utf8'));
  }

  sendJSON(obj) {
    return this.sendText(JSON.stringify(obj));
  }

  sendBinary(buf) {
    return this._sendFrame(0x2, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  }

  ping() {
    return this._sendFrame(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    const reasonBuf = Buffer.from(reason, 'utf8');
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    try {
      const header = Buffer.from([0x88, payload.length]);
      this.socket.end(Buffer.concat([header, payload]));
    } catch {
      this.socket.destroy();
    }
    this._cleanup();
  }

  terminate() {
    this.readyState = 3;
    try {
      this.socket.destroy();
    } catch {
      // ignore
    }
    this._cleanup();
  }
}

class WebSocketServer extends EventEmitter {
  constructor(httpServer, { path = '/ws', pingIntervalMs = 25000 } = {}) {
    super();
    this.path = path;
    this.clients = new Set();

    httpServer.on('upgrade', (req, socket, head) => {
      const urlPath = (req.url || '/').split('?')[0];
      if (urlPath !== this.path) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const key = req.headers['sec-websocket-key'];
      const upgrade = (req.headers.upgrade || '').toLowerCase();
      if (!key || upgrade !== 'websocket') {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const accept = crypto
        .createHash('sha1')
        .update(key + WS_GUID)
        .digest('base64');

      const responseHeaders = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n');

      socket.write(responseHeaders);

      const client = new WebSocketClient(socket, req);
      this.clients.add(client);
      client.on('close', () => {
        this.clients.delete(client);
      });

      this.emit('connection', client, req);

      if (head && head.length > 0) {
        client._onData(head);
      }
    });

    this._pingTimer = setInterval(() => {
      for (const client of this.clients) {
        if (!client.isAlive) {
          client.terminate();
          continue;
        }
        client.isAlive = false;
        client.ping();
      }
    }, pingIntervalMs);
    this._pingTimer.unref();
  }

  broadcastText(str) {
    const buf = Buffer.from(str, 'utf8');
    const frame = buildServerFrame(0x1, buf);
    for (const client of this.clients) {
      if (client.readyState === 1 && !client.socket.destroyed) {
        try {
          client.socket.write(frame);
        } catch {
          client.terminate();
        }
      }
    }
  }

  broadcastJSON(obj) {
    this.broadcastText(JSON.stringify(obj));
  }

  broadcastBinary(buf) {
    const frame = buildServerFrame(0x2, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    for (const client of this.clients) {
      if (client.readyState === 1 && !client.socket.destroyed) {
        try {
          client.socket.write(frame);
        } catch {
          client.terminate();
        }
      }
    }
  }

  close() {
    clearInterval(this._pingTimer);
    for (const client of this.clients) {
      client.close(1001, 'Server shutting down');
    }
    this.clients.clear();
  }
}

function buildServerFrame(opcode, payloadBuffer) {
  const len = payloadBuffer.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  return Buffer.concat([header, payloadBuffer]);
}

module.exports = { WebSocketServer, WebSocketClient };
