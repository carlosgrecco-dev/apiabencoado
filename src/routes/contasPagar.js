const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { requireEmpresaAdmin, requireGrupo } = require('../lib/auth');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);
router.use(requireEmpresaAdmin());
router.use(requireGrupo('financeiro'));

/**
 * @openapi
 * components:
 *   schemas:
 *     ContaPagar:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid, readOnly: true }
 *         empresaId: { type: string, format: uuid }
 *         descricao: { type: string }
 *         fornecedorNome: { type: string, nullable: true }
 *         valor: { type: number }
 *         vencimento: { type: string, format: date }
 *         status: { type: string, enum: [PENDENTE, PAGO] }
 *         pagoEm: { type: string, format: date-time, nullable: true }
 *         observacoes: { type: string, nullable: true }
 */

/**
 * @openapi
 * /empresas/{empresaId}/contas-pagar:
 *   get:
 *     summary: Lista as contas a pagar da loja (ledger manual — fornecedor, aluguel, tarifa etc.)
 *     tags: [Financeiro]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [PENDENTE, PAGO] }
 *     responses:
 *       200:
 *         description: Lista de contas a pagar
 */
router.get('/', asyncHandler(async (req, res) => {
  const { status } = req.query;
  const contas = await prisma.contaPagar.findMany({
    where: {
      empresaId: req.params.empresaId,
      ...(status ? { status } : {}),
    },
    orderBy: { vencimento: 'asc' },
  });
  res.json(contas);
}));

/**
 * @openapi
 * /empresas/{empresaId}/contas-pagar:
 *   post:
 *     summary: Registra uma nova conta a pagar
 *     tags: [Financeiro]
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
 *             required: [descricao, valor, vencimento]
 *             properties:
 *               descricao: { type: string }
 *               fornecedorNome: { type: string }
 *               valor: { type: number }
 *               vencimento: { type: string, format: date }
 *               observacoes: { type: string }
 *     responses:
 *       201:
 *         description: Conta criada
 *       400:
 *         description: Dados inválidos
 */
router.post('/', asyncHandler(async (req, res) => {
  const { descricao, fornecedorNome, valor, vencimento, observacoes } = req.body;
  if (!descricao || !String(descricao).trim()) {
    return res.status(400).json({ error: 'Campo "descricao" é obrigatório' });
  }
  const valorNumero = Number(valor);
  if (!Number.isFinite(valorNumero) || valorNumero <= 0) {
    return res.status(400).json({ error: 'Campo "valor" deve ser maior que zero' });
  }
  if (!vencimento || Number.isNaN(new Date(vencimento).getTime())) {
    return res.status(400).json({ error: 'Campo "vencimento" é obrigatório e deve ser uma data válida' });
  }

  const conta = await prisma.contaPagar.create({
    data: {
      empresaId: req.params.empresaId,
      descricao: String(descricao).trim(),
      fornecedorNome: fornecedorNome ? String(fornecedorNome).trim() : null,
      valor: valorNumero,
      vencimento: new Date(vencimento),
      observacoes: observacoes ? String(observacoes).trim() : null,
    },
  });
  res.status(201).json(conta);
}));

/**
 * @openapi
 * /empresas/{empresaId}/contas-pagar/{id}:
 *   patch:
 *     summary: Atualiza uma conta a pagar (dados, ou marcar como paga/reabrir)
 *     tags: [Financeiro]
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
 *               descricao: { type: string }
 *               fornecedorNome: { type: string }
 *               valor: { type: number }
 *               vencimento: { type: string, format: date }
 *               observacoes: { type: string }
 *               status: { type: string, enum: [PENDENTE, PAGO] }
 *     responses:
 *       200:
 *         description: Conta atualizada
 *       404:
 *         description: Conta não encontrada
 */
router.patch('/:id', asyncHandler(async (req, res) => {
  const existente = await prisma.contaPagar.findFirst({ where: { id: req.params.id, empresaId: req.params.empresaId } });
  if (!existente) {
    return res.status(404).json({ error: 'Conta não encontrada' });
  }

  const { descricao, fornecedorNome, valor, vencimento, observacoes, status } = req.body;
  const data = {};
  if (descricao !== undefined) data.descricao = String(descricao).trim();
  if (fornecedorNome !== undefined) data.fornecedorNome = fornecedorNome ? String(fornecedorNome).trim() : null;
  if (valor !== undefined) {
    const valorNumero = Number(valor);
    if (!Number.isFinite(valorNumero) || valorNumero <= 0) {
      return res.status(400).json({ error: 'Campo "valor" deve ser maior que zero' });
    }
    data.valor = valorNumero;
  }
  if (vencimento !== undefined) {
    if (Number.isNaN(new Date(vencimento).getTime())) {
      return res.status(400).json({ error: 'Campo "vencimento" deve ser uma data válida' });
    }
    data.vencimento = new Date(vencimento);
  }
  if (observacoes !== undefined) data.observacoes = observacoes ? String(observacoes).trim() : null;
  if (status !== undefined) {
    if (status !== 'PENDENTE' && status !== 'PAGO') {
      return res.status(400).json({ error: 'Campo "status" deve ser PENDENTE ou PAGO' });
    }
    data.status = status;
    data.pagoEm = status === 'PAGO' ? new Date() : null;
  }

  const conta = await prisma.contaPagar.update({ where: { id: req.params.id }, data });
  res.json(conta);
}));

/**
 * @openapi
 * /empresas/{empresaId}/contas-pagar/{id}:
 *   delete:
 *     summary: Remove uma conta a pagar
 *     tags: [Financeiro]
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
 *         description: Conta removida
 *       404:
 *         description: Conta não encontrada
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const existente = await prisma.contaPagar.findFirst({ where: { id: req.params.id, empresaId: req.params.empresaId } });
  if (!existente) {
    return res.status(404).json({ error: 'Conta não encontrada' });
  }
  await prisma.contaPagar.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

module.exports = router;
