// Kassenbuch der Künstlerin: echte Einnahmen und Tantiemen. Liegt nur in Redis, nicht im öffentlichen Register.
// Abrufbar nur mit einer Signatur der Salon-Wallet (siehe /backend).
import { Redis } from '@upstash/redis';
import { verifyMessage } from 'viem';
import { PAY_TO } from './_register.js';

const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const R_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = R_URL && R_TOKEN ? new Redis({ url: R_URL, token: R_TOKEN }) : null;

// betraege in Millionstel USDC: { erstverkauf, tantiemen, rueckkauf }
export async function buchen({ erstverkauf = 0, tantiemen = 0, rueckkauf = 0, agent = '', tx = '', art = '' }) {
  if (!redis) return;
  const summe = erstverkauf + tantiemen + rueckkauf;
  if (summe <= 0) return;
  const p = redis.pipeline();
  if (erstverkauf) p.hincrby('kasse', 'erstverkauf', erstverkauf);
  if (tantiemen) p.hincrby('kasse', 'tantiemen', tantiemen);
  if (rueckkauf) p.hincrby('kasse', 'rueckkauf', rueckkauf);
  p.hincrby('kasse', 'zahlungen', 1);
  p.lpush('kasse:log', JSON.stringify({ ts: Date.now(), art, agent, tx, erstverkauf, tantiemen, rueckkauf }));
  p.ltrim('kasse:log', 0, 299);
  await p.exec();
}

export const backendNachricht = ts => `salon-x402 backend ${ts}`;
export async function kasseLesen({ ts, signatur }) {
  ts = +ts;
  if (!(Math.abs(Date.now() - ts) < 12 * 3600_000)) return { error: 'Login expired, please sign again', status: 401 };
  const ok = PAY_TO && await verifyMessage({ address: PAY_TO, message: backendNachricht(ts), signature: signatur }).catch(() => false);
  if (!ok) return { error: 'Only the salon wallet has access', status: 401 };
  if (!redis) return { error: 'Ledger not connected', status: 503 };
  const [k, log] = await Promise.all([redis.hgetall('kasse'), redis.lrange('kasse:log', 0, 99)]);
  const n = v => Number(v || 0);
  const summe = { erstverkauf: n(k?.erstverkauf), tantiemen: n(k?.tantiemen), rueckkauf: n(k?.rueckkauf), zahlungen: n(k?.zahlungen) };
  return { ok: true, summe: { ...summe, gesamt: summe.erstverkauf + summe.tantiemen + summe.rueckkauf }, log: log.map(x => (typeof x === 'string' ? JSON.parse(x) : x)) };
}
