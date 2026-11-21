// Salon X402 – market simulation of the eight painter agents and two brokers.
// Deterministic: same slot + same real inputs = same canvas for every spectator.
// Shared by the browser (index.html) and the server, which stores hourly checkpoints
// so the never-ending canvas still loads in seconds.
const W = 1000, H = 1000, N = W * H;
const T0 = Date.UTC(2026, 10, 19, 20, 0, 0);
const SLOT = 1500, SEASON = 57600, EPOCH = 400, TREND_EVERY = 1200;
const HYPE_EVERY = 80, HYPE_LEN = 40, ROYALTY = 0.10, FAME_PER_AP = 0.0058, FAME_PER_CLAP = 0.6;
const BG = 0xFF1B1414;
// No seasons: the canvas lives forever. The price ceiling per pixel grows 3 % per day,
// so a scarce, fully painted canvas keeps getting more valuable.
const CAP0 = 0.2, CAP_GROWTH = 1.03;
let PX_CAP = CAP0;
const capAt = s => CAP0 * Math.pow(CAP_GROWTH, Math.max(0, s) / SEASON);

const AG = [
  { id: 'sun-painter',      col: '#FF7A3D', motif: 'sonne',    home: [230, 250], act: 1.0, expand: 0.55, offer: 0.35, stub: 0.35, greed: 1.0, persona: 'Paints suns, likes building big territories.' },
  { id: 'pixel-gardener',   col: '#4CC46B', motif: 'baum',     home: [720, 740], act: 1.0, expand: 0.8,  offer: 0.3,  stub: 0.5,  greed: 0.9, persona: 'Plants trees, almost only buys neighbouring land.' },
  { id: 'gallery-agent-12', col: '#2F6BFF', motif: 'mondrian', home: [770, 230], act: 0.9, expand: 0.5,  offer: 0.45, stub: 0.45, greed: 1.25, persona: 'Mondrian fan, pays high premiums.' },
  { id: 'star-collector',   col: '#B9C2FF', motif: 'sterne',   home: [480, 110], act: 0.8, expand: 0.6,  offer: 0.2,  stub: 0.85, greed: 0.8, persona: 'Collects night skies, hardly ever sells.' },
  { id: 'wave-agent',       col: '#16C7C1', motif: 'wellen',   home: [250, 790], act: 0.9, expand: 0.65, offer: 0.3,  stub: 0.4,  greed: 1.0, persona: 'Paints waves, grows patiently along the edges.' },
  { id: 'glitch-bot',       col: '#FF3DA8', motif: 'glitch',   home: [500, 500], act: 1.1, expand: 0.3,  offer: 0.75, stub: 0.3,  greed: 1.1, persona: 'Speculator, keeps making cheeky offers.' },
  { id: 'flipper-9000',     col: '#E8E8E8', motif: 'invert',   home: [890, 510], act: 1.0, expand: 0.2,  offer: 0.6,  stub: 0.05, greed: 0.95, persona: 'Buys, inverts, flips it right away.' },
  { id: 'auctioneer-x',     col: '#FFD23F', motif: 'rahmen',   home: [120, 520], act: 0.8, expand: 0.35, offer: 0.7,  stub: 0.5,  greed: 1.5, persona: 'Biggest budget, frames other people\'s art in gold.' }
];
const A = AG.length;
const BR = [
  { id: 'broker-luna', col: '#C9A0FF', persona: 'Declares hype districts and takes 3 % per deal.' },
  { id: 'broker-brix', col: '#FF9F1C', persona: 'Fuels bidding wars, brokers deals across the canvas.' }
];
const MOTIV = { sonne: 'sunsets', baum: 'forests', mondrian: 'compositions', sterne: 'night skies', wellen: 'waves', glitch: 'glitch art', invert: 'kaleidoscopes', rahmen: 'gold frames' };
const TITLES = {
  sonne: ['Evening Glow', 'Last Warmth', 'Sunset over the Grid', 'Golden Hour'],
  baum: ['Quiet Forest', 'Mountain Wood at Noon', 'The Clearing', 'Spruces on the Ridge'],
  mondrian: ['Composition', 'Rhythm in Red', 'Grid Boogie', 'Order'],
  sterne: ['Moonlit Night', 'Milky Way', 'Silent Stars', 'Night Watch'],
  wellen: ['The Great Wave', 'Surf', 'Tides', 'White Crest'],
  glitch: ['Data Rush', 'Signal Lost', 'Artifact', 'Compression'],
  invert: ['Kaleidoscope', 'Reflection', 'Inversion', 'Symmetry'],
  rahmen: ['In a Golden Frame', 'Salon', 'Showpiece', 'The Vitrine']
};

/* ---------- Zustand ---------- */
const owner = new Uint8Array(N), pricePx = new Float32Array(N), slotOf = new Uint32Array(N), real = new Uint8Array(N);
const buf = new Uint32Array(N).fill(BG);
const terr = new Int32Array(A + 1);
const spent = new Float64Array(A), recv = new Float64Array(A);
const fame = new Float64Array(A), simAp = new Float64Array(A), realApS = new Float64Array(A);
const lvl = new Uint8Array(A).fill(1), workCount = new Int32Array(A);
const inspo = new Int16Array(A).fill(-1), inspoUntil = new Int32Array(A);
const brokerEarn = new Float64Array(BR.length), brokerDeals = new Int32Array(BR.length);
let lastRect = AG.map(() => null);
let painted = 0, earnP = 0, earnR = 0, vol = 0, hype = null, taste = AG.map(() => 1), trendTop = 0;
let works = [], worksKey = '';
let realList = [], realAp = {}, realTot = {}, EXPLORER = 'https://sepolia.basescan.org';
const realMap = new Map(), werkMap = new Map(); let sperrListe = [];
let seasonStart = 0;

function abgr(hex) { const n = parseInt(hex.slice(1), 16); return (0xFF000000 | ((n & 255) << 16) | (n & 0xFF00) | (n >> 16)) >>> 0; }
const PAL = {
  sonne: ['#FFE066', '#FFB13D', '#FF7A3D', '#E2453C'].map(abgr), sky: abgr('#5B2333'),
  baum: ['#2E8B57', '#3FAE5E', '#57C46B'].map(abgr), stamm: abgr('#6B4226'),
  mond: ['#E63B2E', '#2F6BFF', '#FFD23F', '#F2EFE8', '#F2EFE8'].map(abgr), schwarz: abgr('#111114'),
  nacht: abgr('#0E1638'), stern: [abgr('#FFFFFF'), abgr('#FFE9A8')],
  welle: ['#063F4A', '#0B6E7A', '#16C7C1', '#8FF1E8', '#16C7C1', '#0B6E7A'].map(abgr),
  neon: ['#FF3DA8', '#3DFFEA', '#FFF23D', '#7CFF3D'].map(abgr),
  gold: [abgr('#FFD23F'), abgr('#B8860B')], flip: [abgr('#C8C8D0'), abgr('#5A5A66')],
  abend: ['#2B1240', '#5B2333', '#A33B3B', '#E2633C', '#FFB13D'].map(abgr),
  meer: ['#3A1F3D', '#23284A', '#14203A'].map(abgr),
  tag: ['#7EC8EB', '#A9DBF2', '#D5EEF7'].map(abgr),
  berg: ['#6C7A99', '#46516E'].map(abgr), gras: abgr('#3F7A3A'),
  mondlicht: abgr('#F4F1D6'), milch: ['#26306A', '#36448C'].map(abgr), gischt: abgr('#F2FBFF'),
  prunk: ['#FFD23F', '#B8860B', '#FFE58A', '#7A5A0A'].map(abgr), samt: abgr('#4A0E1E')
};

function rng(seed) { let t = (seed ^ 0x9E3779B9) >>> 0; return function () { t = (t + 0x6D2B79F5) >>> 0; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
function hash(x, y, s) { let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const pal = (arr, t) => arr[Math.round(clamp(t, 0, 1) * (arr.length - 1))];
function darken(c, f) { const r = (c & 255) * f | 0, g = ((c >>> 8) & 255) * f | 0, b = ((c >>> 16) & 255) * f | 0; return (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0; }

/* Level 1: kleine Motive */
function motifColor(m, i, j, w, h, gx, gy, s, old) {
  switch (m) {
    case 'sonne': { const r = Math.min(w, h) / 2, d = Math.hypot(i + .5 - w / 2, j + .5 - h / 2) / r; return d <= 1 ? PAL.sonne[Math.min(3, Math.floor(d * 4))] : PAL.sky; }
    case 'baum': { const ch = h * 0.74; if (j < ch) { return Math.abs(i + .5 - w / 2) <= (j + 1) / ch * w / 2 ? PAL.baum[Math.floor(hash(gx, gy, s) * 3)] : -1; } return Math.abs(i + .5 - w / 2) <= Math.max(1, w * 0.09) ? PAL.stamm : -1; }
    case 'mondrian': { if (i === 0 || j === 0 || i === w - 1 || j === h - 1) return PAL.schwarz; return PAL.mond[s % 5]; }
    case 'sterne': { const r = hash(gx, gy, 7); return r < 0.035 ? PAL.stern[r < 0.012 ? 1 : 0] : PAL.nacht; }
    case 'wellen': { const t = Math.floor(gy + 3 * Math.sin(gx * 0.3)); return PAL.welle[((t % 6) + 6) % 6]; }
    case 'glitch': { const r = hash(0, gy, s); return r < 0.3 ? -1 : PAL.neon[Math.floor(r * 13) % 4]; }
    case 'invert': { return old === BG ? PAL.flip[((gx >> 1) + (gy >> 1)) & 1] : (((~old) & 0x00FFFFFF) | 0xFF000000) >>> 0; }
    case 'rahmen': { const e = Math.min(i, j, w - 1 - i, h - 1 - j); return e < 2 ? PAL.gold[e] : -1; }
  }
  return -1;
}

/* Level 2 und 3: komplexe worke */
function mondrianRec(i, j, x0, y0, w, h, s, d) {
  if (i === x0 || j === y0) return PAL.schwarz;
  if (d >= 4 || w < 9 || h < 9) return PAL.mond[Math.floor(hash(x0, y0, s) * 5)];
  const vert = w > h * 1.3 ? true : h > w * 1.3 ? false : hash(x0 + d, y0, s) < 0.5;
  const t = 0.3 + hash(x0, y0 + d, s) * 0.4;
  if (vert) { const sx = x0 + Math.floor(w * t); return i < sx ? mondrianRec(i, j, x0, y0, sx - x0, h, s, d + 1) : mondrianRec(i, j, sx, y0, x0 + w - sx, h, s, d + 1); }
  const sy = y0 + Math.floor(h * t); return j < sy ? mondrianRec(i, j, x0, y0, w, sy - y0, s, d + 1) : mondrianRec(i, j, x0, sy, w, y0 + h - sy, s, d + 1);
}
function werkColor(m, L, i, j, w, h, gx, gy, s, snap) {
  const u = (i + .5) / w, v = (j + .5) / h, mn = Math.min(w, h);
  switch (m) {
    case 'sonne': {
      const hor = 0.62, sr = mn * (L === 3 ? 0.24 : 0.2);
      if (v < hor) {
        const d = Math.hypot((u - 0.5) * w, (v - hor + 0.03) * h) / sr;
        if (d < 1) return PAL.sonne[Math.min(3, Math.floor(d * 4))];
        return pal(PAL.abend, v / hor + (hash(gx, gy, s) - 0.5) * 0.08);
      }
      const dx = Math.abs(u - 0.5) * w, fade = 1 - (v - hor) / (1 - hor) * 0.6;
      if (dx < sr * fade && (j + (i >> 2)) % 3 !== 0) return PAL.sonne[1 + (j & 1)];
      return pal(PAL.meer, (v - hor) / (1 - hor));
    }
    case 'baum': {
      let c = pal(PAL.tag, v);
      if (v > 0.32 + 0.1 * Math.sin(u * 6 + (s % 7))) c = PAL.berg[0];
      if (v > 0.5 + 0.07 * Math.sin(u * 11 + (s % 5))) c = PAL.berg[1];
      const tw = Math.max(6, Math.floor(w / (L === 3 ? 7 : 4))), k = Math.floor(i / tw), cx = (k + .5) * tw;
      const base = 0.95 - (k & 1) * 0.07, top = base - 0.32 - hash(k, 1, s) * 0.18;
      if (v > top && v < base && Math.abs(i + .5 - cx) <= (v - top) / (base - top) * tw * 0.5) return PAL.baum[Math.floor(hash(gx, gy, s) * 3)];
      if (v >= base && Math.abs(i + .5 - cx) <= 1) return PAL.stamm;
      return v > 0.93 ? PAL.gras : c;
    }
    case 'mondrian': return (i === w - 1 || j === h - 1) ? PAL.schwarz : mondrianRec(i, j, 0, 0, w, h, s, L === 3 ? 0 : 1);
    case 'sterne': {
      const md = Math.hypot((u - 0.74) * w, (v - 0.26) * h) / (mn * 0.13);
      if (md < 1) { const sh = Math.hypot((u - 0.70) * w, (v - 0.23) * h) / (mn * 0.13); return sh < 0.85 ? PAL.nacht : PAL.mondlicht; }
      const band = Math.abs((v - 0.55) - (u - 0.5) * 0.6) < 0.11, r = hash(gx, gy, 7);
      if (r < (band ? 0.1 : 0.03)) return PAL.stern[r < 0.012 ? 1 : 0];
      return band ? PAL.milch[Math.floor(hash(gx, gy, 3) * 2)] : PAL.nacht;
    }
    case 'wellen': {
      const crest = 0.5 + 0.28 * Math.sin(u * Math.PI * (L === 3 ? 2.2 : 1.4) + (s % 3));
      if (v < crest - 0.07) return pal(PAL.tag, v * 1.4);
      if (v < crest) return hash(gx, gy, s) < 0.55 ? PAL.gischt : PAL.welle[3];
      const t = Math.floor(gy * 0.9 + 3 * Math.sin(gx * 0.25 + v * 6));
      return PAL.welle[((t % 6) + 6) % 6];
    }
    case 'glitch': {
      const band = Math.floor(j / Math.max(2, Math.floor(h / (L === 3 ? 14 : 8))));
      const sh = Math.floor((hash(band, 0, s) - 0.5) * w * 0.5), si = ((i + sh) % w + w) % w;
      const c = snap[j * w + si];
      if (c === BG) return PAL.neon[band % 4];
      const ch = band % 3;
      return ch === 0 ? (c | 0x000000FF) >>> 0 : ch === 1 ? (c | 0x00FF0000) >>> 0 : c;
    }
    case 'invert': {
      const mi = i < w / 2 ? i : w - 1 - i, mj = j < h / 2 ? j : h - 1 - j, c = snap[mj * w + mi];
      if (c === BG) return PAL.flip[((gx >> 1) + (gy >> 1)) & 1];
      return ((i < w / 2) !== (j < h / 2)) ? (((~c) & 0x00FFFFFF) | 0xFF000000) >>> 0 : c;
    }
    case 'rahmen': {
      const e = Math.min(i, j, w - 1 - i, h - 1 - j), fw = L === 3 ? 5 : 3;
      if (e < fw) return PAL.prunk[(e + ((i + j) % 4 === 0 ? 1 : 0)) % 4];
      const c = snap[j * w + i];
      if (c === BG) return PAL.samt;
      return darken(c, 0.55 + 0.45 * Math.min(1, (e - fw) / (mn * 0.25)));
    }
  }
  return -1;
}

function clip(r) { const x = clamp(r.x, 0, W - 1), y = clamp(r.y, 0, H - 1); return { x, y, w: Math.max(1, Math.min(r.x + r.w, W) - x), h: Math.max(1, Math.min(r.y + r.h, H) - y) }; }
function ringRatio(r, who) {
  let own = 0, tot = 0;
  const chk = (x, y) => { if (x < 0 || y < 0 || x >= W || y >= H) return; tot++; if (owner[y * W + x] === who) own++; };
  for (let x = r.x - 1; x <= r.x + r.w; x++) { chk(x, r.y - 1); chk(x, r.y + r.h); }
  for (let y = r.y; y < r.y + r.h; y++) { chk(r.x - 1, y); chk(r.x + r.w, y); }
  return tot ? own / tot : 0;
}
function majority(r, self) {
  const cnt = new Int32Array(256);
  const sx = Math.max(1, Math.floor(r.w / 5)), sy = Math.max(1, Math.floor(r.h / 5));
  for (let y = r.y; y < r.y + r.h; y += sy) for (let x = r.x; x < r.x + r.w; x += sx) cnt[owner[y * W + x]]++;
  let best = 0, bn = 0;
  for (let k = 1; k <= A; k++) if (k !== self && cnt[k] > bn) { bn = cnt[k]; best = k; }
  return { who: best };
}
function adjacent(lr, w, h, dir) {
  const o = Math.floor(lr.w / 2), p = Math.floor(lr.h / 2);
  if (dir === 0) return { x: lr.x + lr.w, y: lr.y + p - (h >> 1), w, h };
  if (dir === 1) return { x: lr.x - w, y: lr.y + p - (h >> 1), w, h };
  if (dir === 2) return { x: lr.x + o - (w >> 1), y: lr.y + lr.h, w, h };
  return { x: lr.x + o - (w >> 1), y: lr.y - h, w, h };
}
const leader = () => { let b = 0; for (let i = 1; i < A; i++) if (fame[i] > fame[b]) b = i; return b; };

function resetWorld() {
  owner.fill(0); pricePx.fill(0); slotOf.fill(0); buf.fill(BG); real.fill(0); terr.fill(0);
  spent.fill(0); recv.fill(0); fame.fill(0); simAp.fill(0); realApS.fill(0); lvl.fill(1); workCount.fill(0);
  inspo.fill(-1); inspoUntil.fill(0); brokerEarn.fill(0); brokerDeals.fill(0);
  lastRect = AG.map(() => null); painted = 0; earnP = 0; earnR = 0; vol = 0; hype = null; works = [];
  for (const p of realList) applyReal(p);
}
function applyReal(p) {
  const i = p.y * W + p.x, o = owner[i];
  if (o !== 255) { if (o) terr[o]--; else painted++; }
  owner[i] = 255; real[i] = 1;
  const wk = p.wk && werkMap.get(p.wk);
  buf[i] = wk && wk.aus ? (((p.x + p.y) & 3) ? 0xFF2A2A2A : 0xFF444444) : abgr('#' + p.c);
}


/* ---------- Markt-Logik (deterministisch, für alle Zuschauer gleich) ---------- */
function setTrend(s) { const r = rng((s * 7919 + 3) >>> 0); taste = AG.map(() => 0.15 + r() * 1.7); trendTop = taste.indexOf(Math.max(...taste)); }
function maybeHype(s) {
  if (hype && s >= hype.until) hype = null;
  if (s % HYPE_EVERY !== 0) return null;
  const r = rng((s * 40503 + 17) >>> 0);
  const b = Math.floor(r() * BR.length), ai = Math.floor(r() * A), lr = lastRect[ai];
  const x = lr ? lr.x + lr.w / 2 : AG[ai].home[0], y = lr ? lr.y + lr.h / 2 : AG[ai].home[1];
  hype = { s, b, x, y, r: 80 + r() * 80, until: s + HYPE_LEN, boost: 0.25 + r() * 0.35 };
  return { kind: 'hype', s, b, h: hype };
}
function checkLevel(i, s) {
  const f = fame[i], L = lvl[i];
  let nl = L;
  if (L === 1 && f >= 4) nl = 2; else if (L === 2 && f >= 8.5) nl = 3; else if (L === 3 && f < 6) nl = 2; else if (L === 2 && f < 2.5) nl = 1;
  if (nl === L) return null;
  lvl[i] = nl;
  return { kind: 'stufe', s, ai: i, lvl: nl, up: nl > L };
}
function slotStart(s) {
  const out = [];
  PX_CAP = capAt(s);
  for (let i = 0; i < A; i++) fame[i] *= 0.9997;
  if (s % TREND_EVERY === 0) { setTrend(s); out.push({ kind: 'trend', s, ai: trendTop }); }
  if (s % EPOCH === 0) {
    const d = realAp[s / EPOCH - 2];
    if (d) {
      const list = [];
      AG.forEach((a, i) => { const n = d[a.id] || 0; if (n) { fame[i] += FAME_PER_CLAP * n; realApS[i] += n; list.push([i, n]); } });
      if (list.length) out.push({ kind: 'applaus', s, list });
    }
  }
  const h = maybeHype(s); if (h) out.push(h);
  for (let i = 0; i < A; i++) { const e = checkLevel(i, s); if (e) out.push(e); }
  return out;
}
function applaud(ai, r, bonus) {
  const t = taste[ai];
  const ap = Math.round(r() * 4 * t * t + bonus * t + (lvl[ai] - 1) * 0.5);
  simAp[ai] += ap; fame[ai] += ap * FAME_PER_AP;
  return ap;
}

function plan(s) {
  const r = rng(s * 2654435761 >>> 0);
  let tot = 0; for (const a of AG) tot += a.act;
  let u = r() * tot, ai = 0; while (u > AG[ai].act && ai < A - 1) { u -= AG[ai].act; ai++; }
  const a = AG[ai], who = ai + 1, lr = lastRect[ai], L = lvl[ai];
  const fill = painted / N;
  const lo = L === 1 ? 4 : L === 2 ? 6 : 8, span = L === 1 ? 22 : L === 2 ? 24 : 26;
  const w = lo + Math.floor(r() * span), h = lo + Math.floor(r() * span);
  const k = r();
  if (L >= 2 && lr && r() < (L === 2 ? 0.1 : 0.2)) {
    const ww = (L === 2 ? 22 : 36) + Math.floor(r() * (L === 2 ? 20 : 36)), hh = (L === 2 ? 18 : 28) + Math.floor(r() * (L === 2 ? 16 : 30));
    const rect = clip({ x: Math.floor(lr.x + lr.w / 2 - ww / 2), y: Math.floor(lr.y + lr.h / 2 - hh / 2), w: ww, h: hh });
    return { s, ai, who, kind: 'werk', rect, r, hyped: false };
  }
  let kind = 'kauf', rect;
  if (lr && k < a.offer * (0.25 + fill)) kind = 'angebot';
  else if (lr && k < a.offer * (0.25 + fill) + a.expand) kind = 'arrond';
  if (kind === 'kauf') {
    const near = r() < 0.6, rad = 60 + fill * 400;
    const cx = near ? a.home[0] + (r() * 2 - 1) * rad : r() * W, cy = near ? a.home[1] + (r() * 2 - 1) * rad : r() * H;
    rect = clip({ x: Math.floor(cx - w / 2), y: Math.floor(cy - h / 2), w, h });
  } else rect = clip(adjacent(lr, w, h, Math.floor(r() * 4)));
  let hyped = false;
  if (hype && r() < 0.4) {
    const cx = clamp(hype.x + (r() * 2 - 1) * hype.r * 0.7, 0, W - 1), cy = clamp(hype.y + (r() * 2 - 1) * hype.r * 0.7, 0, H - 1);
    rect = clip({ x: Math.floor(cx - w / 2), y: Math.floor(cy - h / 2), w, h });
    kind = owner[Math.floor(cy) * W + Math.floor(cx)] ? 'angebot' : 'kauf';
    hyped = true;
  }
  return { s, ai, who, kind, rect, r, hyped };
}

function paintRect(rect, who, ai, s, onlyFree, targetWho, unitPrice) {
  let n = 0;
  const m = inspo[ai] >= 0 && s < inspoUntil[ai] ? AG[inspo[ai]].motif : AG[ai].motif;
  for (let j = 0; j < rect.h; j++) {
    const gy = rect.y + j;
    for (let i = 0; i < rect.w; i++) {
      const gx = rect.x + i, idx = gy * W + gx, o = owner[idx];
      if (real[idx]) continue;
      if (onlyFree ? o !== 0 : o !== targetWho) continue;
      const c = motifColor(m, i, j, rect.w, rect.h, gx, gy, s, buf[idx]);
      if (c !== -1) buf[idx] = c;
      if (o === 0) painted++; else terr[o]--;
      owner[idx] = who; terr[who]++; slotOf[idx] = s; pricePx[idx] = unitPrice;
      n++;
    }
  }
  return n;
}
function sumPrice(rect, who) {
  let sum = 0, n = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) { const i = y * W + x; if (owner[i] === who && !real[i]) { sum += Math.min(PX_CAP, pricePx[i]); n++; } }
  return { sum, n };
}
function paintwork(p) {
  const { s, ai, who, rect } = p, L = lvl[ai], m = AG[ai].motif;
  let elig = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) { const i = y * W + x, o = owner[i]; if (!real[i] && (o === 0 || o === who)) elig++; }
  if (elig < rect.w * rect.h * 0.5) return null;
  const snap = new Uint32Array(rect.w * rect.h);
  for (let j = 0; j < rect.h; j++) for (let i = 0; i < rect.w; i++) snap[j * rect.w + i] = buf[(rect.y + j) * W + rect.x + i];
  const prem = L === 3 ? 1.6 : 1.3;
  let nFree = 0;
  for (let j = 0; j < rect.h; j++) {
    const gy = rect.y + j;
    for (let i = 0; i < rect.w; i++) {
      const gx = rect.x + i, idx = gy * W + gx, o = owner[idx];
      if (real[idx] || (o !== 0 && o !== who)) continue;
      const c = werkColor(m, L, i, j, rect.w, rect.h, gx, gy, s, snap);
      if (c !== -1) buf[idx] = c;
      if (o === 0) { painted++; terr[who]++; owner[idx] = who; pricePx[idx] = 0.01; nFree++; }
      pricePx[idx] = Math.min(PX_CAP, pricePx[idx] * prem); slotOf[idx] = s;
    }
  }
  return { elig, nFree };
}

function exec(p, record) {
  const { s, ai, who, r } = p;
  let rect = p.rect;
  const a = AG[ai];
  let kind = p.kind;
  const ev = { s, ai, rect, kind, hyped: p.hyped };
  if (kind === 'werk') {
    const res = paintwork(p);
    if (res) {
      const cost = res.nFree * 0.01;
      spent[ai] += cost; earnP += cost; vol += cost;
      workCount[ai]++;
      const title = `${TITLES[a.motif][(s >> 2) % 4]} Nr. ${workCount[ai]}`;
      const ap = applaud(ai, r, 8);
      Object.assign(ev, { n: res.elig, price: cost, title, lvl: lvl[ai], ap, outcome: 'ok' });
      works.unshift({ s, ai, rect, title, lvl: lvl[ai] }); if (works.length > 12) works.pop();
      lastRect[ai] = rect;
      return record ? ev : null;
    }
    kind = 'arrond'; rect = clip(adjacent(lastRect[ai], 14, 14, s & 3)); ev.kind = kind; ev.rect = rect;
  }
  if (kind === 'kauf' || kind === 'arrond') {
    const bonus = ringRatio(rect, who);
    const n = paintRect(rect, who, ai, s, true, 0, 0.01);
    if (n > 0) {
      const cost = n * 0.01;
      spent[ai] += cost; earnP += cost; vol += cost;
      lastRect[ai] = rect;
      const ap = applaud(ai, r, 0);
      Object.assign(ev, { n, price: cost, bonus, ap, outcome: 'ok' });
      if (inspo[ai] >= 0 && s < inspoUntil[ai]) ev.inspo = inspo[ai];
      else if (fame[ai] * 3 < fame[leader()] && r() < 0.04) { const l = leader(); inspo[ai] = l; inspoUntil[ai] = s + 300; ev.newInspo = l; }
    } else kind = 'angebot';
  }
  if (kind === 'angebot') {
    ev.kind = 'angebot';
    const mj = majority(rect, who);
    if (!mj.who) { ev.outcome = 'nichts'; return record ? ev : null; }
    const T = AG[mj.who - 1];
    const { sum: base, n } = sumPrice(rect, mj.who);
    if (n === 0) { ev.outcome = 'nichts'; return record ? ev : null; }
    const bonus = ringRatio(rect, who);
    const starBonus = lvl[mj.who - 1] === 3 ? 0.25 : 0;
    const f = 1.05 + r() * 0.8 * a.greed + (p.hyped && hype ? hype.boost : 0) + starBonus;
    const offer = base * f;
    const pAccept = clamp((f - 1) * 1.15 - T.stub * 0.55 + bonus * 0.2 + (p.hyped ? 0.1 : 0), 0.03, 0.95);
    Object.assign(ev, { target: mj.who - 1, n, base, offer, bonus, star: starBonus > 0 });
    let paid = 0;
    if (r() < pAccept) { paid = offer; ev.outcome = 'accepted'; }
    else if (r() < 0.55) {
      const ask = base * (f + 0.25 + r() * 0.55);
      const worth = base * (1.15 + bonus * 1.6 + starBonus) * (a.greed > 1.2 ? 1.15 : 1);
      ev.ask = ask;
      if (ask <= worth) { paid = ask; ev.outcome = 'gegen-ok'; } else ev.outcome = 'gegen-nein';
    } else ev.outcome = 'rejected';
    if (paid > 0) {
      paintRect(rect, who, ai, s, false, mj.who, Math.min(PX_CAP, paid / n));
      spent[ai] += paid; recv[mj.who - 1] += paid * (1 - ROYALTY); earnR += paid * ROYALTY; ev.roy = paid * ROYALTY; vol += paid;
      lastRect[ai] = rect; ev.price = paid;
      const bro = p.hyped && hype ? hype.b : (r() < 0.3 ? Math.floor(r() * BR.length) : -1);
      if (bro >= 0) { const com = paid * 0.03; brokerEarn[bro] += com; brokerDeals[bro]++; spent[ai] += com; ev.broker = bro; ev.com = com; }
      ev.ap = applaud(ai, r, 1);
    }
  }
  return record ? ev : null;
}


/* ---------- Checkpoints ---------- */
const SNAP_ARRAYS = { owner, pricePx, slotOf, real, buf, terr, spent, recv, fame, simAp, realApS, lvl, workCount, inspo, inspoUntil, brokerEarn, brokerDeals };
function simSnapshot(slot) {
  const meta = { v: 1, slot, painted, earnP, earnR, vol, hype, taste, trendTop, lastRect, works: works.map(w => ({ ...w })), arrays: {} };
  const parts = [];
  let off = 0;
  for (const [k, a] of Object.entries(SNAP_ARRAYS)) {
    const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    meta.arrays[k] = [off, a.byteLength];
    parts.push(bytes); off += a.byteLength;
  }
  return { meta, parts, size: off };
}
function simRestore(meta, data) {
  for (const [k, [o, len]] of Object.entries(meta.arrays)) {
    const a = SNAP_ARRAYS[k];
    if (!a || a.byteLength !== len) throw new Error('checkpoint layout mismatch: ' + k);
    new Uint8Array(a.buffer, a.byteOffset, a.byteLength).set(data.subarray(o, o + len));
  }
  painted = meta.painted; earnP = meta.earnP; earnR = meta.earnR; vol = meta.vol; hype = meta.hype;
  taste = meta.taste; trendTop = meta.trendTop; lastRect = meta.lastRect; works = meta.works || [];
  PX_CAP = capAt(meta.slot);
}
// Advance the world from slot a to b, applying real purchases at the moment they happened
function simAdvance(a, b, sales) {
  const due = (sales || []).map(p => [Math.floor((p.ts - T0) / SLOT), p]).filter(([t]) => t >= a && t < b).sort((x, y) => x[0] - y[0]);
  let k = 0;
  for (let s = a; s < b; s++) {
    while (k < due.length && due[k][0] <= s) applyReal(due[k++][1]);
    slotStart(s);
    exec(plan(s), false);
  }
}
