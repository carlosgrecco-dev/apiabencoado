const { Router } = require('express');
const prisma = require('../lib/prisma');
const { registrarLog } = require('../lib/auditLog');
const { requireSuperAdmin } = require('../lib/auth');

const router = Router();

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(requireSuperAdmin);

const handlePrismaError = (error, res) => {
  if (error.code === 'P2025') {
    return res.status(404).json({ error: 'Plano não encontrado' });
  }
  throw error;
};

const validarPayload = ({ nome, comissaoPercent, valorMensal }) => {
  const erros = [];
  if (!nome) erros.push('Campo "nome" é obrigatório');
  if (comissaoPercent === undefined || Number.isNaN(Number(comissaoPercent)) || Number(comissaoPercent) < 0 || Number(comissaoPercent) > 100) {
    erros.push('Campo "comissaoPercent" é obrigatório e deve estar entre 0 e 100');
  }
  if (valorMensal !== undefined && (Number.isNaN(Number(valorMensal)) || Number(valorMensal) < 0)) {
    erros.push('Campo "valorMensal" deve ser maior ou igual a zero');
  }
  return erros;
};

/**
 * @openapi
 * /planos:
 *   get:
 *     summary: Lista os planos de assinatura da plataforma
 *     tags: [Planos]
 *     responses:
 *       200:
 *         description: Lista de planos
 */
router.get('/', asyncHandler(async (req, res) => {
  const planos = await prisma.plano.findMany({
    orderBy: [{ ordem: 'asc' }, { valorMensal: 'asc' }],
    include: { _count: { select: { empresas: true } } },
  });
  res.json(planos);
}));

/**
 * @openapi
 * /planos:
 *   post:
 *     summary: Cadastra um novo plano
 *     tags: [Planos]
 *     responses:
 *       201:
 *         description: Plano criado
 *       400:
 *         description: Dados inválidos
 */
router.post('/', asyncHandler(async (req, res) => {
  const {
    nome, valorMensal, comissaoPercent, descricao, ativo, ordem, recursos,
    limitePedidosMes, limiteProdutos, limiteUsuarios, limiteEntregadores, destaque,
  } = req.body;

  const erros = validarPayload(req.body);
  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }

  const plano = await prisma.plano.create({
    data: {
      nome,
      valorMensal: valorMensal ?? 0,
      comissaoPercent,
      descricao: descricao || null,
      recursos: Array.isArray(recursos) ? recursos : [],
      limitePedidosMes: limitePedidosMes || null,
      limiteProdutos: limiteProdutos || null,
      limiteUsuarios: limiteUsuarios || null,
      limiteEntregadores: limiteEntregadores || null,
      ...(destaque !== undefined ? { destaque } : {}),
      ...(ativo !== undefined ? { ativo } : {}),
      ...(ordem !== undefined ? { ordem } : {}),
    },
  });

  await registrarLog({ tipo: 'ALTERACAO_CRITICA', ator: 'super-admin', acao: `Plano "${plano.nome}" criado`, detalhes: plano });
  res.status(201).json(plano);
}));

/**
 * @openapi
 * /planos/{id}:
 *   put:
 *     summary: Atualiza um plano
 *     tags: [Planos]
 *     responses:
 *       200:
 *         description: Plano atualizado
 *       404:
 *         description: Plano não encontrado
 */
router.put('/:id', asyncHandler(async (req, res) => {
  const {
    nome, valorMensal, comissaoPercent, descricao, ativo, ordem, recursos,
    limitePedidosMes, limiteProdutos, limiteUsuarios, limiteEntregadores, destaque,
  } = req.body;

  const erros = validarPayload(req.body);
  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }

  try {
    const plano = await prisma.plano.update({
      where: { id: req.params.id },
      data: {
        nome,
        valorMensal: valorMensal ?? 0,
        comissaoPercent,
        descricao: descricao || null,
        recursos: Array.isArray(recursos) ? recursos : [],
        limitePedidosMes: limitePedidosMes || null,
        limiteProdutos: limiteProdutos || null,
        limiteUsuarios: limiteUsuarios || null,
        limiteEntregadores: limiteEntregadores || null,
        ...(destaque !== undefined ? { destaque } : {}),
        ...(ativo !== undefined ? { ativo } : {}),
        ...(ordem !== undefined ? { ordem } : {}),
      },
    });
    await registrarLog({ tipo: 'ALTERACAO_CRITICA', ator: 'super-admin', acao: `Plano "${plano.nome}" atualizado`, detalhes: plano });
    res.json(plano);
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /planos/{id}/status:
 *   patch:
 *     summary: Ativa ou inativa um plano
 *     tags: [Planos]
 *     responses:
 *       200:
 *         description: Status atualizado
 *       404:
 *         description: Plano não encontrado
 */
router.patch('/:id/status', asyncHandler(async (req, res) => {
  const { ativo } = req.body;
  if (typeof ativo !== 'boolean') {
    return res.status(400).json({ error: 'Campo "ativo" é obrigatório e deve ser booleano' });
  }

  try {
    const plano = await prisma.plano.update({ where: { id: req.params.id }, data: { ativo } });
    res.json(plano);
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /planos/{id}:
 *   delete:
 *     summary: Remove um plano (as empresas vinculadas ficam sem plano)
 *     tags: [Planos]
 *     responses:
 *       204:
 *         description: Plano removido
 *       404:
 *         description: Plano não encontrado
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  try {
    const plano = await prisma.plano.delete({ where: { id: req.params.id } });
    await registrarLog({ tipo: 'ALTERACAO_CRITICA', ator: 'super-admin', acao: `Plano "${plano.nome}" removido` });
    res.status(204).send();
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

module.exports = router;
