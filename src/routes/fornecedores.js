const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { requireEmpresaAdmin } = require('../lib/auth');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);
router.use(requireEmpresaAdmin());

/**
 * @openapi
 * components:
 *   schemas:
 *     Fornecedor:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid, readOnly: true }
 *         empresaId: { type: string, format: uuid }
 *         nome: { type: string }
 *         contato: { type: string, nullable: true }
 *         categoria: { type: string, nullable: true }
 *         observacoes: { type: string, nullable: true }
 *         ativo: { type: boolean }
 */

/**
 * @openapi
 * /empresas/{empresaId}/fornecedores:
 *   get:
 *     summary: Lista os fornecedores cadastrados na loja
 *     tags: [Fornecedores]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: ativo
 *         schema: { type: boolean }
 *     responses:
 *       200:
 *         description: Lista de fornecedores
 */
router.get('/', asyncHandler(async (req, res) => {
  const { ativo } = req.query;
  const fornecedores = await prisma.fornecedor.findMany({
    where: {
      empresaId: req.params.empresaId,
      ...(ativo !== undefined ? { ativo: ativo === 'true' } : {}),
    },
    orderBy: { nome: 'asc' },
  });
  res.json(fornecedores);
}));

/**
 * @openapi
 * /empresas/{empresaId}/fornecedores:
 *   post:
 *     summary: Cadastra um novo fornecedor
 *     tags: [Fornecedores]
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
 *             required: [nome]
 *             properties:
 *               nome: { type: string }
 *               contato: { type: string }
 *               categoria: { type: string }
 *               observacoes: { type: string }
 *     responses:
 *       201:
 *         description: Fornecedor criado
 *       400:
 *         description: Dados inválidos
 */
router.post('/', asyncHandler(async (req, res) => {
  const { nome, contato, categoria, observacoes } = req.body;
  if (!nome || !String(nome).trim()) {
    return res.status(400).json({ error: 'Campo "nome" é obrigatório' });
  }

  const fornecedor = await prisma.fornecedor.create({
    data: {
      empresaId: req.params.empresaId,
      nome: String(nome).trim(),
      contato: contato ? String(contato).trim() : null,
      categoria: categoria ? String(categoria).trim() : null,
      observacoes: observacoes ? String(observacoes).trim() : null,
    },
  });
  res.status(201).json(fornecedor);
}));

/**
 * @openapi
 * /empresas/{empresaId}/fornecedores/{id}:
 *   patch:
 *     summary: Atualiza um fornecedor (dados ou status ativo/inativo)
 *     tags: [Fornecedores]
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
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nome: { type: string }
 *               contato: { type: string }
 *               categoria: { type: string }
 *               observacoes: { type: string }
 *               ativo: { type: boolean }
 *     responses:
 *       200:
 *         description: Fornecedor atualizado
 *       404:
 *         description: Fornecedor não encontrado
 */
router.patch('/:id', asyncHandler(async (req, res) => {
  const existente = await prisma.fornecedor.findFirst({ where: { id: req.params.id, empresaId: req.params.empresaId } });
  if (!existente) {
    return res.status(404).json({ error: 'Fornecedor não encontrado' });
  }

  const { nome, contato, categoria, observacoes, ativo } = req.body;
  const data = {};
  if (nome !== undefined) {
    if (!String(nome).trim()) {
      return res.status(400).json({ error: 'Campo "nome" não pode ficar vazio' });
    }
    data.nome = String(nome).trim();
  }
  if (contato !== undefined) data.contato = contato ? String(contato).trim() : null;
  if (categoria !== undefined) data.categoria = categoria ? String(categoria).trim() : null;
  if (observacoes !== undefined) data.observacoes = observacoes ? String(observacoes).trim() : null;
  if (ativo !== undefined) data.ativo = Boolean(ativo);

  const fornecedor = await prisma.fornecedor.update({ where: { id: req.params.id }, data });
  res.json(fornecedor);
}));

/**
 * @openapi
 * /empresas/{empresaId}/fornecedores/{id}:
 *   delete:
 *     summary: Remove um fornecedor
 *     tags: [Fornecedores]
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
 *         description: Fornecedor removido
 *       404:
 *         description: Fornecedor não encontrado
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const existente = await prisma.fornecedor.findFirst({ where: { id: req.params.id, empresaId: req.params.empresaId } });
  if (!existente) {
    return res.status(404).json({ error: 'Fornecedor não encontrado' });
  }
  await prisma.fornecedor.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

module.exports = router;
