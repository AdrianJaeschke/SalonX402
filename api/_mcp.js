// MCP-Server des Salon x402: Assistenten lesen die Leinwand und kaufen Pixel als bezahltes Werkzeug (x402 über MCP).
import { createMcpHandler } from 'mcp-handler';
import { createPaymentWrapper, x402ResourceServer } from '@x402/mcp';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { z } from 'zod';
import { agentKonditionen } from './_publikum.js';
import { buchen } from './_kasse.js';
import { planen, speichern, laden, pruefen, verbuchen, oeffentlich, usdc, ask, MAX_SEITE, preisSetzen, preisNachricht } from './_werke.js';
import { SIZE, NETWORK, NETWORK_NAME, PAY_TO, PRICE, FACILITATOR, KASSE_OFFEN, HAS_BLOB, readCached, readFresh, recordSale, cleanAgent } from './_register.js';

const SITE = 'https://salon-x402.vercel.app';
const text = (t, isError = false) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }], ...(isError ? { isError: true } : {}) });
const coord = () => z.number().int().min(0).max(SIZE - 1);

// Ein Bezahl-Wrapper pro Preisstufe: Agenten mit Publikum zahlen weniger (siehe _publikum.js)
let rsPromise = null;
const wrappers = new Map();
async function resourceServer() {
  if (!rsPromise) rsPromise = (async () => {
    const rs = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR }));
    rs.register(NETWORK, new ExactEvmScheme());
    await rs.initialize();
    return rs;
  })().catch(e => { rsPromise = null; throw e; });
  return rsPromise;
}
// Bezahl-Wrapper für Werk-Teile: Betrag und Empfänger hängen am Auftrag
const teilWrappers = new Map();
async function teilWrapper(price, payTo) {
  const key = price + '|' + payTo;
  if (!teilWrappers.has(key)) teilWrappers.set(key, (async () => {
    const rs = await resourceServer();
    const accepts = await rs.buildPaymentRequirements({ scheme: 'exact', network: NETWORK, payTo, price });
    return createPaymentWrapper(rs, {
      accepts,
      resource: { url: 'mcp://salon-x402/pay_order_part', description: 'One part of a Salon x402 artwork order', mimeType: 'application/json' },
      hooks: {
        onBeforeExecution: async ({ arguments: a }) => { try { await pruefen(a.order_id, a.part, true); return true; } catch { return false; } },
        onAfterSettlement: async ({ arguments: a, settlement }) => {
          try { await verbuchen(a.order_id, a.part, settlement?.payer || '', settlement?.transaction || ''); }
          catch (e) { console.error('MCP: Teil verbuchen', a, e?.message); }
        }
      }
    });
  })().catch(e => { teilWrappers.delete(key); throw e; }));
  if (teilWrappers.size > 200) teilWrappers.clear();
  return teilWrappers.get(key);
}

async function paidWrapper(price = PRICE) {
  if (!wrappers.has(price)) wrappers.set(price, (async () => {
    const rs = await resourceServer();
    const accepts = await rs.buildPaymentRequirements({ scheme: 'exact', network: NETWORK, payTo: PAY_TO, price });
    return createPaymentWrapper(rs, {
      accepts,
      resource: { url: 'mcp://salon-x402/buy_pixel', description: 'One pixel on the Salon x402 canvas', mimeType: 'application/json' },
      hooks: {
        // vor der Abbuchung: Pixel noch frei?
        onBeforeExecution: async ({ arguments: a }) => {
          const { data } = await readFresh();
          return !data.sales.some(s => s.x === a.x && s.y === a.y);
        },
        // nach erfolgreicher Abrechnung: ins Register schreiben
        onAfterSettlement: async ({ arguments: a, settlement }) => {
          try {
            const lp = (await agentKonditionen(a.agent)).atomic;
            const res = await recordSale({ x: a.x, y: a.y, c: String(a.color).replace('#', '').toLowerCase(), agent: cleanAgent(a.agent) }, settlement?.transaction || '', settlement?.payer || '', lp);
            if (!(res && res.abort)) await buchen({ erstverkauf: lp, agent: cleanAgent(a.agent), tx: settlement?.transaction || '', art: 'pixel (MCP)' }).catch(() => {});
            if (res && res.abort) console.error('MCP: Doppelkauf nach Zahlung', a);
          } catch (e) { console.error('MCP: Register-Fehler', a, e?.message); }
        }
      }
    });
  })().catch(e => { wrappers.delete(price); throw e; }));
  return wrappers.get(price);
}

const handler = createMcpHandler(async server => {
  server.tool(
    'salon_info',
    'What Salon x402 is: a 1000x1000 pixel canvas that only AI agents may buy, paid per pixel via x402 (USDC). Returns price, network, rules and links.',
    {},
    async () => text({
      name: 'Salon x402',
      site: SITE,
      checkoutOpen: KASSE_OFFEN,
      price: PRICE + ' per free pixel',
      network: `${NETWORK} (${NETWORK_NAME})`,
      canvas: `${SIZE} x ${SIZE}`,
      rules: ['One owner per pixel, purchases are permanent.', 'Paint something worth looking at; humans applaud the art.', 'Painter agents on the website are a simulation; only real purchases move money.'],
      docs: SITE + '/llms.txt'
    })
  );

  server.tool(
    'read_canvas',
    'Read real purchases in a region of the canvas (max 100x100). Returns sold pixels with color and owner agent.',
    { x: coord(), y: coord(), width: z.number().int().min(1).max(100).default(40), height: z.number().int().min(1).max(100).default(40) },
    async ({ x, y, width, height }) => {
      const d = HAS_BLOB ? await readCached() : { sales: [] };
      const inRegion = d.sales.filter(s => s.x >= x && s.x < x + width && s.y >= y && s.y < y + height).map(({ x, y, c, agent }) => ({ x, y, color: '#' + c, agent }));
      return text({ region: { x, y, width, height }, soldInRegion: inRegion.length, totalSold: d.sales.length, pixels: inRegion.slice(0, 2000) });
    }
  );

  server.tool(
    'find_free_pixels',
    'Find free (unsold) pixels closest to a target coordinate.',
    { x: coord(), y: coord(), count: z.number().int().min(1).max(200).default(20) },
    async ({ x, y, count }) => {
      const d = HAS_BLOB ? await readCached() : { sales: [] };
      const taken = new Set(d.sales.map(s => s.x + '_' + s.y));
      const out = [];
      for (let r = 0; r < SIZE && out.length < count; r++) {
        for (let dy = -r; dy <= r && out.length < count; dy++) for (let dx = -r; dx <= r && out.length < count; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const px = x + dx, py = y + dy;
          if (px < 0 || py < 0 || px >= SIZE || py >= SIZE || taken.has(px + '_' + py)) continue;
          out.push({ x: px, y: py });
        }
      }
      return text({ near: { x, y }, free: out });
    }
  );

  server.tool(
    'get_my_terms',
    'Your audience multiplier and pixel price. Share your invite link (https://salon-x402.vercel.app/?via=your-name) with humans: every 2 humans who watch for a minute raise your multiplier by 0.1, up to x2 (half price). No spam, no fake visits.',
    { agent: z.string().min(1).max(32).describe('your public agent name') },
    async ({ agent }) => text(await agentKonditionen(agent))
  );

  server.tool(
    'create_artwork_order',
    `Paint your own artwork: reserve an area up to ${MAX_SEITE}x${MAX_SEITE} and give either "pixels" (hex colors row by row), a "formula" (animated generative art, see below) or one "color". The area may include pixels owned by other agents: you buy them at their asking price (90 % goes to the owner, 10 % royalty to the salon) and repaint them. Returns the payment parts; pay each with pay_order_part within 15 minutes. Formula language: variables x y (canvas), i j (inside your area), w h, t (seconds); colors rgb(r,g,b) hsv(h,s,v) gray(v) with values 0..1; functions sin cos tan atan2 abs floor fract sqrt pow min max clamp mix step smoothstep mod hash noise dist; operators + - * / % ^ < > == && || ?: . Example: hsv(fract(dist(i,j,w/2,h/2)/8 - t/4), 0.8, 1)`,
    {
      x: coord(), y: coord(),
      width: z.number().int().min(1).max(MAX_SEITE), height: z.number().int().min(1).max(MAX_SEITE),
      agent: z.string().min(1).max(32).describe('your public agent name'),
      pixels: z.array(z.string()).optional().describe('width*height hex colors, row by row'),
      formula: z.string().max(400).optional().describe('generative formula, animated live for every spectator'),
      color: z.string().optional().describe('one hex color for the whole area')
    },
    async a => {
      try { const o = await planen({ x: a.x, y: a.y, w: a.width, h: a.height, agent: a.agent, pixel: a.pixels, formel: a.formula, farbe: a.color }); await speichern(o); return text({ ...oeffentlich(o, SITE), next: 'Call pay_order_part for every part.' }); }
      catch (e) { return text(e.message, true); }
    }
  );
  server.tool('get_order', 'Status of an artwork order and its payment parts.', { order_id: z.string() }, async ({ order_id }) => {
    const o = await laden(order_id, true).catch(() => null);
    return o ? text(oeffentlich(o, SITE)) : text('Order not found', true);
  });
  server.tool(
    'set_price',
    'Set the asking price for your own pixels (anyone may buy them at this price). Sign the message "salon-x402 preis {x},{y},{w},{h} {priceInMicroUSDC} {tsMillis}" with the wallet that bought them (EIP-191 personal_sign).',
    { x: coord(), y: coord(), width: z.number().int().min(1).max(100), height: z.number().int().min(1).max(100), price_usdc: z.string(), wallet: z.string(), ts: z.number().int(), signature: z.string() },
    async a => { try { return text(await preisSetzen({ x: a.x, y: a.y, w: a.width, h: a.height, preis: a.price_usdc, wallet: a.wallet, ts: a.ts, signatur: a.signature })); } catch (e) { return text(e.message, true); } }
  );

  if (KASSE_OFFEN && HAS_BLOB) {
    server.tool(
      'pay_order_part',
      'Pay one part of an artwork order via x402 (amount and recipient come from the order). When all parts are paid, the area is yours.',
      { order_id: z.string(), part: z.number().int().min(1).max(6) },
      async (args, extra) => {
        let t;
        try { t = (await pruefen(args.order_id, args.part, false)).t; } catch (e) { return text(e.message, true); }
        const w = await teilWrapper('$' + usdc(t.betrag), t.salon ? PAY_TO : t.an);
        return w(async ({ order_id }) => {
          const o = await laden(order_id, true).catch(() => null);
          return text(o ? oeffentlich(o, SITE) : { ok: true });
        })(args, extra);
      }
    );
    let paid = null;
    try { paid = await paidWrapper(); } catch (e) { console.error('MCP: Kasse nicht initialisiert', e?.message); }
    if (paid) {
      server.tool(
        'buy_pixel',
        `Buy one free pixel and paint it. Costs ${PRICE} USDC on ${NETWORK_NAME} (less if you bring human spectators, see get_my_terms), paid via x402 (your MCP client needs x402 payment support). Fails without charge if the pixel is already sold.`,
        { x: coord(), y: coord(), color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).describe('hex color like #ffd23f'), agent: z.string().min(1).max(32).describe('your public agent name') },
        async (args, extra) => {
          let price = PRICE;
          try { price = (await agentKonditionen(args.agent)).preis; } catch {}
          const w = await paidWrapper(price);
          return w(async ({ x, y, color, agent }) => text({ ok: true, message: `Pixel (${x}, ${y}) now belongs to ${cleanAgent(agent)}.`, price, color: '#' + color.replace('#', '').toLowerCase(), view: SITE }))(args, extra);
        }
      );
    }
  }
  if (!server._registeredTools?.buy_pixel) {
    server.tool('buy_pixel', 'Buy one pixel (checkout currently closed).', { x: coord(), y: coord() }, async () => text('The checkout is closed right now. See ' + SITE + '/llms.txt', true));
  }
}, { serverInfo: { name: 'salon-x402', version: '1.0.0' } }, { basePath: '/api', maxDuration: 60, verboseLogs: false, disableSse: true });

export const mcpHandler = handler;
