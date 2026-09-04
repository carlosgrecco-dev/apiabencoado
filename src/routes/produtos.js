const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { requireEmpresaAdmin , requireGrupo } = require('../lib/auth');
const { registrarAtividadeLoja } = require('../lib/atividadeLoja');

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

/** Visão pública dos grupos de opção: só grupos com ao menos 1 opção ativa, só opções ativas. */
const comGruposOpcaoPublicos = (produto) => {
  if (!produto.gruposOpcao) return produto;
  return {
    ...produto,
    gruposOpcao: produto.gruposOpcao
      .map((grupo) => ({ ...grupo, opcoes: grupo.opcoes.filter((o) => o.ativo) }))
      .filter((grupo) => grupo.opcoes.length > 0),
  };
};

const INCLUDE_GRUPOS_OPCAO = {
  categoria: true,
  gruposOpcao: {
    orderBy: [{ ordem: 'asc' }, { createdAt: 'asc' }],
    include: { opcoes: { orderBy: [{ ordem: 'asc' }, { nome: 'asc' }] } },
  },
};

/** Garante que categoriaId (se informado) existe e pertence à mesma empresa do produto. */
const validarCategoria = async (empresaId, categoriaId) => {
  if (!categoriaId) return null;
  const categoria = await prisma.categoria.findFirst({ where: { id: categoriaId, empresaId } });
  if (!categoria) return 'Categoria informada não encontrada';
  return null;
};

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
 *         categoriaId: { type: string, format: uuid, nullable: true }
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
 *         categoriaId: { type: string, format: uuid }
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
 *         name: categoriaId
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Lista de produtos
 */
router.get('/', asyncHandler(async (req, res) => {
  const { ativo, categoriaId } = req.query;
  const where = {
    empresaId: req.params.empresaId,
    ...(ativo !== undefined ? { ativo: ativo === 'true' } : {}),
    ...(categoriaId ? { categoriaId } : {}),
  };

  const produtos = await prisma.produto.findMany({
    where,
    include: INCLUDE_GRUPOS_OPCAO,
    orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
  });

  res.json(produtos.map(comDisponibilidade).map(comGruposOpcaoPublicos));
}));

/**
 * @openapi
 * /empresas/{empresaId}/produtos/admin-resumo:
 *   get:
 *     summary: Lista de produtos com vendas totais (lifetime) por produto + estatísticas do catálogo, pra tela de gestão do admin
 *     tags: [Produtos]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Produtos com vendasTotais + estatísticas agregadas
 */
router.get('/admin-resumo', requireEmpresaAdmin(), requireGrupo('vendas'), asyncHandler(async (req, res) => {
  const produtos = await prisma.produto.findMany({
    where: { empresaId: req.params.empresaId },
    include: { categoria: true },
    orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
  });

  const vendasRaw = await prisma.pedidoItem.groupBy({
    by: ['produtoId'],
    where: { produtoId: { not: null }, pedido: { empresaId: req.params.empresaId, status: 'ENTREGUE' } },
    _sum: { quantidade: true },
  });
  const vendasMap = new Map(vendasRaw.map((v) => [v.produtoId, v._sum.quantidade || 0]));

  const produtosComVendas = produtos.map((p) => ({ ...comDisponibilidade(p), vendasTotais: vendasMap.get(p.id) || 0 }));

  const ativos = produtos.filter((p) => p.ativo).length;
  const estoqueBaixo = produtos.filter(
    (p) => p.controlarEstoque && p.estoqueMinimo != null && (p.estoqueQtd ?? 0) <= p.estoqueMinimo
  ).length;
  const maisVendido = produtosComVendas.reduce((max, p) => (p.vendasTotais > (max?.vendasTotais ?? -1) ? p : max), null);

  res.json({
    produtos: produtosComVendas,
    stats: {
      total: produtos.length,
      ativos,
      inativos: produtos.length - ativos,
      estoqueBaixo,
      maisVendido: maisVendido && maisVendido.vendasTotais > 0 ? { id: maisVendido.id, nome: maisVendido.nome } : null,
    },
  });
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

/**
 * @openapi
 * /empresas/{empresaId}/produtos/opcoes-grupos-todos:
 *   get:
 *     summary: Lista todos os grupos de opção de todos os produtos da empresa, com o nome do produto dono — pra tela "Opções e Grupos"/"Adicionais"
 *     tags: [Produtos]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Grupos de opção de todos os produtos
 */
router.get('/opcoes-grupos-todos', requireEmpresaAdmin(), requireGrupo('vendas'), asyncHandler(async (req, res) => {
  const produtos = await prisma.produto.findMany({
    where: { empresaId: req.params.empresaId },
    select: {
      id: true,
      nome: true,
      gruposOpcao: {
        orderBy: [{ ordem: 'asc' }, { createdAt: 'asc' }],
        include: { opcoes: { orderBy: [{ ordem: 'asc' }, { nome: 'asc' }] } },
      },
    },
    orderBy: { nome: 'asc' },
  });

  const grupos = produtos.flatMap((p) =>
    p.gruposOpcao.map((g) => ({ ...g, produtoId: p.id, produtoNome: p.nome }))
  );

  res.json(grupos);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const produto = await prisma.produto.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
    include: INCLUDE_GRUPOS_OPCAO,
  });

  if (!produto) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }

  res.json(comGruposOpcaoPublicos(comDisponibilidade(produto)));
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
router.post('/', requireEmpresaAdmin(), requireGrupo('vendas'), asyncHandler(async (req, res) => {
  const {
    nome, codigo, descricao, categoriaId, preco, precoPromocional, fotoUrl, ativo, ordem,
    controlarEstoque, estoqueQtd, estoqueMinimo, ehCombo,
  } = req.body;

  const erros = validarPayload(req.body);
  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }
  const erroCategoria = await validarCategoria(req.params.empresaId, categoriaId);
  if (erroCategoria) {
    return res.status(400).json({ error: erroCategoria });
  }

  const produto = await prisma.produto.create({
    data: {
      empresaId: req.params.empresaId,
      nome,
      codigo: codigo || null,
      descricao: descricao || null,
      categoriaId: categoriaId || null,
      preco,
      precoPromocional: precoPromocional || null,
      fotoUrl: fotoUrl || null,
      ...(ativo !== undefined ? { ativo } : {}),
      ...(ordem !== undefined ? { ordem } : {}),
      ...(controlarEstoque !== undefined ? { controlarEstoque } : {}),
      ...(estoqueQtd !== undefined ? { estoqueQtd: estoqueQtd === null || estoqueQtd === '' ? null : Number(estoqueQtd) } : {}),
      ...(estoqueMinimo !== undefined ? { estoqueMinimo: estoqueMinimo === null || estoqueMinimo === '' ? null : Number(estoqueMinimo) } : {}),
      ...(ehCombo !== undefined ? { ehCombo } : {}),
    },
    include: { categoria: true },
  });

  registrarAtividadeLoja({
    empresaId: req.params.empresaId,
    tipo: 'PRODUTO_CRIADO',
    ator: 'Admin',
    descricao: `Produto "${produto.nome}" criado`,
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
router.put('/:id', requireEmpresaAdmin(), requireGrupo('vendas'), asyncHandler(async (req, res) => {
  const {
    nome, codigo, descricao, categoriaId, preco, precoPromocional, fotoUrl, ativo, ordem,
    controlarEstoque, estoqueQtd, estoqueMinimo, ehCombo,
  } = req.body;

  const erros = validarPayload(req.body);
  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }
  const erroCategoria = await validarCategoria(req.params.empresaId, categoriaId);
  if (erroCategoria) {
    return res.status(400).json({ error: erroCategoria });
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
        codigo: codigo || null,
        descricao: descricao || null,
        categoriaId: categoriaId || null,
        preco,
        precoPromocional: precoPromocional || null,
        fotoUrl: fotoUrl || null,
        ...(ativo !== undefined ? { ativo } : {}),
        ...(ordem !== undefined ? { ordem } : {}),
        ...(controlarEstoque !== undefined ? { controlarEstoque } : {}),
        ...(estoqueQtd !== undefined ? { estoqueQtd: estoqueQtd === null || estoqueQtd === '' ? null : Number(estoqueQtd) } : {}),
        ...(estoqueMinimo !== undefined ? { estoqueMinimo: estoqueMinimo === null || estoqueMinimo === '' ? null : Number(estoqueMinimo) } : {}),
        ...(ehCombo !== undefined ? { ehCombo } : {}),
      },
      include: { categoria: true },
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
router.patch('/:id/status', requireEmpresaAdmin(), requireGrupo('vendas'), asyncHandler(async (req, res) => {
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
router.patch('/:id/esgotado', requireEmpresaAdmin(), requireGrupo('vendas'), asyncHandler(async (req, res) => {
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
 * /empresas/{empresaId}/produtos/reordenar:
 *   patch:
 *     summary: Atualiza a ordem de exibição de vários produtos de uma vez — usado pelos botões de mover para cima/baixo
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
 *             type: object
 *             required: [itens]
 *             properties:
 *               itens:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [id, ordem]
 *                   properties:
 *                     id: { type: string, format: uuid }
 *                     ordem: { type: integer }
 *     responses:
 *       200:
 *         description: Ordem atualizada
 *       400:
 *         description: Payload inválido ou algum produto não pertence a esta empresa
 */
router.patch('/reordenar', requireEmpresaAdmin(), requireGrupo('vendas'), asyncHandler(async (req, res) => {
  const { itens } = req.body;
  if (!Array.isArray(itens) || itens.length === 0 || itens.some((i) => !i || typeof i.id !== 'string' || typeof i.ordem !== 'number')) {
    return res.status(400).json({ error: 'Campo "itens" é obrigatório e deve ser uma lista de { id, ordem }' });
  }

  const ids = itens.map((i) => i.id);
  const existentes = await prisma.produto.findMany({
    where: { id: { in: ids }, empresaId: req.params.empresaId },
    select: { id: true },
  });
  if (existentes.length !== ids.length) {
    return res.status(400).json({ error: 'Um ou mais produtos não pertencem a esta empresa' });
  }

  // Transação: ou todos os produtos ficam na nova ordem, ou nenhum — evita a lista ficar
  // inconsistente se um item falhar no meio da atualização.
  await prisma.$transaction(
    itens.map((item) => prisma.produto.update({ where: { id: item.id }, data: { ordem: item.ordem } }))
  );

  res.json({ ok: true });
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
router.delete('/:id', requireEmpresaAdmin(), requireGrupo('vendas'), asyncHandler(async (req, res) => {
  const existente = await prisma.produto.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }

  await prisma.produto.delete({ where: { id: req.params.id } });

  registrarAtividadeLoja({
    empresaId: req.params.empresaId,
    tipo: 'PRODUTO_REMOVIDO',
    ator: 'Admin',
    descricao: `Produto "${existente.nome}" removido`,
  });

  res.status(204).send();
}));

module.exports = router;
