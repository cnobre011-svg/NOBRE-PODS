'use strict';
// Loja Adega — API para Vercel (funções Node) + Supabase (PostgreSQL e Storage). Sem dependências npm.
const crypto = require('crypto');
const delivery = require('./delivery');

const sbUrl = () => (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const sbKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
// Chaves novas (sb_secret_...) NÃO são JWT: vão só em 'apikey'. A chave antiga (service_role, JWT) também vai em Authorization.
const keyHeaders = () => (sbKey().startsWith('sb_') ? { apikey: sbKey() } : { apikey: sbKey(), Authorization: 'Bearer ' + sbKey() });
const SECURE = process.env.COOKIE_SECURE !== 'false';
const enc = encodeURIComponent;

/* ---------- acesso ao Supabase (PostgREST) com a chave secreta, só no servidor ---------- */
async function sb(method, table, query, body, prefer) {
  const r = await fetch(`${sbUrl()}/rest/v1/${table}${query || ''}`, {
    method, headers: { ...keyHeaders(), 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Supabase ${method} ${table}: ${r.status} ${txt.slice(0, 200)}`);
  return txt ? JSON.parse(txt) : null;
}
const q = {
  get: (t, query) => sb('GET', t, query),
  one: async (t, query) => { const a = await sb('GET', t, query + (query.includes('limit=') ? '' : '&limit=1')); return (a && a[0]) || null; },
  insert: (t, row, ret) => sb('POST', t, '', row, ret ? 'return=representation' : 'return=minimal'),
  upsert: (t, row, key) => sb('POST', t, `?on_conflict=${key}`, row, 'resolution=merge-duplicates,return=minimal'),
  ignore: (t, row, key) => sb('POST', t, `?on_conflict=${key}`, row, 'resolution=ignore-duplicates,return=minimal'),
  patch: (t, filter, p) => sb('PATCH', t, filter, p, 'return=minimal'),
  del: (t, filter) => sb('DELETE', t, filter, undefined, 'return=minimal'),
};

/* ---------- senhas e TOTP ---------- */
const hashPw = pw => { const s = crypto.randomBytes(16).toString('hex'); return s + '$' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const checkPw = (pw, stored) => { const [s, h] = String(stored).split('$'); const a = crypto.scryptSync(pw, s, 64), b = Buffer.from(h || '', 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const DUMMY = hashPw('dummy-password');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const newSecret = () => { let bits = '', o = ''; crypto.randomBytes(20).forEach(x => bits += x.toString(2).padStart(8, '0')); for (let i = 0; i < bits.length; i += 5) o += B32[parseInt(bits.slice(i, i + 5), 2)]; return o; };
const unb32 = s => { let bits = ''; for (const c of s) bits += B32.indexOf(c).toString(2).padStart(5, '0'); const b = []; for (let i = 0; i + 8 <= bits.length; i += 8) b.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(b); };
const hotp = (sec, ctr) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(ctr)); const h = crypto.createHmac('sha1', unb32(sec)).update(b).digest(); const o = h[19] & 15; return String(((h.readUInt32BE(o) & 0x7fffffff) % 1000000)).padStart(6, '0'); };
const totpStep = (sec, code) => { const c = Math.floor(Date.now() / 30000); for (const d of [-1, 0, 1]) if (hotp(sec, c + d) === code) return c + d; return 0; };

/* ---------- inicialização (administrador e configurações) ---------- */
const cfgErr = m => Object.assign(new Error(m), { status: 500 });
let readyP = null;
const ready = () => readyP || (readyP = init().catch(e => { readyP = null; throw e; }));
async function init() {
  if (!sbUrl() || !sbKey()) throw cfgErr('Servidor sem configuração: defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.');
  if (!(await q.one('admins', '?select=id'))) {
    const user = process.env.ADMIN_USER || 'Cnobre', pw = process.env.ADMIN_PASSWORD;
    if (!pw || pw.length < 10) throw cfgErr('Servidor sem configuração: defina ADMIN_PASSWORD (mínimo de 10 caracteres).');
    await q.ignore('admins', { username: user, pass: hashPw(pw) }, 'username');
  }
  if (!(await q.one('settings', '?k=eq.store&select=k'))) await q.ignore('settings', { k: 'store', v: { whatsapp: process.env.WHATSAPP || '', fee: 0, prazo: 70, zones: [] } }, 'k');
  if (process.env.SEED_DEMO === 'true' && !(await q.one('products', '?select=id')) && !(await q.one('categories', '?select=id'))) {
    await sb('POST', 'categories', '', [['vinhos', 'Vinhos', 'Vinhos tintos e brancos.'], ['destilados', 'Destilados', 'Whisky e outros destilados.']].map(([id, name, desc], i) => ({ id, data: { name, desc, img: '', order: i } })), 'return=minimal');
    const P = (id, n, d, pr, cat, o) => ({ id, data: { name: n, desc: d, price: pr, promo: 0, promoOn: false, cat, brand: '', feat: true, isNew: false, active: true, order: o, img: '', optOn: true, groups: [] } });
    await sb('POST', 'products', '', [P('demo1', 'Produto de
