import { Hono } from 'hono';
import { handle } from 'hono/vercel';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { waitUntil } from '@vercel/functions';
import { ogImage } from './_og.js';
import { mcpHandler } from './_mcp.js';
import { heartbeat, publikum, agentKonditionen, HAS_REDIS } from './_publikum.js';
import { SIZE, T0, EPOCH_MS, AGENTS, NETWORK, NETWORK_NAME, PAY_TO, PRICE, FACILITATOR, KASSE_OFFEN, HAS_BLOB, sleep, empty, addClap, readFresh, readCached, update, recordSale, cleanAgent } from './_register.js';

function parse(c) {
  const q = c.req.query();
  const x = Number.parseInt(q.x, 10), y = Number.parseInt(q.y, 10);
  const col = String(q.c || '').replace('#', '').toLowerCase();
  const agent = cleanAgent(q.agent);
  const ok = Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < SIZE && y < SIZE && /^[0-9a-f]{6}$/.test(col);
  return { ok, x, y, c: col, agent };
}
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
  size: SIZE,
  kaufen: '/api/buy?x=0..999&y=0..999&c=rrggbb&agent=name',
  anleitung: '/llms.txt',
  mcp: '/api/mcp',
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
  let tx = '';
  try { tx = JSON.parse(Buffer.from(pr, 'base64').toString('utf8')).transaction || ''; } catch {}
  const p = parse(c);
  try {
    const res = await recordSale(p, tx);
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
  if (d.sales.some(s => s.x === p.x && s.y === p.y)) return c.json({ fehler: 'Pixel schon vergeben', pixel: { x: p.x, y: p.y } }, 409);
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
    }
  }, server));
}

app.get('/buy', c => {
  const p = parse(c);
  return c.json({ ok: true, nachricht: `Pixel (${p.x}, ${p.y}) gehört jetzt ${p.agent}.`, pixel: { x: p.x, y: p.y, c: p.c }, agent: p.agent });
});

app.get('/state', async c => {
  let d = empty(), fehler;
  if (HAS_BLOB) { try { d = await readCached(); } catch (e) { fehler = 'Register nicht erreichbar'; console.error(e?.message); } }
  c.header('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=50');
  return c.json({ kasse: KASSE_OFFEN, network: NETWORK, networkName: NETWORK_NAME, price: PRICE, count: d.sales.length, sales: d.sales, applaus: applausView(d), ...(fehler ? { fehler } : {}) });
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

const ipOf = c => (c.req.header('x-forwarded-for') || '').split(',')[0].trim() || 'unbekannt';
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
