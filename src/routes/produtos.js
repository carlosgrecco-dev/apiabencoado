const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);

const handlePrismaError = (error, res) => {
  if (error.code === 'P2025') {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }
  throw error;
};

const validarPayload = ({ nome, preco, precoPromocional }) => {
  const erros = [];

  if (!nome) erros.push('Campo "nome" é obrigatório');
  if (preco === undefined || Number.isNaN(Number(preco)) || Number(preco) <= 0) {
    erros.push('Campo "preco" é obrigatório e deve ser maior que zero');
  }
  if (precoPromocional !== undefined && precoPromocional !== null && precoPromocional !== '') {
    if (Number.isNaN(Number(precoPromocional)) || Number(precoPromocional) <= 0) {
      erros.push('Campo "precoPromocional" deve ser maior que zero');
    } else if (preco !== undefined && Number(precoPromocional) >= Number(preco)) {
      erros.push('O preço promocional deve ser menor que o preço normal');
    }
  }

  return erros;
};

/** Disponibilidade real do produto para o cliente: ativo, não marcado esgotado hoje, e com estoque (se controlado). */
const comDisponibilidade = (produto) => ({
  ...produto,
  disponivel: produto.ativo && !produto.esgotadoHoje && (!produto.controlarEstoque || (produto.estoqueQtd ?? 0) > 0),
});

/**
 * @openapi
 * components:
 *   schemas:
 *     Produto:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid, readOnly: true }
 *         empresaId: { type: string, format: uuid }
 *         nome: { type: string }
 *         descricao: { type: string, nullable: true }
 *         categoria: { type: string, nullable: true }
 *         preco: { type: number }
 *         precoPromocional: { type: number, nullable: true }
 *         fotoUrl: { type: string, nullable: true }
 *         ativo: { type: boolean }
 *         ordem: { type: integer }
 *     ProdutoInput:
 *       type: object
 *       required: [nome, preco]
 *       properties:
 *         nome: { type: string }
 *         descricao: { type: string }
 *         categoria: { type: string }
 *         preco: { type: number }
 *         precoPromocional: { type: number }
 *         fotoUrl: { type: string }
 *         ativo: { type: boolean }
 *         ordem: { type: integer }
 */

/**
 * @openapi
 * /empresas/{empresaId}/produtos:
 *   get:
 *     summary: Lista os produtos de uma empresa
 *     tags: [Produtos]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: ativo
 *         schema: { type: boolean }
 *       - in: query
 *         name: categoria
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Lista de produtos
 */
router.get('/', asyncHandler(async (req, res) => {
  const { ativo, categoria } = req.query;
  const where = {
    empresaId: req.params.empresaId,
    ...(ativo !== undefined ? { ativo: ativo === 'true' } : {}),
    ...(categoria ? { categoria } : {}),
  };

  const produtos = await prisma.produto.findMany({
    where,
    orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
  });

  res.json(produtos.map(comDisponibilidade));
}));

/**
 * @openapi
 * /empresas/{empresaId}/produtos/{id}:
 *   get:
 *     summary: Busca um produto pelo id
 *     tags: [Produtos]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Produto encontrado
 *       404:
 *         description: Produto não encontrado
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const produto = await prisma.produto.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });

  if (!produto) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }

  res.json(comDisponibilidade(produto));
}));

/**
 * @openapi
 * /empresas/{empresaId}/produtos:
 *   post:
 *     summary: Cadastra um novo produto
 *     tags: [Produtos]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ProdutoInput'
 *     responses:
 *       201:
 *         description: Produto criado
 *       400:
 *         description: Dados inválidos
 */
router.post('/', asyncHandler(async (req, res) => {
  const {
    nome, descricao, categoria, preco, precoPromocional, fotoUrl, ativo, ordem,
    controlarEstoque, estoqueQtd,
  } = req.body;

  const erros = validarPayload(req.body);
  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }

  const produto = await prisma.produto.create({
    data: {
      empresaId: req.params.empresaId,
      nome,
      descricao: descricao || null,
      categoria: categoria || null,
      preco,
      precoPromocional: precoPromocional || null,
      fotoUrl: fotoUrl || null,
      ...(ativo !== undefined ? { ativo } : {}),
      ...(ordem !== undefined ? { ordem } : {}),
      ...(controlarEstoque !== undefined ? { controlarEstoque } : {}),
      ...(estoqueQtd !== undefined ? { estoqueQtd: estoqueQtd === null || estoqueQtd === '' ? null : Number(estoqueQtd) } : {}),
    },
  });

  res.status(201).json(comDisponibilidade(produto));
}));

/**
 * @openapi
 * /empresas/{empresaId}/produtos/{id}:
 *   put:
 *     summary: Atualiza um produto
 *     tags: [Produtos]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ProdutoInput'
 *     responses:
 *       200:
 *         description: Produto atualizado
 *       404:
 *         description: Produto não encontrado
 */
router.put('/:id', asyncHandler(async (req, res) => {
  const {
    nome, descricao, categoria, preco, precoPromocional, fotoUrl, ativo, ordem,
    controlarEstoque, estoqueQtd,
  } = req.body;

  const erros = validarPayload(req.body);
  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }

  const existente = await prisma.produto.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }

  try {
    const produto = await prisma.produto.update({
      where: { id: req.params.id },
      data: {
        nome,
        descricao: descricao || null,
        categoria: categoria || null,
        preco,
        precoPromocional: precoPromocional || null,
        fotoUrl: fotoUrl || null,
        ...(ativo !== undefined ? { ativo } : {}),
        ...(ordem !== undefined ? { ordem } : {}),
        ...(controlarEstoque !== undefined ? { controlarEstoque } : {}),
        ...(estoqueQtd !== undefined ? { estoqueQtd: estoqueQtd === null || estoqueQtd === '' ? null : Number(estoqueQtd) } : {}),
      },
    });

    res.json(comDisponibilidade(produto));
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{empresaId}/produtos/{id}/status:
 *   patch:
 *     summary: Ativa ou inativa um produto
 *     tags: [Produtos]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ativo]
 *             properties:
 *               ativo: { type: boolean }
 *     responses:
 *       200:
 *         description: Status atualizado
 *       404:
 *         description: Produto não encontrado
 */
router.patch('/:id/status', asyncHandler(async (req, res) => {
  const { ativo } = req.body;
  if (typeof ativo !== 'boolean') {
    return res.status(400).json({ error: 'Campo "ativo" é obrigatório e deve ser booleano' });
  }

  const existente = await prisma.produto.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }

  const produto = await prisma.produto.update({
    where: { id: req.params.id },
    data: { ativo },
  });

  res.json(comDisponibilidade(produto));
}));

/**
 * @openapi
 * /empresas/{empresaId}/produtos/{id}/esgotado:
 *   patch:
 *     summary: Pausa/retoma rapidamente um produto sem desativá-lo (ex. "Esgotado hoje")
 *     tags: [Produtos]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [esgotadoHoje]
 *             properties:
 *               esgotadoHoje: { type: boolean }
 *     responses:
 *       200:
 *         description: Status atualizado
 *       404:
 *         description: Produto não encontrado
 */
router.patch('/:id/esgotado', asyncHandler(async (req, res) => {
  const { esgotadoHoje } = req.body;
  if (typeof esgotadoHoje !== 'boolean') {
    return res.status(400).json({ error: 'Campo "esgotadoHoje" é obrigatório e deve ser booleano' });
  }

  const existente = await prisma.produto.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }

  const produto = await prisma.produto.update({
    where: { id: req.params.id },
    data: { esgotadoHoje },
  });

  res.json(comDisponibilidade(produto));
}));

/**
 * @openapi
 * /empresas/{empresaId}/produtos/{id}:
 *   delete:
 *     summary: Remove um produto
 *     tags: [Produtos]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204:
 *         description: Produto removido
 *       404:
 *         description: Produto não encontrado
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const existente = await prisma.produto.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }

  await prisma.produto.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

module.exports = router;
