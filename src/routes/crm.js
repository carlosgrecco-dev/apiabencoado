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

  // Médias por dimensão — só existem valores quando Empresa.habilitarAvaliacaoDetalhada esteve ligado no momento da avaliação.
  const mediaPorDimensao = (campo) => {
    const notas = entregues.map((p) => p[campo]).filter((n) => n != null);
    return notas.length > 0 ? { media: notas.reduce((s, n) => s + n, 0) / notas.length, quantidade: notas.length } : null;
  };
  const avaliacaoDetalhada = {
    comida: mediaPorDimensao('notaComida'),
    embalagem: mediaPorDimensao('notaEmbalagem'),
    tempo: mediaPorDimensao('notaTempo'),
  };

  const byPaymentMap = new Map();
  for (const p of entregues) {
    byPaymentMap.set(p.formaPagamento, (byPaymentMap.get(p.formaPagamento) || 0) + Number(p.total));
  }
  const byPayment = Array.from(byPaymentMap.entries()).map(([formaPagamento, total]) => ({ formaPagamento, total }));

  // Vendas por tipo de pedido (delivery vs balcão/mesa/retirada do PDV) — mesmo padrão de byPayment.
  const porTipoPedidoMap = new Map();
  for (const p of entregues) {
    const atual = porTipoPedidoMap.get(p.tipoPedido) || { tipoPedido: p.tipoPedido, total: 0, quantidade: 0 };
    atual.total += Number(p.total);
    atual.quantidade += 1;
    porTipoPedidoMap.set(p.tipoPedido, atual);
  }
  const porTipoPedido = Array.from(porTipoPedidoMap.values());

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

  // Produtos mais vendidos — agrega os itens dos mesmos pedidos ENTREGUES já carregados acima.
  const produtoMap = new Map();
  for (const p of entregues) {
    for (const item of p.itens) {
      const atual = produtoMap.get(item.produtoId) || { produtoId: item.produtoId, nome: item.nomeProduto, quantidade: 0, receita: 0 };
      atual.quantidade += item.quantidade;
      atual.receita += Number(item.precoUnitario) * item.quantidade;
      produtoMap.set(item.produtoId, atual);
    }
  }
  const topProdutos = Array.from(produtoMap.values())
    .sort((a, b) => b.quantidade - a.quantidade)
    .slice(0, 10);

  // Curva ABC: todos os produtos (não só o top 10), ordenados por receita, com % acumulado e
  // classificação de Pareto padrão (A até 80% acumulado, B até 95%, C o resto).
  const produtosPorReceita = Array.from(produtoMap.values()).sort((a, b) => b.receita - a.receita);
  const receitaTotalProdutos = produtosPorReceita.reduce((sum, item) => sum + item.receita, 0);
  let receitaAcumulada = 0;
  const curvaAbc = produtosPorReceita.map((item) => {
    receitaAcumulada += item.receita;
    const percentualAcumulado = receitaTotalProdutos > 0 ? (receitaAcumulada / receitaTotalProdutos) * 100 : 0;
    const classe = percentualAcumulado <= 80 ? 'A' : percentualAcumulado <= 95 ? 'B' : 'C';
    return { ...item, percentualAcumulado, classe };
  });

  // Horários de pico — conta os pedidos entregues por hora do dia (0-23), pra ajudar a escalar equipe.
  const porHoraMap = new Map();
  for (const p of entregues) {
    const hora = p.createdAt.getHours();
    porHoraMap.set(hora, (porHoraMap.get(hora) || 0) + 1);
  }
  const porHora = Array.from({ length: 24 }, (_, hora) => ({ hora, pedidos: porHoraMap.get(hora) || 0 }));

  // Distribuição por status no período — dá uma leitura de quanto foi cancelado vs concluído.
  const porStatusRaw = await prisma.pedido.groupBy({
    by: ['status'],
    where: { empresaId: req.params.empresaId, createdAt: range },
    _count: { _all: true },
  });
  const porStatus = porStatusRaw.map((s) => ({ status: s.status, quantidade: s._count._all }));

  // Top bairros por volume de pedidos entregues — ajuda a enxergar onde a demanda se concentra.
  const porBairroMap = new Map();
  for (const p of entregues) {
    const bairro = p.bairro || 'Não informado';
    const atual = porBairroMap.get(bairro) || { bairro, pedidos: 0, total: 0 };
    atual.pedidos += 1;
    atual.total += Number(p.total);
    porBairroMap.set(bairro, atual);
  }
  const porBairro = Array.from(porBairroMap.values()).sort((a, b) => b.pedidos - a.pedidos).slice(0, 10);

  // Pedidos entregues por dia da semana (0=domingo ... 6=sábado).
  const porDiaSemanaMap = new Map();
  for (const p of entregues) {
    const dia = p.createdAt.getDay();
    porDiaSemanaMap.set(dia, (porDiaSemanaMap.get(dia) || 0) + 1);
  }
  const porDiaSemana = Array.from({ length: 7 }, (_, dia) => ({ dia, pedidos: porDiaSemanaMap.get(dia) || 0 }));

  // Novos vs recorrentes: "novo" = a primeira compra ENTREGUE de vida do cliente caiu dentro deste período.
  const clienteIds = [...new Set(entregues.map((p) => p.clienteId).filter(Boolean))];
  let novos = 0;
  let recorrentes = 0;
  if (clienteIds.length > 0) {
    const primeirasCompras = await prisma.pedido.groupBy({
      by: ['clienteId'],
      where: { empresaId: req.params.empresaId, status: 'ENTREGUE', clienteId: { in: clienteIds } },
      _min: { createdAt: true },
    });
    const primeiraCompraPorCliente = new Map(primeirasCompras.map((c) => [c.clienteId, c._min.createdAt]));
    for (const clienteId of clienteIds) {
      const primeira = primeiraCompraPorCliente.get(clienteId);
      const ehNovo = primeira && primeira >= range.gte && (!range.lte || primeira <= range.lte);
      if (ehNovo) novos += 1;
      else recorrentes += 1;
    }
  }
  const novosVsRecorrentes = { novos, recorrentes };

  // Cupons usados no período — quantas vezes cada código foi aplicado e o desconto total gerado.
  const cupomMap = new Map();
  for (const p of entregues) {
    if (!p.cupomCodigo) continue;
    const atual = cupomMap.get(p.cupomCodigo) || { codigo: p.cupomCodigo, usos: 0, descontoTotal: 0 };
    atual.usos += 1;
    atual.descontoTotal += Number(p.descontoCupom ?? 0);
    cupomMap.set(p.cupomCodigo, atual);
  }
  const cuponsUsados = Array.from(cupomMap.values()).sort((a, b) => b.usos - a.usos);

  res.json({
    totalRevenue,
    totalUnits,
    totalOrders,
    ticketMedio,
    avgRating,
    ratingCount: avaliados.length,
    byPayment,
    porTipoPedido,
    daily,
    motoboyClosing: Array.from(motoboyMap.values()),
    comissaoPercent,
    comissaoValor,
    mostrarComissao: !req.empresa.ocultarComissaoTenant,
    topProdutos,
    curvaAbc,
    porHora,
    porStatus,
    porBairro,
    porDiaSemana,
    novosVsRecorrentes,
    cuponsUsados,
    avaliacaoDetalhada,
  });
}));

/** Escapa um campo pra CSV: envolve em aspas se tiver vírgula/aspas/quebra de linha, e duplica aspas internas. */
const csvField = (value) => {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
};

/**
 * @openapi
 * /empresas/{empresaId}/crm/exportar-csv:
 *   get:
 *     summary: Exporta os pedidos entregues do período em CSV, pronto pra abrir em Excel/Planilhas
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
 *         description: Arquivo CSV
 */
router.get('/exportar-csv', asyncHandler(async (req, res) => {
  const { de, ate } = req.query;
  const range = { gte: dataInicio(de), lte: dataFim(ate) };

  const pedidos = await prisma.pedido.findMany({
    where: { empresaId: req.params.empresaId, status: 'ENTREGUE', createdAt: range },
    orderBy: { createdAt: 'asc' },
  });

  const cabecalho = ['Número', 'Data', 'Cliente', 'Telefone', 'Bairro', 'Forma de pagamento', 'Cupom', 'Subtotal', 'Taxa de entrega', 'Total', 'Nota'];
  const linhas = pedidos.map((p) => [
    p.numero,
    p.createdAt.toLocaleString('pt-BR'),
    p.clienteNome,
    p.clienteTelefone,
    p.bairro || '',
    p.formaPagamento,
    p.cupomCodigo || '',
    Number(p.subtotal).toFixed(2),
    Number(p.taxaEntrega).toFixed(2),
    Number(p.total).toFixed(2),
    p.notaPedido ?? '',
  ]);

  const csv = [cabecalho, ...linhas].map((linha) => linha.map(csvField).join(',')).join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="pedidos-${de || 'inicio'}-a-${ate || 'hoje'}.csv"`);
  res.send(`﻿${csv}`);
}));

module.exports = router;
