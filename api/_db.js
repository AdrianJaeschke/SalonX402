// Storage: Upstash Redis (via the Vercel integration). Without credentials a small in-memory stand-in
// with the same commands is used, so everything can be run and tested locally.
import { Redis } from '@upstash/redis';

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
// Everything of this edition lives under its own prefix: it starts at zero and never touches older data
export const NS = (process.env.SALON_NS || 'open1') + ':';
export const HAS_REDIS = !!(URL_ && TOKEN);

class Mem {
  constructor() { this.m = new Map(); this.exp = new Map(); }
  _alive(k) { const e = this.exp.get(k); if (e && e < Date.now()) { this.m.delete(k); this.exp.delete(k); } return this.m.has(k); }
  _get(k, make) { if (!this._alive(k) && make) this.m.set(k, make()); return this.m.get(k); }
  async get(k) { return this._alive(k) ? this.m.get(k) : null; }
  async set(k, v, o = {}) {
    if (o.nx && this._alive(k)) return null;
    this.m.set(k, v);
    if (o.ex) this.exp.set(k, Date.now() + o.ex * 1000); else if (o.px) this.exp.set(k, Date.now() + o.px); else this.exp.delete(k);
    return 'OK';
  }
  async del(k) { const had = this.m.delete(k); this.exp.delete(k); return had ? 1 : 0; }
  async incr(k) { const v = (Number(await this.get(k)) || 0) + 1; this.m.set(k, v); return v; }
  async incrby(k, n) { const v = (Number(await this.get(k)) || 0) + n; this.m.set(k, v); return v; }
  async expire(k, s) { if (this._alive(k)) this.exp.set(k, Date.now() + s * 1000); return 1; }
  async lpush(k, ...v) { const l = this._get(k, () => []); l.unshift(...v.reverse()); return l.length; }
  async ltrim(k, a, b) { const l = this._get(k, () => []); this.m.set(k, l.slice(a, b + 1)); return 'OK'; }
  async lrange(k, a, b) { const l = this._get(k, () => []); return l.slice(a, b < 0 ? l.length + b + 1 : b + 1); }
  async hset(k, o) { const h = this._get(k, () => ({})); Object.assign(h, o); return 1; }
  async hget(k, f) { const h = this._get(k, () => ({})); return h[f] ?? null; }
  async hgetall(k) { const h = this._alive(k) ? this.m.get(k) : null; return h && Object.keys(h).length ? { ...h } : null; }
  async hincrby(k, f, n) { const h = this._get(k, () => ({})); h[f] = (Number(h[f]) || 0) + n; return h[f]; }
  async zadd(k, { score, member }) { const z = this._get(k, () => new Map()); z.set(member, score); return 1; }
  async zincrby(k, n, member) { const z = this._get(k, () => new Map()); z.set(member, (z.get(member) || 0) + n); return z.get(member); }
  async zscore(k, member) { const z = this._get(k, () => new Map()); return z.has(member) ? z.get(member) : null; }
  async zcard(k) { return this._get(k, () => new Map()).size; }
  async zcount(k, min, max) { const lo = min === '-inf' ? -Infinity : +min, hi = max === '+inf' ? Infinity : +max; return [...this._get(k, () => new Map()).values()].filter(s => s >= lo && s <= hi).length; }
  async zremrangebyscore(k, min, max) { const z = this._get(k, () => new Map()); for (const [m, s] of z) if (s >= +min && s <= +max) z.delete(m); return 1; }
  async zrange(k, a, b, o = {}) {
    let e = [...this._get(k, () => new Map()).entries()].sort((p, q) => p[1] - q[1]);
    if (o.byScore) { const lo = a === '-inf' ? -Infinity : +a, hi = b === '+inf' ? Infinity : +b; e = e.filter(([, s]) => s >= lo && s <= hi); }
    if (o.rev) e.reverse();
    if (!o.byScore) e = e.slice(a, b < 0 ? e.length + b + 1 : b + 1);
    return o.withScores ? e.flat() : e.map(([m]) => m);
  }
  async sadd(k, ...v) { const s = this._get(k, () => new Set()); v.forEach(x => s.add(x)); return 1; }
  async srem(k, ...v) { const s = this._get(k, () => new Set()); v.forEach(x => s.delete(x)); return 1; }
  async smembers(k) { return [...this._get(k, () => new Set())]; }
  pipeline() {
    const calls = [], self = this;
    const p = new Proxy({}, { get(_, name) { if (name === 'exec') return async () => { const out = []; for (const [n, a] of calls) out.push(await self[n](...a)); return out; }; return (...a) => { calls.push([name, a]); return p; }; } });
    return p;
  }
}

export const db = HAS_REDIS ? new Redis({ url: URL_, token: TOKEN }) : new Mem();
// Values written as JSON come back parsed from Upstash; from the stand-in they are still strings
export const parse = v => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function withLock(key, fn, { tries = 50, ms = 120, ttl = 10000 } = {}) {
  const me = 'L' + Math.random().toString(36).slice(2);
  let ok = false;
  for (let t = 0; t < tries && !ok; t++) { ok = !!(await db.set(key, me, { nx: true, px: ttl })); if (!ok) await sleep(ms); }
  if (!ok) throw Object.assign(new Error('Busy, please retry in a moment'), { status: 503 });
  try { return await fn(); }
  finally { if ((await db.get(key)) === me) await db.del(key); }
}
