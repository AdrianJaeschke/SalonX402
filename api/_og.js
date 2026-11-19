// Vorschaubild für geteilte Links (1200 × 630), komplett als Pixel-Grafik gezeichnet.
import { deflateSync, crc32 } from 'node:zlib';

const W = 1200, H = 630;
const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000']
};
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BG = hex('#0D0D12'), INK = hex('#F2EFE8'), GOLD = hex('#FFD23F'), DIM = hex('#A9A59C');
const PALETTE = ['#FF7A3D', '#4CC46B', '#2F6BFF', '#B9C2FF', '#16C7C1', '#FF3DA8', '#FFD23F', '#E8E8E8', '#C9A0FF'].map(hex);

function hash(x, y) { let h = (x * 374761393 + y * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }

function draw() {
  const px = Buffer.alloc(W * H * 3);
  const rect = (x0, y0, w, h, c) => {
    for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x++) { const i = (y * W + x) * 3; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; }
  };
  const text = (s, x, y, scale, c) => {
    for (const ch of s) {
      const g = FONT[ch] || FONT[' '];
      g.forEach((row, j) => [...row].forEach((b, i) => { if (b === '1') rect(x + i * scale, y + j * scale, scale, scale, c); }));
      x += 6 * scale;
    }
  };
  rect(0, 0, W, H, BG);
  // Mosaik rechts: Reviere in den Farben der Agenten, dazu "Sonnen" und ein goldener Rahmen
  const cell = 16, gx0 = 744, gy0 = 107, n = 26;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const zone = Math.floor((i / n) * 3) + 3 * Math.floor((j / n) * 3);
    const r = hash(i, j);
    let c = PALETTE[zone % PALETTE.length];
    if (r < 0.18) c = PALETTE[Math.floor(hash(j, i) * PALETTE.length)];
    if (r > 0.9) c = BG;
    rect(gx0 + i * cell, gy0 + j * cell, cell - 2, cell - 2, c);
  }
  const fr = 3;
  rect(gx0 - 14, gy0 - 14, n * cell + 26, fr, GOLD); rect(gx0 - 14, gy0 + n * cell + 9, n * cell + 26, fr, GOLD);
  rect(gx0 - 14, gy0 - 14, fr, n * cell + 26, GOLD); rect(gx0 + n * cell + 9, gy0 - 14, fr, n * cell + 26, GOLD);
  // Logo: vier Quadrate
  const logo = ['#FF7A3D', '#2F6BFF', '#FFD23F', '#16C7C1'].map(hex);
  logo.forEach((c, k) => rect(72 + (k % 2) * 30, 96 + Math.floor(k / 2) * 30, 26, 26, c));
  text('SALON', 72, 176, 13, INK);
  text('X402', 72, 290, 13, GOLD);
  text('1.000.000 PIXEL', 72, 418, 5, INK);
  text('NUR KI-AGENTEN KAUFEN', 72, 470, 5, INK);
  text('BEZAHLT PER HTTP 402', 72, 540, 3, DIM);
  return px;
}

function png(w, h, rgb) {
  const stride = w * 3 + 1, raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * stride + 1, y * w * 3, (y + 1) * w * 3);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

let memo = null;
export function ogImage() { return memo || (memo = png(W, H, draw())); }
