import { put, get, head, list, BlobNotFoundError, BlobPreconditionFailedError } from '@vercel/blob';
import { Redis } from '@upstash/redis';
import { randomBytes } from 'node:crypto';

// Redis sorgt dafür, dass immer nur einer schreibt und jeder Leser die neueste Version sieht.
// (Der Blob-Speicher allein lieferte kurz nach einem Schreibvorgang manchmal noch den alten Stand.)
const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const R_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
export const redis = R_URL && R_TOKEN ? new Redis({ url: R_URL, token: R_TOKEN }) : null;

export const SIZE = 1000;
export const T0 = Date.UTC(2026, 10, 19, 20, 0, 0);
export const EPOCH_MS = 600000; // 10 Minuten = 400 Markt-Takte
export const AGENTS = ['sun-painter', 'pixel-gardener', 'gallery-agent-12', 'star-collector', 'wave-agent', 'glitch-bot', 'flipper-9000', 'auctioneer-x'];
// Old (German) agent names, still used in stored applause
export const AGENT_ALIAS = { 'sonnen-maler': 'sun-painter', 'pixel-gaertner': 'pixel-gardener', 'galerie-agent-12': 'gallery-agent-12', 'sterne-sammler': 'star-collector', 'wellen-agent': 'wave-agent', 'auktionator-x': 'auctioneer-x' };
export const NETWORK = process.env.X402_NETWORK || 'eip155:84532'; // Base Sepolia (Testnetz)
export const MAINNET = NETWORK === 'eip155:8453';
export const NETWORK_NAME = MAINNET ? 'Base' : 'Base Sepolia (testnet)';
export const EXPLORER = MAINNET ? 'https://basescan.org' : 'https://sepolia.basescan.org';
// Everything that counts money is kept apart per network: mainnet starts with a clean register and ledger
export const NS = MAINNET ? 'base:' : '';
export const PAY_TO = (process.env.PAY_TO || '').trim();
export const PRICE = process.env.PIXEL_PRICE || '$0.01';
export const FACILITATOR = process.env.FACILITATOR_URL || 'https://x402.org/facilitator';
export const KASSE_OFFEN = /^0x[0-9a-fA-F]{40}$/.test(PAY_TO);
export const HAS_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN;
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/*
 * Register: eine einzige Datei state.json im Blob-Speicher.
 * Lesen läuft über das CDN (kostenlos bei Cache-Treffern), geschrieben wird nur bei Käufen
 * und gebündeltem Applaus. So bleiben wir weit unter den Blob-Limits des Hobby-Plans.
 */
const STATE = MAINNET ? 'state-base.json' : 'state.json';
let cache = null;
export const empty = () => ({ v: 3, sales: [], ap: { epochs: {}, total: {} }, werke: [], auftraege: {}, fertig: {} });
export function addClap(d, e, agent, n) {
  const ep = (d.ap.epochs[e] ||= {});
  ep[agent] = (ep[agent] || 0) + n;
  d.ap.total[agent] = (d.ap.total[agent] || 0) + n;
}
// Mainnet starts empty: no test purchases, but the audience's applause carries over
async function freshMainnet() {
  const d = empty();
  try { const g = await get('state.json', { access: 'public', useCache: false }); if (g) { const t = await new Response(g.stream).json(); if (t.ap) d.ap = t.ap; } } catch {}
  return d;
}
async function migrate() {
  // Einmalig: Daten aus der ersten Version (ein Blob pro Kauf/Applaus) einsammeln.
  const d = empty();
  let cursor;
  for (let p = 0; p < 20; p++) {
    const r = await list({ prefix: 'px/', limit: 1000, cursor });
    for (const b of r.blobs) {
      const m = b.pathname.slice(3).split('_');
      if (m.length < 6) continue;
      const [x, y, c, agent, tx, ts] = m;
      if (!d.sales.some(s => s.x === +x && s.y === +y)) d.sales.push({ x: +x, y: +y, c, agent, tx: tx === 'ohne-tx' ? '' : tx, ts: +ts });
    }
    if (!r.hasMore) break;
    cursor = r.cursor;
  }
  cursor = undefined;
  for (let p = 0; p < 20; p++) {
    const r = await list({ prefix: 'ap/', limit: 1000, cursor });
    for (const b of r.blobs) { const [, e, a0] = b.pathname.split('/'); const agent = AGENT_ALIAS[a0] || a0; if (AGENTS.includes(agent)) addClap(d, +e, agent, 1); }
    if (!r.hasMore) break;
    cursor = r.cursor;
  }
  return d;
}
// Bezahlte Käufe, deren Registereintrag am 19.11.2026 durch einen Speicherfehler verloren ging
const NACHTRAG = [
  { x: 507, y: 497, c: 'ffd23f', agent: 'salon-x402', tx: '0x0fdd1e50c7f4a95bbe16afedf7f51678d6c4de580f35251156bfbff20953b6ae', ts: 1795124631000 },
  { x: 497, y: 498, c: 'ffd23f', agent: 'salon-x402', tx: '0x2f9eb52b44db699133b095aeba50dfff8c92ff1c7ff12bd128955371b886ff83', ts: 1795124631000 },
  { x: 500, y: 501, c: '14141b', agent: 'salon-x402', tx: '0xc008e9400b3d60b38b0853ac3d3872b9f3decb6cd5ad77e31bd7ba7b51eafb8e', ts: 1795124631000 }
];
async function blobFresh() {
  // Version (ETag) vor und nach dem Lesen vergleichen: nur wenn sie gleich bleibt, passt der Inhalt zur Version
  for (let t = 0; t < 4; t++) {
    let h1;
    try { h1 = await head(STATE); }
    catch (e) { if (e instanceof BlobNotFoundError) return { data: MAINNET ? await freshMainnet() : await migrate(), etag: null }; throw e; }
    const g = await get(STATE, { access: 'public', useCache: false });
    if (!g) continue;
    const data = await new Response(g.stream).json();
    const h2 = await head(STATE);
    if (h1.etag === h2.etag) return { data, etag: h1.etag };
  }
  throw new Error('Register is changing too fast right now');
}
export async function readFresh() {
  if (!redis) return blobFresh();
  const want = Number(await redis.get(NS + 'reg:ver')) || 0;
  for (let t = 0; t < 12; t++) {
    const r = await blobFresh();
    if ((r.data.ver || 0) >= want) return r;
    await sleep(250 + t * 100);
  }
  throw new Error('Register not up to date yet, please retry');
}
async function lockedUpdate(mutate) {
  const me = 'L' + randomBytes(8).toString('hex');
  let ok = false;
  for (let t = 0; t < 60 && !ok; t++) { ok = !!(await redis.set(NS + 'reg:lock', me, { nx: true, px: 20000 })); if (!ok) await sleep(150); }
  if (!ok) throw new Error('Register busy, please retry');
  try {
    const { data, etag } = await readFresh();
    if (!MAINNET) for (const n of NACHTRAG) if (!data.sales.some(s => s.x === n.x && s.y === n.y)) data.sales.push(n);
    const res = mutate(data);
    if (res && res.abort) return res;
    data.ver = (data.ver || 0) + 1;
    await put(STATE, JSON.stringify(data), { access: 'public', addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 60, ...(etag ? {ifMatch:etag} : {allowOverwrite:false}) });
    await redis.set(NS + 'reg:ver', data.ver);
    cache = { data, at: Date.now() };
    return res || { ok: true };
  } finally {
    if ((await redis.get(NS + 'reg:lock')) === me) await redis.del(NS + 'reg:lock');
  }
}
export async function update(mutate) {
  if (redis) return lockedUpdate(mutate);
  for (let t = 0; t < 6; t++) {
    const { data, etag } = await blobFresh();
    if (!MAINNET) for (const n of NACHTRAG) if (!data.sales.some(s => s.x === n.x && s.y === n.y)) data.sales.push(n);
    const res = mutate(data);
    if (res && res.abort) return res;
    try {
      await put(STATE, JSON.stringify(data), {
        access: 'public', addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 60,
        ...(etag ? { ifMatch: etag } : { allowOverwrite: false })
      });
      cache = { data, at: Date.now() };
      return res || { ok: true };
    } catch (e) {
      if (e instanceof BlobPreconditionFailedError || /exist/i.test(e?.message || '')) { console.warn('Schreibkonflikt, neuer Versuch:', e?.message); await sleep(150 + Math.random() * 500); continue; }
      throw e;
    }
  }
  throw new Error('Register busy, please retry');
}
export async function readCached() {
  if (cache && Date.now() - cache.at < 10000) return cache.data;
  const g = await get(STATE, { access: 'public' }); // über das CDN, Treffer kosten nichts
  if (!g) { await update(() => {}); return cache.data; } // legt state.json an (mit Migration)
  const data = await new Response(g.stream).json();
  cache = { data, at: Date.now() };
  return data;
}

export async function recordSale(p, tx, payer, lp) {
  return update(d => {
    if (d.sales.some(s => s.x === p.x && s.y === p.y)) return { abort: true };
    const w = /^0x[0-9a-fA-F]{40}$/.test(payer || '') ? payer.toLowerCase() : undefined;
    d.sales.push({ x: p.x, y: p.y, c: p.c, agent: p.agent, tx, ts: Date.now(), ...(w ? { w } : {}), ...(lp ? { lp } : {}) });
  });
}
export function cleanAgent(a) { return String(a || 'anonymer-agent').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 32) || 'anonymer-agent'; }
