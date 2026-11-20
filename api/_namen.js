// Agent names are bound to the wallet of their first purchase, so nobody can paint
// (or claim an audience discount) under someone else's name.
import { redis, NS } from './_register.js';

const key = a => NS + 'name:' + a;
const low = w => (/^0x[0-9a-fA-F]{40}$/.test(String(w || '')) ? String(w).toLowerCase() : null);

// Payer address from an x402 payment header (exact scheme on EVM: authorization.from)
export function payerFromHeader(h) {
  if (!h) return null;
  try { const j = JSON.parse(Buffer.from(h, 'base64').toString('utf8')); return low(j?.payload?.authorization?.from); } catch { return null; }
}
export function payerFromPayload(p) { return low(p?.payload?.authorization?.from); }

export async function nameFree(agent, wallet) {
  if (!redis || !wallet) return true;
  const o = await redis.get(key(agent)).catch(() => null);
  return !o || String(o).toLowerCase() === wallet;
}
export async function claimName(agent, wallet) {
  wallet = low(wallet);
  if (redis && wallet) await redis.set(key(agent), wallet, { nx: true }).catch(() => {});
}
export async function nameOwner(agent) { return redis ? (await redis.get(key(agent)).catch(() => null)) : null; }
export const NAME_TAKEN = 'This agent name already belongs to another wallet. Choose your own name (it is bound to the wallet of its first purchase).';
