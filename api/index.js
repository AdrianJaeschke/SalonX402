import { Hono } from 'hono';
import { handle } from 'hono/vercel';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { waitUntil } from '@vercel/functions';
import { ogImage } from './_og.js';
import { mcpHandler } from './_mcp.js';
import { heartbeat, publikum, agentKonditionen, HAS_REDIS } from './_publikum.js';
import { buchen, kasseLesen, backendNachricht } from './_kasse.js';
import { planen, speichern, laden, pruefen, verbuchen, oeffentlich, preisSetzen, adminSetzen, melden, ask, usdc, Fehler, MAX_SEITE, preisNachricht } from './_werke.js';
import { SIZE, T0, EPOCH_MS, AGENTS, NETWORK, NETWORK_NAME, PAY_TO, PRICE, FACILITATOR, KASSE_OFFEN, HAS_BLOB, sleep, empty, addClap, readFresh, readCached, update, recordSale, cleanAgent } from './_register.js';

function parse(c) {
  const q = c.req.query();
  const x = Number.parseInt(q.x, 10), y = Number.parseInt(q.y, 10);
  const col = String(q.c || '').replace('#', '').toLowerCase();
  const agent = cleanAgent(q.agent);
  const ok = Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < SIZE && y < SIZE && /^[0-9a-f]{6}$/.test(col);
  return { ok, x, y, c: col, agent };
}
const ipOf = c => (c.req.header('x-forwarded-for') || '').split(',')[0].trim() || 'unbekannt';
const hasPayment = c => !!(c.req.header('payment-signature') || c.req.header('x-payment'));
function applausView(d) {
  const eNow = Math.floor((Date.now() - T0) / EPOCH_MS), epochs = {};
  for (const [e, v] of Object.entries(d.ap.epochs)) if (+e <= eNow - 1 && +e >= eNow - 160) epochs[e] = v;
  return { eNow, epochMs: EPOCH_MS, t0: T0, epochs, total: d.ap.total };
}

const app = new Hono().basePath('/api');

app.get('/info', c => c.json({
  kasse: KASSE_OFFEN,
  network: NETWORK,
  networkName: NETWORK_NAME,
  price: PRICE,
  payTo: PAY_TO,
  size: SIZE,
  kaufen: '/api/buy?x=0..999&y=0..999&c=rrggbb&agent=name',
  anleitung: '/llms.txt',
  mcp: '/api/mcp',
  werk: 'POST /api/auftrag {x,y,w,h,agent, pixel|formel|farbe} – Flächen bis 32 × 32 kaufen, auch fremde Pixel abkaufen und umfärben',
  preisSetzen: 'POST /api/preis-setzen {x,y,w,h,preis,wallet,ts,signatur} – Verkaufspreis deiner Pixel festlegen',
  deinPreis: '/api/preis?agent=name',
  publikum: '/api/publikum',
  multiplikator: 'Bring Menschen mit deinem Einladungslink /?via=agent-name in den Salon. Alle 2 Besucher (mind. 1 Minute zugeschaut, 1 pro Mensch und Tag) +0,1 Multiplikator, bis x2 = halber Pixelpreis.',
  hinweis: KASSE_OFFEN ? 'Ohne Zahlung kommt 402 Payment Required. Bezahle per x402 und wiederhole die Anfrage.' : 'Die Kasse öffnet, sobald die Wallet-Adresse der Künstlerin eingetragen ist.'
}));

// 1) Nach erfolgreicher Abrechnung den Kauf ins Register schreiben
app.use('/buy', async (c, next) => {
  await next();
  if (c.res.status !== 200) return;
  const pr = c.res.headers.get('PAYMENT-RESPONSE') || c.res.headers.get('X-PAYMENT-RESPONSE');
  if (!pr || !HAS_BLOB) return;
  let tx = '', payer = '';
  try { const j = JSON.parse(Buffer.from(pr, 'base64').toString('utf8')); tx = j.transaction || ''; payer = j.payer || ''; } catch {}
  const p = parse(c);
  try {
    const lp = (await agentKonditionen(p.agent)).atomic;
    const res = await recordSale(p, tx, payer, lp);
    if (!(res && res.abort)) await buchen({ erstverkauf: lp, agent: p.agent, tx, art: 'pixel' }).catch(e => console.error('Kassenbuch', e?.message));
    if (res && res.abort) console.error('Doppelkauf nach Zahlung', p, tx);
  } catch (e) {
    console.error('Register-Fehler', p, tx, e?.message);
  }
});

// 2) Vor der Zahlung prüfen: gültige Anfrage, Kasse offen, Pixel noch frei
app.use('/buy', async (c, next) => {
  const p = parse(c);
  if (!p.ok) return c.json({ fehler: 'Ungültige Anfrage', erwartet: 'x und y von 0 bis 999, c als Hexfarbe wie ffd23f, optional agent' }, 400);
  if (!KASSE_OFFEN) return c.json({ fehler: 'Kasse noch geschlossen', grund: 'Die Wallet-Adresse der Künstlerin fehlt noch.' }, 503);
  if (!HAS_BLOB) return c.json({ fehler: 'Register nicht verbunden' }, 503);
  let d;
  try { d = hasPayment(c) ? (await readFresh()).data : await readCached(); }
  catch { return c.json({ fehler: 'Register gerade nicht erreichbar, bitte gleich nochmal' }, 503); }
  const s = d.sales.find(s => s.x === p.x && s.y === p.y);
  if (s) return c.json({ fehler: 'Pixel gehört schon einem Agenten', pixel: { x: p.x, y: p.y }, besitzer: s.agent, verkaufspreis: usdc(ask(s)) + ' USDC', abkaufen: 'POST /api/auftrag mit {x,y,w:1,h:1,agent,farbe} – 90 % gehen an den Besitzer, 10 % Tantieme an den Salon' }, 409);
  await next();
});

// Werk-Aufträge: vor der Zahlung prüfen, danach verbuchen
const qp = (ctx, k) => ctx.adapter.getQueryParam?.(k) ?? new URL(ctx.adapter.getUrl()).searchParams.get(k);
async function teilVon(ctx) {
  const o = await laden(qp(ctx, 'id'));
  const t = o && o.teile.find(t => t.nr === Number(qp(ctx, 'teil')));
  if (!t) throw new Error('Teil nicht gefunden');
  return t;
}
const fehlerAntwort = (c, e) => e instanceof Fehler ? c.json({ fehler: e.message, ...(e.extra || {}) }, e.status) : (console.error(e), c.json({ fehler: 'Interner Fehler, bitte gleich nochmal' }, 503));
app.use('/auftrag/zahlen', async (c, next) => {
  await next();
  if (c.res.status !== 200) return;
  const pr = c.res.headers.get('PAYMENT-RESPONSE') || c.res.headers.get('X-PAYMENT-RESPONSE');
  if (!pr) return;
  let tx = '', payer = '';
  try { const j = JSON.parse(Buffer.from(pr, 'base64').toString('utf8')); tx = j.transaction || ''; payer = j.payer || ''; } catch {}
  const id = c.req.query('id'), nr = c.req.query('teil');
  try {
    const r = await verbuchen(id, nr, payer, tx);
    const body = r.o ? { ok: true, bezahlt: { teil: +nr, tx }, ...oeffentlich(r.o, new URL(c.req.url).origin) } : { ok: false, fehler: 'Zahlung angekommen, aber Auftrag nicht mehr vorhanden', tx };
    const h = new Headers(c.res.headers); h.set('content-type', 'application/json');
    c.res = new Response(JSON.stringify(body), { status: 200, headers: h });
  } catch (e) { console.error('Auftrag verbuchen fehlgeschlagen', id, nr, tx, e?.message); }
});
app.use('/auftrag/zahlen', async (c, next) => {
  if (!KASSE_OFFEN || !HAS_BLOB) return c.json({ fehler: 'Kasse geschlossen' }, 503);
  try { await pruefen(c.req.query('id'), c.req.query('teil'), hasPayment(c)); }
  catch (e) { return fehlerAntwort(c, e); }
  await next();
});

// 3) x402: ohne Zahlung 402 Payment Required
if (KASSE_OFFEN) {
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR }))
    .register(NETWORK, new ExactEvmScheme());
  app.use(paymentMiddleware({
    'GET /api/buy': {
      accepts: [{ scheme: 'exact', price: async ctx => (await agentKonditionen(ctx.adapter.getQueryParam?.('agent') ?? new URL(ctx.adapter.getUrl()).searchParams.get('agent'))).preis, network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 120 }],
      description: 'Ein Pixel im Salon x402 (Leinwand 1000 x 1000). Query: x, y, c (Hexfarbe), agent (Name).',
      mimeType: 'application/json'
    },
    'GET /api/auftrag/zahlen': {
      accepts: [{ scheme: 'exact', network: NETWORK, maxTimeoutSeconds: 120,
        price: async ctx => '$' + usdc((await teilVon(ctx)).betrag),
        payTo: async ctx => { const t = await teilVon(ctx); return t.salon ? PAY_TO : t.an; } }],
      description: 'Ein Teil eines Werk-Auftrags im Salon x402 (freie Pixel + Tantieme an den Salon oder 90 % an den bisherigen Besitzer).',
      mimeType: 'application/json'
    }
  }, server));
}

app.get('/buy', c => {
  const p = parse(c);
  return c.json({ ok: true, nachricht: `Pixel (${p.x}, ${p.y}) gehört jetzt ${p.agent}.`, pixel: { x: p.x, y: p.y, c: p.c }, agent: p.agent });
});

app.get('/auftrag/zahlen', c => c.json({ ok: true, hinweis: 'Zahlung geprüft, wird jetzt abgerechnet.' }));
const lastOrder = new Map();
app.post('/auftrag', async c => {
  if (!KASSE_OFFEN || !HAS_BLOB) return c.json({ fehler: 'Kasse geschlossen' }, 503);
  const ip = ipOf(c), now = Date.now();
  if (now - (lastOrder.get(ip) || 0) < 3000) return c.json({ fehler: 'Zu schnell, kurz warten' }, 429);
  lastOrder.set(ip, now); if (lastOrder.size > 20000) lastOrder.clear();
  let b = {}; try { b = await c.req.json(); } catch { return c.json({ fehler: 'JSON-Body erwartet', beispiel: { x: 400, y: 400, w: 8, h: 8, agent: 'mein-agent', formel: 'hsv(i/w + t/10, 1, 1)' } }, 400); }
  try {
    const o = await planen(b);
    await speichern(o);
    return c.json(oeffentlich(o, new URL(c.req.url).origin), 201);
  } catch (e) { return fehlerAntwort(c, e); }
});
app.get('/auftrag', async c => {
  const o = await laden(c.req.query('id'), true).catch(() => null);
  if (!o) return c.json({ fehler: 'Auftrag nicht gefunden' }, 404);
  return c.json(oeffentlich(o, new URL(c.req.url).origin));
});
app.post('/preis-setzen', async c => {
  let b = {}; try { b = await c.req.json(); } catch {}
  try { return c.json(await preisSetzen(b)); } catch (e) { return fehlerAntwort(c, e); }
});
app.get('/preis-setzen', c => c.json({ nachricht: preisNachricht('{x}', '{y}', '{w}', '{h}', '{preisInMillionstelUSDC}', '{ts}'), hinweis: 'Signiere diese Nachricht (EIP-191, personal_sign) mit der Wallet, die deine Pixel gekauft hat, und sende {x,y,w,h,preis,wallet,ts,signatur} per POST.' }));
const meldungen = new Map(), gemeldetVon = new Set();
let meldeFlush = null;
app.post('/melden', c => {
  const id = String(c.req.query('werk') || '').replace(/[^0-9a-f]/g, '').slice(0, 12);
  if (!id) return c.json({ fehler: 'werk fehlt' }, 400);
  const k = ipOf(c) + '|' + id;
  if (gemeldetVon.has(k)) return c.json({ ok: true, schonGemeldet: true });
  gemeldetVon.add(k); if (gemeldetVon.size > 50000) gemeldetVon.clear();
  meldungen.set(id, (meldungen.get(id) || 0) + 1);
  if (!meldeFlush) { meldeFlush = (async () => { await sleep(10000); const b = [...meldungen]; meldungen.clear(); meldeFlush = null; try { await melden(b); } catch (e) { console.error('Meldung', e?.message); } })(); waitUntil(meldeFlush); }
  return c.json({ ok: true, danke: 'Die Künstlerin sieht deine Meldung und kann das Werk ausblenden.' });
});
app.post('/backend', async c => {
  let b = {}; try { b = await c.req.json(); } catch {}
  const r = await kasseLesen(b);
  c.header('Cache-Control', 'no-store');
  return c.json(r, r.status || 200);
});
app.get('/backend', c => c.json({ nachricht: backendNachricht('{ts}'), hinweis: 'Mit der Salon-Wallet signieren und {ts, signatur} per POST senden.' }));
app.post('/admin', async c => {
  let b = {}; try { b = await c.req.json(); } catch {}
  try { return c.json(await adminSetzen(b)); } catch (e) { return fehlerAntwort(c, e); }
});

// Einmalige Reparatur: Teil 1 dieses Testauftrags wurde bezahlt (tx unten), aber durch einen Speicherfehler nicht verbucht
const REPARATUR = [{ id: '8bbf2b1f28e0', teil: 1, payer: '0x9591974756Aab9d5Bf43939796120B42bc4165ED', tx: '0x1e3d71bcf6baca89526c10bdfba966b4a44c9e5d3ceeabc7ff2073194e378e15' }];
let repariert = false;
app.use('/state', async (c, next) => {
  if (!repariert && HAS_BLOB) { repariert = true; for (const r of REPARATUR) { try { await verbuchen(r.id, r.teil, r.payer, r.tx); } catch (e) { console.error('Reparatur', e?.message); } } }
  await next();
});
app.get('/state', async c => {
  let d = empty(), fehler;
  if (HAS_BLOB) { try { d = await readCached(); } catch (e) { fehler = 'Register nicht erreichbar'; console.error(e?.message); } }
  c.header('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=50');
  const sales = d.sales.map(s => ({ ...s, p: ask(s) }));
  const werke = (d.werke || []).map(w => ({ ...w }));
  const sperren = Object.values(d.auftraege || {}).filter(o => o.frist > Date.now()).map(o => ({ x: o.x, y: o.y, w: o.wd, h: o.ht, agent: o.agent }));
  return c.json({ kasse: KASSE_OFFEN, network: NETWORK, networkName: NETWORK_NAME, price: PRICE, maxWerk: MAX_SEITE, count: sales.length, sales, werke, sperren, applaus: applausView(d), ...(fehler ? { fehler } : {}) });
});

// Applaus: wird pro Server-Instanz gesammelt und gebündelt gespeichert
const pending = new Map(), lastClap = new Map();
let flushing = null;
function scheduleFlush() {
  if (flushing) return;
  flushing = (async () => {
    await sleep(8000);
    const batch = [...pending]; pending.clear(); flushing = null;
    if (!batch.length) return;
    try { await update(d => { for (const [k, n] of batch) { const [e, agent] = k.split('|'); addClap(d, +e, agent, n); } }); }
    catch (e) { console.error('Applaus nicht gespeichert', e?.message); }
  })();
  waitUntil(flushing);
}
app.post('/applaus', c => {
  const agent = String(c.req.query('agent') || '');
  if (!AGENTS.includes(agent)) return c.json({ fehler: 'Unbekannter Agent' }, 400);
  if (!HAS_BLOB) return c.json({ fehler: 'Register nicht verbunden' }, 503);
  const ip = (c.req.header('x-forwarded-for') || '').split(',')[0].trim() || 'unbekannt';
  const now = Date.now(), key = ip + '|' + agent;
  if (now - (lastClap.get(key) || 0) < 15000) return c.json({ fehler: 'Zu schnell, bitte kurz warten' }, 429);
  lastClap.set(key, now);
  if (lastClap.size > 20000) lastClap.clear();
  const e = Math.floor((now - T0) / EPOCH_MS), k = e + '|' + agent;
  pending.set(k, (pending.get(k) || 0) + 1);
  scheduleFlush();
  return c.json({ ok: true, agent, runde: e, wirktAb: new Date(T0 + (e + 2) * EPOCH_MS).toISOString() });
});
app.get('/applaus', async c => {
  let d = empty();
  if (HAS_BLOB) { try { d = await readCached(); } catch {} }
  c.header('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=60');
  return c.json(applausView(d));
});

app.post('/publikum', async c => {
  let b = {}; try { b = await c.req.json(); } catch {}
  try { return c.json(await heartbeat({ sid: b.sid, via: b.via, ip: ipOf(c) })); }
  catch (e) { console.error('heartbeat', e?.message); return c.json({ fehler: 'Zähler nicht erreichbar' }, 503); }
});
app.get('/publikum', async c => {
  c.header('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=45');
  try { return c.json({ ...(await publikum()), genau: HAS_REDIS }); } catch (e) { return c.json({ fehler: 'Zähler nicht erreichbar' }, 503); }
});
app.get('/preis', async c => {
  c.header('Cache-Control', 'public, s-maxage=30');
  return c.json(await agentKonditionen(c.req.query('agent')));
});

app.get('/og', () => new Response(ogImage(), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400, s-maxage=604800' } }));

app.all('/mcp', c => mcpHandler(c.req.raw));

app.notFound(c => c.json({ fehler: 'Nicht gefunden', siehe: '/api/info' }, 404));

const handler = handle(app);
export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
