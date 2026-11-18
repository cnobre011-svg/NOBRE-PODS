'use strict';
// Notificações de novos pedidos para o administrador.
// - O banco (trigger em orders) registra cada pedido finalizado em order_notifications (UNIQUE por pedido = sem duplicatas).
// - dispatch() "reivindica" cada notificação de forma atômica (pending → sending) e envia o push para os aparelhos do admin.
const push = require('./webpush');

const MAX_ATTEMPTS = 5, STALE_MS = 120000, MAX_AGE_MS = 24 * 3600000;
const brl = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);
const hora = iso => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)).replace(',', ' às');
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Conteúdo da notificação (vai criptografado de ponta a ponta até o aparelho do admin)
function payloadFor(order) {
  const d = order.data || {}, items = Array.isArray(d.items) ? d.items : [];
  const nome = (d.customer && d.customer.name) || 'Cliente';
  const prod = items.slice(0, 3).map(x => cut(String(x), 60)).join(', ') + (items.length > 3 ? ` +${items.length - 3}` : '');
  return {
    title: `Novo pedido #${order.num}`,
    body: cut(`${nome} · ${prod || 'sem itens'}\nTotal ${brl(d.total)} · ${hora(order.created)}`, 380),
    num: Number(order.num), tag: 'pedido-' + order.num, ts: new Date(order.created).getTime() || Date.now(),
  };
}

module.exports = q => {
  const ensure = num => q.ignore('order_notifications', { order_num: Number(num), push_status: 'pending' }, 'order_num');

  async function sendOne(num) {
    const cur = await q.one('order_notifications', `?order_num=eq.${num}&push_status=eq.pending&select=attempts`);
    if (!cur) return;
    // Reivindicação atômica: só UM processo consegue mudar pending → sending (evita envio duplicado)
    const won = await q.patchRet('order_notifications', `?order_num=eq.${num}&push_status=eq.pending&attempts=eq.${cur.attempts}`, { push_status: 'sending', claimed_at: Date.now(), attempts: cur.attempts + 1 });
    if (!won || !won.length) return;
    const fin = p => q.patch('order_notifications', `?order_num=eq.${num}`, p);
    try {
      const order = await q.one('orders', `?num=eq.${num}&status=eq.sent&select=num,created,data`);
      if (!order) return await fin({ push_status: 'skipped', last_error: 'pedido não encontrado' });
      const subs = await q.get('push_subscriptions', '?select=id,endpoint,p256dh,auth');
      if (!subs.length) return await fin({ push_status: 'no_device', last_error: 'nenhum aparelho ativado' });
      const pl = payloadFor(order);
      const rs = await Promise.all(subs.map(s => push.send(s, pl).catch(e => ({ ok: false, error: String(e.message || e) }))));
      await Promise.all(rs.map((r, i) => r.gone ? q.del('push_subscriptions', `?id=eq.${subs[i].id}`).catch(() => {}) : null));
      const ok = rs.filter(r => r.ok).length;
      if (ok) return await fin({ push_status: 'sent', sent_at: new Date().toISOString(), devices: ok, last_error: '' });
      const err = (rs.find(r => r.error) || {}).error || 'falha no envio';
      const left = rs.some(r => !r.gone); // se todas as inscrições expiraram, não adianta repetir
      return await fin({ push_status: left && cur.attempts + 1 < MAX_ATTEMPTS ? 'pending' : 'failed', last_error: String(err).slice(0, 200) });
    } catch (e) {
      await fin({ push_status: cur.attempts + 1 < MAX_ATTEMPTS ? 'pending' : 'failed', last_error: String(e.message || e).slice(0, 200) }).catch(() => {});
    }
  }

  // Envia tudo que está pendente (inclusive repetições de falhas temporárias). Seguro para chamar a qualquer momento.
  async function dispatch() {
    if (!push.configured()) return;
    await q.patch('order_notifications', `?push_status=eq.sending&claimed_at=lt.${Date.now() - STALE_MS}`, { push_status: 'pending' }).catch(() => {});
    const since = new Date(Date.now() - MAX_AGE_MS).toISOString();
    const todo = await q.get('order_notifications', `?push_status=eq.pending&attempts=lt.${MAX_ATTEMPTS}&created_at=gt.${since}&order=order_num.asc&limit=10&select=order_num`);
    for (const t of todo) await sendOne(t.order_num);
  }

  async function history(limit = 100) {
    const ns = await q.get('order_notifications', `?order=order_num.desc&limit=${limit}&select=order_num,created_at,push_status,attempts,sent_at,devices,last_error`);
    if (!ns.length) return [];
    const os = await q.get('orders', `?num=in.(${ns.map(n => n.order_num).join(',')})&select=num,created,data`);
    const by = Object.fromEntries(os.map(o => [o.num, o]));
    return ns.map(n => { const o = by[n.order_num] || { data: {} }, d = o.data || {};
      return { num: n.order_num, at: o.created || n.created_at, status: n.push_status, attempts: n.attempts, sentAt: n.sent_at, devices: n.devices, error: n.last_error,
        customer: (d.customer && d.customer.name) || '', items: d.items || [], total: d.total != null ? d.total : null }; });
  }

  async function saveSub(adminId, sub, ua) {
    const ep = sub && sub.endpoint, k = (sub && sub.keys) || {};
    if (typeof ep !== 'string' || !push.allowedEndpoint(ep)) return false;
    if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string') return false;
    try { push.encrypt('x', k.p256dh, k.auth); } catch { return false; } // valida o formato das chaves
    const mine = await q.get('push_subscriptions', `?admin_id=eq.${adminId}&select=id,endpoint`);
    if (mine.length >= 10 && !mine.some(m => m.endpoint === ep)) return 'limit';
    await q.upsert('push_subscriptions', { admin_id: adminId, endpoint: ep, p256dh: k.p256dh, auth: k.auth, ua: String(ua || '').slice(0, 200) }, 'endpoint');
    return true;
  }

  async function sendTest(adminId) {
    const subs = await q.get('push_subscriptions', `?admin_id=eq.${adminId}&select=id,endpoint,p256dh,auth`);
    const pl = { title: 'Notificações ativas ✅', body: 'Você receberá aqui os novos pedidos da loja.', num: 0, tag: 'teste', ts: Date.now() };
    const rs = await Promise.all(subs.map(s => push.send(s, pl)));
    await Promise.all(rs.map((r, i) => r.gone ? q.del('push_subscriptions', `?id=eq.${subs[i].id}`).catch(() => {}) : null));
    return { devices: subs.length, delivered: rs.filter(r => r.ok).length };
  }

  return { ensure, dispatch, history, saveSub, sendTest, payloadFor };
};
