// The never-ending canvas: the server replays the market simulation (public/sim.js, the very same
// code the browser runs) and stores a checkpoint every 3 hours in Blob storage. Visitors download the
// newest checkpoint and only replay the minutes since, so loading stays fast no matter how old the canvas is.
import vm from 'node:vm';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { put, get, del } from '@vercel/blob';
import { readCached, redis, NS, MAINNET, AGENT_ALIAS, T0 } from './_register.js';

const CODE = fs.readFileSync(new URL('../public/sim.js', import.meta.url), 'utf8');
const SLOT = 1500, DAY = 57600;
export const STEP = 7200; // 3 hours of market slots
const DIR = MAINNET ? 'world-base/' : 'world/';
const LATEST = DIR + 'latest.json';
const curSlot = () => Math.floor((Date.now() - T0) / SLOT);

function newSim() {
  const ctx = vm.createContext({ console });
  return vm.runInContext(CODE + '\n;({ simAdvance, simSnapshot, simRestore, resetWorld, setRealAp: x => { realAp = x; } })', ctx);
}

let memo = null; // { at, latest }
export async function latest(fresh) {
  if (!fresh && memo && Date.now() - memo.at < 30_000) return memo.latest;
  let l = null;
  try { const g = await get(LATEST, { access: 'public', useCache: !fresh }); if (g) l = await new Response(g.stream).json(); } catch {}
  memo = { at: Date.now(), latest: l };
  return l;
}

async function loadCheckpoint(l) {
  const g = await get(l.path, { access: 'public' });
  const gz = Buffer.from(await new Response(g.stream).arrayBuffer());
  return new Uint8Array(zlib.gunzipSync(gz));
}

export async function build() {
  const target = Math.floor(curSlot() / STEP) * STEP;
  const lock = NS + 'world:lock';
  if (redis && !(await redis.set(lock, '1', { nx: true, ex: 240 }))) return { busy: true };
  try {
    const l = await latest(true);
    if (l && l.slot >= target) return { ok: true, slot: l.slot, unchanged: true };
    const sim = newSim();
    let from = 0;
    if (l) { try { sim.simRestore(l.meta, await loadCheckpoint(l)); from = l.slot; } catch (e) { console.error('checkpoint unreadable, rebuilding', e?.message); sim.resetWorld(); from = 0; } }
    else sim.resetWorld();
    const d = await readCached();
    const ap = {};
    for (const [e, v] of Object.entries(d.ap?.epochs || {})) { ap[e] = {}; for (const [a, n] of Object.entries(v)) { const k = AGENT_ALIAS[a] || a; ap[e][k] = (ap[e][k] || 0) + n; } }
    sim.setRealAp(ap);
    const t = Date.now();
    sim.simAdvance(from, target, d.sales || []);
    const snap = sim.simSnapshot(target);
    const raw = Buffer.concat(snap.parts.map(p => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
    const gz = zlib.gzipSync(raw, { level: 6 });
    const path = `${DIR}cp-${target}.bin`;
    const b = await put(path, gz, { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/octet-stream', cacheControlMaxAge: 31536000 });
    const next = { slot: target, path, url: b.url, size: gz.length, built: Date.now(), ms: Date.now() - t, meta: snap.meta, prev: l ? { slot: l.slot, url: l.url } : null };
    await put(LATEST, JSON.stringify(next), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60 });
    memo = { at: Date.now(), latest: next };
    // keep one checkpoint per day as history; drop older in-between ones (the previous one stays a while for clients mid-load)
    if (l && l.prev && l.prev.slot % DAY !== 0) await del(l.prev.url).catch(() => {});
    return { ok: true, slot: target, from, ms: next.ms, size: gz.length };
  } finally {
    if (redis) await redis.del(lock).catch(() => {});
  }
}

export const stale = l => !l || curSlot() - l.slot >= STEP;
