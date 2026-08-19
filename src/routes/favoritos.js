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

// Favoritos são sempre do próprio cliente — nenhum caso de uso de admin aqui.
router.use(requireCliente('clienteId'));
router.use(loadCliente);

/**
 * @openapi
 * /empresas/{empresaId}/clientes/{clienteId}/favoritos:
 *   get:
 *     summary: Lista os produtos favoritados pelo cliente
 *     tags: [Favoritos]
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
 *         description: Lista de favoritos, com os dados do produto
 */
router.get('/', asyncHandler(async (req, res) => {
  const favoritos = await prisma.favorito.findMany({
    where: { clienteId: req.params.clienteId },
    include: { produto: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(favoritos);
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes/{clienteId}/favoritos:
 *   post:
 *     summary: Favorita um produto
 *     tags: [Favoritos]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: clienteId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [produtoId]
 *             properties:
 *               produtoId: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: Produto favoritado
 *       404:
 *         description: Produto não encontrado
 */
router.post('/', asyncHandler(async (req, res) => {
  const { produtoId } = req.body;
  if (!produtoId) {
    return res.status(400).json({ error: 'Campo "produtoId" é obrigatório' });
  }

  const produto = await prisma.produto.findFirst({
    where: { id: produtoId, empresaId: req.params.empresaId },
  });
  if (!produto) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }

  const favorito = await prisma.favorito.upsert({
    where: { clienteId_produtoId: { clienteId: req.params.clienteId, produtoId } },
    update: {},
    create: { clienteId: req.params.clienteId, produtoId },
    include: { produto: true },
  });

  res.status(201).json(favorito);
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes/{clienteId}/favoritos/{produtoId}:
 *   delete:
 *     summary: Remove um produto dos favoritos
 *     tags: [Favoritos]
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
 *         name: produtoId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204:
 *         description: Favorito removido
 */
router.delete('/:produtoId', asyncHandler(async (req, res) => {
  await prisma.favorito.deleteMany({
    where: { clienteId: req.params.clienteId, produtoId: req.params.produtoId },
  });
  res.status(204).send();
}));

module.exports = router;
