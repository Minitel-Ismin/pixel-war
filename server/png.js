'use strict';

const zlib = require('node:zlib');

// Precomputed CRC32 table for PNG chunks
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

/**
 * Encodes an indexed pixel canvas into a crisp nearest-neighbor upscaled PNG Buffer.
 * @param {Uint8Array} pixels - width * height array of palette indices
 * @param {number} width
 * @param {number} height
 * @param {string[]} palette - array of #RRGGBB hex strings
 * @param {number} scale - integer upscale factor (1..16)
 * @returns {Buffer}
 */
function encodeCanvasPNG(pixels, width, height, palette, scale = 1) {
  const s = Math.max(1, Math.min(16, Math.floor(scale)));
  const outW = width * s;
  const outH = height * s;

  // Guard against excessive memory allocation (max ~16M output pixels)
  if (outW * outH > 16_000_000) {
    throw new Error(`Export PNG trop grand (${outW}x${outH}). Réduisez l'échelle.`);
  }

  const rgbPalette = palette.map(hexToRgb);
  const fallbackRgb = rgbPalette[0] || [255, 255, 255];

  const stride = 1 + outW * 3;
  const raw = Buffer.allocUnsafe(stride * outH);

  for (let y = 0; y < height; y++) {
    const firstRowOffset = y * s * stride;
    raw[firstRowOffset] = 0; // filter type 0 (None)
    let ptr = firstRowOffset + 1;
    const srcRow = y * width;

    for (let x = 0; x < width; x++) {
      const idx = pixels[srcRow + x];
      const rgb = rgbPalette[idx] || fallbackRgb;
      const r = rgb[0];
      const g = rgb[1];
      const b = rgb[2];
      for (let sx = 0; sx < s; sx++) {
        raw[ptr++] = r;
        raw[ptr++] = g;
        raw[ptr++] = b;
      }
    }

    // Duplicate the scaled scanline (s - 1) times vertically
    for (let sy = 1; sy < s; sy++) {
      raw.copy(raw, firstRowOffset + sy * stride, firstRowOffset, firstRowOffset + stride);
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(outW, 0);
  ihdr.writeUInt32BE(outH, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: Truecolor (RGB)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = zlib.deflateSync(raw, { level: 6 });

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { encodeCanvasPNG, hexToRgb };
