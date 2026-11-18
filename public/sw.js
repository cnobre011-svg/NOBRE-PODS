/* Service worker do PAINEL ADMINISTRATIVO: recebe as notificações push de novos pedidos.
   Só é registrado depois que o administrador faz login e ativa as notificações. Não guarda cache nem dados. */
'use strict';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

const openUrl = num => (num > 0 ? '/admin?pedido=' + encodeURIComponent(num) : '/admin');

self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = {}; }
  const num = Number(d.num) || 0;
  const title = String(d.title || 'Novo pedido').slice(0, 120);
  const opts = {
    body: String(d.body || 'Toque para ver os detalhes.').slice(0, 400),
    tag: String(d.tag || (num ? 'pedido-' + num : 'loja')), // mesmo pedido = mesma notificação (nunca duplica na tela)
    icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', lang: 'pt-BR',
    timestamp: Number(d.ts) || Date.now(), requireInteraction: true, data: { num },
  };
  event.waitUntil((async () => {
    await self.registration.showNotification(title, opts); // sempre exibe (exigência do iOS/Chrome)
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    cs.forEach(c => c.postMessage({ type: 'push-received', num })); // painel aberto atualiza a lista na hora
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const num = Number((event.notification.data || {}).num) || 0;
  event.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const adm = cs.find(c => { try { return new URL(c.url).pathname.startsWith('/admin'); } catch (e) { return false; } });
    if (adm) { await adm.focus(); adm.postMessage({ type: 'open-order', num }); return; }
    await self.clients.openWindow(openUrl(num)); // abre o painel direto nos detalhes do pedido
  })());
});

// Se o navegador renovar a inscrição, tenta registrar a nova (usa a sessão do painel, se ainda válida).
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      const old = event.oldSubscription, key = old && old.options && old.options.applicationServerKey;
      const sub = event.newSubscription || (key ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) : null);
      if (sub) await fetch('/api/admin/push/subscribe', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ subscription: sub.toJSON() }) });
    } catch (e) { /* o painel re-sincroniza no próximo acesso */ }
  })());
});
