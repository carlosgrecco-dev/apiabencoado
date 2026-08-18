const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { requireEmpresaAdmin } = require('../lib/auth');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const TIPOS_VALIDOS = ['ENTRADA', 'SAIDA', 'FECHAMENTO'];

router.use(loadEmpresa);
router.use(requireEmpresaAdmin());

/**
 * @openapi
 * components:
 *   schemas:
 *     MovimentoCaixa:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid, readOnly: true }
 *         empresaId: { type: string, format: uuid }
 *         motoboyId: { type: string, format: uuid, nullable: true }
 *         tipo: { type: string, enum: [ENTRADA, SAIDA, FECHAMENTO] }
 *         descricao: { type: string, nullable: true }
 *         valor: { type: number }
 *         dataMovimento: { type: string, format: date }
 *     MovimentoCaixaInput:
 *       type: object
 *       required: [tipo, valor]
 *       properties:
 *         tipo: { type: string, enum: [ENTRADA, SAIDA, FECHAMENTO] }
 *         descricao: { type: string }
 *         valor: { type: number }
 *         motoboyId: { type: string, format: uuid }
 *         dataMovimento: { type: string, format: date }
 */

/**
 * @openapi
 * /empresas/{empresaId}/movimentos-caixa:
 *   get:
 *     summary: Lista os movimentos de caixa da empresa (entradas, saídas e fechamentos)
 *     tags: [MovimentosCaixa]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: tipo
 *         schema: { type: string, enum: [ENTRADA, SAIDA, FECHAMENTO] }
 *       - in: query
 *         name: motoboyId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: de
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: ate
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: Lista de movimentos
 */
router.get('/', asyncHandler(async (req, res) => {
  const { tipo, motoboyId, de, ate } = req.query;

  if (tipo && !TIPOS_VALIDOS.includes(tipo)) {
    return res.status(400).json({ error: `Campo "tipo" deve ser um de: ${TIPOS_VALIDOS.join(', ')}` });
  }

  const where = {
    empresaId: req.params.empresaId,
    ...(tipo ? { tipo } : {}),
    ...(motoboyId ? { motoboyId } : {}),
    ...(de || ate
      ? {
        dataMovimento: {
          ...(de ? { gte: new Date(de) } : {}),
          ...(ate ? { lte: new Date(ate) } : {}),
        },
      }
      : {}),
  };

  const movimentos = await prisma.movimentoCaixa.findMany({
    where,
    orderBy: { dataMovimento: 'desc' },
  });

  res.json(movimentos);
}));

/**
 * @openapi
 * /empresas/{empresaId}/movimentos-caixa/{id}:
 *   get:
 *     summary: Busca um movimento de caixa pelo id
 *     tags: [MovimentosCaixa]
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
 *         description: Movimento encontrado
 *       404:
 *         description: Movimento não encontrado
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const movimento = await prisma.movimentoCaixa.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });

  if (!movimento) {
    return res.status(404).json({ error: 'Movimento não encontrado' });
  }

  res.json(movimento);
}));

/**
 * @openapi
 * /empresas/{empresaId}/movimentos-caixa:
 *   post:
 *     summary: Registra uma entrada, saída ou fechamento de caixa
 *     tags: [MovimentosCaixa]
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
 *             $ref: '#/components/schemas/MovimentoCaixaInput'
 *     responses:
 *       201:
 *         description: Movimento criado
 *       400:
 *         description: Dados inválidos
 */
router.post('/', asyncHandler(async (req, res) => {
  const { tipo, descricao, valor, motoboyId, dataMovimento } = req.body;

  if (!tipo || !TIPOS_VALIDOS.includes(tipo)) {
    return res.status(400).json({ error: `Campo "tipo" é obrigatório e deve ser um de: ${TIPOS_VALIDOS.join(', ')}` });
  }
  if (valor === undefined || Number.isNaN(Number(valor)) || Number(valor) <= 0) {
    return res.status(400).json({ error: 'Campo "valor" é obrigatório e deve ser maior que zero' });
  }

  if (motoboyId) {
    const motoboy = await prisma.motoboy.findFirst({
      where: { id: motoboyId, empresaId: req.params.empresaId },
    });
    if (!motoboy) {
      return res.status(400).json({ error: 'Motoboy informado não pertence a esta empresa' });
    }
  }

  const movimento = await prisma.movimentoCaixa.create({
    data: {
      empresaId: req.params.empresaId,
      motoboyId: motoboyId || null,
      tipo,
      descricao: descricao || null,
      valor,
      ...(dataMovimento ? { dataMovimento: new Date(dataMovimento) } : {}),
    },
  });

  res.status(201).json(movimento);
}));

/**
 * @openapi
 * /empresas/{empresaId}/movimentos-caixa/{id}:
 *   delete:
 *     summary: Remove um movimento de caixa
 *     tags: [MovimentosCaixa]
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
 *         description: Movimento removido
 *       404:
 *         description: Movimento não encontrado
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const existente = await prisma.movimentoCaixa.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Movimento não encontrado' });
  }

  await prisma.movimentoCaixa.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

module.exports = router;
