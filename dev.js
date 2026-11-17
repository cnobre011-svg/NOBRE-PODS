'use strict';
// Servidor local para desenvolvimento/testes: serve public/ e a mesma API usada na Vercel.
const http = require('http'), fs = require('fs'), path = require('path');
const { handle, resetAdmin, SEC } = require('./lib/handler');
if (process.argv.includes('--reset-admin')) {
  resetAdmin(process.env.ADMIN_USER || 'Cnobre', process.env.ADMIN_PASSWORD).then(() => { console.log('Senha redefinida e 2FA desativado.'); process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); });
} else {
  const PUB = path.join(__dirname, 'public'), MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.startsWith('/api/')) return handle(req, res);
    const rel = (p === '/' || p === '/admin' || p === '/admin/login') ? 'index.html' : p.replace(/^\/+/, ''); const f = path.normalize(path.join(PUB, rel));
    if (!f.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end('Proibido.'); }
    fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end('Não encontrado.'); } res.writeHead(200, { ...SEC, 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(d); });
  }).listen(+process.env.PORT || 3000, () => console.log('Loja Adega (dev) em http://localhost:' + (process.env.PORT || 3000)));
}
