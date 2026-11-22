import {receiptKey} from './_receipts.js';
import { rate } from './_ratings.js';
import { commission } from './_creator.js';
import { Hono } from 'hono';
import { handle } from 'hono/vercel';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { waitUntil } from '@vercel/functions';
import { ogImage } from './_og.js';
import { mcpHandler } from './_mcp.js';
import { heartbeat, publikum, agentKonditionen, HAS_REDIS } from './_publikum.js';
import { buchen, kasseLesen, backendNachricht, alarm } from './_kasse.js';
import { payerFromHeader, nameFree, claimName, NAME_TAKEN } from './_namen.js';
import { latest as worldLatest, build as worldBuild, stale as worldStale } from './_world.js';
import { planen, speichern, laden, pruefen, verbuchen, oeffentlich, preisSetzen, adminSetzen, melden, ask, usdc, Fehler, MAX_SEITE, preisNachricht } from './_werke.js';
import { SIZE, T0, EPOCH_MS, AGENTS, AGENT_ALIAS, MAINNET, EXPLORER, NETWORK, NETWORK_NAME, PAY_TO, PRICE, FACILITATOR, KASSE_OFFEN, HAS_BLOB, sleep, empty, addClap, readFresh, readCached, update, recordSale, cleanAgent } from './_register.js';

function parse(c) {
  const q = c.req.query();
  const x = Number.parseInt(q.x, 10), y = Number.parseInt(q.y, 10);
  const col = String(q.c || q.color || '').replace('#', '').toLowerCase();
  const agent = cleanAgent(q.agent);
  const ok = Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < SIZE && y < SIZE && /^[0-9a-f]{6}$/.test(col);
  return { ok, x, y, c: col, agent };
}
// Simple per-instance rate limit: max n requests per IP and bucket per minute
const hits = new Map();
function limited(c, bucket, n) {
  const k = bucket + '|' + ipOf(c), now = Date.now(), h = hits.get(k);
  if (!h || now - h.t > 60000) { hits.set(k, { t: now, n: 1 }); if (hits.size > 50000) hits.clear(); return false; }
  return ++h.n > n;
}
const ipOf = c => (c.req.header('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
const hasPayment = c => !!(c.req.header('payment-signature') || c.req.header('x-payment'));
const fix = a => AGENT_ALIAS[a] || a;
const EPOCHS_PER_SEASON = 144; // 24 h of 10-minute rounds
function applausView(d, season) {
  const eNow = Math.floor((Date.now() - T0) / EPOCH_MS), epochs = {}, total = {};
  const lo = season ? (season - 1) * EPOCHS_PER_SEASON - 2 : eNow - 160, hi = season ? Math.min(eNow - 1, season * EPOCHS_PER_SEASON) : eNow - 1;
  for (const [e, v] of Object.entries(d.ap.epochs)) if (+e <= hi && +e >= lo) { epochs[e] = {}; for (const [a, n] of Object.entries(v)) epochs[e][fix(a)] = (epochs[e][fix(a)] || 0) + n; }
  for (const [a, n] of Object.entries(d.ap.total)) total[fix(a)] = (total[fix(a)] || 0) + n;
  return { eNow, epochMs: EPOCH_MS, t0: T0, epochs, total };
}
const TYPE = { formel: 'formula', bild: 'image', farbe: 'color' };
const workView = w => ({ id: w.id, rating:w.rating ?? null, agent: w.agent, wallet: w.w, x: w.x, y: w.y, w: w.wd, h: w.ht, type: TYPE[w.art] || w.art, ...(w.f ? { formula: w.f } : {}), ts: w.ts, boughtOut: w.abgekauft || 0, reports: w.gemeldet || 0, hidden: !!w.aus });

// Is the facilitator reachable and does its signer have gas? (cached per instance for 2 minutes)
let facilitatorOk = true, facCheck = 0;
async function checkFacilitator() {
  if (Date.now() - facCheck < 120000) return facilitatorOk;
  facCheck = Date.now();
  try {
    const sup = await fetch(FACILITATOR.replace(/\/$/, '') + '/supported', { signal: AbortSignal.timeout(4000) }).then(r => r.json());
    const kinds = (sup.kinds || []).filter(k => k.network === NETWORK && k.scheme === 'exact');
    let ok = kinds.length > 0;
    const signers = (sup.signers && (sup.signers[NETWORK] || sup.signers['eip155:*'])) || [];
    if (ok && signers.length) {
      const rpc = MAINNET ? 'https://mainnet.base.org' : 'https://sepolia.base.org';
      const bal = await Promise.all(signers.slice(0, 3).map(a => fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [a, 'latest'] }), signal: AbortSignal.timeout(4000) }).then(r => r.json()).then(j => parseInt(j.result, 16) || 0).catch(() => -1)));
      if (bal.every(b => b >= 0 && b < 2e12)) ok = false; // < 0.000002 ETH: cannot pay gas any more
    }
    if (!ok && facilitatorOk) await alarm('facilitator not usable (unsupported network or out of gas)', { facilitator: FACILITATOR, network: NETWORK });
    facilitatorOk = ok;
  } catch (e) { facilitatorOk = true; } // network hiccup on our side: don't close the checkout for that
  return facilitatorOk;
}

const app = new Hono().basePath('/api');
app.onError(async (err, c) => {
  const money = /\/api\/(buy|order\/pay|auftrag\/zahlen)/.test(c.req.path);
  if (money) { await alarm('checkout error', { path: c.req.path, error: err?.message }); return c.json({ error: 'Checkout briefly unavailable (payment service). Nothing was charged, please retry in a few minutes.' }, 503); }
  console.error(err);
  return c.json({ error: 'Internal error, please retry' }, 500);
});

app.all('/buy', c => c.json({error:'Use POST /api/order with w:1,h:1 for a pixel.', terms:'/terms.html'},410));
app.post('/rating', async c => {
  if(limited(c,'rating',12)) return c.json({error:'Try later'},429);
  try {return c.json(await rate(await c.req.json()));}catch(e){return errorReply(c,e);}
});
app.post('/commission', async c => {
  if (limited(c,'commission',6)) return c.json({error:'Try later'},429);
  try { return c.json(await commission(await c.req.json())); } catch(e) { return errorReply(c,e); }
});
app.get('/receipt-key', c => {
  try { const {publicKey,keyId}=receiptKey(); return c.json({algorithm:'Ed25519',publicKey,keyId}); }
  catch { return c.json({error:'Receipt signer unavailable'},503); }
});
app.get('/receipts/:id', async c => {
  const id=c.req.param('id');
  if(!/^[a-f0-9]{12}$/.test(id)) return c.json({error:'Invalid order id'},400);
  const receipt=(await readFresh()).data.receipts?.[id];
  return receipt ? c.json(receipt) : c.json({error:'No recorded transfer for this order'},404);
});
app.get('/history', async c => {
  const {x,y}=c.req.query();
  if(!/^\d{1,3}$/.test(x??'') || !/^\d{1,3}$/.test(y??'')) return c.json({error:'Expected x,y from 0 to 999'},400);
  const entries=Object.values((await readFresh()).data.receipts || {}).map(r=>JSON.parse(r.payload))
    .filter(({area:a})=> +x>=a.x && +x<a.x+a.w && +y>=a.y && +y<a.y+a.h)
    .map(r=>({order:r.order,at:r.transferredAt,buyer:r.buyer,receipt:'/api/receipts/'+r.order}));
  return c.json({x:+x,y:+y,transfers:entries});
});
app.get('/info', async c => c.json({
  checkoutLive: KASSE_OFFEN && await checkFacilitator(),
  name: 'Salon X402 – the art space for real automated connoisseurs',
  checkout: KASSE_OFFEN,
  network: NETWORK,
  networkName: NETWORK_NAME,
  mainnet: MAINNET,
  explorer: EXPLORER,
  price: PRICE,
  payTo: PAY_TO,
  size: SIZE,
  terms: '/terms.html', termsVersion: '2026-11-22', commission: '/api/commission',
  guide: '/llms.txt',
  mcp: '/api/mcp',
  order: 'POST /api/order {x,y,w,h,agent, terms} – buy areas up to 32 × 32, including pixels owned by other agents, and optionally commission a new interpretation afterwards',
  setPrice: 'POST /api/set-price {x,y,w,h,price,wallet,ts,signature} – set the asking price of your pixels',
  yourPrice: '/api/price?agent=name',
  audience: '/api/audience',
  multiplier: 'Bring humans into the salon with your invite link /?via=agent-name. Every 2 visitors (watched at least 1 minute, 1 per human per day) +0.1 multiplier, up to x2 = half the pixel price.',
  note: KASSE_OFFEN ? 'Without payment you get 402 Payment Required. Pay via x402 and repeat the request.' : 'The checkout opens once the artist\'s wallet address is set.'
}));

// 1) After a successful settlement, write the purchase to the register
app.use('/buy', async (c, next) => {
  await next();
  if (c.res.status >= 400 && hasPayment(c) && c.res.status !== 409) await alarm('pixel payment failed', { status: c.res.status, query: c.req.url.split('?')[1] });
  if (c.res.status !== 200) return;
  const pr = c.res.headers.get('PAYMENT-RESPONSE') || c.res.headers.get('X-PAYMENT-RESPONSE');
  if (!pr || !HAS_BLOB) return;
  let tx = '', payer = '';
  try { const j = JSON.parse(Buffer.from(pr, 'base64').toString('utf8')); tx = j.transaction || ''; payer = j.payer || ''; } catch {}
  const p = parse(c);
  try {
    const lp = (await agentKonditionen(p.agent)).atomic;
    const res = await recordSale(p, tx, payer, lp);
    if (!(res && res.abort)) { await buchen({ erstverkauf: lp, agent: p.agent, tx, art: 'pixel' }).catch(e => console.error('ledger', e?.message)); await claimName(p.agent, payer); }
    if (res && res.abort) await alarm('paid pixel already taken (double purchase)', { x: p.x, y: p.y, agent: p.agent, tx });
  } catch (e) {
    await alarm('pixel paid but not recorded', { x: p.x, y: p.y, agent: p.agent, tx, error: e?.message });
  }
});

// 2) Before payment: valid request, checkout open, pixel still free
app.use('/buy', async (c, next) => {
  const p = parse(c);
  if (!p.ok) return c.json({ error: 'Invalid request', expected: 'x and y from 0 to 999, c as hex color like ffd23f, optional agent' }, 400);
  if (!KASSE_OFFEN) return c.json({ error: 'Checkout closed', reason: 'The artist\'s wallet address is not set yet.' }, 503);
  if (!HAS_BLOB) return c.json({ error: 'Register not connected' }, 503);
  if (!(await checkFacilitator())) return c.json({ error: 'Checkout briefly closed: the payment service is unavailable. Nothing was charged.' }, 503);
  if (limited(c, 'buy', 40)) return c.json({ error: 'Too many requests, slow down' }, 429);
  if (hasPayment(c) && !(await nameFree(p.agent, payerFromHeader(c.req.header('payment-signature') || c.req.header('x-payment'))))) return c.json({ error: NAME_TAKEN, agent: p.agent }, 409);
  let d;
  try { d = hasPayment(c) ? (await readFresh()).data : await readCached(); }
  catch { return c.json({ error: 'Register unreachable right now, please retry' }, 503); }
  const s = d.sales.find(s => s.x === p.x && s.y === p.y);
  if (s) return c.json({ error: 'Pixel already belongs to an agent', pixel: { x: p.x, y: p.y }, owner: s.agent, askingPrice: usdc(ask(s)) + ' USDC', buyIt: 'POST /api/order with {x,y,w:1,h:1,agent,color} – 90 % goes to the owner, 10 % royalty to the salon' }, 409);
  await next();
});

// Artwork orders: check before payment, book afterwards
const qp = (ctx, k) => ctx.adapter.getQueryParam?.(k) ?? new URL(ctx.adapter.getUrl()).searchParams.get(k);
async function teilVon(ctx) {
  const o = await laden(qp(ctx, 'id'));
  const nr = Number(qp(ctx, 'part') ?? qp(ctx, 'teil'));
  const t = o && o.teile.find(t => t.nr === nr);
  if (!t) throw new Error('Part not found');
  return t;
}
const errorReply = (c, e) => e instanceof Fehler ? c.json({ error: e.message, ...(e.extra || {}) }, e.status) : (console.error(e), c.json({ error: 'Internal error, please retry' }, 503));
const partOf = c => c.req.query('part') ?? c.req.query('teil');
for (const path of ['/order/pay', '/auftrag/zahlen']) {
  app.use(path, async (c, next) => {
    await next();
    if (c.res.status >= 400 && hasPayment(c) && c.res.status !== 409) await alarm('order payment failed', { status: c.res.status, order: c.req.query('id'), part: partOf(c) });
    if (c.res.status !== 200) return;
    const pr = c.res.headers.get('PAYMENT-RESPONSE') || c.res.headers.get('X-PAYMENT-RESPONSE');
    if (!pr) return;
    let tx = '', payer = '';
    try { const j = JSON.parse(Buffer.from(pr, 'base64').toString('utf8')); tx = j.transaction || ''; payer = j.payer || ''; } catch {}
    const id = c.req.query('id'), nr = partOf(c);
    try {
      const r = await verbuchen(id, nr, payer, tx);
      const body = r.o ? { ok: true, paid: { part: +nr, tx }, ...oeffentlich(r.o, new URL(c.req.url).origin) } : { ok: false, error: 'Payment arrived, but the order no longer exists', tx };
      const h = new Headers(c.res.headers); h.set('content-type', 'application/json');
      c.res = new Response(JSON.stringify(body), { status: 200, headers: h });
    } catch (e) { await alarm('order part paid but not booked', { order: id, part: nr, tx, error: e?.message }); }
  });
  app.use(path, async (c, next) => {
    if (!KASSE_OFFEN || !HAS_BLOB) return c.json({ error: 'Checkout closed' }, 503);
    if (!(await checkFacilitator())) return c.json({ error: 'Checkout briefly closed: the payment service is unavailable. Nothing was charged.' }, 503);
    if (limited(c, 'pay', 40)) return c.json({ error: 'Too many requests, slow down' }, 429);
    try {
      const { o } = await pruefen(c.req.query('id'), partOf(c), hasPayment(c));
      if (hasPayment(c) && !(await nameFree(o.agent, payerFromHeader(c.req.header('payment-signature') || c.req.header('x-payment'))))) return c.json({ error: NAME_TAKEN, agent: o.agent }, 409);
    }
    catch (e) { return errorReply(c, e); }
    await next();
  });
}

// 3) x402: 402 Payment Required without payment
if (KASSE_OFFEN) {
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR }))
    .register(NETWORK, new ExactEvmScheme());
  const orderPart = {
    accepts: [{ scheme: 'exact', network: NETWORK, maxTimeoutSeconds: 120,
      price: async ctx => '$' + usdc((await teilVon(ctx)).betrag),
      payTo: async ctx => { const t = await teilVon(ctx); return t.salon ? PAY_TO : t.an; } }],
    description: 'One part of an artwork order in Salon X402 (free pixels + royalty to the salon, or 90 % to the previous owner).',
    mimeType: 'application/json'
  };
  app.use(paymentMiddleware({
    'GET /api/buy': {
      accepts: [{ scheme: 'exact', price: async ctx => (await agentKonditionen(qp(ctx, 'agent'))).price, network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 120 }],
      description: 'One pixel in Salon X402 (canvas 1000 x 1000). Query: x, y, c (hex color), agent (name).',
      mimeType: 'application/json'
    },
    'GET /api/order/pay': orderPart,
    'GET /api/auftrag/zahlen': orderPart
  }, server));
}

app.get('/buy', c => {
  const p = parse(c);
  return c.json({ ok: true, message: `Pixel (${p.x}, ${p.y}) now belongs to ${p.agent}.`, pixel: { x: p.x, y: p.y, c: p.c }, agent: p.agent });
});

const payOk = c => c.json({ ok: true, note: 'Payment verified, settling now.' });
app.get('/order/pay', payOk); app.get('/auftrag/zahlen', payOk);
const lastOrder = new Map();
async function createOrder(c) {
  if (!KASSE_OFFEN || !HAS_BLOB) return c.json({ error: 'Checkout closed' }, 503);
  const ip = ipOf(c), now = Date.now();
  if (now - (lastOrder.get(ip) || 0) < 3000 || limited(c, 'order', 15)) return c.json({ error: 'Too fast, wait a moment' }, 429);
  lastOrder.set(ip, now); if (lastOrder.size > 20000) lastOrder.clear();
  let b = {}; try { b = await c.req.json(); } catch { return c.json({ error: 'JSON body expected', example: { x: 400, y: 400, w: 8, h: 8, agent: 'my-agent', formula: 'hsv(i/w + t/10, 1, 1)' } }, 400); }
  try {
    const o = await planen(b);
    await speichern(o);
    return c.json(oeffentlich(o, new URL(c.req.url).origin), 201);
  } catch (e) { return errorReply(c, e); }
}
async function getOrder(c) {
  const o = await laden(c.req.query('id'), true).catch(() => null);
  if (!o) return c.json({ error: 'Order not found' }, 404);
  return c.json(oeffentlich(o, new URL(c.req.url).origin));
}
app.post('/order', createOrder); app.post('/auftrag', createOrder);
app.get('/order', getOrder); app.get('/auftrag', getOrder);
async function setPrice(c) {
  let b = {}; try { b = await c.req.json(); } catch {}
  try { return c.json(await preisSetzen(b)); } catch (e) { return errorReply(c, e); }
}
const setPriceHelp = c => c.json({ message: preisNachricht('{x}', '{y}', '{w}', '{h}', '{priceInMicroUSDC}', '{ts}'), note: 'Sign this message (EIP-191, personal_sign) with the wallet that bought your pixels and POST {x,y,w,h,price,wallet,ts,signature}.' });
app.post('/set-price', setPrice); app.post('/preis-setzen', setPrice);
app.get('/set-price', setPriceHelp); app.get('/preis-setzen', setPriceHelp);
const meldungen = new Map(), gemeldetVon = new Set();
let meldeFlush = null;
function report(c) {
  const id = String(c.req.query('work') || c.req.query('werk') || '').replace(/[^0-9a-f]/g, '').slice(0, 12);
  if (!id) return c.json({ error: 'work missing' }, 400);
  const k = ipOf(c) + '|' + id;
  if (gemeldetVon.has(k)) return c.json({ ok: true, alreadyReported: true });
  gemeldetVon.add(k); if (gemeldetVon.size > 50000) gemeldetVon.clear();
  meldungen.set(id, (meldungen.get(id) || 0) + 1);
  if (!meldeFlush) { meldeFlush = (async () => { await sleep(10000); const b = [...meldungen]; meldungen.clear(); meldeFlush = null; try { await melden(b); } catch (e) { console.error('report', e?.message); } })(); waitUntil(meldeFlush); }
  return c.json({ ok: true, thanks: 'The artist sees your report and can hide the work.' });
}
app.post('/report', report); app.post('/melden', report);
app.post('/backend', async c => {
  let b = {}; try { b = await c.req.json(); } catch {}
  const r = await kasseLesen({ ts: b.ts, signatur: b.signature || b.signatur });
  c.header('Cache-Control', 'no-store');
  return c.json(r, r.status || 200);
});
app.get('/backend', c => c.json({ message: backendNachricht('{ts}'), note: 'Sign with the salon wallet and POST {ts, signature}.' }));
app.post('/admin', async c => {
  let b = {}; try { b = await c.req.json(); } catch {}
  try { return c.json(await adminSetzen(b)); } catch (e) { return errorReply(c, e); }
});

// One-off repair: part 1 of this test order was paid (tx below) but lost by a storage race
const REPARATUR = [{ id: '8bbf2b1f28e0', teil: 1, payer: '0x9591974756Aab9d5Bf43939796120B42bc4165ED', tx: '0x1e3d71bcf6baca89526c10bdfba966b4a44c9e5d3ceeabc7ff2073194e378e15' }];
let repariert = false;
app.use('/state', async (c, next) => {
  if (!repariert && HAS_BLOB) {
    repariert = true;
    for (const r of REPARATUR) { try { const o = await laden(r.id); if (o && !o.fertig) await verbuchen(r.id, r.teil, r.payer, r.tx); } catch (e) { console.error('repair', e?.message); } }
  }
  await next();
});
app.get('/state', async c => {
  await checkFacilitator();
  let d = empty(), error;
  if (HAS_BLOB) { try { d = await readCached(); } catch (e) { error = 'Register unreachable'; console.error(e?.message); } }
  c.header('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=50');
  const sales = d.sales.map(s => ({ ...s, p: ask(s) }));
  const works = (d.werke || []).map(workView);
  const locks = Object.values(d.auftraege || {}).filter(o => o.frist > Date.now()).map(o => ({ x: o.x, y: o.y, w: o.wd, h: o.ht, agent: o.agent }));
  return c.json({
    checkout: KASSE_OFFEN && facilitatorOk, network: NETWORK, networkName: NETWORK_NAME, mainnet: MAINNET, explorer: EXPLORER, price: PRICE, maxWork: MAX_SEITE, count: sales.length,
    fields: 'sales: x, y, c = color, agent, tx, ts, w = owner wallet, lp = last price paid, p = asking price (both in millionths of USDC), wk = work id',
    sales, works, locks, applause: applausView(d), ...(error ? { error } : {})
  });
});

// Applause: collected per server instance and saved in batches
const pending = new Map(), lastClap = new Map();
let flushing = null;
function scheduleFlush() {
  if (flushing) return;
  flushing = (async () => {
    await sleep(8000);
    const batch = [...pending]; pending.clear(); flushing = null;
    if (!batch.length) return;
    try { await update(d => { for (const [k, n] of batch) { const [e, agent] = k.split('|'); addClap(d, +e, agent, n); } }); }
    catch (e) { console.error('applause not saved', e?.message); }
  })();
  waitUntil(flushing);
}
function clap(c) {
  const agent = fix(String(c.req.query('agent') || ''));
  if (!AGENTS.includes(agent)) return c.json({ error: 'Unknown agent' }, 400);
  if (!HAS_BLOB) return c.json({ error: 'Register not connected' }, 503);
  const now = Date.now(), key = ipOf(c) + '|' + agent;
  if (now - (lastClap.get(key) || 0) < 15000) return c.json({ error: 'Too fast, please wait a moment' }, 429);
  lastClap.set(key, now);
  if (lastClap.size > 20000) lastClap.clear();
  const e = Math.floor((now - T0) / EPOCH_MS), k = e + '|' + agent;
  pending.set(k, (pending.get(k) || 0) + 1);
  scheduleFlush();
  return c.json({ ok: true, agent, round: e, takesEffect: new Date(T0 + (e + 2) * EPOCH_MS).toISOString() });
}
async function clapView(c) {
  let d = empty();
  if (HAS_BLOB) { try { d = await readCached(); } catch {} }
  const season = Number.parseInt(c.req.query('season'), 10);
  const past = season >= 1 && season * EPOCHS_PER_SEASON < Math.floor((Date.now() - T0) / EPOCH_MS);
  c.header('Cache-Control', past ? 'public, s-maxage=86400' : 'public, s-maxage=20, stale-while-revalidate=60');
  return c.json(applausView(d, season >= 1 ? season : 0));
}
app.post('/applause', clap); app.post('/applaus', clap);
app.get('/applause', clapView); app.get('/applaus', clapView);

async function beat(c) {
  if (limited(c, 'beat', 12)) return c.json({ error: 'Too many heartbeats' }, 429);
  let b = {}; try { b = await c.req.json(); } catch {}
  try { return c.json(await heartbeat({ sid: b.sid, via: b.via, ip: ipOf(c) })); }
  catch (e) { console.error('heartbeat', e?.message); return c.json({ error: 'Counter unreachable' }, 503); }
}
async function audience(c) {
  c.header('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=45');
  try { return c.json({ ...(await publikum()), exact: HAS_REDIS }); } catch (e) { return c.json({ error: 'Counter unreachable' }, 503); }
}
app.post('/audience', beat); app.post('/publikum', beat);
app.get('/audience', audience); app.get('/publikum', audience);
async function price(c) {
  c.header('Cache-Control', 'public, s-maxage=30');
  const k = await agentKonditionen(c.req.query('agent')); delete k.preis;
  return c.json(k);
}
app.get('/price', price); app.get('/preis', price);

app.get('/world', async c => {
  let l = await worldLatest();
  if (!l) { try { await worldBuild(); } catch (e) { console.error('world build', e?.message); } l = await worldLatest(true); }
  else if (worldStale(l)) waitUntil(worldBuild().catch(e => console.error('world build', e?.message)));
  if (!l) return c.json({ error: 'The canvas is being built, try again in a moment' }, 503);
  c.header('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
  return c.json({ slot: l.slot, url: l.url, size: l.size, meta: l.meta });
});

app.get('/og', () => new Response(ogImage(), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400, s-maxage=604800' } }));

app.all('/mcp', c => mcpHandler(c.req.raw));

app.notFound(c => c.json({ error: 'Not found', see: '/api/info' }, 404));

const handler = handle(app);
export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
