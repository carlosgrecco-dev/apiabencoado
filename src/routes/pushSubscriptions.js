const { Router } = require('express');
const prisma = require('../lib/prisma');
const { VAPID_PUBLIC_KEY, configurado } = require('../lib/pushNotifications');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * @openapi
 * /empresas/{empresaId}/push/vapid-public-key:
 *   get:
 *     summary: Chave pública VAPID — o front usa pra registrar a inscrição de push no navegador
 *     tags: [Push]
 *     responses:
 *       200:
 *         description: Chave pública (ou null se a plataforma não tem push configurado)
 */
router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: configurado ? VAPID_PUBLIC_KEY : null });
});

/**
 * @openapi
 * /empresas/{empresaId}/push/pedidos/{pedidoId}/inscrever:
 *   post:
 *     summary: Inscreve este navegador pra receber push quando o status deste pedido mudar
 *     tags: [Push]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: pedidoId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [endpoint, keys]
 *             properties:
 *               endpoint: { type: string }
 *               keys:
 *                 type: object
 *                 properties:
 *                   p256dh: { type: string }
 *                   auth: { type: string }
 *     responses:
 *       201:
 *         description: Inscrição registrada
 *       404:
 *         description: Pedido não encontrado
 */
router.post('/pedidos/:pedidoId/inscrever', asyncHandler(async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Campos "endpoint" e "keys" (p256dh, auth) são obrigatórios' });
  }

  const pedido = await prisma.pedido.findFirst({
    where: { id: req.params.pedidoId, empresaId: req.params.empresaId },
  });
  if (!pedido) {
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }

  await prisma.pushSubscription.upsert({
    where: { endpoint },
    update: { pedidoId: pedido.id, p256dh: keys.p256dh, auth: keys.auth },
    create: { pedidoId: pedido.id, endpoint, p256dh: keys.p256dh, auth: keys.auth },
  });

  res.status(201).json({ ok: true });
}));

module.exports = router;
