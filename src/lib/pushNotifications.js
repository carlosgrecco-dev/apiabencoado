const webpush = require('web-push');
const prisma = require('./prisma');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT;

const configurado = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT);
if (configurado) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

/**
 * Manda uma notificação push pra todo mundo inscrito no acompanhamento de um pedido (o cliente
 * pode ter feito isso em mais de um navegador/aba). Assinaturas que o navegador já descartou
 * (410/404) são removidas do banco — não vale a pena tentar de novo.
 * @param {string} pedidoId
 * @param {{ title: string, body: string, url?: string }} payload
 */
const notificarPedido = async (pedidoId, payload) => {
  if (!configurado) return;

  const inscricoes = await prisma.pushSubscription.findMany({ where: { pedidoId } });
  if (inscricoes.length === 0) return;

  await Promise.all(
    inscricoes.map(async (inscricao) => {
      const subscription = {
        endpoint: inscricao.endpoint,
        keys: { p256dh: inscricao.p256dh, auth: inscricao.auth },
      };
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload));
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          await prisma.pushSubscription.delete({ where: { id: inscricao.id } }).catch(() => {});
        }
      }
    })
  );
};

module.exports = { notificarPedido, VAPID_PUBLIC_KEY, configurado };
