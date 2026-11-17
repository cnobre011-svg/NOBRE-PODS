'use strict';
// Simulador mínimo do Supabase (PostgREST + Storage) para testar offline. NÃO é o Supabase real.
const http = require('http');
const T = { admins: [], sessions: [], categories: [], products: [], settings: [], orders: [], audit: [], login_attempts: [] };
const AUTO = { admins: 'id', orders: 'num', audit: 'id' }, PK = { admins: 'username', sessions: 'hash', categories: 'id', products: 'id', settings: 'k' }, seq = {};
const files = {};
const cmp = (v, s) => (typeof v === 'number' ? Number(s) : String(s));
function filt(rows, sp) {
  return rows.filter(r => { for (const [k, v] of sp) { if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue; const [op, ...rest] = v.split('.'); const val = rest.join('.'); const x = r[k];
    if (op === 'eq' && !(String(x) === val)) return false; if (op === 'neq' && String(x) === val) return false;
    if (op === 'gt' && !(Number(x) > Number(val))) return false; if (op === 'lt' && !(Number(x) < Number(val))) return false; } return true; });
}
const defaults = (t, row) => { const r = { ...row };
  if (AUTO[t] && r[AUTO[t]] === undefined) r[AUTO[t]] = seq[t] = (seq[t] || 0) + 1;
  if (t === 'admins') { r.totp_on ??= false; r.totp_last ??= 0; r.totp_secret ??= null; }
  if (t === 'orders') { r.status ??= 'reserved'; r.created ??= new Date().toISOString(); r.data ??= {}; }
  if (t === 'audit') { r.ts ??= new Date().toISOString(); r.detail ??= ''; } return r; };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const chunks = []; for await (const c of req) chunks.push(c); const raw = Buffer.concat(chunks);
  const out = (code, body, h = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...h }); res.end(body === undefined ? '' : (Buffer.isBuffer(body) ? body : JSON.stringify(body))); };
  if (!(req.headers.authorization || '').includes('test-key') && !u.pathname.includes('/object/public/')) return out(401, { message: 'no key' });
  let m;
  if ((m = u.pathname.match(/^\/storage\/v1\/object\/produtos\/(.+)$/)) && req.method === 'POST') { files[m[1]] = { buf: raw, type: req.headers['content-type'] }; return out(200, { Key: m[1] }); }
  if ((m = u.pathname.match(/^\/storage\/v1\/object\/public\/produtos\/(.+)$/))) { const f = files[m[1]]; return f ? out(200, f.buf, { 'Content-Type': f.type }) : out(404, { message: 'nf' }); }
  if (!(m = u.pathname.match(/^\/rest\/v1\/(\w+)$/)) || !T[m[1]]) return out(404, { message: 'nf' });
  const t = m[1], prefer = req.headers.prefer || '', sp = [...u.searchParams];
  if (req.method === 'GET') {
    let rows = filt(T[t], sp); const ord = u.searchParams.get('order'); if (ord) { const [c, d] = ord.split('.'); rows = [...rows].sort((a, b) => (a[c] > b[c] ? 1 : -1) * (d === 'desc' ? -1 : 1)); }
    const lim = u.searchParams.get('limit'); if (lim) rows = rows.slice(0, +lim);
    if (t === 'sessions' && /admins\(\*\)/.test(u.searchParams.get('select') || '')) rows = rows.map(r => ({ ...r, admins: T.admins.find(a => a.id === r.admin_id) || null }));
    return out(200, rows);
  }
  if (req.method === 'POST') {
    const body = JSON.parse(raw.toString()); const arr = Array.isArray(body) ? body : [body]; const made = []; const key = u.searchParams.get('on_conflict') || PK[t];
    for (const b of arr) { const row = defaults(t, b); const ex = key && T[t].find(r => r[key] === row[key]);
      if (ex) { if (prefer.includes('ignore-duplicates')) continue; if (prefer.includes('merge-duplicates')) { Object.assign(ex, b); made.push(ex); continue; } return out(409, { message: 'duplicate' }); }
      if (t === 'sessions' && !T.admins.find(a => a.id === row.admin_id)) return out(409, { message: 'fk' });
      T[t].push(row); made.push(row); }
    return prefer.includes('return=representation') ? out(201, made) : out(201);
  }
  if (req.method === 'PATCH') { const rows = filt(T[t], sp); const b = JSON.parse(raw.toString()); rows.forEach(r => Object.assign(r, b)); return out(204); }
  if (req.method === 'DELETE') { const rows = new Set(filt(T[t], sp)); T[t] = T[t].filter(r => !rows.has(r)); if (t === 'admins') T.sessions = T.sessions.filter(s => T.admins.find(a => a.id === s.admin_id)); return out(204); }
  out(405, { message: 'x' });
}).listen(+process.env.MOCK_PORT || 4010, () => console.log('mock supabase :' + (process.env.MOCK_PORT || 4010)));
