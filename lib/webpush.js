'use strict';
// Web Push (VAPID + criptografia aes128gcm, RFC 8030 / 8188 / 8291 / 8292) sem dependências npm.
// Funciona com Chrome/Android (FCM por baixo), Firefox, Edge e Safari/iOS 16.4+ (PWA instalado).
// A chave PRIVADA (VAPID_PRIVATE_KEY) só existe no servidor.
const crypto = require('crypto');

const b64u = b => Buffer.from(b).toString('base64url');
const fromB64u = s => Buffer.from(String(s), 'base64url');

// Chaves: variáveis de ambiente (se definidas) OU par gerado automaticamente pelo servidor e guardado no banco (tabela push_keys).
let stored = null, autoSubject = '';
const envPair = () => { const a = (process.env.VAPID_PUBLIC_KEY || '').trim(), b = (process.env.VAPID_PRIVATE_KEY || '').trim(); return a && b ? { publicKey: a, privateKey: b } : null; };
const pubKey = () => (envPair() || stored || {}).publicKey || '';
const privKey = () => (envPair() || stored || {}).privateKey || '';
const subject = () => (process.env.VAPID_SUBJECT || '').trim() || autoSubject || 'mailto:admin@example.com';
const setStored = k => { stored = k && k.publicKey && k.privateKey ? { publicKey: k.publicKey, privateKey: k.privateKey } : null; };
const setSubject = s => { autoSubject = s; };
const configured = () => { try { return fromB64u(pubKey()).length === 65 && fromB64u(privKey()).length === 32; } catch { return false; } };

// Gera um par de chaves VAPID (usado por scripts/generate-vapid-keys.js)
function generateKeys() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = privateKey.export({ format: 'jwk' });
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(j.x), fromB64u(j.y)])), privateKey: j.d };
}

function vapidKeyObject() {
  const pub = fromB64u(pubKey());
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: privKey() }, format: 'jwk' });
}

// Cabeçalho Authorization (VAPID) para o servidor de push do endpoint
function vapidHeader(endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject() }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: vapidKeyObject(), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${pubKey()}`;
}

// Criptografa o conteúdo para a inscrição do aparelho (RFC 8291, aes128gcm, registro único)
function encrypt(payload, p256dh, auth, fixed) { // `fixed` ({ ecdh, salt }) só existe para testar com o vetor oficial da RFC 8291
  const uaPub = fromB64u(p256dh), authSecret = fromB64u(auth);
  if (uaPub.length !== 65 || uaPub[0] !== 4 || authSecret.length !== 16) throw new Error('Inscrição inválida.');
  const ecdh = (fixed && fixed.ecdh) || crypto.createECDH('prime256v1'); if (!fixed) ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPub);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32));
  const salt = (fixed && fixed.salt) || crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const data = Buffer.from(payload);
  if (data.length > 3800) throw new Error('Conteúdo grande demais para push.');
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const enc = Buffer.concat([cipher.update(Buffer.concat([data, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, enc]);
}

// Só enviamos para servidores de push conhecidos (evita usar o servidor como "proxy" para URLs arbitrárias)
const HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
function allowedEndpoint(endpoint) {
  let u; try { u = new URL(endpoint); } catch { return false; }
  if (String(endpoint).length > 700 || u.username || u.password) return false;
  const extra = (process.env.PUSH_TEST_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean); // só para testes automatizados
  if (extra.includes(u.host)) return true;
  return u.protocol === 'https:' && HOSTS.some(r => r.test(u.hostname));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Envia uma notificação. Retorna { ok, status, gone } — gone = inscrição expirada (deve ser apagada).
async function send(sub, payloadObj, opts = {}) {
  if (!configured()) return { ok: false, status: 0, error: 'VAPID não configurado' };
  if (!allowedEndpoint(sub.endpoint)) return { ok: false, status: 0, gone: true, error: 'endpoint não permitido' };
  const body = encrypt(JSON.stringify(payloadObj), sub.p256dh, sub.auth);
  let last = { ok: false, status: 0, error: 'falha' };
  for (let i = 0; i < 2; i++) { // uma nova tentativa para falhas temporárias
    try {
      const r = await fetch(sub.endpoint, { method: 'POST', body, signal: AbortSignal.timeout(opts.timeoutMs || 4000),
        headers: { Authorization: vapidHeader(sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(opts.ttl || 86400), Urgency: 'high' } });
      if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status };
      last = { ok: false, status: r.status, gone: r.status === 404 || r.status === 410, error: 'HTTP ' + r.status };
      if (r.status < 500 && r.status !== 429) return last;
    } catch (e) { last = { ok: false, status: 0, error: String(e.message || e).slice(0, 100) }; }
    if (i === 0) await sleep(400);
  }
  return last;
}

module.exports = { setStored, setSubject, configured, generateKeys, send, encrypt, vapidHeader, allowedEndpoint, publicKey: pubKey };
