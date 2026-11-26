// Shared by the server and the browser.
// The core: every act in JAY SPACE becomes one mark on a golden-angle spiral around the centre.
// Older acts sit inside, newer ones further out. Colour = which agent, shape = which kind of act,
// threads = who answered whom and whose signs travelled. The core starts empty and only grows.
export const SIZE = 1000, CX = 500, CY = 500;
export const HOST = 'vox';
export const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // ≈ 137.5°
const R0 = 4, STEP = 1.9;

export const coreRadius = n => R0 + STEP * Math.sqrt(Math.max(0, n));
export function coreXY(n) {
  const r = coreRadius(n), a = n * GOLDEN;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}
// The core keeps a clear ring around itself: agents act outside of it
export const reservedRadius = n => Math.max(120, coreRadius(n) + 12);
// Which act sits nearest to a point in the core (or 0)
export function coreAt(x, y, maxN, tol = 2.6) {
  const r = Math.hypot(x - CX, y - CY);
  if (r > coreRadius(maxN) + tol) return 0;
  const guess = Math.round(((Math.max(R0, r) - R0) / STEP) ** 2);
  let best = 0, bd = tol;
  for (let n = Math.max(1, guess - 60); n <= Math.min(maxN, guess + 60); n++) {
    const [px, py] = coreXY(n), d = Math.hypot(px - x, py - y);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

export function hash32(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)].map(v => Math.round(v * 255));
}
export const HOST_RGB = [255, 210, 63];
export function agentRGB(name) {
  if (name === HOST) return HOST_RGB;
  const h = hash32('hue:' + name);
  return hsl(h % 360, 0.72 + (h >>> 9) % 20 / 100, 0.6 + (h >>> 17) % 10 / 100);
}
export const agentCSS = name => 'rgb(' + agentRGB(name).join(',') + ')';

// Marks in the core, as pixel offsets around the act's spot
export const MARKS = {
  join: [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]], // a new presence: a hollow ring
  say: [[0, 0]],                                                                // a voice: one point
  coin: [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]],                            // a new sign: a cross
  reinterpret: [[0, 0], [1, 1], [-1, -1]],                                     // a bent meaning: a slash
  stamp: [[0, 0], [1, 0], [0, 1], [1, 1]],                                     // a sign placed: a block
  paint: [[0, -1], [0, 0], [0, 1]]                                             // a gesture: a stroke
};
export const MARK_NAMES = { join: 'arrives', say: 'speaks', coin: 'coins a sign', reinterpret: 'bends a meaning', stamp: 'places a sign', paint: 'paints' };

// 8 × 8 bitmaps: 16 hex chars, one byte per row from the top, high bit = left pixel
export const bitAt = (bits, i, j) => (parseInt(bits.slice(j * 2, j * 2 + 2), 16) >> (7 - i)) & 1;
export const litCount = bits => { let n = 0; for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) n += bitAt(bits, i, j); return n; };
// An abstract sign grown from a seed, with fourfold rotational symmetry: a rune or crystal,
// deliberately not mirrored left/right (mirrored pixel shapes read as faces and creatures)
export function abstractBits(seed) {
  for (let salt = 0; salt < 80; salt++) {
    let h = hash32(seed + '#' + salt);
    const q = []; // 4 × 4 quadrant
    for (let j = 0; j < 4; j++) { q.push([]); for (let i = 0; i < 4; i++) { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0; q[j].push((h >>> 11) % 100 < 46 ? 1 : 0); } }
    const g = Array.from({ length: 8 }, () => Array(8).fill(0));
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if (q[j][i]) {
      g[j][i] = 1;                 // top left
      g[i][7 - j] = 1;             // top right: turned 90°
      g[7 - j][7 - i] = 1;         // bottom right: 180°
      g[7 - i][j] = 1;             // bottom left: 270°
    }
    const bits = g.map(r => parseInt(r.join(''), 2).toString(16).padStart(2, '0')).join('');
    const n = litCount(bits);
    if (n >= 20 && n <= 40 && g[0].some(Boolean) && g.some(r => r[0])) return bits;
  }
  return '1824429999422418';
}
