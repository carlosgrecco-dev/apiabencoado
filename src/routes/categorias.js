const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { requireEmpresaAdmin , requireGrupo } = require('../lib/auth');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);

/**
 * @openapi
 * /empresas/{empresaId}/categorias:
 *   get:
 *     summary: Lista as categorias de produtos de uma empresa
 *     tags: [Categorias]
 *     responses:
 *       200:
 *         description: Lista de categorias
 */
router.get('/', asyncHandler(async (req, res) => {
  const categorias = await prisma.categoria.findMany({
    where: { empresaId: req.params.empresaId },
    orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
  });
  res.json(categorias);
}));

/**
 * @openapi
 * /empresas/{empresaId}/categorias:
 *   post:
 *     summary: Cadastra uma categoria de produtos
 *     tags: [Categorias]
 *     responses:
 *       201:
 *         description: Categoria criada
 *       400:
 *         description: Dados inválidos
 */
router.post('/', requireEmpresaAdmin(), requireGrupo('vendas'), asyncHandler(async (req, res) => {
  const { nome, ordem, ativo } = req.body;
  if (!nome) {
    return res.status(400).json({ error: 'Campo "nome" é obrigatório' });
  }

  const categoria = await prisma.categoria.create({
    data: {
      empresaId: req.params.empresaId,
      nome,
      ...(ordem !== undefined ? { ordem } : {}),
      ...(ativo !== undefined ? { ativo } : {}),
    },
  });

  res.status(201).json(categoria);
}));

/**
 * @openapi
 * /empresas/{empresaId}/categorias/{id}:
 *   put:
 *     summary: Atualiza uma categoria (nome, ordem, status)
 *     tags: [Categorias]
 *     responses:
 *       200:
 *         description: Categoria atualizada
 *       404:
 *         description: Categoria não encontrada
 */
router.put('/:id', requireEmpresaAdmin(), requireGrupo('vendas'), asyncHandler(async (req, res) => {
  const { nome, ordem, ativo } = req.body;
  if (!nome) {
    return res.status(400).json({ error: 'Campo "nome" é obrigatório' });
  }

  const existente = await prisma.categoria.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Categoria não encontrada' });
  }

  const categoria = await prisma.categoria.update({
    where: { id: req.params.id },
    data: {
      nome,
      ...(ordem !== undefined ? { ordem } : {}),
      ...(ativo !== undefined ? { ativo } : {}),
    },
  });

  res.json(categoria);
}));

/**
 * @openapi
 * /empresas/{empresaId}/categorias/{id}:
 *   delete:
 *     summary: Remove uma categoria (produtos vinculados ficam sem categoria)
 *     tags: [Categorias]
 *     responses:
 *       204:
 *         description: Categoria removida
 *       404:
 *         description: Categoria não encontrada
 */
router.delete('/:id', requireEmpresaAdmin(), requireGrupo('vendas'), asyncHandler(async (req, res) => {
  const existente = await prisma.categoria.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Categoria não encontrada' });
  }

  await prisma.categoria.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

module.exports = router;
