import {loadConcept} from './_concept.js';
import { conceptRequest, commission, collaborations } from './_creator.js';
// MCP-Server des Salon x402: Assistenten lesen die Leinwand und kaufen Pixel als bezahltes Werkzeug (x402 über MCP).
import { createMcpHandler } from 'mcp-handler';
import { createPaymentWrapper, x402ResourceServer } from '@x402/mcp';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { z } from 'zod';
import { agentKonditionen } from './_publikum.js';
import { buchen, alarm } from './_kasse.js';
import { payerFromPayload, nameFree, claimName } from './_namen.js';
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
        onBeforeExecution: async ({ arguments: a, paymentPayload }) => { try { const { o } = await pruefen(a.order_id, a.part, true); return await nameFree(o.agent, payerFromPayload(paymentPayload)); } catch { return false; } },
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
        onBeforeExecution: async ({ arguments: a, paymentPayload }) => {
          if (!(await nameFree(cleanAgent(a.agent), payerFromPayload(paymentPayload)))) return false;
          const { data } = await readFresh();
          return !data.sales.some(s => s.x === a.x && s.y === a.y);
        },
        // nach erfolgreicher Abrechnung: ins Register schreiben
        onAfterSettlement: async ({ arguments: a, settlement }) => {
          try {
            const lp = (await agentKonditionen(a.agent)).atomic;
            const res = await recordSale({ x: a.x, y: a.y, c: String(a.color).replace('#', '').toLowerCase(), agent: cleanAgent(a.agent) }, settlement?.transaction || '', settlement?.payer || '', lp);
            if (!(res && res.abort)) { await buchen({ erstverkauf: lp, agent: cleanAgent(a.agent), tx: settlement?.transaction || '', art: 'pixel (MCP)' }).catch(() => {}); await claimName(cleanAgent(a.agent), settlement?.payer); }
            else await alarm('MCP: paid pixel already taken', { x: a.x, y: a.y, tx: settlement?.transaction });
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
      rules: ['Merchandise rights end at resale. Remove offers at transfer. Read /terms.html.', 'Paint something worth looking at; humans applaud the art.', 'Painter agents on the website are a simulation; only real purchases move money.'],
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
    'Buy a pixel or rectangle. Read /terms.html before ordering. Resale preserves its artwork.',
    { x:coord(), y:coord(), width:z.number().int().min(1).max(MAX_SEITE), height:z.number().int().min(1).max(MAX_SEITE), agent:z.string().min(1).max(32), terms:z.literal('2026-11-22') },
    async a => {
      try { const o = await planen(a); await speichern(o); return text({ ...oeffentlich(o, SITE), next: 'Call pay_order_part for every part.' }); }
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
  }
  server.tool('buy_pixel','Prepare a one-pixel order. Pay the returned parts.',{x:coord(),y:coord(),agent:z.string(),terms:z.literal('2026-11-22')},async a=>{
    try { const order=await planen({...a,w:1,h:1}); await speichern(order); return text(oeffentlich(order,SITE)); } catch(e){return text(e.message,true);}
  });
  server.tool('list_collaborations','Discover open joint commissions or invitations for one wallet.',{wallet:z.string().optional()},async a=>text(await collaborations(a)));
  server.tool('propose_collaboration','Propose a joint commission or counter with a new signed brief. Signing protocol in /llms.txt.',{wallet:z.string(),x:coord(),y:coord(),w:z.number().int(),h:z.number().int(),brief:z.string(),ts:z.number().int(),signature:z.string()},async a=>{try{return text(await collaborations(a,'propose'));}catch(e){return text(e.message,true);}});
  server.tool('approve_collaboration','Approve the exact proposal ID using your wallet signature.',{id:z.string(),wallet:z.string(),ts:z.number().int(),signature:z.string()},async a=>{try{return text(await collaborations(a,'approve'));}catch(e){return text(e.message,true);}});
  server.tool('render_collaboration','Realise a fully approved proposal through the salon creator.',{id:z.string()},async a=>{try{return text(await collaborations(a,'render'));}catch(e){return text(e.message,true);}});
  server.tool('design_concept','Ask the Salon Concept Artist for a proposal or send feedback with parent set to the previous ID. Read /llms.txt for signing instructions.',{wallet:z.string(),x:coord(),y:coord(),w:z.number().int(),h:z.number().int(),brief:z.string(),parent:z.string().optional(),ts:z.number().int(),signature:z.string()},async a=>{try{return text(await conceptRequest(a));}catch(e){return text(e.message,true);}});
  server.tool('read_concept','Review the exact concept before signing a commission.',{id:z.string()},async a=>{try{return text(await loadConcept(a.id));}catch(e){return text(e.message,true);}});
  server.tool('commission','Submit a wallet-signed creative brief. Signature format: see /llms.txt.',{x:coord(),y:coord(),w:z.number().int(),h:z.number().int(),brief:z.string(),wallet:z.string(),ts:z.number(),signature:z.string(),terms:z.literal('2026-11-22')},async a=>{
    try {return text(await commission(a));} catch(e){return text(e.message,true);}
  });
}, { serverInfo: { name: 'salon-x402', version: '1.0.0' } }, { basePath: '/api', maxDuration: 60, verboseLogs: false, disableSse: true });

export const mcpHandler = handler;
