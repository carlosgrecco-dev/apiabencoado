const prisma = require('./prisma');

/**
 * Grava uma notificação no feed in-app do cliente (sininho) — complementa o push, funciona mesmo
 * sem permissão de notificação concedida no navegador. Fire-and-forget: nunca deve derrubar o
 * fluxo que a chamou (mesmo espírito do notificarPedido em lib/pushNotifications.js).
 * @param {string} clienteId
 * @param {{ titulo: string, corpo: string, url?: string }} payload
 */
const criarNotificacaoCliente = async (clienteId, { titulo, corpo, url }) => {
  if (!clienteId) return;
  await prisma.notificacaoCliente.create({
    data: { clienteId, titulo, corpo, url: url || null },
  });
};

module.exports = { criarNotificacaoCliente };
