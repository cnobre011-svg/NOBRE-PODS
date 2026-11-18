'use strict';
// Taxa de entrega por distância. Roda SÓ no servidor (função da Vercel).
// O endereço da loja vem de variável de ambiente e nunca sai deste módulo:
// nenhuma função aqui devolve o endereço, as coordenadas da loja ou chaves.
const crypto = require('crypto');

const PRICE_PER_KM = 2;   // R$ por km
const MIN_FEE = 5;        // taxa mínima em R$
const QUOTE_TTL_MS = 30 * 60 * 1000;

const env = (k, d = '') => (process.env[k] || d).trim();
const uerr = (m, status = 422) => Object.assign(new Error(m), { status });

/* ---------- regra de preço ---------- */
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
function feeFor(km) {
  return round(Math.max(MIN_FEE, round(km, 1) * PRICE_PER_KM), 2);
}

/* ---------- distância ---------- */
function haversineKm(a, b) {
  const R = 6371.0088, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---------- configuração (lida a cada chamada: variáveis da Vercel) ---------- */
const enabled = () => !!(env('STORE_ADDRESS') || (env('STORE_LAT') && env('STORE_LNG')));
const sign = () => env('DELIVERY_SECRET') || env('SUPABASE_SERVICE_ROLE_KEY') || '';

async function getJson(url, headers) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', ...(headers || {}) }, signal: ctl.signal });
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

/* ---------- CEP -> logradouro/bairro/cidade (ViaCEP) ---------- */
async function lookupCep(cep) {
  const base = env('VIACEP_URL', 'https://viacep.com.br/ws');
  let j;
  try { j = await getJson(`${base}/${cep}/json/`); } catch { throw uerr('Não foi possível consultar o CEP agora. Tente novamente.', 503); }
  if (!j || j.erro) throw uerr('CEP não encontrado.');
  return { street: j.logradouro || '', bairro: j.bairro || '', city: j.localidade || '', uf: j.uf || '' };
}

/* ---------- endereço -> coordenadas ---------- */
async function geocode(query) {
  const gkey = env('GOOGLE_MAPS_API_KEY');
  if (gkey) {
    const base = env('GOOGLE_GEOCODE_URL', 'https://maps.googleapis.com/maps/api/geocode/json');
    const j = await getJson(`${base}?address=${encodeURIComponent(query)}&region=br&key=${encodeURIComponent(gkey)}`);
    if (j.status === 'ZERO_RESULTS') return null;
    if (j.status !== 'OK' || !j.results || !j.results[0]) throw new Error('geocoder ' + j.status);
    const l = j.results[0].geometry.location; return { lat: +l.lat, lng: +l.lng };
  }
  const base = env('NOMINATIM_URL', 'https://nominatim.openstreetmap.org/search');
  const j = await getJson(`${base}?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(query)}`,
    { 'User-Agent': env('GEOCODER_USER_AGENT', 'loja-adega-entrega/1.0') });
  if (!Array.isArray(j) || !j[0]) return null;
  return { lat: +j[0].lat, lng: +j[0].lon };
}

let storeCache = null; // { key, loc } — só em memória do servidor
async function storeLocation() {
  if (!enabled()) throw uerr('Entrega por distância não configurada.', 500);
  const key = env('STORE_LAT') + '|' + env('STORE_LNG') + '|' + env('STORE_ADDRESS');
  if (storeCache && storeCache.key === key) return storeCache.loc;
  let loc;
  if (env('STORE_LAT') && env('STORE_LNG')) loc = { lat: +env('STORE_LAT'), lng: +env('STORE_LNG') };
  else loc = await geocode(env('STORE_ADDRESS')).catch(() => null);
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) throw uerr('Não foi possível calcular a entrega agora. Fale com a loja.', 503);
  storeCache = { key, loc }; return loc;
}

/* ---------- entrada do cliente ---------- */
const cleanCep = v => { const d = String(v || '').replace(/\D/g, ''); if (d.length !== 8) throw uerr('Informe um CEP com 8 dígitos.', 400); return d; };
const cleanNumber = v => { const n = String(v || '').trim(); if (!n || n.length > 12 || !/^[\p{L}\p{N} ./-]+$/u.test(n)) throw uerr('Informe o número do endereço.', 400); return n; };
const cleanStreet = v => String(v || '').trim().slice(0, 150);

/* ---------- cotação ---------- */
async function quote(cepIn, numberIn, streetIn) {
  const cep = cleanCep(cepIn), number = cleanNumber(numberIn);
  const [store, addr] = await Promise.all([storeLocation(), lookupCep(cep)]);
  const street = addr.street || cleanStreet(streetIn);
  if (!street) throw uerr('Esse CEP não tem rua cadastrada. Informe a rua para calcular.', 422);
  const tail = [addr.bairro, addr.city, addr.uf, 'Brasil'].filter(Boolean).join(', ');
  let loc = null;
  try {
    loc = await geocode(`${street}, ${number}, ${tail}`);
    if (!loc) loc = await geocode(`${street}, ${tail}`); // sem número exato: usa a rua
  } catch { throw uerr('Não foi possível calcular a entrega agora. Tente novamente.', 503); }
  if (!loc) throw uerr('Não encontramos esse endereço. Confira o CEP e o número.');
  const factor = Math.max(1, Math.min(3, Number(env('DELIVERY_ROUTE_FACTOR', '1')) || 1));
  const km = round(haversineKm(store, loc) * factor, 1);
  const max = Number(env('DELIVERY_MAX_KM')) || 0;
  if (max && km > max) throw uerr('Esse endereço está fora da nossa área de entrega.');
  const fee = feeFor(km);
  const exp = Date.now() + QUOTE_TTL_MS;
  return { fee, km, address: { street: addr.street, bairro: addr.bairro, city: addr.city, uf: addr.uf }, token: makeToken(cep, number, fee, km, exp) };
}

/* ---------- token assinado: o servidor confirma a taxa sem confiar no cliente ---------- */
const norm = n => String(n).toLowerCase().replace(/\s+/g, '');
const mac = body => crypto.createHmac('sha256', 'delivery-quote:' + sign()).update(body).digest('base64url');
function makeToken(cep, number, fee, km, exp) {
  const body = [cep, norm(number), Math.round(fee * 100), km, exp].join('|');
  return Buffer.from(body).toString('base64url') + '.' + mac(body);
}
function verifyToken(token, cepIn, numberIn) {
  const bad = () => uerr('Taxa de entrega inválida ou expirada. Recalcule o frete.', 409);
  if (typeof token !== 'string' || !sign()) throw bad();
  const [b64, m] = token.split('.'); if (!b64 || !m) throw bad();
  const body = Buffer.from(b64, 'base64url').toString();
  const a = Buffer.from(mac(body)), b = Buffer.from(m);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw bad();
  const [cep, number, cents, km, exp] = body.split('|');
  if (Number(exp) < Date.now()) throw bad();
  if (cep !== String(cepIn || '').replace(/\D/g, '') || number !== norm(numberIn || '')) throw bad();
  return { fee: Number(cents) / 100, km: Number(km) };
}

module.exports = { enabled, quote, verifyToken, feeFor, haversineKm, PRICE_PER_KM, MIN_FEE };
