// Kassenbuch der Künstlerin: echte Einnahmen und Tantiemen. Liegt nur in Redis, nicht im öffentlichen Register.
// Abrufbar nur mit einer Signatur der Salon-Wallet (siehe /backend).
import { verifyMessage } from 'viem';
import { PAY_TO, redis, NS } from './_register.js';
const K = NS + 'kasse', LOG = NS + 'kasse:log', ALARM = NS + 'alarm';

// betraege in Millionstel USDC: { erstverkauf, tantiemen, rueckkauf }
export async function buchen({ erstverkauf = 0, tantiemen = 0, rueckkauf = 0, agent = '', tx = '', art = '' }) {
  if (!redis) return;
  const summe = erstverkauf + tantiemen + rueckkauf;
  if (summe <= 0) return;
  const p = redis.pipeline();
  if (erstverkauf) p.hincrby(K, 'erstverkauf', erstverkauf);
  if (tantiemen) p.hincrby(K, 'tantiemen', tantiemen);
  if (rueckkauf) p.hincrby(K, 'rueckkauf', rueckkauf);
  p.hincrby(K, 'zahlungen', 1);
  p.lpush(LOG, JSON.stringify({ ts: Date.now(), art, agent, tx, erstverkauf, tantiemen, rueckkauf }));
  p.ltrim(LOG, 0, 299);
  await p.exec();
}

export const backendNachricht = ts => `salon-x402 backend ${ts}`;
export async function kasseLesen({ ts, signatur }) {
  ts = +ts;
  if (!(Math.abs(Date.now() - ts) < 12 * 3600_000)) return { error: 'Login expired, please sign again', status: 401 };
  const ok = PAY_TO && await verifyMessage({ address: PAY_TO, message: backendNachricht(ts), signature: signatur }).catch(() => false);
  if (!ok) return { error: 'Only the salon wallet has access', status: 401 };
  if (!redis) return { error: 'Ledger not connected', status: 503 };
  const [k, log, alarm] = await Promise.all([redis.hgetall(K), redis.lrange(LOG, 0, 99), redis.lrange(ALARM, 0, 49)]);
  const n = v => Number(v || 0);
  const summe = { erstverkauf: n(k?.erstverkauf), tantiemen: n(k?.tantiemen), rueckkauf: n(k?.rueckkauf), zahlungen: n(k?.zahlungen) };
  return { ok: true, summe: { ...summe, gesamt: summe.erstverkauf + summe.tantiemen + summe.rueckkauf }, log: log.map(x => (typeof x === 'string' ? JSON.parse(x) : x)), alarms: alarm.map(x => (typeof x === 'string' ? JSON.parse(x) : x)) };
}

// Alarm: something went wrong around money (payment arrived but booking failed, facilitator down …)
export async function alarm(what, detail = {}) {
  console.error('ALARM', what, JSON.stringify(detail));
  if (!redis) return;
  try { const p = redis.pipeline(); p.lpush(ALARM, JSON.stringify({ ts: Date.now(), what, ...detail })); p.ltrim(ALARM, 0, 199); await p.exec(); } catch {}
}
