// The canvas: 1000 × 1000, starts completely empty. Stored as 100 × 100 tiles (RGBA) that only come
// into existence when something is painted on them. Browsers load each tile as a small PNG whose URL
// carries the tile's version, so the CDN can cache it forever.
import zlib from 'node:zlib';
import { db, NS, withLock } from './_db.js';
import { SIZE } from '../public/core.js';

export const TILE = 100, PER_ROW = SIZE / TILE;
const K = { tile: id => NS + 'tile:' + id, index: NS + 'tiles', ver: NS + 'tilever', lock: NS + 'lock:px', pixels: NS + 'pixels' };
const idOf = (x, y) => Math.floor(x / TILE) + ':' + Math.floor(y / TILE);

const decode = v => (typeof v === 'string' && v.startsWith('t:') ? Buffer.from(v.slice(2), 'base64') : null);
const encode = b => 't:' + b.toString('base64');

/**
 * Apply pixel operations. op = { x, y, c: [r,g,b], a: 0..1, mode: 'set' | 'over' | 'erase' }
 * 'set' replaces, 'over' blends over what is there, 'erase' makes the pixel empty again.
 */
export async function applyPixels(ops) {
  const groups = new Map();
  for (const o of ops) {
    if (!(o.x >= 0 && o.y >= 0 && o.x < SIZE && o.y < SIZE)) continue;
    const id = idOf(o.x, o.y);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(o);
  }
  if (!groups.size) return { changed: 0 };
  return withLock(K.lock, async () => {
    const ids = [...groups.keys()];
    const p = db.pipeline(); for (const id of ids) p.get(K.tile(id));
    const raw = await p.exec();
    const ver = await db.incr(K.ver);
    const out = db.pipeline(), index = {};
    let changed = 0, added = 0;
    ids.forEach((id, k) => {
      const buf = decode(raw[k]) || Buffer.alloc(TILE * TILE * 4);
      const [tx, ty] = id.split(':').map(Number);
      for (const o of groups.get(id)) {
        const i = ((o.y - ty * TILE) * TILE + (o.x - tx * TILE)) * 4, was = buf[i + 3] > 0;
        if (o.mode === 'erase') { if (was) { buf.fill(0, i, i + 4); changed++; added--; } continue; }
        const a = o.a ?? 1;
        if (o.mode === 'over' && was && a < 1) {
          for (let c = 0; c < 3; c++) buf[i + c] = Math.round(o.c[c] * a + buf[i + c] * (1 - a));
        } else {
          buf[i] = o.c[0]; buf[i + 1] = o.c[1]; buf[i + 2] = o.c[2];
          buf[i + 3] = was ? Math.max(buf[i + 3], Math.round(a * 255)) : Math.round(a * 255);
          if (!was) added++;
        }
        changed++;
      }
      out.set(K.tile(id), encode(buf));
      index[id] = ver;
    });
    out.hset(K.index, index);
    if (added) out.incrby(K.pixels, added);
    await out.exec();
    return { changed, ver };
  });
}

export async function tileIndex() { return (await db.hgetall(K.index)) || {}; }
export async function paintedCount() { return Math.max(0, Number(await db.get(K.pixels)) || 0); }

// Read a region for agents: rows of hex colours, '' where the canvas is still empty
export async function readRegion(x, y, w, h) {
  const list = [];
  for (let ty = Math.floor(y / TILE); ty <= Math.floor((y + h - 1) / TILE); ty++) for (let tx = Math.floor(x / TILE); tx <= Math.floor((x + w - 1) / TILE); tx++) list.push(tx + ':' + ty);
  const p = db.pipeline(); for (const id of list) p.get(K.tile(id));
  const raw = await p.exec(), bufs = new Map(list.map((id, k) => [id, decode(raw[k])]));
  const rows = [];
  for (let j = y; j < y + h; j++) {
    const row = [];
    for (let i = x; i < x + w; i++) {
      const b = bufs.get(idOf(i, j)), tx = Math.floor(i / TILE), ty = Math.floor(j / TILE);
      const o = ((j - ty * TILE) * TILE + (i - tx * TILE)) * 4;
      row.push(b && b[o + 3] > 0 ? [b[o], b[o + 1], b[o + 2]].map(v => v.toString(16).padStart(2, '0')).join('') : '');
    }
    rows.push(row);
  }
  return rows;
}

// Minimal PNG encoder (RGBA, no filter)
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
export function png(rgba, w, h) {
  const stride = w * 4 + 1, raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
export async function tilePng(id) {
  if (!/^\d{1,2}:\d{1,2}$/.test(id)) return null;
  const [tx, ty] = id.split(':').map(Number);
  if (tx >= PER_ROW || ty >= PER_ROW) return null;
  const b = decode(await db.get(K.tile(id)));
  return png(b || Buffer.alloc(TILE * TILE * 4), TILE, TILE);
}
