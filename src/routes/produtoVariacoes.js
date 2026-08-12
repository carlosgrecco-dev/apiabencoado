const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);

/** Garante que o produto pertence à empresa da rota antes de qualquer operação em suas variações. */
const loadProduto = asyncHandler(async (req, res, next) => {
  const produto = await prisma.produto.findFirst({
    where: { id: req.params.produtoId, empresaId: req.params.empresaId },
  });
  if (!produto) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }
  req.produto = produto;
  next();
});

router.use(loadProduto);

/**
 * @openapi
 * /empresas/{empresaId}/produtos/{produtoId}/variacoes:
 *   get:
 *     summary: Lista as variações (sabores) de um produto, com estoque próprio
 *     tags: [ProdutoVariacoes]
 *     responses:
 *       200:
 *         description: Lista de variações
 */
router.get('/', asyncHandler(async (req, res) => {
  const variacoes = await prisma.produtoVariacao.findMany({
    where: { produtoId: req.params.produtoId },
    orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
  });
  res.json(variacoes);
}));

/**
 * @openapi
 * /empresas/{empresaId}/produtos/{produtoId}/variacoes:
 *   post:
 *     summary: Cadastra uma variação (sabor) para o produto
 *     tags: [ProdutoVariacoes]
 *     responses:
 *       201:
 *         description: Variação criada
 *       400:
 *         description: Dados inválidos
 */
router.post('/', asyncHandler(async (req, res) => {
  const { nome, estoqueQtd, ativo, ordem } = req.body;
  if (!nome) {
    return res.status(400).json({ error: 'Campo "nome" é obrigatório' });
  }

  const variacao = await prisma.produtoVariacao.create({
    data: {
      produtoId: req.params.produtoId,
      nome,
      estoqueQtd: estoqueQtd === undefined || estoqueQtd === '' ? null : Number(estoqueQtd),
      ...(ativo !== undefined ? { ativo } : {}),
      ...(ordem !== undefined ? { ordem } : {}),
    },
  });

  res.status(201).json(variacao);
}));

/**
 * @openapi
 * /empresas/{empresaId}/produtos/{produtoId}/variacoes/{id}:
 *   put:
 *     summary: Atualiza uma variação (nome, estoque, status)
 *     tags: [ProdutoVariacoes]
 *     responses:
 *       200:
 *         description: Variação atualizada
 *       404:
 *         description: Variação não encontrada
 */
router.put('/:id', asyncHandler(async (req, res) => {
  const { nome, estoqueQtd, ativo, ordem } = req.body;
  if (!nome) {
    return res.status(400).json({ error: 'Campo "nome" é obrigatório' });
  }

  const existente = await prisma.produtoVariacao.findFirst({
    where: { id: req.params.id, produtoId: req.params.produtoId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Variação não encontrada' });
  }

  const variacao = await prisma.produtoVariacao.update({
    where: { id: req.params.id },
    data: {
      nome,
      estoqueQtd: estoqueQtd === undefined || estoqueQtd === '' ? null : Number(estoqueQtd),
      ...(ativo !== undefined ? { ativo } : {}),
      ...(ordem !== undefined ? { ordem } : {}),
    },
  });

  res.json(variacao);
}));

/**
 * @openapi
 * /empresas/{empresaId}/produtos/{produtoId}/variacoes/{id}:
 *   delete:
 *     summary: Remove uma variação
 *     tags: [ProdutoVariacoes]
 *     responses:
 *       204:
 *         description: Variação removida
 *       404:
 *         description: Variação não encontrada
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const existente = await prisma.produtoVariacao.findFirst({
    where: { id: req.params.id, produtoId: req.params.produtoId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Variação não encontrada' });
  }

  await prisma.produtoVariacao.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

module.exports = router;
