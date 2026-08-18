const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { requireEmpresaAdmin } = require('../lib/auth');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);
router.use(requireEmpresaAdmin());

const dataInicio = (de) => (de ? new Date(`${de}T00:00:00`) : undefined);
const dataFim = (ate) => (ate ? new Date(`${ate}T23:59:59`) : undefined);

/**
 * @openapi
 * /empresas/{empresaId}/crm/resumo:
 *   get:
 *     summary: Resumo de vendas, avaliações, comissão e fechamento de motoboys num período
 *     tags: [CRM]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: de
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: ate
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: Resumo do período
 */
router.get('/resumo', asyncHandler(async (req, res) => {
  const { de, ate } = req.query;
  const range = { gte: dataInicio(de), lte: dataFim(ate) };

  const entregues = await prisma.pedido.findMany({
    where: { empresaId: req.params.empresaId, status: 'ENTREGUE', createdAt: range },
    include: { itens: true },
  });

  const totalRevenue = entregues.reduce((sum, p) => sum + Number(p.total), 0);
  const totalUnits = entregues.reduce((sum, p) => sum + p.itens.reduce((s, i) => s + i.quantidade, 0), 0);
  const totalOrders = entregues.length;
  const ticketMedio = totalOrders > 0 ? totalRevenue / totalOrders : 0;

  const avaliados = entregues.filter((p) => p.notaPedido != null);
  const avgRating = avaliados.length > 0 ? avaliados.reduce((s, p) => s + p.notaPedido, 0) / avaliados.length : 0;

  const byPaymentMap = new Map();
  for (const p of entregues) {
    byPaymentMap.set(p.formaPagamento, (byPaymentMap.get(p.formaPagamento) || 0) + Number(p.total));
  }
  const byPayment = Array.from(byPaymentMap.entries()).map(([formaPagamento, total]) => ({ formaPagamento, total }));

  const dailyMap = new Map();
  for (const p of entregues) {
    const dia = p.createdAt.toISOString().slice(0, 10);
    dailyMap.set(dia, (dailyMap.get(dia) || 0) + Number(p.total));
  }
  const daily = Array.from(dailyMap.entries())
    .map(([date, total]) => ({ date, total }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const comMotoboy = await prisma.pedido.findMany({
    where: {
      empresaId: req.params.empresaId,
      motoboyId: { not: null },
      status: { in: ['ENTREGUE', 'CANCELADO'] },
      createdAt: range,
    },
    include: { motoboy: { select: { id: true, nome: true } } },
  });

  const motoboyMap = new Map();
  for (const p of comMotoboy) {
    if (!p.motoboy) continue;
    const atual = motoboyMap.get(p.motoboy.id) || {
      motoboyId: p.motoboy.id,
      motoboyNome: p.motoboy.nome,
      corridasConcluidas: 0,
      corridasCanceladas: 0,
      totalAPagar: 0,
    };
    if (p.status === 'ENTREGUE') {
      atual.corridasConcluidas += 1;
      atual.totalAPagar += Number(p.taxaEntregaMotoboy ?? 0);
    } else {
      atual.corridasCanceladas += 1;
    }
    motoboyMap.set(p.motoboy.id, atual);
  }

  const comissaoPercent = Number(req.empresa.comissaoPercent);
  const comissaoValor = totalRevenue * (comissaoPercent / 100);

  res.json({
    totalRevenue,
    totalUnits,
    totalOrders,
    ticketMedio,
    avgRating,
    ratingCount: avaliados.length,
    byPayment,
    daily,
    motoboyClosing: Array.from(motoboyMap.values()),
    comissaoPercent,
    comissaoValor,
    mostrarComissao: !req.empresa.ocultarComissaoTenant,
  });
}));

module.exports = router;
