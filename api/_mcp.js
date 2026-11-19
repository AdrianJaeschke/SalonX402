// MCP-Server des Salon x402: Assistenten lesen die Leinwand und kaufen Pixel als bezahltes Werkzeug (x402 über MCP).
import { createMcpHandler } from 'mcp-handler';
import { createPaymentWrapper, x402ResourceServer } from '@x402/mcp';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { z } from 'zod';
import { SIZE, NETWORK, NETWORK_NAME, PAY_TO, PRICE, FACILITATOR, KASSE_OFFEN, HAS_BLOB, readCached, readFresh, recordSale, cleanAgent } from './_register.js';

const SITE = 'https://salon-x402.vercel.app';
const text = (t, isError = false) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }], ...(isError ? { isError: true } : {}) });
const coord = () => z.number().int().min(0).max(SIZE - 1);

let paidPromise = null;
async function paidWrapper() {
  if (!paidPromise) paidPromise = (async () => {
    const rs = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR }));
    rs.register(NETWORK, new ExactEvmScheme());
    await rs.initialize();
    const accepts = await rs.buildPaymentRequirements({ scheme: 'exact', network: NETWORK, payTo: PAY_TO, price: PRICE });
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
            const res = await recordSale({ x: a.x, y: a.y, c: String(a.color).replace('#', '').toLowerCase(), agent: cleanAgent(a.agent) }, settlement?.transaction || '');
            if (res && res.abort) console.error('MCP: Doppelkauf nach Zahlung', a);
          } catch (e) { console.error('MCP: Register-Fehler', a, e?.message); }
        }
      }
    });
  })().catch(e => { paidPromise = null; throw e; });
  return paidPromise;
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

  if (KASSE_OFFEN && HAS_BLOB) {
    let paid = null;
    try { paid = await paidWrapper(); } catch (e) { console.error('MCP: Kasse nicht initialisiert', e?.message); }
    if (paid) {
      server.tool(
        'buy_pixel',
        `Buy one free pixel and paint it. Costs ${PRICE} USDC on ${NETWORK_NAME}, paid via x402 (your MCP client needs x402 payment support). Fails without charge if the pixel is already sold.`,
        { x: coord(), y: coord(), color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).describe('hex color like #ffd23f'), agent: z.string().min(1).max(32).describe('your public agent name') },
        paid(async ({ x, y, color, agent }) => text({ ok: true, message: `Pixel (${x}, ${y}) now belongs to ${cleanAgent(agent)}.`, color: '#' + color.replace('#', '').toLowerCase(), view: SITE }))
      );
    }
  }
  if (!server._registeredTools?.buy_pixel) {
    server.tool('buy_pixel', 'Buy one pixel (checkout currently closed).', { x: coord(), y: coord() }, async () => text('The checkout is closed right now. See ' + SITE + '/llms.txt', true));
  }
}, { serverInfo: { name: 'salon-x402', version: '1.0.0' } }, { basePath: '/api', maxDuration: 60, verboseLogs: false, disableSse: true });

export const mcpHandler = handler;
