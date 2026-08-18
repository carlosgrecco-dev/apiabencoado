const { Router } = require('express');
const prisma = require('../lib/prisma');
const { registrarLog } = require('../lib/auditLog');
const { requireSuperAdmin } = require('../lib/auth');

const router = Router();

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(requireSuperAdmin);

const STATUS_VALIDOS = ['PENDENTE', 'PAGO', 'ATRASADO'];

/** Marca como "atrasada" (para exibição) qualquer fatura não paga cujo vencimento já passou, sem sobrescrever o status manual salvo. */
const comAtraso = (fatura) => ({
  ...fatura,
  atrasada: fatura.status !== 'PAGO' && new Date(fatura.vencimento) < new Date(new Date().toDateString()),
});

/**
 * Calcula o total vendido (pedidos ENTREGUES) de uma empresa num período e monta os valores da fatura,
 * usando a comissão e o plano vigentes da empresa no momento da geração (snapshot).
 */
const montarFatura = async (empresa, periodoInicio, periodoFim) => {
  const agregado = await prisma.pedido.aggregate({
    where: {
      empresaId: empresa.id,
      status: 'ENTREGUE',
      entregueEm: { gte: new Date(`${periodoInicio}T00:00:00`), lte: new Date(`${periodoFim}T23:59:59`) },
    },
    _sum: { total: true },
  });

  const valorVendas = Number(agregado._sum.total || 0);
  const comissaoPercent = Number(empresa.comissaoPercent);
  const valorComissao = Math.round(valorVendas * (comissaoPercent / 100) * 100) / 100;
  const valorPlano = empresa.plano ? Number(empresa.plano.valorMensal) : 0;
  const valorTotal = valorComissao + valorPlano;

  return { valorVendas, comissaoPercent, valorComissao, valorPlano, valorTotal };
};

/**
 * @openapi
 * /faturas:
 *   get:
 *     summary: Lista as faturas de comissão/mensalidade das empresas
 *     tags: [Faturas]
 *     parameters:
 *       - in: query
 *         name: empresaId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [PENDENTE, PAGO, ATRASADO] }
 *     responses:
 *       200:
 *         description: Lista de faturas
 */
router.get('/', asyncHandler(async (req, res) => {
  const { empresaId, status } = req.query;
  if (status && !STATUS_VALIDOS.includes(status)) {
    return res.status(400).json({ error: `Campo "status" deve ser um de: ${STATUS_VALIDOS.join(', ')}` });
  }

  const faturas = await prisma.fatura.findMany({
    where: {
      ...(empresaId ? { empresaId } : {}),
      ...(status ? { status } : {}),
    },
    include: { empresa: { select: { id: true, nome: true, slug: true } } },
    orderBy: [{ vencimento: 'desc' }, { createdAt: 'desc' }],
  });

  res.json(faturas.map(comAtraso));
}));

/**
 * @openapi
 * /faturas/gerar:
 *   post:
 *     summary: Gera a fatura de comissão (+ mensalidade do plano) de uma empresa para um período
 *     tags: [Faturas]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [empresaId, periodoInicio, periodoFim, vencimento]
 *             properties:
 *               empresaId: { type: string, format: uuid }
 *               periodoInicio: { type: string, format: date }
 *               periodoFim: { type: string, format: date }
 *               vencimento: { type: string, format: date }
 *     responses:
 *       201:
 *         description: Fatura gerada
 *       400:
 *         description: Dados inválidos
 *       404:
 *         description: Empresa não encontrada
 *       409:
 *         description: Já existe fatura para esta empresa neste período exato
 */
router.post('/gerar', asyncHandler(async (req, res) => {
  const { empresaId, periodoInicio, periodoFim, vencimento } = req.body;

  if (!empresaId || !periodoInicio || !periodoFim || !vencimento) {
    return res.status(400).json({ error: 'Campos "empresaId", "periodoInicio", "periodoFim" e "vencimento" são obrigatórios' });
  }

  const empresa = await prisma.empresa.findUnique({ where: { id: empresaId }, include: { plano: true } });
  if (!empresa) {
    return res.status(404).json({ error: 'Empresa não encontrada' });
  }

  const valores = await montarFatura(empresa, periodoInicio, periodoFim);

  try {
    const fatura = await prisma.fatura.create({
      data: {
        empresaId,
        periodoInicio: new Date(`${periodoInicio}T00:00:00`),
        periodoFim: new Date(`${periodoFim}T00:00:00`),
        vencimento: new Date(`${vencimento}T00:00:00`),
        ...valores,
      },
      include: { empresa: { select: { id: true, nome: true, slug: true } } },
    });
    await registrarLog({
      tipo: 'ALTERACAO_CRITICA', empresaId: empresa.id, empresaNome: empresa.nome, ator: 'super-admin',
      acao: `Fatura gerada (R$ ${valores.valorTotal.toFixed(2)}) para o período ${periodoInicio} a ${periodoFim}`,
    });
    res.status(201).json(comAtraso(fatura));
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Já existe uma fatura desta empresa para exatamente este período' });
    }
    throw error;
  }
}));

/**
 * @openapi
 * /faturas/gerar-lote:
 *   post:
 *     summary: Gera faturas para todas as empresas ativas num período (pula quem já tem fatura no período exato)
 *     tags: [Faturas]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [periodoInicio, periodoFim, vencimento]
 *             properties:
 *               periodoInicio: { type: string, format: date }
 *               periodoFim: { type: string, format: date }
 *               vencimento: { type: string, format: date }
 *     responses:
 *       200:
 *         description: Resultado do lote
 */
router.post('/gerar-lote', asyncHandler(async (req, res) => {
  const { periodoInicio, periodoFim, vencimento } = req.body;
  if (!periodoInicio || !periodoFim || !vencimento) {
    return res.status(400).json({ error: 'Campos "periodoInicio", "periodoFim" e "vencimento" são obrigatórios' });
  }

  const empresas = await prisma.empresa.findMany({ where: { empresaAtiva: true }, include: { plano: true } });

  const geradas = [];
  const puladas = [];
  for (const empresa of empresas) {
    const valores = await montarFatura(empresa, periodoInicio, periodoFim);
    try {
      const fatura = await prisma.fatura.create({
        data: {
          empresaId: empresa.id,
          periodoInicio: new Date(`${periodoInicio}T00:00:00`),
          periodoFim: new Date(`${periodoFim}T00:00:00`),
          vencimento: new Date(`${vencimento}T00:00:00`),
          ...valores,
        },
      });
      geradas.push(fatura.id);
    } catch (error) {
      if (error.code === 'P2002') {
        puladas.push(empresa.nome);
      } else {
        throw error;
      }
    }
  }

  await registrarLog({
    tipo: 'ALTERACAO_CRITICA', ator: 'super-admin',
    acao: `Geração em lote de faturas (${periodoInicio} a ${periodoFim}): ${geradas.length} geradas, ${puladas.length} já existiam`,
  });

  res.json({ geradas: geradas.length, puladas });
}));

/**
 * @openapi
 * /faturas/{id}/status:
 *   patch:
 *     summary: Marca a fatura como Pendente, Paga ou Atrasada (controle manual de repasse/liquidação)
 *     tags: [Faturas]
 *     parameters:
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
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [PENDENTE, PAGO, ATRASADO] }
 *     responses:
 *       200:
 *         description: Status atualizado
 *       404:
 *         description: Fatura não encontrada
 */
router.patch('/:id/status', asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!status || !STATUS_VALIDOS.includes(status)) {
    return res.status(400).json({ error: `Campo "status" é obrigatório e deve ser um de: ${STATUS_VALIDOS.join(', ')}` });
  }

  const fatura = await prisma.fatura.findUnique({ where: { id: req.params.id }, include: { empresa: { select: { nome: true } } } });
  if (!fatura) {
    return res.status(404).json({ error: 'Fatura não encontrada' });
  }

  const atualizada = await prisma.fatura.update({
    where: { id: req.params.id },
    data: { status, pagoEm: status === 'PAGO' ? new Date() : null },
    include: { empresa: { select: { id: true, nome: true, slug: true } } },
  });

  await registrarLog({
    tipo: 'ALTERACAO_CRITICA', empresaId: fatura.empresaId, empresaNome: fatura.empresa?.nome, ator: 'super-admin',
    acao: `Fatura marcada como ${status}`,
  });

  res.json(comAtraso(atualizada));
}));

/**
 * @openapi
 * /faturas/{id}:
 *   delete:
 *     summary: Remove uma fatura gerada por engano
 *     tags: [Faturas]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204:
 *         description: Fatura removida
 *       404:
 *         description: Fatura não encontrada
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  try {
    await prisma.fatura.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Fatura não encontrada' });
    }
    throw error;
  }
}));

module.exports = router;
