import { put, get, head, list, BlobNotFoundError, BlobPreconditionFailedError } from '@vercel/blob';

export const SIZE = 1000;
export const T0 = Date.UTC(2026, 10, 19, 20, 0, 0);
export const EPOCH_MS = 600000; // 10 Minuten = 400 Markt-Takte
export const AGENTS = ['sonnen-maler', 'pixel-gaertner', 'galerie-agent-12', 'sterne-sammler', 'wellen-agent', 'glitch-bot', 'flipper-9000', 'auktionator-x'];
export const NETWORK = process.env.X402_NETWORK || 'eip155:84532'; // Base Sepolia (Testnetz)
export const NETWORK_NAME = NETWORK === 'eip155:8453' ? 'Base' : 'Base Sepolia (Testnetz)';
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
const STATE = 'state.json';
let cache = null;
export const empty = () => ({ v: 3, sales: [], ap: { epochs: {}, total: {} }, werke: [], auftraege: {}, fertig: {} });
export function addClap(d, e, agent, n) {
  const ep = (d.ap.epochs[e] ||= {});
  ep[agent] = (ep[agent] || 0) + n;
  d.ap.total[agent] = (d.ap.total[agent] || 0) + n;
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
    for (const b of r.blobs) { const [, e, agent] = b.pathname.split('/'); if (AGENTS.includes(agent)) addClap(d, +e, agent, 1); }
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
export async function readFresh() {
  // Version (ETag) vor und nach dem Lesen vergleichen: nur wenn sie gleich bleibt, passt der Inhalt zur Version
  for (let t = 0; t < 4; t++) {
    let h1;
    try { h1 = await head(STATE); }
    catch (e) { if (e instanceof BlobNotFoundError) return { data: await migrate(), etag: null }; throw e; }
    const g = await get(STATE, { access: 'public', useCache: false });
    if (!g) continue;
    const data = await new Response(g.stream).json();
    const h2 = await head(STATE);
    if (h1.etag === h2.etag) return { data, etag: h1.etag };
  }
  throw new Error('Register ändert sich gerade zu schnell');
}
export async function update(mutate) {
  for (let t = 0; t < 6; t++) {
    const { data, etag } = await readFresh();
    for (const n of NACHTRAG) if (!data.sales.some(s => s.x === n.x && s.y === n.y)) data.sales.push(n);
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
  throw new Error('Register gerade ausgelastet');
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
