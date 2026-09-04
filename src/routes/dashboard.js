const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { requireEmpresaAdmin, requireGrupo } = require('../lib/auth');
const { calcularRfm, RFM_SEGMENT_LABELS } = require('../lib/rfm');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);
router.use(requireEmpresaAdmin());
router.use(requireGrupo('painel'));

const dataInicio = (de) => (de ? new Date(`${de}T00:00:00`) : undefined);
const dataFim = (ate) => (ate ? new Date(`${ate}T23:59:59`) : undefined);

/**
 * @openapi
 * /empresas/{empresaId}/dashboard/resumo:
 *   get:
 *     summary: Widgets do dashboard "Visão Geral" que não estão em /crm/resumo — funil, heatmap, RFM, caixa, alertas, top motoboys com avaliação, top categorias
 *     tags: [Dashboard]
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
  const empresaId = req.params.empresaId;
  const range = { gte: dataInicio(de), lte: dataFim(ate) };

  const entregues = await prisma.pedido.findMany({
    where: { empresaId, status: 'ENTREGUE', createdAt: range },
    include: { itens: { include: { produto: { select: { categoriaId: true, categoria: { select: { nome: true } } } } } } },
  });

  // Top categorias por receita — mesmo padrão de topProdutos/curvaAbc já existente em crm.js.
  const categoriaMap = new Map();
  for (const p of entregues) {
    for (const item of p.itens) {
      const categoriaId = item.produto?.categoriaId || 'sem-categoria';
      const nome = item.produto?.categoria?.nome || 'Sem categoria';
      const atual = categoriaMap.get(categoriaId) || { categoriaId, nome, quantidade: 0, receita: 0 };
      atual.quantidade += item.quantidade;
      atual.receita += Number(item.precoUnitario) * item.quantidade;
      categoriaMap.set(categoriaId, atual);
    }
  }
  const receitaTotalCategorias = Array.from(categoriaMap.values()).reduce((s, c) => s + c.receita, 0);
  const porCategoria = Array.from(categoriaMap.values())
    .map((c) => ({ ...c, percentual: receitaTotalCategorias > 0 ? (c.receita / receitaTotalCategorias) * 100 : 0 }))
    .sort((a, b) => b.receita - a.receita)
    .slice(0, 10);

  // Tempo médio de entrega e % dentro do prazo configurado da loja (Empresa.tempoEstimadoMax) —
  // só pedidos DELIVERY (balcão/mesa/retirada são "entregues" na hora, misturar distorceria a média).
  const entreguesDelivery = entregues.filter((p) => p.tipoPedido === 'DELIVERY');
  const tempos = entreguesDelivery.filter((p) => p.entregueEm).map((p) => (p.entregueEm.getTime() - p.createdAt.getTime()) / 60000);
  const tempoMedioEntregaMin = tempos.length > 0 ? tempos.reduce((s, t) => s + t, 0) / tempos.length : null;
  const prazoMaxMin = req.empresa.tempoEstimadoMax;
  const entregasNoPrazoPercent = prazoMaxMin && tempos.length > 0
    ? (tempos.filter((t) => t <= prazoMaxMin).length / tempos.length) * 100
    : null;

  // Cancelamentos % — precisa do total de pedidos do período (não só os entregues).
  const totalPedidosPeriodo = await prisma.pedido.count({ where: { empresaId, createdAt: range } });
  const canceladosPeriodo = await prisma.pedido.count({ where: { empresaId, createdAt: range, status: 'CANCELADO' } });
  const cancelamentosPercent = totalPedidosPeriodo > 0 ? (canceladosPeriodo / totalPedidosPeriodo) * 100 : 0;

  // Clientes ativos, pedidos por cliente ativo (substitui "taxa de conversão" — não dá pra medir
  // honestamente sem rastreamento de visita/carrinho, que o site não tem) e taxa de recompra.
  const clienteIdsPeriodo = [...new Set(entregues.map((p) => p.clienteId).filter(Boolean))];
  const clientesAtivos = clienteIdsPeriodo.length;
  const pedidosPorClienteAtivo = clientesAtivos > 0 ? entregues.length / clientesAtivos : 0;

  let taxaRecompraPercent = 0;
  if (clienteIdsPeriodo.length > 0) {
    const totalPorCliente = await prisma.pedido.groupBy({
      by: ['clienteId'],
      where: { empresaId, status: 'ENTREGUE', clienteId: { in: clienteIdsPeriodo } },
      _count: { _all: true },
    });
    const recompradores = totalPorCliente.filter((c) => c._count._all > 1).length;
    taxaRecompraPercent = (recompradores / clienteIdsPeriodo.length) * 100;
  }

  // Série diária pro gráfico de linha "Visão Geral de Vendas" — pedidos e novos clientes por dia
  // (o total diário já existe em crm.js/daily; aqui só o que falta lá).
  let primeiraCompraMap = new Map();
  if (clienteIdsPeriodo.length > 0) {
    const primeirasCompras = await prisma.pedido.groupBy({
      by: ['clienteId'],
      where: { empresaId, status: 'ENTREGUE', clienteId: { in: clienteIdsPeriodo } },
      _min: { createdAt: true },
    });
    primeiraCompraMap = new Map(primeirasCompras.map((c) => [c.clienteId, c._min.createdAt.toISOString().slice(0, 10)]));
  }
  const porDiaMap = new Map();
  const novosPorDia = new Map();
  for (const p of entregues) {
    const dia = p.createdAt.toISOString().slice(0, 10);
    const atual = porDiaMap.get(dia) || { date: dia, pedidos: 0 };
    atual.pedidos += 1;
    porDiaMap.set(dia, atual);
    if (p.clienteId && primeiraCompraMap.get(p.clienteId) === dia) {
      if (!novosPorDia.has(dia)) novosPorDia.set(dia, new Set());
      novosPorDia.get(dia).add(p.clienteId);
    }
  }
  const porDia = Array.from(porDiaMap.values())
    .map((d) => ({ ...d, novosClientes: (novosPorDia.get(d.date) || new Set()).size }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Heatmap dia-da-semana × hora — extensão do padrão já usado em porHora/porDiaSemana (crm.js).
  const heatmapMap = new Map();
  for (const p of entregues) {
    const chave = `${p.createdAt.getDay()}-${p.createdAt.getHours()}`;
    heatmapMap.set(chave, (heatmapMap.get(chave) || 0) + 1);
  }
  const heatmap = [];
  for (let dia = 0; dia < 7; dia++) {
    for (let hora = 0; hora < 24; hora++) {
      heatmap.push({ dia, hora, pedidos: heatmapMap.get(`${dia}-${hora}`) || 0 });
    }
  }

  // Funil — só pedidos DELIVERY: BALCAO/MESA/RETIRADA (venda no PDV) não passam por "a caminho" e
  // costumam pular direto pra ENTREGUE, o que faria o funil parecer um abandono gigante sem ser.
  // Usa os timestamps de cada etapa (preparandoEm/saiuEntregaEm/entregueEm), não o status atual,
  // pra contar corretamente até quem foi cancelado depois de já ter passado por uma etapa.
  const todosPeriodo = await prisma.pedido.findMany({
    where: { empresaId, createdAt: range, tipoPedido: 'DELIVERY' },
    select: { status: true, preparandoEm: true, saiuEntregaEm: true, entregueEm: true },
  });
  const funil = {
    recebidos: todosPeriodo.length,
    preparando: todosPeriodo.filter((p) => p.preparandoEm).length,
    saiuEntrega: todosPeriodo.filter((p) => p.saiuEntregaEm).length,
    entregues: todosPeriodo.filter((p) => p.entregueEm).length,
    cancelados: todosPeriodo.filter((p) => p.status === 'CANCELADO').length,
  };

  // Top motoboys com avaliação média — motoboyClosing do crm.js não tem nota, esta é independente.
  const comMotoboy = await prisma.pedido.findMany({
    where: { empresaId, motoboyId: { not: null }, status: 'ENTREGUE', createdAt: range },
    select: { motoboyId: true, notaMotoboy: true, motoboy: { select: { nome: true } } },
  });
  const motoboyStatsMap = new Map();
  for (const p of comMotoboy) {
    const atual = motoboyStatsMap.get(p.motoboyId) || { motoboyId: p.motoboyId, motoboyNome: p.motoboy.nome, entregas: 0, somaNotas: 0, qtdNotas: 0 };
    atual.entregas += 1;
    if (p.notaMotoboy != null) {
      atual.somaNotas += p.notaMotoboy;
      atual.qtdNotas += 1;
    }
    motoboyStatsMap.set(p.motoboyId, atual);
  }
  const topMotoboys = Array.from(motoboyStatsMap.values())
    .map((m) => ({
      motoboyId: m.motoboyId,
      motoboyNome: m.motoboyNome,
      entregas: m.entregas,
      avaliacaoMedia: m.qtdNotas > 0 ? m.somaNotas / m.qtdNotas : null,
    }))
    .sort((a, b) => b.entregas - a.entregas)
    .slice(0, 10);

  // Status das entregas em tempo real — sempre "hoje", independente do período selecionado.
  const hojeInicio = new Date();
  hojeInicio.setHours(0, 0, 0, 0);
  const hojeFim = new Date();
  hojeFim.setHours(23, 59, 59, 999);
  const statusHojeRaw = await prisma.pedido.groupBy({
    by: ['status'],
    where: { empresaId, createdAt: { gte: hojeInicio, lte: hojeFim } },
    _count: { _all: true },
  });
  const statusHoje = statusHojeRaw.map((s) => ({ status: s.status, quantidade: s._count._all }));

  // RFM (recência/frequência/valor) — sempre calculado sobre o histórico completo do cliente
  // (não só o período selecionado), porque "em risco"/"perdidos" só fazem sentido olhando pra trás.
  const rfmGroup = await prisma.pedido.groupBy({
    by: ['clienteId'],
    where: { empresaId, status: 'ENTREGUE', clienteId: { not: null } },
    _count: { _all: true },
    _sum: { total: true },
    _max: { createdAt: true },
  });
  const clientesInfo = rfmGroup.length > 0
    ? await prisma.cliente.findMany({ where: { id: { in: rfmGroup.map((g) => g.clienteId) } }, select: { id: true, nome: true } })
    : [];
  const nomeClienteMap = new Map(clientesInfo.map((c) => [c.id, c.nome]));
  const agoraMs = Date.now();
  const baseRfm = rfmGroup.map((g) => ({
    clienteId: g.clienteId,
    nome: nomeClienteMap.get(g.clienteId) || 'Cliente',
    frequencia: g._count._all,
    monetario: Number(g._sum.total || 0),
    recenciaDias: Math.floor((agoraMs - g._max.createdAt.getTime()) / 86400000),
  }));
  const rfmClassificado = calcularRfm(baseRfm);
  const rfm = Object.keys(RFM_SEGMENT_LABELS).map((segmento) => ({
    segmento,
    label: RFM_SEGMENT_LABELS[segmento],
    quantidade: rfmClassificado.filter((c) => c.segmento === segmento).length,
  }));

  // Avaliações recentes — sempre as mais recentes de fato, independente do período selecionado.
  const avaliacoesRecentes = await prisma.pedido.findMany({
    where: { empresaId, notaPedido: { not: null } },
    select: { id: true, numero: true, clienteNome: true, notaPedido: true, comentarioPedido: true, avaliadoEm: true },
    orderBy: { avaliadoEm: 'desc' },
    take: 8,
  });

  // Resumo financeiro real: saldo de caixa físico (não repasse — cada loja usa gateway próprio,
  // o dinheiro cai direto pra ela, não existe repasse SaltFood→loja nesse modelo).
  const sessaoAberta = await prisma.caixaSessao.findFirst({ where: { empresaId, status: 'ABERTO' }, orderBy: { abertoEm: 'desc' } });
  const movimentosPeriodo = await prisma.movimentoCaixa.findMany({
    where: { empresaId, dataMovimento: { gte: de ? new Date(de) : undefined, lte: ate ? new Date(ate) : undefined } },
  });
  let entradasPeriodo = 0;
  let saidasPeriodo = 0;
  const caixaPorDiaMap = new Map();
  for (const m of movimentosPeriodo) {
    const valor = Number(m.valor);
    const dia = m.dataMovimento.toISOString().slice(0, 10);
    const atual = caixaPorDiaMap.get(dia) || { date: dia, entradas: 0, saidas: 0 };
    if (m.tipo === 'ENTRADA' || m.tipo === 'SUPRIMENTO') {
      entradasPeriodo += valor;
      atual.entradas += valor;
    } else if (m.tipo === 'SAIDA' || m.tipo === 'SANGRIA') {
      saidasPeriodo += valor;
      atual.saidas += valor;
    }
    caixaPorDiaMap.set(dia, atual);
  }
  const caixaPorDia = Array.from(caixaPorDiaMap.values())
    .map((d) => ({ ...d, saldo: d.entradas - d.saidas }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const caixa = {
    sessaoAberta: sessaoAberta
      ? { operadorNome: sessaoAberta.operadorNome, abertoEm: sessaoAberta.abertoEm, fundoTroco: Number(sessaoAberta.fundoTroco) }
      : null,
    entradasPeriodo,
    saidasPeriodo,
    saldoPeriodo: entradasPeriodo - saidasPeriodo,
    porDia: caixaPorDia,
  };

  // Alertas com dado real — "motoboy inativo" fica de fora: não existe last-seen além da posição
  // GPS ao vivo, então não dá pra afirmar "inativo" honestamente.
  const produtosComEstoqueMinimo = await prisma.produto.findMany({
    where: { empresaId, controlarEstoque: true, estoqueMinimo: { not: null } },
    select: { id: true, nome: true, estoqueQtd: true, estoqueMinimo: true },
  });
  const estoqueBaixo = produtosComEstoqueMinimo
    .filter((p) => (p.estoqueQtd ?? 0) <= p.estoqueMinimo)
    .map((p) => ({ produtoId: p.id, nome: p.nome, estoqueQtd: p.estoqueQtd ?? 0, estoqueMinimo: p.estoqueMinimo }));

  let pedidosAtrasados = [];
  if (prazoMaxMin) {
    const emAndamento = await prisma.pedido.findMany({
      where: { empresaId, status: { in: ['RECEBIDO', 'PREPARANDO', 'SAIU_ENTREGA'] } },
      select: { id: true, numero: true, createdAt: true },
    });
    pedidosAtrasados = emAndamento
      .filter((p) => (agoraMs - p.createdAt.getTime()) / 60000 > prazoMaxMin)
      .map((p) => ({ pedidoId: p.id, numero: p.numero, minutosDesdeOPedido: Math.round((agoraMs - p.createdAt.getTime()) / 60000) }));
  }

  const catorzeDiasAtras = new Date(agoraMs - 14 * 24 * 60 * 60 * 1000);
  const avaliacoesNegativas = await prisma.pedido.findMany({
    where: { empresaId, notaPedido: { lte: 2 }, avaliadoEm: { gte: catorzeDiasAtras } },
    select: { id: true, numero: true, notaPedido: true, comentarioPedido: true, avaliadoEm: true },
    orderBy: { avaliadoEm: 'desc' },
    take: 10,
  });

  res.json({
    porDia,
    porCategoria,
    tempoMedioEntregaMin,
    entregasNoPrazoPercent,
    cancelamentosPercent,
    clientesAtivos,
    pedidosPorClienteAtivo,
    taxaRecompraPercent,
    heatmap,
    funil,
    topMotoboys,
    statusHoje,
    rfm,
    avaliacoesRecentes,
    caixa,
    alertas: { estoqueBaixo, pedidosAtrasados, avaliacoesNegativas },
  });
}));

module.exports = router;
