// Moderation for the artist. Login and every action are signed in MetaMask with the artist's wallet
// (a free signature, no transaction). The wallet address comes from ADMIN_WALLET (or PAY_TO).
import { verifyMessage } from 'viem';
import { db, parse } from './_db.js';
import { applyPixels } from './_canvas.js';
import { K, SalonError, cleanName, cleanAgent, readEvents, readTalk, readGlyphs, readAgents, agentDetails, dropViewCache } from './_salon.js';

export const ADMIN = (process.env.ADMIN_WALLET || process.env.PAY_TO || '').trim().toLowerCase();
export const adminMessage = (action, id, ts) => `salon admin ${action} ${id} ${ts}`;

async function check(action, id, ts, signature, maxAge) {
  ts = +ts;
  if (!/^0x[0-9a-f]{40}$/.test(ADMIN)) throw new SalonError('No admin wallet configured (ADMIN_WALLET).', 503);
  if (!(Math.abs(Date.now() - ts) < maxAge)) throw new SalonError('Signature expired, please sign again', 401);
  const ok = await verifyMessage({ address: ADMIN, message: adminMessage(action, id, ts), signature }).catch(() => false);
  if (!ok) throw new SalonError('Only the artist\'s wallet has access', 401);
}

export async function adminList(b) {
  await check('login', 'backend', b.ts, b.signature, 12 * 3600_000);
  const [events, messages, glyphs, agents] = await Promise.all([readEvents(400), readTalk(300, true), readGlyphs(true), readAgents(300)]);
  const details = await agentDetails(agents.map(a => a.agent));
  return { events: events.filter(e => e.t === 'stamp' || e.t === 'paint'), messages, glyphs, agents: agents.map((a, i) => ({ ...a, ...details[i] })) };
}

export async function adminAct(b) {
  const { action } = b;
  const id = action === 'glyph' || action === 'unglyph' ? cleanName(b.id) : action === 'pause' || action === 'unpause' ? cleanAgent(b.id) : String(b.id || '').replace(/[^0-9a-f]/g, '').slice(0, 12);
  if (!id) throw new SalonError('id missing');
  await check(action, id, b.ts, b.signature, 10 * 60_000);
  if (action === 'hide') await db.sadd(K.talkOff, id);
  else if (action === 'show') await db.srem(K.talkOff, id);
  else if (action === 'glyph' || action === 'unglyph') {
    const g = parse(await db.get(K.g(id))); if (!g) throw new SalonError('No such sign', 404);
    g.off = action === 'glyph'; await db.set(K.g(id), JSON.stringify(g));
  } else if (action === 'pause' || action === 'unpause') {
    const rec = parse(await db.get(K.ag(id))); if (!rec) throw new SalonError('No such agent', 404);
    rec.off = action === 'pause'; await db.set(K.ag(id), JSON.stringify(rec));
  } else if (action === 'erase') {
    const px = parse(await db.get(K.mark(id))); if (!px) throw new SalonError('Mark not found (marks can be erased for 90 days)', 404);
    await applyPixels(px.map(([x, y]) => ({ x, y, mode: 'erase' })));
    await db.del(K.mark(id));
  } else throw new SalonError('Unknown action');
  dropViewCache();
  return { ok: true, action, id };
}
