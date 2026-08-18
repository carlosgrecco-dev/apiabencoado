const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { requireEmpresaAdmin } = require('../lib/auth');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);
router.use(requireEmpresaAdmin());

/** Garante que o produto pertence à empresa da rota antes de qualquer operação em seus grupos de opção. */
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

const validarGrupoPayload = ({ nome, minSelecoes, maxSelecoes }) => {
  const erros = [];
  if (!nome) erros.push('Campo "nome" é obrigatório');
  if (minSelecoes !== undefined && (Number.isNaN(Number(minSelecoes)) || Number(minSelecoes) < 0)) {
    erros.push('Campo "minSelecoes" deve ser maior ou igual a zero');
  }
  if (maxSelecoes !== undefined && maxSelecoes !== null && maxSelecoes !== '' && Number(maxSelecoes) < 1) {
    erros.push('Campo "maxSelecoes" deve ser maior ou igual a 1');
  }
  return erros;
};

/**
 * @openapi
 * /empresas/{empresaId}/produtos/{produtoId}/grupos-opcao:
 *   get:
 *     summary: Lista os grupos de opções/complementos de um produto, com as opções de cada grupo
 *     tags: [ProdutoGruposOpcao]
 *     responses:
 *       200:
 *         description: Lista de grupos
 */
router.get('/', asyncHandler(async (req, res) => {
  const grupos = await prisma.produtoGrupoOpcao.findMany({
    where: { produtoId: req.params.produtoId },
    include: { opcoes: { orderBy: [{ ordem: 'asc' }, { nome: 'asc' }] } },
    orderBy: [{ ordem: 'asc' }, { createdAt: 'asc' }],
  });
  res.json(grupos);
}));

/**
 * @openapi
 * /empresas/{empresaId}/produtos/{produtoId}/grupos-opcao:
 *   post:
 *     summary: Cadastra um grupo de opções/complementos para o produto
 *     tags: [ProdutoGruposOpcao]
 *     responses:
 *       201:
 *         description: Grupo criado
 *       400:
 *         description: Dados inválidos
 */
router.post('/', asyncHandler(async (req, res) => {
  const { nome, obrigatorio, selecaoMultipla, minSelecoes, maxSelecoes, ordem } = req.body;

  const erros = validarGrupoPayload(req.body);
  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }

  const grupo = await prisma.produtoGrupoOpcao.create({
    data: {
      produtoId: req.params.produtoId,
      nome,
      obrigatorio: !!obrigatorio,
      selecaoMultipla: selecaoMultipla === undefined ? true : !!selecaoMultipla,
      minSelecoes: minSelecoes !== undefined ? Number(minSelecoes) : 0,
      maxSelecoes: maxSelecoes === undefined || maxSelecoes === null || maxSelecoes === '' ? null : Number(maxSelecoes),
      ...(ordem !== undefined ? { ordem } : {}),
    },
    include: { opcoes: true },
  });

  res.status(201).json(grupo);
}));

/**
 * @openapi
 * /empresas/{empresaId}/produtos/{produtoId}/grupos-opcao/{id}:
 *   put:
 *     summary: Atualiza um grupo de opções
 *     tags: [ProdutoGruposOpcao]
 *     responses:
 *       200:
 *         description: Grupo atualizado
 *       404:
 *         description: Grupo não encontrado
 */
router.put('/:id', asyncHandler(async (req, res) => {
  const { nome, obrigatorio, selecaoMultipla, minSelecoes, maxSelecoes, ordem } = req.body;

  const erros = validarGrupoPayload(req.body);
  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }

  const existente = await prisma.produtoGrupoOpcao.findFirst({
    where: { id: req.params.id, produtoId: req.params.produtoId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Grupo não encontrado' });
  }

  const grupo = await prisma.produtoGrupoOpcao.update({
    where: { id: req.params.id },
    data: {
      nome,
      obrigatorio: !!obrigatorio,
      selecaoMultipla: selecaoMultipla === undefined ? true : !!selecaoMultipla,
      minSelecoes: minSelecoes !== undefined ? Number(minSelecoes) : 0,
      maxSelecoes: maxSelecoes === undefined || maxSelecoes === null || maxSelecoes === '' ? null : Number(maxSelecoes),
      ...(ordem !== undefined ? { ordem } : {}),
    },
    include: { opcoes: { orderBy: [{ ordem: 'asc' }, { nome: 'asc' }] } },
  });

  res.json(grupo);
}));

/**
 * @openapi
 * /empresas/{empresaId}/produtos/{produtoId}/grupos-opcao/{id}:
 *   delete:
 *     summary: Remove um grupo de opções (e suas opções)
 *     tags: [ProdutoGruposOpcao]
 *     responses:
 *       204:
 *         description: Grupo removido
 *       404:
 *         description: Grupo não encontrado
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const existente = await prisma.produtoGrupoOpcao.findFirst({
    where: { id: req.params.id, produtoId: req.params.produtoId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Grupo não encontrado' });
  }

  await prisma.produtoGrupoOpcao.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

/** Garante que o grupo pertence ao produto da rota antes de mexer em suas opções. */
const loadGrupo = asyncHandler(async (req, res, next) => {
  const grupo = await prisma.produtoGrupoOpcao.findFirst({
    where: { id: req.params.grupoId, produtoId: req.params.produtoId },
  });
  if (!grupo) {
    return res.status(404).json({ error: 'Grupo não encontrado' });
  }
  req.grupo = grupo;
  next();
});

/**
 * @openapi
 * /empresas/{empresaId}/produtos/{produtoId}/grupos-opcao/{grupoId}/opcoes:
 *   post:
 *     summary: Cadastra uma opção dentro do grupo (ex: "Camarão", com preço adicional opcional)
 *     tags: [ProdutoGruposOpcao]
 *     responses:
 *       201:
 *         description: Opção criada
 *       400:
 *         description: Dados inválidos
 *       404:
 *         description: Grupo não encontrado
 */
router.post('/:grupoId/opcoes', loadGrupo, asyncHandler(async (req, res) => {
  const { nome, precoAdicional, ativo, ordem, selecionadoPorPadrao, fotoUrl, descricao } = req.body;
  if (!nome) {
    return res.status(400).json({ error: 'Campo "nome" é obrigatório' });
  }
  if (precoAdicional !== undefined && (Number.isNaN(Number(precoAdicional)) || Number(precoAdicional) < 0)) {
    return res.status(400).json({ error: 'Campo "precoAdicional" deve ser maior ou igual a zero' });
  }

  const opcao = await prisma.produtoOpcao.create({
    data: {
      grupoId: req.params.grupoId,
      nome,
      precoAdicional: precoAdicional !== undefined ? precoAdicional : 0,
      ...(ativo !== undefined ? { ativo } : {}),
      ...(ordem !== undefined ? { ordem } : {}),
      ...(selecionadoPorPadrao !== undefined ? { selecionadoPorPadrao: !!selecionadoPorPadrao } : {}),
      ...(fotoUrl !== undefined ? { fotoUrl: fotoUrl || null } : {}),
      ...(descricao !== undefined ? { descricao: descricao || null } : {}),
    },
  });

  res.status(201).json(opcao);
}));

/**
 * @openapi
 * /empresas/{empresaId}/produtos/{produtoId}/grupos-opcao/{grupoId}/opcoes/{id}:
 *   put:
 *     summary: Atualiza uma opção do grupo
 *     tags: [ProdutoGruposOpcao]
 *     responses:
 *       200:
 *         description: Opção atualizada
 *       404:
 *         description: Opção não encontrada
 */
router.put('/:grupoId/opcoes/:id', loadGrupo, asyncHandler(async (req, res) => {
  const { nome, precoAdicional, ativo, ordem, selecionadoPorPadrao, fotoUrl, descricao } = req.body;
  if (!nome) {
    return res.status(400).json({ error: 'Campo "nome" é obrigatório' });
  }
  if (precoAdicional !== undefined && (Number.isNaN(Number(precoAdicional)) || Number(precoAdicional) < 0)) {
    return res.status(400).json({ error: 'Campo "precoAdicional" deve ser maior ou igual a zero' });
  }

  const existente = await prisma.produtoOpcao.findFirst({
    where: { id: req.params.id, grupoId: req.params.grupoId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Opção não encontrada' });
  }

  const opcao = await prisma.produtoOpcao.update({
    where: { id: req.params.id },
    data: {
      nome,
      precoAdicional: precoAdicional !== undefined ? precoAdicional : 0,
      ...(ativo !== undefined ? { ativo } : {}),
      ...(ordem !== undefined ? { ordem } : {}),
      ...(selecionadoPorPadrao !== undefined ? { selecionadoPorPadrao: !!selecionadoPorPadrao } : {}),
      ...(fotoUrl !== undefined ? { fotoUrl: fotoUrl || null } : {}),
      ...(descricao !== undefined ? { descricao: descricao || null } : {}),
    },
  });

  res.json(opcao);
}));

/**
 * @openapi
 * /empresas/{empresaId}/produtos/{produtoId}/grupos-opcao/{grupoId}/opcoes/{id}:
 *   delete:
 *     summary: Remove uma opção do grupo
 *     tags: [ProdutoGruposOpcao]
 *     responses:
 *       204:
 *         description: Opção removida
 *       404:
 *         description: Opção não encontrada
 */
router.delete('/:grupoId/opcoes/:id', loadGrupo, asyncHandler(async (req, res) => {
  const existente = await prisma.produtoOpcao.findFirst({
    where: { id: req.params.id, grupoId: req.params.grupoId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Opção não encontrada' });
  }

  await prisma.produtoOpcao.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

module.exports = router;
