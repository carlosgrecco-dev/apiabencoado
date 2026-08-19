const { Router } = require('express');
const prisma = require('../lib/prisma');
const { requireCliente } = require('../lib/auth');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/** Garante que o cliente existe e pertence à empresa da rota. */
const loadCliente = asyncHandler(async (req, res, next) => {
  const cliente = await prisma.cliente.findFirst({
    where: { id: req.params.clienteId, empresaId: req.params.empresaId },
  });
  if (!cliente) {
    return res.status(404).json({ error: 'Cliente não encontrado' });
  }
  req.cliente = cliente;
  next();
});

// Notificações são sempre do próprio cliente — nenhum caso de uso de admin aqui.
router.use(requireCliente('clienteId'));
router.use(loadCliente);

/**
 * @openapi
 * /empresas/{empresaId}/clientes/{clienteId}/notificacoes:
 *   get:
 *     summary: Lista as notificações in-app do cliente (mais recentes primeiro)
 *     tags: [Notificacoes]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: clienteId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Lista de notificações
 */
router.get('/', asyncHandler(async (req, res) => {
  const notificacoes = await prisma.notificacaoCliente.findMany({
    where: { clienteId: req.params.clienteId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.json(notificacoes);
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes/{clienteId}/notificacoes/{id}/lida:
 *   patch:
 *     summary: Marca uma notificação como lida
 *     tags: [Notificacoes]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: clienteId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Notificação atualizada
 *       404:
 *         description: Notificação não encontrada
 */
router.patch('/:id/lida', asyncHandler(async (req, res) => {
  const existente = await prisma.notificacaoCliente.findFirst({
    where: { id: req.params.id, clienteId: req.params.clienteId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Notificação não encontrada' });
  }
  const atualizada = await prisma.notificacaoCliente.update({ where: { id: req.params.id }, data: { lida: true } });
  res.json(atualizada);
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes/{clienteId}/notificacoes/marcar-todas-lidas:
 *   patch:
 *     summary: Marca todas as notificações do cliente como lidas
 *     tags: [Notificacoes]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: clienteId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204:
 *         description: Notificações marcadas como lidas
 */
router.patch('/marcar-todas-lidas', asyncHandler(async (req, res) => {
  await prisma.notificacaoCliente.updateMany({
    where: { clienteId: req.params.clienteId, lida: false },
    data: { lida: true },
  });
  res.status(204).send();
}));

module.exports = router;
