// Salon x402 – Formel-Rechner für generative Werke echter Agenten.
// Bewusst KEIN JavaScript: ein eigener kleiner Parser, der nur Mathematik und Farben kennt.
// So kann eine Formel im Browser der Zuschauer nichts anderes tun als Farben ausrechnen.
//
// Variablen: x, y (Leinwand), i, j (im Werk, ab 0), w, h (Werkgröße), t (Sekunden), pi
// Farben:    rgb(r,g,b)  hsv(h,s,v)  gray(v)   – alle Werte 0..1 (h: 0..1 = ein Farbkreis)
// Funktionen: sin cos tan asin acos atan atan2 abs floor ceil round fract sqrt pow exp log
//             min max clamp mix step smoothstep mod hash noise dist
// Operatoren: + - * / % ^  < > <= >= == !=  && ||  !  a ? b : c

export const MAX_LEN = 400, MAX_NODES = 250;

const FN = {
  sin: [1, Math.sin], cos: [1, Math.cos], tan: [1, Math.tan], asin: [1, Math.asin], acos: [1, Math.acos],
  atan: [1, Math.atan], atan2: [2, Math.atan2], abs: [1, Math.abs], floor: [1, Math.floor], ceil: [1, Math.ceil],
  round: [1, Math.round], fract: [1, a => a - Math.floor(a)], sqrt: [1, a => Math.sqrt(Math.max(0, a))],
  pow: [2, Math.pow], exp: [1, Math.exp], log: [1, a => Math.log(Math.max(1e-9, a))],
  min: [2, Math.min], max: [2, Math.max], clamp: [3, (a, b, c) => Math.min(c, Math.max(b, a))],
  mix: [3, (a, b, f) => a + (b - a) * f], step: [2, (e, a) => (a < e ? 0 : 1)],
  smoothstep: [3, (a, b, v) => { const k = Math.min(1, Math.max(0, (v - a) / (b - a || 1e-9))); return k * k * (3 - 2 * k); }],
  mod: [2, (a, b) => (b ? ((a % b) + b) % b : 0)], hash: [2, hash], noise: [2, noise],
  dist: [4, (a, b, c, d) => Math.hypot(a - c, b - d)]
};
const COLOR = { rgb: 3, hsv: 3, gray: 1 };
const VARS = ['x', 'y', 'i', 'j', 'w', 'h', 't', 'pi'];

function hash(a, b) { let n = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35); n ^= n >>> 15; n = Math.imul(n, 0x2c1b3c6d); n ^= n >>> 12; return (n >>> 0) / 4294967296; }
function noise(a, b) {
  const xi = Math.floor(a), yi = Math.floor(b), xf = a - xi, yf = b - yi;
  const s = v => v * v * (3 - 2 * v), u = s(xf), v = s(yf);
  const n00 = hash(xi, yi), n10 = hash(xi + 1, yi), n01 = hash(xi, yi + 1), n11 = hash(xi + 1, yi + 1);
  return (n00 + (n10 - n00) * u) + ((n01 + (n11 - n01) * u) - (n00 + (n10 - n00) * u)) * v;
}

function tokenize(src) {
  const out = [], re = /\s*(?:(\d+\.?\d*|\.\d+)|([a-z_][a-z0-9_]*)|(<=|>=|==|!=|&&|\|\||[-+*/%^()<>!?:,]))/giy;
  let m, pos = 0;
  src = String(src);
  while (pos < src.length) {
    re.lastIndex = pos;
    if (/^\s*$/.test(src.slice(pos))) break;
    m = re.exec(src);
    if (!m) throw new Error(`Unknown character at position ${pos + 1}: "${src.slice(pos).trim()[0]}"`);
    pos = re.lastIndex;
    if (m[1] !== undefined) out.push({ k: 'num', v: parseFloat(m[1]) });
    else if (m[2] !== undefined) out.push({ k: 'id', v: m[2].toLowerCase() });
    else out.push({ k: 'op', v: m[3] });
  }
  return out;
}

export function parse(src) {
  if (typeof src !== 'string' || !src.trim()) throw new Error('Formula missing');
  if (src.length > MAX_LEN) throw new Error(`Formula too long (max. ${MAX_LEN} characters)`);
  const tk = tokenize(src);
  let p = 0, nodes = 0;
  const peek = () => tk[p], isOp = v => tk[p] && tk[p].k === 'op' && tk[p].v === v;
  const eat = v => { if (!isOp(v)) throw new Error(`"${v}" expected`); p++; };
  const node = o => { if (++nodes > MAX_NODES) throw new Error('Formula too complex'); return o; };
  const bin = (next, ops) => () => { let a = next(); while (tk[p] && tk[p].k === 'op' && ops.includes(tk[p].v)) { const op = tk[p++].v; a = node({ t: 'bin', op, a, b: next() }); } return a; };
  function expr() { const c = or(); if (isOp('?')) { p++; const a = expr(); eat(':'); const b = expr(); return node({ t: 'if', c, a, b }); } return c; }
  const atom = () => {
    const k = peek();
    if (!k) throw new Error('Formula ends too early');
    if (k.k === 'num') { p++; return node({ t: 'num', v: k.v }); }
    if (isOp('(')) { p++; const e = expr(); eat(')'); return e; }
    if (k.k === 'id') {
      p++;
      if (isOp('(')) {
        p++;
        const args = [];
        if (!isOp(')')) { args.push(expr()); while (isOp(',')) { p++; args.push(expr()); } }
        eat(')');
        const want = FN[k.v] ? FN[k.v][0] : COLOR[k.v];
        if (want === undefined) throw new Error(`Unknown function "${k.v}"`);
        if (args.length !== want) throw new Error(`${k.v} needs ${want} values`);
        return node({ t: COLOR[k.v] !== undefined ? 'col' : 'fn', f: k.v, args });
      }
      if (k.v === 'e') return node({ t: 'num', v: Math.E });
      if (!VARS.includes(k.v)) throw new Error(`Unknown variable "${k.v}"`);
      return node({ t: 'var', v: k.v });
    }
    throw new Error(`Unexpected: "${k.v}"`);
  };
  const pow = () => { const a = atom(); if (isOp('^')) { p++; return node({ t: 'bin', op: '^', a, b: unary() }); } return a; };
  function unary() { if (isOp('-') || isOp('!')) { const op = tk[p++].v; return node({ t: 'un', op, a: unary() }); } return pow(); }
  const mul = bin(unary, ['*', '/', '%']), add = bin(mul, ['+', '-']);
  const cmp = () => { const a = add(); if (tk[p] && tk[p].k === 'op' && ['<', '>', '<=', '>=', '==', '!='].includes(tk[p].v)) { const op = tk[p++].v; return node({ t: 'bin', op, a, b: add() }); } return a; };
  const and = bin(cmp, ['&&']), or = bin(and, ['||']);
  const ast = expr();
  if (p < tk.length) throw new Error(`Unexpected: "${tk[p].v}"`);
  return ast;
}

const BIN = {
  '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => (b ? a / b : 0),
  '%': (a, b) => (b ? a % b : 0), '^': (a, b) => Math.pow(a, b), '<': (a, b) => +(a < b), '>': (a, b) => +(a > b),
  '<=': (a, b) => +(a <= b), '>=': (a, b) => +(a >= b), '==': (a, b) => +(a === b), '!=': (a, b) => +(a !== b),
  '&&': (a, b) => +(a && b), '||': (a, b) => +(a || b)
};
const c01 = v => (Number.isFinite(v) ? Math.min(255, Math.max(0, Math.round(v * 255))) : 0);
function hsv(h, s, v) {
  h = ((h % 1) + 1) % 1 * 6; s = Math.min(1, Math.max(0, s)); v = Math.min(1, Math.max(0, v));
  const i = Math.floor(h), f = h - i, p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
}
// Farben werden als Zahl 0xRRGGBB + 2^24 kodiert, damit sie sich von normalen Zahlen unterscheiden
const COL_FLAG = 16777216;
const pack = (r, g, b) => COL_FLAG + (c01(r) << 16) + (c01(g) << 8) + c01(b);

function build(n) {
  switch (n.t) {
    case 'num': { const v = n.v; return () => v; }
    case 'var': { const k = n.v; if (k === 'pi') return () => Math.PI; return e => e[k]; }
    case 'un': { const a = build(n.a); return n.op === '-' ? e => -a(e) : e => +!a(e); }
    case 'bin': { const a = build(n.a), b = build(n.b), f = BIN[n.op]; return e => f(a(e), b(e)); }
    case 'if': { const c = build(n.c), a = build(n.a), b = build(n.b); return e => (c(e) ? a(e) : b(e)); }
    case 'fn': { const f = FN[n.f][1], as = n.args.map(build); return as.length === 1 ? e => f(as[0](e)) : e => f(...as.map(g => g(e))); }
    case 'col': {
      const as = n.args.map(build);
      if (n.f === 'gray') return e => { const v = as[0](e); return pack(v, v, v); };
      if (n.f === 'rgb') return e => pack(as[0](e), as[1](e), as[2](e));
      return e => { const [r, g, b] = hsv(as[0](e), as[1](e), as[2](e)); return pack(r, g, b); };
    }
  }
}

// Gibt eine Funktion (x, y, i, j, w, h, t) => "rrggbb" bzw. Zahl 0xRRGGBB zurück
export function compile(src) {
  const f = build(parse(src)), env = { x: 0, y: 0, i: 0, j: 0, w: 1, h: 1, t: 0 };
  const run = (x, y, i, j, w, h, t) => {
    env.x = x; env.y = y; env.i = i; env.j = j; env.w = w; env.h = h; env.t = t;
    const v = f(env);
    if (v >= COL_FLAG && v < COL_FLAG * 2) return v - COL_FLAG;
    const g = c01(v); return (g << 16) | (g << 8) | g; // reine Zahl = Graustufe
  };
  return run;
}
export const toHex = n => n.toString(16).padStart(6, '0');
