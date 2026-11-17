'use strict';
// Loja Adega — API para Vercel (funções Node) + Supabase (PostgreSQL e Storage). Sem dependências npm.
const crypto = require('crypto');

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
    await sb('POST', 'products', '', [P('demo1', 'Produto de demonstração 1', 'Exemplo. Exclua pelo painel.', 50, 'vinhos', 0), P('demo2', 'Produto de demonstração 2', 'Exemplo. Exclua pelo painel.', 80, 'destilados', 1)], 'return=minimal');
  }
}
async function resetAdmin(user, pw) {
  if (!pw || pw.length < 10) throw new Error('Defina ADMIN_PASSWORD (mínimo de 10 caracteres).');
  await q.patch('admins', `?username=eq.${enc(user)}`, { pass: hashPw(pw), totp_secret: null, totp_on: false, totp_last: 0 });
  await q.del('sessions', '?exp=gt.0');
}

/* ---------- validação ---------- */
const bad = m => { const e = new Error(m); e.status = 400; throw e; };
const str = (v, max, name, req) => { v = typeof v === 'string' ? v.trim() : ''; if (req && !v) bad(`Informe ${name}.`); if (v.length > max) bad(`${name} muito longo.`); return v; };
const num = (v, min, max, name) => { v = Number(v); if (!Number.isFinite(v) || v < min || v > max) bad(`${name} inválido.`); return v; };
const img = v => { v = typeof v === 'string' ? v : ''; if (v === '' || /^https:\/\/\S{1,480}$/.test(v)) return v; bad('Endereço de imagem inválido.'); };
const slug = id => { if (!/^[\w-]{1,40}$/.test(id)) bad('Identificador inválido.'); return id; };
function cleanProduct(b) {
  const o = { name: str(b.name, 120, 'o nome', true), desc: str(b.desc, 1000, 'a descrição'), price: num(b.price, 0.01, 100000, 'Preço'), promo: b.promo ? num(b.promo, 0, 100000, 'Preço promocional') : 0, promoOn: !!b.promoOn, cat: str(b.cat, 40, 'a categoria'), brand: str(b.brand, 60, 'a marca'), feat: !!b.feat, isNew: !!b.isNew, active: b.active !== false, order: Math.trunc(num(b.order || 0, 0, 100000, 'Ordem')), img: img(b.img), optOn: b.optOn !== false, groups: [] };
  if (o.promoOn && !(o.promo > 0 && o.promo < o.price)) bad('O preço promocional deve ser menor que o preço de venda.');
  if (!Array.isArray(b.groups || [])) bad('Grupos inválidos.'); if ((b.groups || []).length > 20) bad('Grupos demais.');
  o.groups = (b.groups || []).map(g => {
    if (!Array.isArray(g.options) || g.options.length > 100) bad('Opções inválidas.');
    const max = Math.trunc(num(g.max || 1, 1, 50, 'Máximo')), min = Math.trunc(num(g.min || 0, 0, 50, 'Mínimo')); if (min > max) bad('O mínimo não pode ser maior que o máximo.');
    return { id: slug(String(g.id || crypto.randomBytes(4).toString('hex'))), name: str(g.name, 80, 'o nome do grupo', true), required: !!g.required, show: g.show !== false, min, max, options: g.options.map(p => ({ id: slug(String(p.id || crypto.randomBytes(4).toString('hex'))), name: str(p.name, 80, 'o nome da opção', true), price: p.price ? num(p.price, 0, 100000, 'Valor adicional') : 0, img: img(p.img), active: p.active !== false })) };
  });
  return o;
}
const cleanCat = b => ({ name: str(b.name, 60, 'o nome', true), desc: str(b.desc, 300, 'a descrição'), img: img(b.img), order: Math.trunc(num(b.order || 0, 0, 100000, 'Ordem')) });
const cleanSettings = b => { const w = String(b.whatsapp || '').replace(/\D/g, ''); if (w && (w.length < 12 || w.length > 15)) bad('WhatsApp inválido (use 55 + DDD + número).');
  const zones = Array.isArray(b.zones) ? b.zones : []; if (zones.length > 100) bad('Zonas demais.');
  return { whatsapp: w, fee: num(b.fee || 0, 0, 1000, 'Taxa'), prazo: Math.trunc(num(b.prazo || 70, 1, 600, 'Prazo')), zones: zones.map(z => ({ name: str(z.name, 80, 'o nome do bairro', true), fee: num(z.fee || 0, 0, 1000, 'Taxa do bairro') })) }; };

/* ---------- utilidades HTTP ---------- */
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.tailwindcss.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https://*.supabase.co wss://*.supabase.co; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': CSP };
const send = (res, code, body, extra = {}) => { res.writeHead(code, { ...SEC, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(body)); };
const MAX_UP = 4 * 1024 * 1024; // limite de corpo das funções da Vercel é ~4,5 MB
async function readBody(req, limit) {
  if (req.body !== undefined) { // Vercel já leu o corpo
    const b = req.body; const buf = Buffer.isBuffer(b) ? b : Buffer.from(typeof b === 'string' ? b : JSON.stringify(b));
    if (buf.length > limit) throw Object.assign(new Error('Arquivo grande demais.'), { status: 413 }); return buf;
  }
  return new Promise((ok, no) => { const c = []; let n = 0; req.on('data', d => { n += d.length; if (n > limit) { no(Object.assign(new Error('Arquivo grande demais.'), { status: 413 })); req.destroy(); } else c.push(d); }); req.on('end', () => ok(Buffer.concat(c))); req.on('error', no); });
}
const readJson = async req => { const b = await readBody(req, 300000); try { return b.length ? JSON.parse(b.toString()) : {}; } catch { bad('JSON inválido.'); } };
const ipOf = req => String(req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || 'x').trim();
async function limited(key, max, ms) {
  const rows = await q.get('login_attempts', `?key=eq.${enc(key)}&ts=gt.${Date.now() - ms}&select=ts`);
  if (rows.length >= max) return true;
  await q.insert('login_attempts', { key, ts: Date.now() }); return false;
}
const parseCookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(a => a[0]).map(([k, ...v]) => [k, v.join('=')]));
async function sessionOf(req) {
  const t = parseCookies(req).sid; if (!t) return null;
  const r = await q.one('sessions', `?hash=eq.${sha(t)}&select=hash,exp,admins(*)`);
  if (!r || !r.admins || Number(r.exp) <= Date.now()) return null;
  return { ...r.admins, hash: r.hash, totp_on: !!r.admins.totp_on, totp_last: Number(r.admins.totp_last || 0) };
}
const rows = async t => (await q.get(t, '?select=id,data')).map(r => ({ id: r.id, ...r.data }));
const settings = async () => (await q.one('settings', '?k=eq.store&select=v')).v;
const audit = (admin, action, detail = '') => q.insert('audit', { admin, action, detail: String(detail).slice(0, 300) }).catch(() => {});
const orderView = r => ({ id: String(r.num), date: r.created, ...r.data });

/* ---------- rotas ---------- */
async function api(req, res, url) {
  await ready();
  const m = req.method, p = url.pathname;
  if (m !== 'GET' && m !== 'HEAD') {
    if (req.headers['x-requested-with'] !== 'fetch') return send(res, 403, { error: 'Requisição não permitida.' });
    const o = req.headers.origin; if (o && new URL(o).host !== req.headers.host) return send(res, 403, { error: 'Origem não permitida.' });
  }
  if (m === 'GET' && p === '/api/config') return send(res, 200, { supabaseUrl: sbUrl(), anonKey: process.env.SUPABASE_ANON_KEY || '' });
  if (m === 'GET' && p === '/api/public') return send(res, 200, { categories: await rows('categories'), products: (await rows('products')).filter(x => x.active !== false), settings: await settings() });
  if (m === 'POST' && p === '/api/orders/reserve') {
    if (await limited('res:' + ipOf(req), 40, 3600000)) return send(res, 429, { error: 'Muitas tentativas.' });
    const token = crypto.randomBytes(16).toString('hex');
    const r = await q.insert('orders', { token, status: 'reserved' }, true);
    return send(res, 200, { num: Number(r[0].num), token });
  }
  let mm;
  if (m === 'POST' && (mm = p.match(/^\/api\/orders\/(\d+)\/confirm$/))) {
    const b = await readJson(req); const row = await q.one('orders', `?num=eq.${+mm[1]}&status=eq.reserved&select=num,token`);
    if (!row || typeof b.token !== 'string' || b.token.length !== row.token.length || !crypto.timingSafeEqual(Buffer.from(b.token), Buffer.from(row.token))) return send(res, 404, { error: 'Pedido não encontrado.' });
    const c = b.customer || {}; const items = (Array.isArray(b.items) ? b.items : []).slice(0, 40).map(x => String(x).slice(0, 300));
    const data = { total: num(b.total, 0, 1000000, 'Total'), items, message: str(b.message, 4000, 'a mensagem'), customer: { name: str(c.name, 100, 'o nome'), phone: str(c.phone, 30, 'o telefone'), street: str(c.street, 150, 'a rua'), comp: str(c.comp, 100, 'o complemento'), ref: str(c.ref, 100, 'a referência'), bairro: str(c.bairro, 80, 'o bairro'), city: str(c.city, 80, 'a cidade'), pay: str(c.pay, 20, 'o pagamento') } };
    await q.patch('orders', `?num=eq.${row.num}&status=eq.reserved`, { status: 'sent', data }); return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/admin/login') {
    const ip = ipOf(req); if (await limited('login:' + ip, 8, 600000)) return send(res, 429, { error: 'Muitas tentativas. Aguarde 10 minutos.' });
    q.del('login_attempts', `?ts=lt.${Date.now() - 86400000}`).catch(() => {}); q.del('sessions', `?exp=lt.${Date.now()}`).catch(() => {});
    const b = await readJson(req); const a = await q.one('admins', `?username=eq.${enc(String(b.username || ''))}&select=*`);
    const okPw = checkPw(String(b.password || ''), a ? a.pass : DUMMY);
    if (!a || !okPw) { await audit(String(b.username || '?').slice(0, 40), 'login_falhou', ip); return send(res, 401, { error: 'Usuário ou senha incorretos.' }); }
    if (a.totp_on) { const step = totpStep(a.totp_secret, String(b.code || '')); if (!step || step <= Number(a.totp_last || 0)) { await audit(a.username, 'login_2fa_falhou', ip); return send(res, 401, { error: 'Código de verificação incorreto.', need2fa: true }); } await q.patch('admins', `?id=eq.${a.id}`, { totp_last: step }); }
    await audit(a.username, 'login', ip);
    const tok = crypto.randomBytes(32).toString('base64url'); await q.insert('sessions', { hash: sha(tok), admin_id: a.id, exp: Date.now() + 8 * 3600000 });
    return send(res, 200, { ok: true, totp: !!a.totp_on }, { 'Set-Cookie': `sid=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${SECURE ? '; Secure' : ''}` });
  }
  if (p.startsWith('/api/admin/')) {
    const s = await sessionOf(req); if (!s) return send(res, 401, { error: 'Faça login.' });
    if (m === 'GET' && p === '/api/admin/me') return send(res, 200, { username: s.username, totp: s.totp_on });
    if (m === 'POST' && p === '/api/admin/logout') { await audit(s.username, 'logout'); await q.del('sessions', `?hash=eq.${s.hash}`); return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${SECURE ? '; Secure' : ''}` }); }
    if (m === 'POST' && p === '/api/admin/2fa/setup') { if (s.totp_on) return send(res, 400, { error: '2FA já ativo.' }); const sec = newSecret(); await q.patch('admins', `?id=eq.${s.id}`, { totp_secret: sec }); return send(res, 200, { secret: sec, uri: `otpauth://totp/Loja%20Adega:${enc(s.username)}?secret=${sec}&issuer=Loja%20Adega` }); }
    if (m === 'POST' && p === '/api/admin/2fa/enable') { const b = await readJson(req); if (s.totp_on || !s.totp_secret) return send(res, 400, { error: 'Configuração inválida.' }); const step = totpStep(s.totp_secret, String(b.code || '')); if (!step) return send(res, 400, { error: 'Código incorreto.' }); await q.patch('admins', `?id=eq.${s.id}`, { totp_on: true, totp_last: step }); await audit(s.username, '2fa_ativado'); return send(res, 200, { ok: true }); }
    if (!s.totp_on) return send(res, 403, { error: 'Ative a verificação em duas etapas primeiro.' });
    if (m === 'POST' && p === '/api/admin/password') { const b = await readJson(req); if (!checkPw(String(b.current || ''), s.pass)) return send(res, 400, { error: 'Senha atual incorreta.' }); if (String(b.next || '').length < 10) return send(res, 400, { error: 'A nova senha precisa de ao menos 10 caracteres.' }); await q.patch('admins', `?id=eq.${s.id}`, { pass: hashPw(b.next) }); await q.del('sessions', `?admin_id=eq.${s.id}&hash=neq.${s.hash}`); await audit(s.username, 'senha_alterada'); return send(res, 200, { ok: true }); }
    if (m === 'GET' && p === '/api/admin/data') { const od = await q.get('orders', '?status=eq.sent&order=num.desc&limit=500&select=num,created,data'); return send(res, 200, { categories: await rows('categories'), products: await rows('products'), settings: await settings(), orders: od.map(orderView) }); }
    if (m === 'GET' && p === '/api/admin/audit') return send(res, 200, { items: await q.get('audit', '?select=ts,admin,action,detail&order=id.desc&limit=200') });
    if (m === 'PUT' && (mm = p.match(/^\/api\/admin\/orders\/(\d+)\/state$/))) { const b = await readJson(req); if (!['novo', 'confirmado', 'entregue', 'cancelado'].includes(b.state)) bad('Situação inválida.'); const row = await q.one('orders', `?num=eq.${+mm[1]}&status=eq.sent&select=data`); if (!row) return send(res, 404, { error: 'Pedido não encontrado.' }); await q.patch('orders', `?num=eq.${+mm[1]}`, { data: { ...row.data, state: b.state } }); await audit(s.username, 'pedido_' + b.state, '#' + mm[1]); return send(res, 200, { ok: true }); }
    if (m === 'PUT' && p === '/api/admin/settings') { await q.upsert('settings', { k: 'store', v: cleanSettings(await readJson(req)) }, 'k'); await audit(s.username, 'configuracoes_alteradas'); return send(res, 200, { ok: true }); }
    if ((mm = p.match(/^\/api\/admin\/(products|categories)\/([^/]+)$/))) {
      const t = mm[1], id = slug(decodeURIComponent(mm[2]));
      if (m === 'PUT') { const d = t === 'products' ? cleanProduct(await readJson(req)) : cleanCat(await readJson(req)); await q.upsert(t, { id, data: d }, 'id'); await audit(s.username, t + '_salvo', id + ' ' + (d.name || '')); return send(res, 200, { ok: true }); }
      if (m === 'DELETE') { await q.del(t, `?id=eq.${enc(id)}`); await audit(s.username, t + '_excluido', id); return send(res, 200, { ok: true }); }
    }
    if (m === 'POST' && p === '/api/admin/upload') {
      const buf = await readBody(req, MAX_UP); let ext = '', mime = '';
      if (buf.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) { ext = 'jpg'; mime = 'image/jpeg'; } else if (buf.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) { ext = 'png'; mime = 'image/png'; } else if (buf.slice(0, 4).toString() === 'GIF8') { ext = 'gif'; mime = 'image/gif'; } else if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') { ext = 'webp'; mime = 'image/webp'; }
      if (!ext) return send(res, 400, { error: 'Envie uma imagem JPG, PNG, GIF ou WEBP.' });
      const name = crypto.randomBytes(12).toString('hex') + '.' + ext;
      const r = await fetch(`${sbUrl()}/storage/v1/object/produtos/${name}`, { method: 'POST', headers: { ...keyHeaders(), 'Content-Type': mime }, body: buf });
      if (!r.ok) throw new Error('Storage: ' + r.status);
      await audit(s.username, 'imagem_enviada', name); return send(res, 200, { url: `${sbUrl()}/storage/v1/object/public/produtos/${name}` });
    }
  }
  return send(res, 404, { error: 'Não encontrado.' });
}

async function handle(req, res) {
  try { return await api(req, res, new URL(req.url, 'http://x')); }
  catch (e) { if (e.status) return send(res, e.status, { error: e.message }); console.error(e); return send(res, 500, { error: 'Erro interno.' }); }
}
module.exports = { handle, resetAdmin, CSP, SEC };
