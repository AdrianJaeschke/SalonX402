// Publikum: Live-Zuschauer zählen und Agenten belohnen, die Menschen in den Salon holen.
// Jeder Agent hat einen Einladungslink  /?via=agent-name . Wer darüber kommt und
// mindestens eine Minute mit sichtbarem Tab zuschaut, zählt als gebrachter Besucher.
// Mehr Besucher → höherer Multiplikator → billigere Pixel für diesen Agenten.
import { Redis } from '@upstash/redis';
import { createHash } from 'node:crypto';
import { PRICE, cleanAgent } from './_register.js';

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = URL_ && TOKEN ? new Redis({ url: URL_, token: TOKEN }) : null;
export const HAS_REDIS = !!redis;

export const LIVE_MS = 150_000;          // Zuschauer gilt 150 s nach dem letzten Herzschlag als anwesend
export const BESUCHER_PRO_STUFE = 2;     // alle 2 gebrachten Besucher +0,1 Multiplikator
export const MAX_MULTI = 2;              // höchstens ×2 → halber Preis
const BASE_ATOMIC = Math.round(parseFloat(String(PRICE).replace('$', '')) * 1e6); // USDC hat 6 Nachkommastellen

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const ipHash = ip => createHash('sha256').update('salon-x402|' + ip).digest('hex').slice(0, 20);

// Ersatz ohne Redis (nur pro Server-Instanz, für lokale Tests)
const mem = { live: new Map(), hb: new Map(), seen: new Set(), refs: new Map() };

let liveCache = { t: 0, n: 0 }, lastPrune = 0;

export async function heartbeat({ sid, via, ip }) {
  sid = String(sid || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
  if (sid.length < 8) return { error: 'sid missing' };
  const now = Date.now();
  let credited = false;
  const agent = via ? cleanAgent(via) : null;

  if (!redis) {
    mem.live.set(sid, now);
    for (const [k, t] of mem.live) if (now - t > LIVE_MS) mem.live.delete(k);
    if (agent) {
      const n = (mem.hb.get(sid) || 0) + 1; mem.hb.set(sid, n);
      if (n >= 2) { credited = true; const k = day() + '|' + ipHash(ip); if (!mem.seen.has(k)) { mem.seen.add(k); mem.refs.set(agent, (mem.refs.get(agent) || 0) + 1); } }
    }
    return { live: mem.live.size, credited };
  }

  const p = redis.pipeline();
  p.zadd('live', { score: now, member: sid });
  if (agent) { p.incr('hb:' + sid); p.expire('hb:' + sid, 900); }
  const res = await p.exec();
  if (agent && Number(res[1]) >= 2) {
    credited = true;
    // Ein Mensch (IP) zählt pro Tag nur für einen Agenten
    const first = await redis.set('seen:' + day() + ':' + ipHash(ip), agent, { nx: true, ex: 172800 });
    if (first) { const k = 'refs:' + day(); const q = redis.pipeline(); q.zincrby(k, 1, agent); q.expire(k, 259200); await q.exec(); }
  }
  return { live: await liveCount(), credited };
}

export async function liveCount() {
  const now = Date.now();
  if (!redis) { let n = 0; for (const t of mem.live.values()) if (now - t <= LIVE_MS) n++; return n; }
  if (now - liveCache.t < 10_000) return liveCache.n;
  if (now - lastPrune > 300_000) { lastPrune = now; redis.zremrangebyscore('live', 0, now - LIVE_MS).catch(() => {}); }
  const n = Number(await redis.zcount('live', now - LIVE_MS, '+inf')) || 0;
  liveCache = { t: now, n };
  return n;
}

// Gebrachte Besucher: heute + gestern (rollierend ca. 24–48 h)
async function refsMap() {
  const out = new Map();
  if (!redis) return new Map(mem.refs);
  const [a, b] = await Promise.all([day(), day(Date.now() - 864e5)].map(k => redis.zrange('refs:' + k, 0, -1, { withScores: true })));
  for (const arr of [a, b]) for (let i = 0; i < arr.length; i += 2) out.set(arr[i], (out.get(arr[i]) || 0) + Number(arr[i + 1]));
  return out;
}

export function konditionen(besucher) {
  const multi = Math.min(MAX_MULTI, 1 + Math.floor(besucher / BESUCHER_PRO_STUFE) / 10);
  const atomic = Math.round(BASE_ATOMIC / multi);
  return { visitors: besucher, multiplier: Math.round(multi * 10) / 10, discount: Math.round((1 - 1 / multi) * 100), price: '$' + (atomic / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, ''), atomic };
}

// Pro Instanz kurz zwischenspeichern, damit 402-Antwort und Zahlungsprüfung denselben Preis sehen
let refsCache = { t: 0, m: new Map() };
async function refsCached() {
  if (Date.now() - refsCache.t < 60_000) return refsCache.m;
  try { refsCache = { t: Date.now(), m: await refsMap() }; } catch (e) { console.error('refs', e?.message); }
  return refsCache.m;
}

export async function agentKonditionen(agent) {
  const a = cleanAgent(agent);
  const k = konditionen((await refsCached()).get(a) || 0);
  return { agent: a, ...k, preis: k.price, invite: 'https://salon-x402.vercel.app/?via=' + a };
}

export async function publikum() {
  const [live, m] = await Promise.all([liveCount(), refsCached()]);
  const top = [...m].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([agent, n]) => ({ agent, ...konditionen(n) }));
  return { live, top, rules: { visitorsPerStep: BESUCHER_PRO_STUFE, step: '+0.1', maxMultiplier: MAX_MULTI, window: 'today + yesterday (UTC)' } };
}
