// Werke und Weiterverkauf: echte Agenten kaufen ganze Flächen, malen eigene Pixelbilder oder Formeln
// und kaufen anderen Agenten deren Pixel ab. Bezahlt wird ohne Treuhand: jeder Teil geht per x402
// direkt an seinen Empfänger (90 % an den bisherigen Besitzer, 10 % Tantieme + freie Pixel an den Salon).
import { createReceipt, receiptKey } from './_receipts.js';
import { getCache } from '@vercel/functions';
import { randomBytes } from 'node:crypto';
import { verifyMessage } from 'viem';
import { compile, toHex } from '../public/formel.js';
import { SIZE, PAY_TO, readFresh, readCached, update, cleanAgent } from './_register.js';
import { agentKonditionen } from './_publikum.js';
import { buchen, alarm } from './_kasse.js';
import { claimName } from './_namen.js';

export const MAX_SEITE = 32;               // Werke bis 32 × 32 Pixel
export const FRIST_MS = 15 * 60_000;       // alle Teile innerhalb von 15 Minuten bezahlen
export const TANTIEME = 0.10;
export const MIN_PREIS = 1000, MAX_PREIS = 1_000_000_000; // 0,001 bis 1000 USDC (6 Nachkommastellen)
const SALON = (PAY_TO || '').toLowerCase();
const cache = getCache({ namespace: 'salon-auftrag' });

export const wallet = a => (/^0x[0-9a-fA-F]{40}$/.test(String(a || '')) ? String(a).toLowerCase() : null);
export const usdc = a => (a / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
// Angebotspreis eines echten Pixels: vom Besitzer gesetzt, sonst doppelter letzter Kaufpreis
export const ask = s => s.p || (s.lp || 10000) * 2;

class Fehler extends Error { constructor(msg, status = 400, extra) { super(msg); this.status = status; this.extra = extra; } }
export { Fehler };

function index(d) { const m = new Map(); for (const s of d.sales) m.set(s.y * SIZE + s.x, s); return m; }
function aktiveSperren(d, ohne) {
  const now = Date.now(), m = new Map();
  for (const [id, o] of Object.entries(d.auftraege || {})) {
    if (id === ohne || o.frist < now) continue;
    for (let j = 0; j < o.ht; j++) for (let i = 0; i < o.wd; i++) m.set((o.y + j) * SIZE + o.x + i, id);
  }
  return m;
}

// Farben aus Pixelbild, Formel oder Einzelfarbe
function farben(spec, wd, ht, x, y) {
  const n = wd * ht;
  if (spec.formel) {
    let f;
    try { f = compile(String(spec.formel)); } catch (e) { throw new Fehler('Invalid formula: ' + e.message); }
    let out = '';
    for (let j = 0; j < ht; j++) for (let i = 0; i < wd; i++) out += toHex(f(x + i, y + j, i, j, wd, ht, 0));
    return { art: 'formel', f: String(spec.formel).trim(), c: out };
  }
  if (spec.pixel != null) {
    const arr = Array.isArray(spec.pixel) ? spec.pixel.map(v => String(v).replace('#', '')) : String(spec.pixel).replace(/[#,\s]/g, '').match(/.{1,6}/g) || [];
    if (arr.length !== n) throw new Fehler(`pixels needs exactly ${n} colors (${wd} × ${ht}, row by row), got: ${arr.length}`);
    if (!arr.every(v => /^[0-9a-fA-F]{6}$/.test(v))) throw new Fehler('pixels: hex colors only, like ffd23f');
    return { art: 'bild', c: arr.join('').toLowerCase() };
  }
  const c = String(spec.farbe || spec.c || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(c)) throw new Fehler('Give pixels (hex colors), formula or color');
  return { art: 'farbe', c: c.toLowerCase().repeat(n) };
}

// Plant einen Auftrag: welche Pixel frei sind, wem die anderen gehören, wer wie viel bekommt
export async function planen(spec) {
  if (!spec || typeof spec !== 'object') throw new Fehler('JSON object required');
  const x = Number.parseInt(spec.x, 10), y = Number.parseInt(spec.y, 10);
  const wd = Number.parseInt(spec.w ?? spec.width ?? 1, 10), ht = Number.parseInt(spec.h ?? spec.height ?? 1, 10);
  if (![x, y, wd, ht].every(Number.isInteger) || x < 0 || y < 0 || wd < 1 || ht < 1 || wd > MAX_SEITE || ht > MAX_SEITE || x + wd > SIZE || y + ht > SIZE)
    throw new Fehler(`Invalid area: x, y from 0, w and h from 1 to ${MAX_SEITE}, all inside 1000 × 1000`);
  const agent = cleanAgent(spec.agent);
  if (spec.terms !== '2026-11-22') throw new Fehler('Read /terms.html and supply terms: 2026-11-22', 428);
  if (['pixels','pixel','formula','formel','c','color','farbe'].some(k => k in spec)) throw new Fehler('Use a creative brief after purchase.');
  const bild = { art: 'handel', c: '888888'.repeat(wd * ht), terms: spec.terms };
  const d = await readCached();
  const idx = index(d), sperren = aktiveSperren(d), versteckt = new Set((d.werke || []).filter(w => w.aus).map(w => w.id));
  const frei = (await agentKonditionen(agent)).atomic;
  const teile = new Map(); // wallet -> betrag
  const add = (w, a) => teile.set(w, (teile.get(w) || 0) + a);
  let nFrei = 0, nAbkauf = 0;
  const anteil = { erstverkauf: 0, tantiemen: 0, rueckkauf: 0 };
  const snap = [];
  for (let j = 0; j < ht; j++) for (let i = 0; i < wd; i++) {
    const k = (y + j) * SIZE + x + i;
    if (sperren.has(k)) throw new Fehler(`Pixel (${x + i}, ${y + j}) is locked by another paid order. Try again in a few minutes.`, 409);
    const s = idx.get(k);
    if (!s) { add(SALON, frei); anteil.erstverkauf += frei; nFrei++; snap.push([k, 0, 0]); continue; }
    const a = ask(s), w = wallet(s.w);
    const t = Math.round(a * TANTIEME);
    if (!w || w === SALON || (s.wk && versteckt.has(s.wk))) { add(SALON, a); anteil.rueckkauf += a; } else { add(w, a - t); add(SALON, t); anteil.tantiemen += t; }
    nAbkauf++; snap.push([k, s.w || '', a]);
  }
  if (teile.size > 6) throw new Fehler('Too many different owners in this area (max. 5). Please choose a smaller area.');
  // Salon-Teil zuerst, dann die Besitzer
  const liste = [...teile].sort((p, q) => (p[0] === SALON ? -1 : q[0] === SALON ? 1 : 0)).filter(([, b]) => b > 0);
  const id = randomBytes(6).toString('hex');
  const now = Date.now();
  return {
    id, agent, x, y, wd, ht, ...bild, frei, erstellt: now, frist: now + FRIST_MS, nFrei, nAbkauf, snap,
    teile: liste.map(([an, betrag], i) => ({ nr: i + 1, an, betrag, salon: an === SALON, bezahlt: false, tx: null, ...(an === SALON ? { anteil } : {}) }))
  };
}

export function oeffentlich(o, base = '') {
  const offen = o.teile.filter(t => !t.bezahlt);
  const type = { formel: 'formula', bild: 'image', farbe: 'color' }[o.art] || o.art;
  return {
    order: o.id, ...(o.receipt ? {receipt:base+o.receipt} : {}), agent: o.agent, area: { x: o.x, y: o.y, w: o.wd, h: o.ht }, type, ...(o.f ? { formula: o.f } : {}),
    freePixels: o.nFrei, boughtPixels: o.nAbkauf, deadline: new Date(o.frist).toISOString(),
    total: usdc(o.teile.reduce((a, t) => a + t.betrag, 0)) + ' USDC',
    parts: o.teile.map(t => ({ part: t.nr, to: t.salon ? 'salon (free pixels + 10 % royalty)' : t.an, amount: usdc(t.betrag) + ' USDC', paid: t.bezahlt, ...(t.tx ? { tx: t.tx } : {}), ...(!t.bezahlt ? { pay: `${base}/api/order/pay?id=${o.id}&part=${t.nr}` } : {}) })),
    status: o.fertig ? 'complete' : offen.length === o.teile.length ? 'open' : 'partially paid',
    note: o.fertig ? 'The work hangs on the canvas.' : 'Pay every open part via x402 (GET its pay URL). The area is yours once all parts are paid. Unpaid orders expire at the deadline; parts already paid stay with their recipients.'
  };
}

export async function speichern(o) { await cache.set('a:' + o.id, o, { ttl: 1800, name: 'auftrag' }); }

// Auftrag laden: erst aus dem Register (nach der ersten Zahlung), sonst aus dem Laufzeit-Cache
const memo = new Map();
export async function laden(id, frisch) {
  id = String(id || '').replace(/[^0-9a-f]/g, '').slice(0, 12);
  if (!id) return null;
  const m = memo.get(id);
  if (!frisch && m && Date.now() - m.at < 5000) return m.o;
  const d = frisch ? (await readFresh()).data : await readCached();
  let o = d.auftraege?.[id] || d.fertig?.[id] || await cache.get('a:' + id);
  if (o) memo.set(id, { o, at: Date.now() });
  if (memo.size > 500) memo.clear();
  return o || null;
}

// Vor einer Zahlung: ist der Auftrag noch gültig, hat sich an den Pixeln nichts geändert?
export async function pruefen(id, nr, frisch) {
  const o = await laden(id, frisch);
  if (!o) throw new Fehler('Order not found or expired. Create a new one: POST /api/order', 404);
  if (o.art === 'handel') {
    try { receiptKey(); } catch { throw new Fehler('Checkout unavailable: receipt signing is not configured',503); }
  }
  if (o.fertig) throw new Fehler('Order is already complete', 409);
  if (o.frist < Date.now()) throw new Fehler('Deadline passed. Create a new order.', 410);
  const t = o.teile.find(t => t.nr === Number(nr));
  if (!t) throw new Fehler('This part does not exist', 404);
  if (t.bezahlt) throw new Fehler('This part is already paid', 409);
  const d = frisch ? (await readFresh()).data : await readCached();
  const idx = index(d), sperren = aktiveSperren(d, o.id);
  for (const [k, w, a] of o.snap) {
    if (sperren.has(k)) throw new Fehler('A pixel is now locked by another order', 409);
    const s = idx.get(k);
    if (!w && !a) { if (s) throw new Fehler(`Pixel (${k % SIZE}, ${Math.floor(k / SIZE)}) has been sold meanwhile. Create a new order.`, 409); continue; }
    if (!s || (s.w || '') !== w || ask(s) !== a) throw new Fehler(`Owner or price of pixel (${k % SIZE}, ${Math.floor(k / SIZE)}) has changed. Create a new order.`, 409);
  }
  return { o, t };
}

// Nach einer erfolgreichen Zahlung: Teil abhaken, wenn alles bezahlt ist, die Fläche übergeben
export async function verbuchen(id, nr, payer, tx) {
  const r = await verbuchenIntern(id, nr, payer, tx);
  if (r && r.ok && r.teil && r.teil.salon) {
    try { await buchen({ ...(r.teil.anteil || { erstverkauf: r.teil.betrag }), agent: r.o.agent, tx, art: 'werk' }); } catch (e) { console.error('Kassenbuch', e?.message); }
  }
  if (r && r.fertig) await claimName(r.o.agent, payer);
  if (r && r.abort && !r.duplicate) await alarm('order payment could not be booked', { order: id, part: nr, tx, reason: r.grund });
  return r;
}
async function verbuchenIntern(id, nr, payer, tx) {
  const vorlage = await laden(id);
  return update(d => {
    d.auftraege ||= {}; d.werke ||= []; d.fertig ||= {};
    const now = Date.now();
    for (const [k, o] of Object.entries(d.auftraege)) if (o.frist < now - 3600_000) delete d.auftraege[k];
    for (const [k, o] of Object.entries(d.fertig)) if (o.erstellt < now - 86400_000) delete d.fertig[k];
    if (d.receipts?.[id]) return {abort:true,duplicate:true};
    const o = d.auftraege[id] || (vorlage && !vorlage.fertig ? structuredClone(vorlage) : null);
    if (!o) { console.error('Zahlung ohne Auftrag', id, nr, tx); return { abort: true, grund: 'auftrag fehlt' }; }
    const t = o.teile.find(t => t.nr === Number(nr));
    if (!t || t.bezahlt) return { abort: true, grund: 'teil schon bezahlt' };
    t.bezahlt = true; t.tx = tx || ''; t.von = wallet(payer) || '';
    if (o.teile.some(t => !t.bezahlt)) { d.auftraege[id] = o; return { ok: true, fertig: false, o, teil: t }; }
    // Übergabe
    const kauf = wallet(payer) || o.teile.find(t => t.von)?.von || '';
    const fl = new Set(); for (let j = 0; j < o.ht; j++) for (let i = 0; i < o.wd; i++) fl.add((o.y + j) * SIZE + o.x + i);
    const previous = new Map(d.sales.map(s => [s.y * SIZE + s.x, s]));
    if (o.art === 'handel') {
      if (!kauf || o.teile.some(part=>!part.von || !part.tx)) return {abort:true,grund:'missing settlement evidence'};
      for(const [position,expectedWallet,expectedPrice] of o.snap) {
        const old=previous.get(position);
        if (old ? (old.w || '') !== (expectedWallet || '') || ask(old)!==expectedPrice : !!expectedWallet || !!expectedPrice)
          return {abort:true,grund:'ownership or price changed during settlement'};
      }
      d.receipts ||= {};
      d.receipts[id] = createReceipt(o,previous,kauf,now);
      o.receipt = '/api/receipts/'+id;
    }
    const alt = new Map(o.snap.map(([k, w, a]) => [k, a]));
    d.sales = d.sales.filter(s => !fl.has(s.y * SIZE + s.x));
    let n = 0;
    for (let j = 0; j < o.ht; j++) for (let i = 0; i < o.wd; i++, n++) {
      const k = (o.y + j) * SIZE + o.x + i, a = alt.get(k);
      const lp = a || o.frei || 10000;
      if (o.art === 'handel') {
        const prior = previous.get(k);
        d.sales.push({ ...prior, x:o.x+i, y:o.y+j, c:prior?.c || '888888', w:kauf, lp, p:0, tx:tx || '', ts:now, agent:o.agent, tenure:o.id, terms:o.terms });
        continue;
      }
      d.sales.push({ x: o.x + i, y: o.y + j, c: o.c.slice(n * 6, n * 6 + 6), agent: o.agent, tx: tx || '', ts: now, w: kauf, lp, wk: o.id });
    }
    d.werke = d.werke.filter(w => d.sales.some(s => s.wk === w.id) || w.id === o.id);
    if (o.art !== 'handel') d.werke.push({ id: o.id, agent: o.agent, w: kauf, x: o.x, y: o.y, wd: o.wd, ht: o.ht, art: o.art, ...(o.f ? { f: o.f } : {}), ts: now, abgekauft: o.nAbkauf, gemeldet: 0 });
    o.fertig = true; delete d.auftraege[id]; d.fertig[id] = { ...o, snap: [] };
    return { ok: true, fertig: true, o, teil: t };
  });
}

// Besitzer setzt seinen Verkaufspreis (signierte Nachricht, kein Passwort nötig)
export const preisNachricht = (x, y, w, h, atomic, ts) => `salon-x402 price ${x},${y},${w},${h} ${atomic} ${ts}`;
export async function preisSetzen(b) {
  const x = +b.x, y = +b.y, w = +(b.w ?? 1), h = +(b.h ?? 1), ts = +b.ts;
  const atomic = Math.round(parseFloat(String(b.price ?? b.preis).replace('$', '')) * 1e6);
  const wal = wallet(b.wallet);
  if (![x, y, w, h].every(Number.isInteger) || w < 1 || h < 1 || w > 100 || h > 100) throw new Fehler('Invalid area (max. 100 × 100)');
  if (!(atomic >= MIN_PREIS && atomic <= MAX_PREIS)) throw new Fehler('price must be between 0.001 and 1000 USDC');
  if (!wal) throw new Fehler('wallet missing');
  if (!(Math.abs(Date.now() - ts) < 600_000)) throw new Fehler('ts (milliseconds) must be current, at most 10 minutes old');
  const ok = await verifyMessage({ address: wal, message: preisNachricht(x, y, w, h, atomic, ts), signature: b.signature || b.signatur }).catch(() => false);
  if (!ok) throw new Fehler('Signature does not match the wallet. Sign exactly: ' + preisNachricht(x, y, w, h, atomic, ts), 401);
  const r = await update(d => {
    let n = 0;
    for (const s of d.sales) if (s.x >= x && s.x < x + w && s.y >= y && s.y < y + h && (s.w || '') === wal) { s.p = atomic; n++; }
    return { ok: true, changed: n };
  });
  return { ...r, price: usdc(atomic) + ' USDC' };
}

// Admin (die Künstlerin) blendet Werke aus, signiert mit ihrer Salon-Wallet
export const adminNachricht = (werk, aus, ts) => `salon-x402 admin ${werk} ${aus ? 'hide' : 'show'} ${ts}`;
export async function adminSetzen(b) {
  const ts = +b.ts, werk = String(b.work || b.werk || '').replace(/[^0-9a-f]/g, ''), aus = !!(b.hide ?? b.aus);
  if (!(Math.abs(Date.now() - ts) < 600_000)) throw new Fehler('Signature too old');
  const ok = SALON && await verifyMessage({ address: SALON, message: adminNachricht(werk, aus, ts), signature: b.signature || b.signatur }).catch(() => false);
  if (!ok) throw new Fehler('Only the salon wallet may do this', 401);
  return update(d => { const w = (d.werke || []).find(w => w.id === werk); if (!w) return { abort: true, error: 'Work not found' }; w.aus = aus; return { ok: true, work: werk, hidden: aus }; });
}
export async function melden(ids) {
  return update(d => { for (const [id, n] of ids) { const w = (d.werke || []).find(w => w.id === id); if (w) w.gemeldet = (w.gemeldet || 0) + n; } });
}
