const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { requireEmpresaAdmin, requireGrupo } = require('../lib/auth');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);
router.use(requireEmpresaAdmin());
router.use(requireGrupo('financeiro'));

const todayStr = () => new Date().toISOString().slice(0, 10);

/** Soma de MovimentoCaixa por tipo(s), num intervalo de datas (strings YYYY-MM-DD), mesmo padrão de filtro já usado em GET /movimentos-caixa. */
const somaMovimentos = async (empresaId, tipos, deStr, ateStr) => {
  const agg = await prisma.movimentoCaixa.aggregate({
    where: { empresaId, tipo: { in: tipos }, dataMovimento: { gte: new Date(deStr), lte: new Date(ateStr) } },
    _sum: { valor: true },
  });
  return Number(agg._sum.valor || 0);
};

const diaAnterior = (str) => {
  const d = new Date(`${str}T00:00:00`);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
};

/** Calcula o intervalo anterior de mesma duração (em dias) que [deStr, ateStr], pra variação percentual. */
const periodoAnterior = (deStr, ateStr) => {
  const de = new Date(`${deStr}T00:00:00`);
  const ate = new Date(`${ateStr}T00:00:00`);
  const duracaoDias = Math.round((ate.getTime() - de.getTime()) / 86400000) + 1;
  const anteAte = diaAnterior(deStr);
  const anteAteDate = new Date(`${anteAte}T00:00:00`);
  const anteDeDate = new Date(anteAteDate);
  anteDeDate.setDate(anteDeDate.getDate() - (duracaoDias - 1));
  return { deStr: anteDeDate.toISOString().slice(0, 10), ateStr: anteAte };
};

/**
 * @openapi
 * /empresas/{empresaId}/financeiro/resumo:
 *   get:
 *     summary: Resumo financeiro completo — entradas/saídas/saldo com variação vs período anterior, fluxo de caixa (por hora hoje, por dia últimos 30 dias), formas de pagamento, categorias de saída, movimentações recentes, recebimentos futuros agendados, resumo geral, top produtos e alertas
 *     tags: [Financeiro]
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
 *         description: Resumo financeiro
 */
router.get('/resumo', asyncHandler(async (req, res) => {
  const empresaId = req.params.empresaId;
  const deStr = req.query.de || todayStr();
  const ateStr = req.query.ate || todayStr();
  const { deStr: deAnteriorStr, ateStr: ateAnteriorStr } = periodoAnterior(deStr, ateStr);

  const inicioAtual = new Date(`${deStr}T00:00:00`);
  const fimAtual = new Date(`${ateStr}T23:59:59.999`);
  const inicioAnterior = new Date(`${deAnteriorStr}T00:00:00`);
  const fimAnterior = new Date(`${ateAnteriorStr}T23:59:59.999`);

  const [entradasAtual, entradasAnterior, saidasAtual, saidasAnterior] = await Promise.all([
    somaMovimentos(empresaId, ['ENTRADA'], deStr, ateStr),
    somaMovimentos(empresaId, ['ENTRADA'], deAnteriorStr, ateAnteriorStr),
    somaMovimentos(empresaId, ['SAIDA', 'SANGRIA'], deStr, ateStr),
    somaMovimentos(empresaId, ['SAIDA', 'SANGRIA'], deAnteriorStr, ateAnteriorStr),
  ]);

  const buscarEntregues = (inicio, fim) => prisma.pedido.findMany({
    where: { empresaId, status: 'ENTREGUE', createdAt: { gte: inicio, lte: fim } },
    include: { itens: true },
  });
  const [entreguesAtual, entreguesAnterior, canceladosAtual, canceladosAnterior, totalAtual, totalAnterior] = await Promise.all([
    buscarEntregues(inicioAtual, fimAtual),
    buscarEntregues(inicioAnterior, fimAnterior),
    prisma.pedido.count({ where: { empresaId, status: 'CANCELADO', createdAt: { gte: inicioAtual, lte: fimAtual } } }),
    prisma.pedido.count({ where: { empresaId, status: 'CANCELADO', createdAt: { gte: inicioAnterior, lte: fimAnterior } } }),
    prisma.pedido.count({ where: { empresaId, createdAt: { gte: inicioAtual, lte: fimAtual } } }),
    prisma.pedido.count({ where: { empresaId, createdAt: { gte: inicioAnterior, lte: fimAnterior } } }),
  ]);

  const ticketMedioDe = (entregues) => (entregues.length > 0 ? entregues.reduce((s, p) => s + Number(p.total), 0) / entregues.length : 0);
  const taxaCancelamentoDe = (cancelados, total) => (total > 0 ? (cancelados / total) * 100 : 0);

  const stats = {
    entradas: { atual: entradasAtual, anterior: entradasAnterior },
    saidas: { atual: saidasAtual, anterior: saidasAnterior },
    saldo: { atual: entradasAtual - saidasAtual, anterior: entradasAnterior - saidasAnterior },
    pedidosPagos: { atual: entreguesAtual.length, anterior: entreguesAnterior.length },
    ticketMedio: { atual: ticketMedioDe(entreguesAtual), anterior: ticketMedioDe(entreguesAnterior) },
    taxaCancelamentoPercent: { atual: taxaCancelamentoDe(canceladosAtual, totalAtual), anterior: taxaCancelamentoDe(canceladosAnterior, totalAnterior) },
  };

  // Fluxo de caixa por hora — sempre hoje (dataMovimento não guarda hora, então usa createdAt).
  const inicioHoje = new Date(`${todayStr()}T00:00:00`);
  const fimHoje = new Date(`${todayStr()}T23:59:59.999`);
  const movimentosHoje = await prisma.movimentoCaixa.findMany({
    where: { empresaId, tipo: { in: ['ENTRADA', 'SAIDA', 'SANGRIA'] }, createdAt: { gte: inicioHoje, lte: fimHoje } },
    select: { tipo: true, valor: true, createdAt: true },
  });
  const porHoraMap = new Map();
  for (const m of movimentosHoje) {
    const h = m.createdAt.getHours();
    const atual = porHoraMap.get(h) || { entradas: 0, saidas: 0 };
    if (m.tipo === 'ENTRADA') atual.entradas += Number(m.valor);
    else atual.saidas += Number(m.valor);
    porHoraMap.set(h, atual);
  }
  let acumuladoHora = 0;
  const fluxoPorHora = Array.from({ length: 24 }, (_, hora) => {
    const v = porHoraMap.get(hora) || { entradas: 0, saidas: 0 };
    acumuladoHora += v.entradas - v.saidas;
    return { hora, entradas: v.entradas, saidas: v.saidas, saldoAcumulado: acumuladoHora };
  });

  // Fluxo de caixa por dia — últimos 30 dias corridos, terminando hoje.
  const inicio30 = new Date();
  inicio30.setDate(inicio30.getDate() - 29);
  const inicio30Str = inicio30.toISOString().slice(0, 10);
  const movimentos30Dias = await prisma.movimentoCaixa.findMany({
    where: { empresaId, tipo: { in: ['ENTRADA', 'SAIDA', 'SANGRIA'] }, dataMovimento: { gte: new Date(inicio30Str), lte: new Date(todayStr()) } },
    select: { tipo: true, valor: true, dataMovimento: true },
  });
  const porDiaMap = new Map();
  for (const m of movimentos30Dias) {
    const dia = m.dataMovimento.toISOString().slice(0, 10);
    const atual = porDiaMap.get(dia) || { entradas: 0, saidas: 0 };
    if (m.tipo === 'ENTRADA') atual.entradas += Number(m.valor);
    else atual.saidas += Number(m.valor);
    porDiaMap.set(dia, atual);
  }
  let acumuladoDia = 0;
  const fluxoPorDia = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(inicio30);
    d.setDate(d.getDate() + i);
    const dia = d.toISOString().slice(0, 10);
    const v = porDiaMap.get(dia) || { entradas: 0, saidas: 0 };
    acumuladoDia += v.entradas - v.saidas;
    return { data: dia, entradas: v.entradas, saidas: v.saidas, saldoAcumulado: acumuladoDia };
  });

  // Entradas por forma de pagamento — só os valores reais do enum (PIX/DINHEIRO/CARTAO/MULTIPLO), sem inventar crédito/débito/online separados.
  const entradasPorFormaRaw = await prisma.movimentoCaixa.groupBy({
    by: ['formaPagamento'],
    where: { empresaId, tipo: 'ENTRADA', dataMovimento: { gte: new Date(deStr), lte: new Date(ateStr) }, formaPagamento: { not: null } },
    _sum: { valor: true },
  });
  const entradasPorFormaPagamento = entradasPorFormaRaw.map((r) => ({ formaPagamento: r.formaPagamento, valor: Number(r._sum.valor || 0) }));

  // Saídas por categoria — motoboy e sangria já se distinguem por campo próprio; o resto usa a categoria opcional (ou "OUTROS" quando não informada).
  const saidasPeriodo = await prisma.movimentoCaixa.findMany({
    where: { empresaId, tipo: { in: ['SAIDA', 'SANGRIA'] }, dataMovimento: { gte: new Date(deStr), lte: new Date(ateStr) } },
    select: { tipo: true, motoboyId: true, categoria: true, valor: true },
  });
  const categorias = { MOTOBOYS: 0, SANGRIAS: 0, COMPRAS_ESTOQUE: 0, TAXAS_TARIFAS: 0, OUTROS: 0 };
  for (const m of saidasPeriodo) {
    const valor = Number(m.valor);
    if (m.tipo === 'SANGRIA') categorias.SANGRIAS += valor;
    else if (m.motoboyId) categorias.MOTOBOYS += valor;
    else if (m.categoria === 'COMPRAS_ESTOQUE') categorias.COMPRAS_ESTOQUE += valor;
    else if (m.categoria === 'TAXAS_TARIFAS') categorias.TAXAS_TARIFAS += valor;
    else categorias.OUTROS += valor;
  }
  const saidasPorCategoria = Object.entries(categorias).map(([categoria, valor]) => ({ categoria, valor }));

  // Movimentações recentes — últimas 15, com nome do cliente/pedido quando vier de uma venda.
  const recentes = await prisma.movimentoCaixa.findMany({
    where: { empresaId, tipo: { in: ['ENTRADA', 'SAIDA', 'SANGRIA'] } },
    orderBy: { createdAt: 'desc' },
    take: 15,
    include: { pedido: { select: { numero: true, clienteNome: true } } },
  });
  const movimentacoesRecentes = recentes.map((m) => ({
    id: m.id,
    tipo: m.tipo,
    descricao: m.pedido ? `Pedido #${m.pedido.numero}${m.pedido.clienteNome ? ` — ${m.pedido.clienteNome}` : ''}` : (m.descricao || '—'),
    categoria: m.tipo === 'SANGRIA' ? 'SANGRIAS' : m.motoboyId ? 'MOTOBOYS' : (m.categoria || (m.pedidoId ? null : 'OUTROS')),
    formaPagamento: m.formaPagamento,
    valor: Number(m.valor),
    data: m.createdAt,
    usuario: m.pedidoId ? 'Sistema' : 'Admin',
    pedidoNumero: m.pedido?.numero ?? null,
  }));

  // Recebimentos futuros — pedidos agendados (Empresa.agendadoPara) ainda não entregues/cancelados.
  const agora = new Date();
  const hojeFim = new Date(`${todayStr()}T23:59:59.999`);
  const amanha = new Date(agora);
  amanha.setDate(amanha.getDate() + 1);
  const amanhaFim = new Date(`${amanha.toISOString().slice(0, 10)}T23:59:59.999`);
  const fimSemana = new Date(agora);
  fimSemana.setDate(fimSemana.getDate() + 7);

  const agendados = await prisma.pedido.findMany({
    where: { empresaId, agendadoPara: { gte: agora, lte: fimSemana }, status: { notIn: ['ENTREGUE', 'CANCELADO'] } },
    select: { total: true, agendadoPara: true },
  });
  const somaAgendados = (filtro) => {
    const lista = agendados.filter(filtro);
    return { valor: lista.reduce((s, p) => s + Number(p.total), 0), pedidos: lista.length };
  };
  const recebimentosFuturos = {
    hoje: somaAgendados((p) => p.agendadoPara <= hojeFim),
    amanha: somaAgendados((p) => p.agendadoPara > hojeFim && p.agendadoPara <= amanhaFim),
    semana: somaAgendados((p) => p.agendadoPara > amanhaFim),
    total: agendados.reduce((s, p) => s + Number(p.total), 0),
  };

  // Resumo geral do período + lucro bruto estimado (entradas - custos diretos: compras/estoque + taxas, excluindo repasse a motoboy e sangria, que não são custo de mercadoria).
  const entradasTotais = entradasAtual;
  const saidasTotais = saidasAtual;
  const lucroBrutoEstimado = entradasTotais - (categorias.COMPRAS_ESTOQUE + categorias.TAXAS_TARIFAS);
  const resumoGeral = {
    entradasTotais,
    saidasTotais,
    saldoLiquido: entradasTotais - saidasTotais,
    lucroBrutoEstimado,
  };

  // Top produtos por faturamento no período — mesmo padrão de agregação de crm.js.
  const produtoMap = new Map();
  for (const p of entreguesAtual) {
    for (const item of p.itens) {
      const atual = produtoMap.get(item.produtoId) || { produtoId: item.produtoId, nome: item.nomeProduto, quantidade: 0, receita: 0 };
      atual.quantidade += item.quantidade;
      atual.receita += Number(item.precoUnitario) * item.quantidade;
      produtoMap.set(item.produtoId, atual);
    }
  }
  const topProdutos = Array.from(produtoMap.values()).sort((a, b) => b.receita - a.receita).slice(0, 5);

  // Alertas financeiros com dado real.
  const pendentesMotoboy = await prisma.pedido.findMany({
    where: { empresaId, status: 'ENTREGUE', motoboyId: { not: null }, motoboyPago: false },
    select: { taxaEntregaMotoboy: true },
  });
  const pagamentosAguardandoConfirmacao = await prisma.pedido.count({
    where: { empresaId, status: { notIn: ['CANCELADO'] }, pagamentoConfirmado: false },
  });
  const produtosComEstoqueMinimo = await prisma.produto.findMany({
    where: { empresaId, controlarEstoque: true, estoqueMinimo: { not: null } },
    select: { id: true, nome: true, estoqueQtd: true, estoqueMinimo: true },
  });
  const estoqueBaixo = produtosComEstoqueMinimo
    .filter((p) => (p.estoqueQtd ?? 0) <= p.estoqueMinimo)
    .map((p) => ({ produtoId: p.id, nome: p.nome, estoqueQtd: p.estoqueQtd ?? 0, estoqueMinimo: p.estoqueMinimo }));

  const sangriaHoje = await somaMovimentos(empresaId, ['SANGRIA'], todayStr(), todayStr());
  const trintaDiasAtras = new Date();
  trintaDiasAtras.setDate(trintaDiasAtras.getDate() - 30);
  const sangriasUltimos30 = await prisma.movimentoCaixa.aggregate({
    where: { empresaId, tipo: 'SANGRIA', dataMovimento: { gte: trintaDiasAtras, lte: new Date(todayStr()) } },
    _sum: { valor: true },
  });
  const mediaSangriaDiaria = Number(sangriasUltimos30._sum.valor || 0) / 30;

  const alertas = {
    motoboysPendentes: { quantidade: pendentesMotoboy.length, valor: pendentesMotoboy.reduce((s, p) => s + Number(p.taxaEntregaMotoboy || 0), 0) },
    pagamentosAguardandoConfirmacao,
    estoqueBaixo,
    sangriaAcimaDaMedia: mediaSangriaDiaria > 0 && sangriaHoje > mediaSangriaDiaria * 1.5
      ? { hoje: sangriaHoje, media: mediaSangriaDiaria }
      : null,
  };

  res.json({
    periodo: { de: deStr, ate: ateStr },
    stats,
    fluxoPorHora,
    fluxoPorDia,
    entradasPorFormaPagamento,
    saidasPorCategoria,
    movimentacoesRecentes,
    recebimentosFuturos,
    resumoGeral,
    topProdutos,
    alertas,
  });
}));

/** Progresso "hoje" de uma meta a partir de dado real, sem tabela de log — recalculado a cada chamada. */
const progressoMeta = async (empresaId, tipo, produtoId) => {
  const hoje = new Date(`${todayStr()}T00:00:00`);
  const amanha = new Date(hoje);
  amanha.setDate(amanha.getDate() + 1);

  if (tipo === 'PRODUTO') {
    const itens = await prisma.pedidoItem.findMany({
      where: { produtoId, pedido: { empresaId, status: 'ENTREGUE', entregueEm: { gte: hoje, lt: amanha } } },
      select: { quantidade: true },
    });
    return itens.reduce((s, i) => s + i.quantidade, 0);
  }

  const entreguesHoje = await prisma.pedido.findMany({
    where: { empresaId, status: 'ENTREGUE', entregueEm: { gte: hoje, lt: amanha } },
    select: { total: true },
  });
  if (tipo === 'PEDIDOS') return entreguesHoje.length;
  const faturamento = entreguesHoje.reduce((s, p) => s + Number(p.total), 0);
  if (tipo === 'FATURAMENTO') return faturamento;
  if (tipo === 'TICKET_MEDIO') return entreguesHoje.length > 0 ? faturamento / entreguesHoje.length : 0;
  return 0;
};

/**
 * @openapi
 * /empresas/{empresaId}/financeiro/extrato:
 *   get:
 *     summary: Extrato cronológico — movimentos de caixa (vendas, sangrias, suprimentos) + contas a pagar/receber já baixadas no período, com saldo corrente
 *     tags: [Financeiro]
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
 *         description: Extrato com saldo corrente
 */
router.get('/extrato', asyncHandler(async (req, res) => {
  const empresaId = req.params.empresaId;
  const deStr = req.query.de || todayStr();
  const ateStr = req.query.ate || todayStr();
  const inicio = new Date(`${deStr}T00:00:00`);
  const fim = new Date(`${ateStr}T23:59:59.999`);

  const [movimentos, pagas, recebidas] = await Promise.all([
    prisma.movimentoCaixa.findMany({
      where: { empresaId, dataMovimento: { gte: inicio, lte: fim } },
      orderBy: { dataMovimento: 'asc' },
    }),
    prisma.contaPagar.findMany({
      where: { empresaId, status: 'PAGO', pagoEm: { gte: inicio, lte: fim } },
      orderBy: { pagoEm: 'asc' },
    }),
    prisma.contaReceber.findMany({
      where: { empresaId, status: 'PAGO', recebidoEm: { gte: inicio, lte: fim } },
      orderBy: { recebidoEm: 'asc' },
    }),
  ]);

  const lancamentos = [
    ...movimentos.map((m) => ({
      id: `movimento-${m.id}`,
      data: m.dataMovimento,
      origem: 'CAIXA',
      tipo: m.tipo,
      descricao: m.descricao || (m.tipo === 'ENTRADA' ? 'Venda' : m.tipo),
      valor: Number(m.valor),
      sinal: m.tipo === 'ENTRADA' ? 1 : -1,
    })),
    ...pagas.map((c) => ({
      id: `conta-pagar-${c.id}`,
      data: c.pagoEm,
      origem: 'CONTA_PAGAR',
      tipo: 'SAIDA',
      descricao: c.descricao,
      valor: Number(c.valor),
      sinal: -1,
    })),
    ...recebidas.map((c) => ({
      id: `conta-receber-${c.id}`,
      data: c.recebidoEm,
      origem: 'CONTA_RECEBER',
      tipo: 'ENTRADA',
      descricao: c.descricao,
      valor: Number(c.valor),
      sinal: 1,
    })),
  ].sort((a, b) => new Date(a.data).getTime() - new Date(b.data).getTime());

  let saldo = 0;
  const extrato = lancamentos.map((l) => {
    saldo += l.sinal * l.valor;
    return { ...l, saldoAcumulado: saldo };
  });

  res.json({ lancamentos: extrato, saldoFinal: saldo });
}));

/**
 * @openapi
 * /empresas/{empresaId}/financeiro/metas:
 *   get:
 *     summary: Metas do dia (Faturamento/Pedidos/Ticket médio + metas por produto) com progresso real de hoje
 *     tags: [Financeiro]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Metas com progresso
 */
router.get('/metas', asyncHandler(async (req, res) => {
  const empresaId = req.params.empresaId;
  const metas = await prisma.meta.findMany({ where: { empresaId }, include: { produto: { select: { nome: true } } } });

  const agregadas = {};
  for (const tipo of ['FATURAMENTO', 'PEDIDOS', 'TICKET_MEDIO']) {
    const meta = metas.find((m) => m.tipo === tipo);
    agregadas[tipo] = { valorAlvo: meta ? Number(meta.valorAlvo) : 0, atual: await progressoMeta(empresaId, tipo) };
  }

  const produtos = [];
  for (const m of metas.filter((m) => m.tipo === 'PRODUTO')) {
    produtos.push({
      produtoId: m.produtoId,
      nome: m.produto?.nome || '—',
      valorAlvo: Number(m.valorAlvo),
      atual: await progressoMeta(empresaId, 'PRODUTO', m.produtoId),
    });
  }

  res.json({ faturamento: agregadas.FATURAMENTO, pedidos: agregadas.PEDIDOS, ticketMedio: agregadas.TICKET_MEDIO, produtos });
}));

/**
 * @openapi
 * /empresas/{empresaId}/financeiro/metas:
 *   put:
 *     summary: Define as metas do dia (Faturamento/Pedidos/Ticket médio e a lista de metas por produto, que substitui a lista anterior por completo)
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
 *             properties:
 *               faturamento: { type: number, nullable: true }
 *               pedidos: { type: number, nullable: true }
 *               ticketMedio: { type: number, nullable: true }
 *               produtos:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [produtoId, valorAlvo]
 *                   properties:
 *                     produtoId: { type: string, format: uuid }
 *                     valorAlvo: { type: number }
 *     responses:
 *       200:
 *         description: Metas salvas
 */
router.put('/metas', asyncHandler(async (req, res) => {
  const empresaId = req.params.empresaId;
  const { faturamento, pedidos, ticketMedio, produtos } = req.body;

  const upsertAgregada = async (tipo, valor) => {
    if (valor === undefined) return;
    const existente = await prisma.meta.findFirst({ where: { empresaId, tipo, produtoId: null } });
    if (valor === null) {
      if (existente) await prisma.meta.delete({ where: { id: existente.id } });
      return;
    }
    const numero = Number(valor);
    if (Number.isNaN(numero) || numero < 0) {
      throw Object.assign(new Error(`Meta "${tipo}" deve ser um número maior ou igual a zero`), { status: 400 });
    }
    if (existente) {
      await prisma.meta.update({ where: { id: existente.id }, data: { valorAlvo: numero } });
    } else {
      await prisma.meta.create({ data: { empresaId, tipo, valorAlvo: numero } });
    }
  };

  try {
    await upsertAgregada('FATURAMENTO', faturamento);
    await upsertAgregada('PEDIDOS', pedidos);
    await upsertAgregada('TICKET_MEDIO', ticketMedio);

    if (Array.isArray(produtos)) {
      for (const p of produtos) {
        if (!p.produtoId || Number.isNaN(Number(p.valorAlvo)) || Number(p.valorAlvo) < 0) {
          return res.status(400).json({ error: 'Cada meta de produto precisa de "produtoId" e "valorAlvo" (número maior ou igual a zero)' });
        }
      }
      const produto = await prisma.produto.findMany({ where: { empresaId, id: { in: produtos.map((p) => p.produtoId) } }, select: { id: true } });
      const idsValidos = new Set(produto.map((p) => p.id));
      if (produtos.some((p) => !idsValidos.has(p.produtoId))) {
        return res.status(400).json({ error: 'Um dos produtos informados não pertence a esta empresa' });
      }
      await prisma.meta.deleteMany({ where: { empresaId, tipo: 'PRODUTO' } });
      if (produtos.length > 0) {
        await prisma.meta.createMany({
          data: produtos.map((p) => ({ empresaId, tipo: 'PRODUTO', produtoId: p.produtoId, valorAlvo: Number(p.valorAlvo) })),
        });
      }
    }
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    throw err;
  }

  res.json({ ok: true });
}));

module.exports = router;
