const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const validarCupom = require('../lib/validarCupom');
const { calcularStatusLoja } = require('../lib/statusLoja');
const { calcularFrete } = require('../lib/calcularFrete');
const { disponibilidadeFidelidade } = require('../lib/fidelidade');
const { creditarCoins, debitarCoins } = require('../lib/coins');
const { notificarPedido } = require('../lib/pushNotifications');
const { criarNotificacaoCliente } = require('../lib/notificacoesCliente');
const { requireEmpresaAdmin, requireCliente } = require('../lib/auth');
const { montarItensPedido, decrementarEstoque, ErroPedidoItens } = require('../lib/pedidoItens');
const { finalizarComoEntregue } = require('../lib/pedidoFinalizacao');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);

const STATUS_VALIDOS = ['RECEBIDO', 'PREPARANDO', 'SAIU_ENTREGA', 'ENTREGUE', 'CANCELADO'];
const FORMAS_PAGAMENTO_VALIDAS = ['PIX', 'DINHEIRO', 'CARTAO'];
const TIPOS_PEDIDO_VALIDOS = ['DELIVERY', 'BALCAO', 'MESA', 'RETIRADA'];

const TIMESTAMP_POR_STATUS = {
  PREPARANDO: 'preparandoEm',
  SAIU_ENTREGA: 'saiuEntregaEm',
  ENTREGUE: 'entregueEm',
  CANCELADO: 'canceladoEm',
};

/**
 * Próxima transição de status válida a partir da atual, indexado por tipo de pedido: DELIVERY
 * mantém o fluxo com etapa de entrega; BALCAO/MESA/RETIRADA pulam direto pra ENTREGUE (não tem
 * "saiu pra entrega" pra esses casos).
 */
const PROXIMOS_STATUS_VALIDOS_POR_TIPO = {
  DELIVERY: {
    RECEBIDO: ['PREPARANDO', 'CANCELADO'],
    PREPARANDO: ['SAIU_ENTREGA', 'CANCELADO'],
    SAIU_ENTREGA: ['ENTREGUE', 'CANCELADO'],
    ENTREGUE: [],
    CANCELADO: [],
  },
  PDV: {
    RECEBIDO: ['PREPARANDO', 'ENTREGUE', 'CANCELADO'],
    PREPARANDO: ['ENTREGUE', 'CANCELADO'],
    ENTREGUE: [],
    CANCELADO: [],
  },
};
const proximosStatusValidos = (tipoPedido) =>
  PROXIMOS_STATUS_VALIDOS_POR_TIPO[tipoPedido === 'DELIVERY' ? 'DELIVERY' : 'PDV'];

/**
 * @openapi
 * components:
 *   schemas:
 *     PedidoItemInput:
 *       type: object
 *       required: [produtoId, quantidade]
 *       properties:
 *         produtoId: { type: string, format: uuid }
 *         quantidade: { type: integer }
 *         observacoes: { type: string }
 *     PedidoInput:
 *       type: object
 *       required: [clienteNome, clienteTelefone, endereco, formaPagamento, itens]
 *       properties:
 *         clienteNome: { type: string }
 *         clienteTelefone: { type: string }
 *         endereco: { type: string }
 *         bairro: { type: string }
 *         referencia: { type: string }
 *         formaPagamento: { type: string, enum: [PIX, DINHEIRO, CARTAO] }
 *         trocoPara: { type: number }
 *         observacoes: { type: string }
 *         clienteId: { type: string, format: uuid }
 *         usarItemGratis: { type: boolean }
 *         cupomCodigo: { type: string }
 *         itens:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/PedidoItemInput'
 */

/**
 * @openapi
 * /empresas/{empresaId}/pedidos:
 *   get:
 *     summary: Lista os pedidos da empresa
 *     tags: [Pedidos]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [RECEBIDO, PREPARANDO, SAIU_ENTREGA, ENTREGUE, CANCELADO] }
 *       - in: query
 *         name: motoboyId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: motoboyPago
 *         schema: { type: boolean }
 *       - in: query
 *         name: de
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: ate
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: Lista de pedidos
 */
router.get('/', asyncHandler(async (req, res) => {
  // Admin da loja pode filtrar por qualquer motoboyId; o portal do motoboy só pode ver os
  // próprios pedidos — o id vem do token, nunca da query, pra um motoboy não listar corridas de outro.
  if (!req.auth || !['EMPRESA_ADMIN', 'MOTOBOY'].includes(req.auth.role)) {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  if (req.auth.empresaId !== req.params.empresaId) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  if (req.empresa && !req.empresa.empresaAtiva) {
    return res.status(403).json({ error: 'Acesso desativado. Fale com o suporte da plataforma.' });
  }
  const motoboyIdFiltro = req.auth.role === 'MOTOBOY' ? req.auth.motoboyId : req.query.motoboyId;

  const { status, motoboyPago, de, ate, tipoPedido } = req.query;

  if (status && !STATUS_VALIDOS.includes(status)) {
    return res.status(400).json({ error: `Campo "status" deve ser um de: ${STATUS_VALIDOS.join(', ')}` });
  }
  if (tipoPedido && !TIPOS_PEDIDO_VALIDOS.includes(tipoPedido)) {
    return res.status(400).json({ error: `Campo "tipoPedido" deve ser um de: ${TIPOS_PEDIDO_VALIDOS.join(', ')}` });
  }

  const where = {
    empresaId: req.params.empresaId,
    ...(status ? { status } : {}),
    ...(tipoPedido ? { tipoPedido } : {}),
    ...(motoboyIdFiltro ? { motoboyId: motoboyIdFiltro } : {}),
    ...(motoboyPago !== undefined ? { motoboyPago: motoboyPago === 'true' } : {}),
    ...(de || ate
      ? {
        createdAt: {
          ...(de ? { gte: new Date(`${de}T00:00:00`) } : {}),
          ...(ate ? { lte: new Date(`${ate}T23:59:59`) } : {}),
        },
      }
      : {}),
  };

  const pedidos = await prisma.pedido.findMany({
    where,
    include: { itens: { include: { opcoesSelecionadas: true } }, motoboy: { select: { id: true, nome: true, latitudeAtual: true, longitudeAtual: true, localizacaoAtualizadaEm: true } } },
    orderBy: { createdAt: 'desc' },
  });

  res.json(pedidos);
}));

/**
 * @openapi
 * /empresas/{empresaId}/pedidos/conferencia-motoboys:
 *   get:
 *     summary: Conferência de recebimento por motoboy — soma o valor confirmado como recebido em cada entrega, agrupado por motoboy e forma de pagamento
 *     tags: [Pedidos]
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
 *         description: Conferência por motoboy no período
 */
router.get('/conferencia-motoboys', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { de, ate } = req.query;
  const range = {
    ...(de ? { gte: new Date(`${de}T00:00:00`) } : {}),
    ...(ate ? { lte: new Date(`${ate}T23:59:59`) } : {}),
  };

  const entregues = await prisma.pedido.findMany({
    where: {
      empresaId: req.params.empresaId,
      status: 'ENTREGUE',
      motoboyId: { not: null },
      ...(de || ate ? { entregueEm: range } : {}),
    },
    include: { motoboy: { select: { id: true, nome: true } } },
  });

  const porMotoboy = new Map();
  let naoConfirmados = 0;

  for (const p of entregues) {
    if (!p.pagamentoConfirmado) {
      naoConfirmados += 1;
      continue;
    }
    const valor = Number(p.valorRecebido ?? p.total);
    if (!porMotoboy.has(p.motoboyId)) {
      porMotoboy.set(p.motoboyId, {
        motoboyId: p.motoboyId,
        motoboyNome: p.motoboy?.nome ?? 'Motoboy removido',
        entregas: 0,
        totais: { PIX: 0, DINHEIRO: 0, CARTAO: 0 },
        total: 0,
      });
    }
    const registro = porMotoboy.get(p.motoboyId);
    registro.entregas += 1;
    registro.totais[p.formaPagamento] += valor;
    registro.total += valor;
  }

  res.json({
    motoboys: Array.from(porMotoboy.values()).sort((a, b) => b.total - a.total),
    naoConfirmados,
  });
}));

/**
 * @openapi
 * /empresas/{empresaId}/pedidos/{id}:
 *   get:
 *     summary: Busca um pedido pelo id
 *     tags: [Pedidos]
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
 *         description: Pedido encontrado
 *       404:
 *         description: Pedido não encontrado
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const pedido = await prisma.pedido.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
    include: { itens: { include: { opcoesSelecionadas: true } }, motoboy: { select: { id: true, nome: true, latitudeAtual: true, longitudeAtual: true, localizacaoAtualizadaEm: true } } },
  });

  if (!pedido) {
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }

  res.json(pedido);
}));

/**
 * @openapi
 * /empresas/{empresaId}/pedidos/{id}:
 *   patch:
 *     summary: Edita dados gerais de um pedido ainda não finalizado (cliente, endereço, observações, forma de pagamento) — não mexe em itens/valores, ver POST/DELETE /itens
 *     tags: [Pedidos]
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
 *         description: Pedido atualizado
 *       400:
 *         description: Pedido já finalizado ou dados inválidos
 *       404:
 *         description: Pedido não encontrado
 */
router.patch('/:id', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { clienteNome, clienteTelefone, endereco, bairro, referencia, observacoes, formaPagamento, trocoPara } = req.body;

  const pedido = await prisma.pedido.findFirst({ where: { id: req.params.id, empresaId: req.params.empresaId } });
  if (!pedido) {
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }
  if (['ENTREGUE', 'CANCELADO'].includes(pedido.status)) {
    return res.status(400).json({ error: 'Este pedido já foi finalizado e não pode mais ser editado' });
  }
  if (formaPagamento !== undefined && !FORMAS_PAGAMENTO_VALIDAS.includes(formaPagamento)) {
    return res.status(400).json({ error: `Campo "formaPagamento" deve ser um de: ${FORMAS_PAGAMENTO_VALIDAS.join(', ')}` });
  }

  const atualizado = await prisma.pedido.update({
    where: { id: pedido.id },
    data: {
      ...(clienteNome !== undefined ? { clienteNome: clienteNome || null } : {}),
      ...(clienteTelefone !== undefined ? { clienteTelefone: clienteTelefone || null } : {}),
      ...(endereco !== undefined ? { endereco: endereco || null } : {}),
      ...(bairro !== undefined ? { bairro: bairro || null } : {}),
      ...(referencia !== undefined ? { referencia: referencia || null } : {}),
      ...(observacoes !== undefined ? { observacoes: observacoes || null } : {}),
      ...(formaPagamento !== undefined ? { formaPagamento } : {}),
      ...(trocoPara !== undefined ? { trocoPara: trocoPara === null || trocoPara === '' ? null : Number(trocoPara) } : {}),
    },
    include: { itens: { include: { opcoesSelecionadas: true } }, motoboy: { select: { id: true, nome: true, latitudeAtual: true, longitudeAtual: true, localizacaoAtualizadaEm: true } } },
  });

  res.json(atualizado);
}));

/**
 * @openapi
 * /empresas/{empresaId}/pedidos:
 *   post:
 *     summary: Cria um novo pedido (checkout do cliente)
 *     tags: [Pedidos]
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
 *             $ref: '#/components/schemas/PedidoInput'
 *     responses:
 *       201:
 *         description: Pedido criado
 *       400:
 *         description: Dados inválidos
 */
router.post('/', asyncHandler(async (req, res) => {
  const {
    clienteNome, clienteTelefone, endereco, bairro, referencia,
    formaPagamento, trocoPara, observacoes, itens, usarItemGratis, cupomCodigo, agendadoPara, usarCashback, usarCoins,
    tipoPedido, mesaIdentificador,
  } = req.body;

  const souEmpresaAdmin = req.auth && req.auth.role === 'EMPRESA_ADMIN' && req.auth.empresaId === req.params.empresaId;

  // Só o PDV (autenticado como EMPRESA_ADMIN) pode criar pedido de balcão/mesa/retirada — o
  // checkout público continua sempre DELIVERY, sem nenhuma mudança de comportamento.
  const tipoPedidoFinal = tipoPedido && TIPOS_PEDIDO_VALIDOS.includes(tipoPedido) ? tipoPedido : 'DELIVERY';
  if (tipoPedido && !TIPOS_PEDIDO_VALIDOS.includes(tipoPedido)) {
    return res.status(400).json({ error: `Campo "tipoPedido" deve ser um de: ${TIPOS_PEDIDO_VALIDOS.join(', ')}` });
  }
  if (tipoPedidoFinal !== 'DELIVERY' && !souEmpresaAdmin) {
    return res.status(403).json({ error: 'Só o painel/app da loja pode criar pedidos de balcão, mesa ou retirada' });
  }

  // Checkout aceita convidado (sem login) — clienteId nunca vem do corpo da requisição de um
  // cliente qualquer, só do token de quem estiver logado como CLIENTE desta empresa, pra ninguém
  // resgatar fidelidade ou aplicar cupom de "primeira compra" em nome de outra pessoa. O PDV
  // (EMPRESA_ADMIN) já administra todos os clientes da própria loja, então pode informar um
  // clienteId explícito (ex: cliente buscado/cadastrado na hora) sem essa mesma restrição.
  const clienteId = (req.auth && req.auth.role === 'CLIENTE' && req.auth.empresaId === req.params.empresaId)
    ? req.auth.clienteId
    : (souEmpresaAdmin && req.body.clienteId) ? req.body.clienteId : null;

  const erros = [];
  if (tipoPedidoFinal === 'DELIVERY') {
    if (!clienteNome) erros.push('Campo "clienteNome" é obrigatório');
    if (!clienteTelefone) erros.push('Campo "clienteTelefone" é obrigatório');
    if (!endereco) erros.push('Campo "endereco" é obrigatório');
  }
  if (!formaPagamento || !FORMAS_PAGAMENTO_VALIDAS.includes(formaPagamento)) {
    erros.push(`Campo "formaPagamento" é obrigatório e deve ser um de: ${FORMAS_PAGAMENTO_VALIDAS.join(', ')}`);
  }
  if (!Array.isArray(itens) || itens.length === 0) {
    erros.push('O pedido precisa de ao menos um item');
  }
  let agendadoParaData = null;
  if (agendadoPara) {
    if (!req.empresa.habilitarAgendamento) {
      erros.push('Esta loja não habilitou o agendamento de pedidos');
    }
    agendadoParaData = new Date(agendadoPara);
    if (Number.isNaN(agendadoParaData.getTime()) || agendadoParaData.getTime() <= Date.now()) {
      erros.push('Campo "agendadoPara" precisa ser uma data/hora válida no futuro');
    } else {
      // Não deixa agendar pra antes do tempo mínimo de preparo/entrega que a própria loja
      // configurou (Operacional) — o front já limita isso no seletor, mas revalida aqui pra
      // ninguém contornar chamando a API direto.
      const tempoMinimoMin = req.empresa.tempoEstimadoMin ?? req.empresa.tempoEstimadoMax;
      if (tempoMinimoMin) {
        const maisCedoPermitido = Date.now() + tempoMinimoMin * 60 * 1000;
        if (agendadoParaData.getTime() < maisCedoPermitido) {
          erros.push(`O agendamento precisa ser pelo menos ${tempoMinimoMin} minutos a partir de agora (tempo mínimo de preparo/entrega desta loja)`);
        }
      }
    }
  }

  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }

  if (req.empresa.usarHorarioAutomatico) {
    const horarios = await prisma.horarioFuncionamento.findMany({ where: { empresaId: req.params.empresaId } });
    if (!calcularStatusLoja(req.empresa, horarios).aberta) {
      return res.status(400).json({ error: 'A loja está fechada no momento e não está aceitando novos pedidos.' });
    }
  } else if (!req.empresa.lojaAbertaManual) {
    return res.status(400).json({ error: 'A loja está fechada no momento e não está aceitando novos pedidos.' });
  }

  let itensParaCriar;
  let produtoPorId;
  try {
    ({ itensParaCriar, produtoPorId } = await montarItensPedido(prisma, req.params.empresaId, itens));
  } catch (err) {
    if (err instanceof ErroPedidoItens) return res.status(400).json({ error: err.message });
    throw err;
  }

  let subtotal = itensParaCriar.reduce((sum, i) => sum + Number(i.precoUnitario) * i.quantidade, 0);

  const pedidoMinimo = tipoPedidoFinal === 'DELIVERY' ? Number(req.empresa.pedidoMinimo) : 0;
  if (pedidoMinimo > 0 && subtotal < pedidoMinimo) {
    return res.status(400).json({ error: `Pedido mínimo de R$ ${pedidoMinimo.toFixed(2)}` });
  }

  let taxaEntrega = 0;
  if (tipoPedidoFinal === 'DELIVERY') {
    const zonas = await prisma.zonaEntrega.findMany({
      where: { empresaId: req.params.empresaId, tipo: 'BAIRRO', ativo: true },
    });
    ({ taxa: taxaEntrega } = calcularFrete({
      zonas,
      bairro,
      subtotal,
      taxaPadrao: req.empresa.taxaEntrega,
      freteGratisAcimaDe: req.empresa.freteGratisAcimaDe,
    }));
  }

  let cliente = null;
  let resgatouItemGratis = false;
  if (clienteId) {
    cliente = await prisma.cliente.findFirst({ where: { id: clienteId, empresaId: req.params.empresaId } });
    if (!cliente) {
      return res.status(400).json({ error: 'Cliente informado não pertence a esta empresa' });
    }
    if (usarItemGratis) {
      const { disponiveis, expirado } = disponibilidadeFidelidade(cliente, req.empresa);
      if (disponiveis <= 0) {
        return res.status(400).json({
          error: expirado ? 'O prazo para resgatar o item grátis expirou' : 'Nenhum item grátis disponível para resgate',
        });
      }
      const menorPreco = Math.min(...itensParaCriar.map((i) => Number(i.precoUnitario)));
      subtotal = Math.max(0, subtotal - menorPreco);
      resgatouItemGratis = true;
    }
  }

  let taxaEntregaFinal = taxaEntrega;
  let descontoCupom = null;
  let cupomAplicado = null;

  if (cupomCodigo) {
    const resultado = await validarCupom(prisma, req.params.empresaId, cupomCodigo, cliente?.id || null, subtotal);
    if (!resultado.ok) {
      return res.status(400).json({ error: resultado.error });
    }
    cupomAplicado = resultado.cupom;
    if (resultado.freteGratis) {
      descontoCupom = taxaEntregaFinal;
      taxaEntregaFinal = 0;
    } else {
      descontoCupom = resultado.desconto;
      subtotal = Math.max(0, subtotal - resultado.desconto);
    }
  }

  let cashbackUsadoValor = 0;
  if (usarCashback) {
    if (!cliente) {
      return res.status(400).json({ error: 'É preciso estar logado para usar o saldo de cashback' });
    }
    const valorSolicitado = Number(usarCashback);
    if (!Number.isFinite(valorSolicitado) || valorSolicitado <= 0) {
      return res.status(400).json({ error: 'Campo "usarCashback" deve ser um valor maior que zero' });
    }
    if (valorSolicitado > Number(cliente.saldoCashback)) {
      return res.status(400).json({ error: 'Saldo de cashback insuficiente' });
    }
    cashbackUsadoValor = Math.min(valorSolicitado, subtotal);
    subtotal = Math.max(0, subtotal - cashbackUsadoValor);
  }

  // SaltFood Coins — em paralelo ao cashback local acima, aplicado depois dele sobre o subtotal
  // já reduzido. Diferente do cashback (isolado por loja), o saldo de coins é compartilhado entre
  // lojas, então a checagem definitiva de saldo acontece de novo dentro da transação (debitarCoins),
  // não só aqui — evita gasto duplo em dois pedidos simultâneos em lojas diferentes.
  let coinsUsadoValor = 0;
  if (usarCoins) {
    if (!req.empresa.participaSaltfoodCoins) {
      return res.status(400).json({ error: 'Esta loja não participa do SaltFood Coins' });
    }
    if (!cliente) {
      return res.status(400).json({ error: 'É preciso estar logado para usar o saldo de SaltFood Coins' });
    }
    if (!cliente.contaPlataformaId) {
      return res.status(400).json({ error: 'Você ainda não tem uma conta SaltFood Coins vinculada' });
    }
    const valorSolicitado = Number(usarCoins);
    if (!Number.isFinite(valorSolicitado) || valorSolicitado <= 0) {
      return res.status(400).json({ error: 'Campo "usarCoins" deve ser um valor maior que zero' });
    }
    const contaPlataforma = await prisma.contaPlataforma.findUnique({ where: { id: cliente.contaPlataformaId } });
    if (!contaPlataforma || valorSolicitado > Number(contaPlataforma.saldoCoins)) {
      return res.status(400).json({ error: 'Saldo de SaltFood Coins insuficiente' });
    }
    coinsUsadoValor = Math.min(valorSolicitado, subtotal);
    subtotal = Math.max(0, subtotal - coinsUsadoValor);
  }

  const total = subtotal + taxaEntregaFinal;

  let pedido;
  try {
    pedido = await prisma.$transaction(async (tx) => {
      const ultimo = await tx.pedido.findFirst({
        where: { empresaId: req.params.empresaId },
        orderBy: { numero: 'desc' },
        select: { numero: true },
      });
      const numero = (ultimo?.numero ?? 0) + 1;

      const criado = await tx.pedido.create({
        data: {
          empresaId: req.params.empresaId,
          numero,
          tipoPedido: tipoPedidoFinal,
          mesaIdentificador: tipoPedidoFinal === 'MESA' ? (mesaIdentificador || null) : null,
          clienteNome: clienteNome || null,
          clienteTelefone: clienteTelefone || null,
          endereco: endereco || null,
          bairro: bairro || null,
          referencia: referencia || null,
          subtotal,
          taxaEntrega: taxaEntregaFinal,
          total,
          formaPagamento,
          trocoPara: trocoPara || null,
          observacoes: observacoes || null,
          agendadoPara: agendadoParaData,
          userAgent: req.headers['user-agent']?.slice(0, 300) || null,
          clienteId: cliente?.id || null,
          itemGratisResgatado: resgatouItemGratis,
          cupomId: cupomAplicado?.id || null,
          cupomCodigo: cupomAplicado?.codigo || null,
          descontoCupom,
          cashbackUsado: cashbackUsadoValor > 0 ? cashbackUsadoValor : null,
          coinsUsado: coinsUsadoValor > 0 ? coinsUsadoValor : null,
          itens: { create: itensParaCriar },
        },
        include: { itens: { include: { opcoesSelecionadas: true } }, motoboy: { select: { id: true, nome: true, latitudeAtual: true, longitudeAtual: true, localizacaoAtualizadaEm: true } } },
      });

      if (resgatouItemGratis) {
        await tx.cliente.update({
          where: { id: cliente.id },
          data: { itensGratisResgatados: { increment: 1 } },
        });
      }

      if (cashbackUsadoValor > 0) {
        await tx.cliente.update({
          where: { id: cliente.id },
          data: { saldoCashback: { decrement: cashbackUsadoValor } },
        });
      }

      if (coinsUsadoValor > 0) {
        await debitarCoins(tx, {
          contaPlataformaId: cliente.contaPlataformaId,
          empresaId: req.params.empresaId,
          clienteId: cliente.id,
          pedidoId: criado.id,
          valor: coinsUsadoValor,
        });
      }

      if (cupomAplicado) {
        await tx.cupom.update({
          where: { id: cupomAplicado.id },
          data: { usosRealizados: { increment: 1 } },
        });
      }

      await decrementarEstoque(tx, itensParaCriar, produtoPorId);

      return criado;
    });
  } catch (error) {
    if (error.message === 'SALDO_COINS_INSUFICIENTE') {
      return res.status(400).json({ error: 'Saldo de SaltFood Coins insuficiente' });
    }
    throw error;
  }

  res.status(201).json(pedido);
}));

/**
 * @openapi
 * /empresas/{empresaId}/pedidos/{id}/status:
 *   patch:
 *     summary: Avança (ou cancela) o status do pedido
 *     tags: [Pedidos]
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
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [PREPARANDO, SAIU_ENTREGA, ENTREGUE, CANCELADO] }
 *     responses:
 *       200:
 *         description: Pedido atualizado
 *       400:
 *         description: Transição de status inválida
 *       404:
 *         description: Pedido não encontrado
 */
// Admin muda pra qualquer status válido; motoboy só pode confirmar a própria entrega (ENTREGUE),
// e só do pedido que está atribuído a ele — nada além disso.
router.patch('/:id/status', asyncHandler(async (req, res, next) => {
  if (!req.auth || !['EMPRESA_ADMIN', 'MOTOBOY'].includes(req.auth.role)) {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  if (req.auth.empresaId !== req.params.empresaId) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  if (req.empresa && !req.empresa.empresaAtiva) {
    return res.status(403).json({ error: 'Acesso desativado. Fale com o suporte da plataforma.' });
  }
  if (req.auth.role === 'EMPRESA_ADMIN' && req.empresa && !req.empresa.adminAtivo) {
    return res.status(403).json({ error: 'Acesso desativado. Fale com o suporte da plataforma.' });
  }
  next();
}), asyncHandler(async (req, res) => {
  const {
    status, fotoEntrega, pagamentoRecebido, valorRecebido, pagamentos,
    descontoManual, acrescimoManual, motivoAjusteManual,
  } = req.body;
  if (!status || !STATUS_VALIDOS.includes(status)) {
    return res.status(400).json({ error: `Campo "status" é obrigatório e deve ser um de: ${STATUS_VALIDOS.join(', ')}` });
  }
  if (req.auth.role === 'MOTOBOY' && status !== 'ENTREGUE') {
    return res.status(403).json({ error: 'Motoboys só podem confirmar a entrega de um pedido' });
  }
  // Nenhuma entrega (pix, dinheiro ou cartão) pode ser concluída sem confirmar que o valor foi
  // recebido — é essa confirmação que permite depois conferir o caixa de cada motoboy.
  if (status === 'ENTREGUE' && pagamentoRecebido !== true) {
    return res.status(400).json({ error: 'Confirme que o pagamento foi recebido para concluir a entrega.' });
  }
  if (status === 'ENTREGUE' && valorRecebido != null && (typeof valorRecebido !== 'number' || !(valorRecebido > 0))) {
    return res.status(400).json({ error: 'Campo "valorRecebido" deve ser um número maior que zero' });
  }
  // Ajuste manual de valor (desconto/acréscimo avulso do PDV) — nunca vindo de um motoboy, só de
  // quem está operando a venda como EMPRESA_ADMIN.
  if ((descontoManual != null || acrescimoManual != null) && req.auth.role !== 'EMPRESA_ADMIN') {
    return res.status(403).json({ error: 'Só o admin da loja pode aplicar desconto ou acréscimo manual' });
  }
  if (descontoManual != null && (typeof descontoManual !== 'number' || descontoManual < 0)) {
    return res.status(400).json({ error: 'Campo "descontoManual" deve ser um número maior ou igual a zero' });
  }
  if (acrescimoManual != null && (typeof acrescimoManual !== 'number' || acrescimoManual < 0)) {
    return res.status(400).json({ error: 'Campo "acrescimoManual" deve ser um número maior ou igual a zero' });
  }
  // Pagamento dividido (PDV) — cada linha precisa ser uma forma "de verdade" (nunca MULTIPLO,
  // que é só o rótulo agregado quando há mais de uma linha).
  let pagamentosValidados = null;
  if (status === 'ENTREGUE' && Array.isArray(pagamentos) && pagamentos.length > 0) {
    for (const p of pagamentos) {
      if (!p || !FORMAS_PAGAMENTO_VALIDAS.includes(p.formaPagamento)) {
        return res.status(400).json({ error: `Cada pagamento precisa de uma "formaPagamento" válida: ${FORMAS_PAGAMENTO_VALIDAS.join(', ')}` });
      }
      if (typeof p.valor !== 'number' || !(p.valor > 0)) {
        return res.status(400).json({ error: 'Cada pagamento precisa de um "valor" maior que zero' });
      }
    }
    if (pagamentos.length > 1 && !req.empresa.pdvPermiteSplitPagamento) {
      return res.status(403).json({ error: 'Esta loja não habilitou dividir uma venda em mais de uma forma de pagamento' });
    }
    pagamentosValidados = pagamentos;
  }

  const pedido = await prisma.pedido.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!pedido) {
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }

  if (req.auth.role === 'MOTOBOY' && pedido.motoboyId !== req.auth.motoboyId) {
    return res.status(403).json({ error: 'Este pedido não está atribuído a você' });
  }

  if (!proximosStatusValidos(pedido.tipoPedido)[pedido.status].includes(status)) {
    return res.status(400).json({
      error: `Não é possível mudar de "${pedido.status}" para "${status}"`,
    });
  }

  // Total final considerando ajuste manual (o subtotal/taxaEntrega gravados na criação não mudam
  // — só o total pago reflete o desconto/acréscimo aplicado no fechamento).
  const totalAjustado = status === 'ENTREGUE'
    ? Number(pedido.total) - (descontoManual ?? 0) + (acrescimoManual ?? 0)
    : Number(pedido.total);
  if (status === 'ENTREGUE' && pagamentosValidados) {
    const somaPagamentos = pagamentosValidados.reduce((sum, p) => sum + p.valor, 0);
    if (Math.abs(somaPagamentos - totalAjustado) > 0.01) {
      return res.status(400).json({ error: `A soma dos pagamentos (R$ ${somaPagamentos.toFixed(2)}) não bate com o total da venda (R$ ${totalAjustado.toFixed(2)})` });
    }
  }

  const carimboCampo = TIMESTAMP_POR_STATUS[status];
  const valorRecebidoFinal = status === 'ENTREGUE'
    ? (pagamentosValidados ? pagamentosValidados.reduce((sum, p) => sum + p.valor, 0)
      : typeof valorRecebido === 'number' ? valorRecebido : Number(pedido.trocoPara ?? pedido.total))
    : undefined;
  const formaPagamentoFinal = pagamentosValidados && pagamentosValidados.length > 1
    ? 'MULTIPLO'
    : pagamentosValidados?.[0]?.formaPagamento;
  // Quando o fechamento veio com uma única linha de pagamento (não dividido), reflete o troco
  // dela também no campo flat do pedido — é o que a comanda impressa e o card do pedido leem.
  const trocoParaFinal = pagamentosValidados?.length === 1 ? pagamentosValidados[0].trocoPara : undefined;

  const atualizado = await prisma.$transaction(async (tx) => {
    let salvo = await tx.pedido.update({
      where: { id: pedido.id },
      data: {
        status,
        ...(carimboCampo ? { [carimboCampo]: new Date() } : {}),
        ...(status === 'ENTREGUE' && typeof fotoEntrega === 'string' && fotoEntrega ? { fotoEntrega } : {}),
        ...(status === 'ENTREGUE' ? {
          pagamentoConfirmado: true,
          valorRecebido: valorRecebidoFinal,
          pagamentoConfirmadoPorRole: req.auth.role,
          ...(formaPagamentoFinal ? { formaPagamento: formaPagamentoFinal } : {}),
          ...(trocoParaFinal !== undefined ? { trocoPara: trocoParaFinal } : {}),
          ...(descontoManual != null || acrescimoManual != null ? {
            descontoManual: descontoManual ?? null,
            acrescimoManual: acrescimoManual ?? null,
            motivoAjusteManual: motivoAjusteManual || null,
            total: totalAjustado,
          } : {}),
        } : {}),
      },
      include: { itens: { include: { opcoesSelecionadas: true } }, motoboy: { select: { id: true, nome: true, latitudeAtual: true, longitudeAtual: true, localizacaoAtualizadaEm: true } } },
    });

    if (status === 'ENTREGUE' && pagamentosValidados) {
      await tx.pedidoPagamento.createMany({
        data: pagamentosValidados.map((p) => ({
          pedidoId: salvo.id,
          formaPagamento: p.formaPagamento,
          valor: p.valor,
          trocoPara: p.trocoPara || null,
        })),
      });
    }

    if (status === 'ENTREGUE') {
      salvo = await finalizarComoEntregue(tx, {
        pedido: salvo,
        empresaId: req.params.empresaId,
        empresa: req.empresa,
        pagamentos: pagamentosValidados,
      });
    }

    return salvo;
  });

  // Fora da transação (I/O externo) — se o push falhar, não deve derrubar a atualização do status.
  const MENSAGEM_POR_STATUS = {
    PREPARANDO: 'Seu pedido está sendo preparado!',
    SAIU_ENTREGA: 'Seu pedido saiu para entrega!',
    ENTREGUE: 'Seu pedido foi entregue. Bom apetite! 🎉',
    CANCELADO: 'Seu pedido foi cancelado.',
  };
  if (MENSAGEM_POR_STATUS[atualizado.status]) {
    const frontOrigin = process.env.FRONT_ORIGIN || 'https://saltfood.com.br';
    const url = `${frontOrigin}/${req.empresa.slug}/pedidos/${atualizado.id}`;
    notificarPedido(atualizado.id, {
      title: `Pedido #${atualizado.numero}`,
      body: MENSAGEM_POR_STATUS[atualizado.status],
      url,
    }).catch(() => {});
    if (atualizado.clienteId && req.empresa.habilitarNotificacoesInApp) {
      criarNotificacaoCliente(atualizado.clienteId, {
        titulo: `Pedido #${atualizado.numero}`,
        corpo: MENSAGEM_POR_STATUS[atualizado.status],
        url,
      }).catch(() => {});
    }
  }

  res.json(atualizado);
}));

/**
 * @openapi
 * /empresas/{empresaId}/pedidos/{id}/itens:
 *   post:
 *     summary: Adiciona itens a um pedido já criado (mesa aberta do PDV) — não existe pra pedidos já ENTREGUE/CANCELADO
 *     tags: [Pedidos]
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
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [itens]
 *             properties:
 *               itens:
 *                 type: array
 *                 items: { $ref: '#/components/schemas/PedidoItemInput' }
 *     responses:
 *       200:
 *         description: Pedido atualizado com os itens novos
 *       400:
 *         description: Pedido já finalizado ou item inválido
 *       404:
 *         description: Pedido não encontrado
 */
router.post('/:id/itens', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { itens } = req.body;
  if (!Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({ error: 'Informe ao menos um item' });
  }

  const pedido = await prisma.pedido.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!pedido) {
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }
  if (['ENTREGUE', 'CANCELADO'].includes(pedido.status)) {
    return res.status(400).json({ error: 'Este pedido já foi finalizado e não aceita mais itens' });
  }

  let itensParaCriar;
  let produtoPorId;
  try {
    ({ itensParaCriar, produtoPorId } = await montarItensPedido(prisma, req.params.empresaId, itens));
  } catch (err) {
    if (err instanceof ErroPedidoItens) return res.status(400).json({ error: err.message });
    throw err;
  }

  const subtotalNovo = itensParaCriar.reduce((sum, i) => sum + Number(i.precoUnitario) * i.quantidade, 0);

  const atualizado = await prisma.$transaction(async (tx) => {
    await decrementarEstoque(tx, itensParaCriar, produtoPorId);
    return tx.pedido.update({
      where: { id: pedido.id },
      data: {
        itens: { create: itensParaCriar },
        subtotal: { increment: subtotalNovo },
        total: { increment: subtotalNovo },
      },
      include: { itens: { include: { opcoesSelecionadas: true } }, motoboy: { select: { id: true, nome: true, latitudeAtual: true, longitudeAtual: true, localizacaoAtualizadaEm: true } } },
    });
  });

  res.json(atualizado);
}));

/**
 * @openapi
 * /empresas/{empresaId}/pedidos/{id}/itens/{itemId}:
 *   delete:
 *     summary: Remove um item de um pedido ainda não finalizado (corrige lançamento errado antes de fechar a conta)
 *     tags: [Pedidos]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Pedido atualizado sem o item
 *       404:
 *         description: Pedido ou item não encontrado
 */
router.delete('/:id/itens/:itemId', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const pedido = await prisma.pedido.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!pedido) {
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }
  if (['ENTREGUE', 'CANCELADO'].includes(pedido.status)) {
    return res.status(400).json({ error: 'Este pedido já foi finalizado e não permite remover itens' });
  }

  const item = await prisma.pedidoItem.findFirst({
    where: { id: req.params.itemId, pedidoId: pedido.id },
  });
  if (!item) {
    return res.status(404).json({ error: 'Item não encontrado neste pedido' });
  }

  const valorItem = Number(item.precoUnitario) * item.quantidade;

  const atualizado = await prisma.$transaction(async (tx) => {
    await tx.pedidoItem.delete({ where: { id: item.id } });
    return tx.pedido.update({
      where: { id: pedido.id },
      data: {
        subtotal: { decrement: valorItem },
        total: { decrement: valorItem },
      },
      include: { itens: { include: { opcoesSelecionadas: true } }, motoboy: { select: { id: true, nome: true, latitudeAtual: true, longitudeAtual: true, localizacaoAtualizadaEm: true } } },
    });
  });

  res.json(atualizado);
}));

/**
 * @openapi
 * /empresas/{empresaId}/pedidos/{id}/motoboy:
 *   patch:
 *     summary: Atribui (ou remove) o motoboy responsável pela entrega do pedido
 *     tags: [Pedidos]
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
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               motoboyId: { type: string, format: uuid, nullable: true }
 *     responses:
 *       200:
 *         description: Pedido atualizado
 *       404:
 *         description: Pedido ou motoboy não encontrado
 */
router.patch('/:id/motoboy', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { motoboyId } = req.body;

  const pedido = await prisma.pedido.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!pedido) {
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }

  if (pedido.status === 'ENTREGUE' || pedido.status === 'CANCELADO') {
    return res.status(400).json({ error: 'Não é possível trocar o motoboy de um pedido já finalizado' });
  }

  if (!motoboyId) {
    const pedidoAtualizado = await prisma.pedido.update({
      where: { id: pedido.id },
      data: { motoboyId: null, taxaEntregaMotoboy: null },
      include: { itens: { include: { opcoesSelecionadas: true } }, motoboy: { select: { id: true, nome: true, latitudeAtual: true, longitudeAtual: true, localizacaoAtualizadaEm: true } } },
    });
    return res.json(pedidoAtualizado);
  }

  const motoboy = await prisma.motoboy.findFirst({
    where: { id: motoboyId, empresaId: req.params.empresaId },
  });
  if (!motoboy) {
    return res.status(404).json({ error: 'Motoboy não encontrado' });
  }

  const pedidoAtualizado = await prisma.pedido.update({
    where: { id: pedido.id },
    data: { motoboyId: motoboy.id, taxaEntregaMotoboy: motoboy.taxaPadrao },
    include: { itens: { include: { opcoesSelecionadas: true } }, motoboy: { select: { id: true, nome: true, latitudeAtual: true, longitudeAtual: true, localizacaoAtualizadaEm: true } } },
  });

  res.json(pedidoAtualizado);
}));

/**
 * @openapi
 * /empresas/{empresaId}/pedidos/{id}/liberar-resgate:
 *   post:
 *     summary: Aplica o item grátis da fidelidade a um pedido já criado, quando o cliente pede depois (WhatsApp, telefone etc.)
 *     tags: [Pedidos]
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
 *         description: Resgate aplicado, pedido atualizado com o desconto
 *       400:
 *         description: Pedido sem cliente vinculado, já resgatado, finalizado, ou sem item grátis disponível
 *       404:
 *         description: Pedido não encontrado
 */
router.post('/:id/liberar-resgate', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const pedido = await prisma.pedido.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
    include: { itens: true },
  });
  if (!pedido) {
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }
  if (!pedido.clienteId) {
    return res.status(400).json({ error: 'Este pedido não está vinculado a uma conta de cliente' });
  }
  if (pedido.itemGratisResgatado) {
    return res.status(400).json({ error: 'Este pedido já usou o item grátis da fidelidade' });
  }
  if (pedido.status === 'ENTREGUE' || pedido.status === 'CANCELADO') {
    return res.status(400).json({ error: 'Não é possível liberar o resgate em um pedido já finalizado' });
  }

  const cliente = await prisma.cliente.findFirst({ where: { id: pedido.clienteId, empresaId: req.params.empresaId } });
  if (!cliente) {
    return res.status(404).json({ error: 'Cliente do pedido não encontrado' });
  }

  const { disponiveis, expirado } = disponibilidadeFidelidade(cliente, req.empresa);
  if (disponiveis <= 0) {
    return res.status(400).json({
      error: expirado ? 'O prazo para resgatar o item grátis deste cliente já expirou' : 'Este cliente não tem itens grátis disponíveis para resgate',
    });
  }

  const menorPreco = Math.min(...pedido.itens.map((i) => Number(i.precoUnitario)));
  const novoSubtotal = Math.max(0, Number(pedido.subtotal) - menorPreco);
  const novoTotal = Math.max(0, Number(pedido.total) - menorPreco);

  const atualizado = await prisma.$transaction(async (tx) => {
    const salvo = await tx.pedido.update({
      where: { id: pedido.id },
      data: { subtotal: novoSubtotal, total: novoTotal, itemGratisResgatado: true },
      include: { itens: { include: { opcoesSelecionadas: true } }, motoboy: { select: { id: true, nome: true, latitudeAtual: true, longitudeAtual: true, localizacaoAtualizadaEm: true } } },
    });

    await tx.cliente.update({
      where: { id: cliente.id },
      data: { itensGratisResgatados: { increment: 1 } },
    });

    return salvo;
  });

  res.json(atualizado);
}));

/**
 * @openapi
 * /empresas/{empresaId}/pedidos/pagar-motoboy:
 *   post:
 *     summary: Fecha e paga todas as corridas entregues e ainda não pagas de um motoboy, lançando a saída no caixa
 *     tags: [Pedidos]
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
 *             required: [motoboyId]
 *             properties:
 *               motoboyId: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Pagamento registrado
 *       400:
 *         description: Não há corridas pendentes de pagamento
 *       404:
 *         description: Motoboy não encontrado
 */
router.post('/pagar-motoboy', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { motoboyId } = req.body;
  if (!motoboyId) {
    return res.status(400).json({ error: 'Campo "motoboyId" é obrigatório' });
  }

  const motoboy = await prisma.motoboy.findFirst({
    where: { id: motoboyId, empresaId: req.params.empresaId },
  });
  if (!motoboy) {
    return res.status(404).json({ error: 'Motoboy não encontrado' });
  }

  const resultado = await prisma.$transaction(async (tx) => {
    const pendentes = await tx.pedido.findMany({
      where: {
        empresaId: req.params.empresaId,
        motoboyId,
        status: 'ENTREGUE',
        motoboyPago: false,
      },
    });

    if (pendentes.length === 0) {
      return null;
    }

    const total = pendentes.reduce((sum, p) => sum + Number(p.taxaEntregaMotoboy ?? 0), 0);

    const movimento = await tx.movimentoCaixa.create({
      data: {
        empresaId: req.params.empresaId,
        motoboyId,
        tipo: 'SAIDA',
        descricao: `Pagamento motoboy ${motoboy.nome} — ${pendentes.length} corrida(s)`,
        valor: total,
        dataMovimento: new Date(),
      },
    });

    await tx.pedido.updateMany({
      where: { id: { in: pendentes.map((p) => p.id) } },
      data: { motoboyPago: true },
    });

    return { movimento, corridas: pendentes.length, total };
  });

  if (!resultado) {
    return res.status(400).json({ error: 'Não há corridas entregues pendentes de pagamento para este motoboy' });
  }

  res.json(resultado);
}));

/**
 * @openapi
 * /empresas/{empresaId}/pedidos/{id}/avaliar-pedido:
 *   post:
 *     summary: Cliente avalia o pedido (1 a 5 estrelas + comentário), só após ENTREGUE e uma única vez
 *     tags: [Pedidos]
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
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [clienteId, nota]
 *             properties:
 *               clienteId: { type: string, format: uuid }
 *               nota: { type: integer, minimum: 1, maximum: 5 }
 *               comentario: { type: string }
 *     responses:
 *       200:
 *         description: Avaliação registrada
 *       400:
 *         description: Pedido ainda não entregue, já avaliado, ou nota inválida
 *       403:
 *         description: Pedido não pertence a este cliente
 *       404:
 *         description: Pedido não encontrado
 */
router.post('/:id/avaliar-pedido', requireCliente(), asyncHandler(async (req, res) => {
  const { nota, comentario, fotos, notaComida, notaEmbalagem, notaTempo } = req.body;

  if (!Number.isInteger(nota) || nota < 1 || nota > 5) {
    return res.status(400).json({ error: 'A nota precisa ser um número inteiro entre 1 e 5' });
  }
  if (fotos !== undefined && (!Array.isArray(fotos) || !fotos.every((f) => typeof f === 'string'))) {
    return res.status(400).json({ error: 'Campo "fotos" deve ser uma lista de URLs' });
  }
  if (Array.isArray(fotos) && fotos.length > 0 && !req.empresa.habilitarAvaliacaoComFotos) {
    return res.status(400).json({ error: 'Esta loja não habilitou fotos na avaliação' });
  }
  const notasDetalhadas = { notaComida, notaEmbalagem, notaTempo };
  for (const [campo, valor] of Object.entries(notasDetalhadas)) {
    if (valor !== undefined && (!Number.isInteger(valor) || valor < 1 || valor > 5)) {
      return res.status(400).json({ error: `Campo "${campo}" deve ser um número inteiro entre 1 e 5` });
    }
  }
  const temNotaDetalhada = Object.values(notasDetalhadas).some((v) => v !== undefined);
  if (temNotaDetalhada && !req.empresa.habilitarAvaliacaoDetalhada) {
    return res.status(400).json({ error: 'Esta loja não habilitou a avaliação detalhada' });
  }

  const pedido = await prisma.pedido.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!pedido) {
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }
  if (!pedido.clienteId || pedido.clienteId !== req.auth.clienteId) {
    return res.status(403).json({ error: 'Este pedido não pertence a este cliente' });
  }
  if (pedido.status !== 'ENTREGUE') {
    return res.status(400).json({ error: 'Só é possível avaliar pedidos já entregues' });
  }
  if (pedido.avaliadoEm) {
    return res.status(400).json({ error: 'Este pedido já foi avaliado' });
  }

  const atualizado = await prisma.pedido.update({
    where: { id: pedido.id },
    data: {
      notaPedido: nota,
      comentarioPedido: comentario || null,
      fotosAvaliacao: Array.isArray(fotos) ? fotos.slice(0, 5) : [],
      ...(notaComida !== undefined ? { notaComida } : {}),
      ...(notaEmbalagem !== undefined ? { notaEmbalagem } : {}),
      ...(notaTempo !== undefined ? { notaTempo } : {}),
      avaliadoEm: new Date(),
    },
    include: { itens: { include: { opcoesSelecionadas: true } }, motoboy: { select: { id: true, nome: true, latitudeAtual: true, longitudeAtual: true, localizacaoAtualizadaEm: true } } },
  });

  res.json(atualizado);
}));

/**
 * @openapi
 * /empresas/{empresaId}/pedidos/{id}/avaliar-motoboy:
 *   post:
 *     summary: Cliente avalia o motoboy da entrega (1 a 5 estrelas + comentário)
 *     tags: [Pedidos]
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
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [clienteId, nota]
 *             properties:
 *               clienteId: { type: string, format: uuid }
 *               nota: { type: integer, minimum: 1, maximum: 5 }
 *               comentario: { type: string }
 *     responses:
 *       200:
 *         description: Avaliação registrada
 *       400:
 *         description: Pedido ainda não entregue, sem motoboy, já avaliado, ou nota inválida
 *       403:
 *         description: Pedido não pertence a este cliente
 *       404:
 *         description: Pedido não encontrado
 */
router.post('/:id/avaliar-motoboy', requireCliente(), asyncHandler(async (req, res) => {
  const { nota, comentario } = req.body;

  if (!Number.isInteger(nota) || nota < 1 || nota > 5) {
    return res.status(400).json({ error: 'A nota precisa ser um número inteiro entre 1 e 5' });
  }

  const pedido = await prisma.pedido.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!pedido) {
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }
  if (!pedido.clienteId || pedido.clienteId !== req.auth.clienteId) {
    return res.status(403).json({ error: 'Este pedido não pertence a este cliente' });
  }
  if (pedido.status !== 'ENTREGUE') {
    return res.status(400).json({ error: 'Só é possível avaliar pedidos já entregues' });
  }
  if (!pedido.motoboyId) {
    return res.status(400).json({ error: 'Este pedido não teve um motoboy atribuído' });
  }
  if (pedido.motoboyAvaliadoEm) {
    return res.status(400).json({ error: 'A entrega deste pedido já foi avaliada' });
  }

  const atualizado = await prisma.pedido.update({
    where: { id: pedido.id },
    data: { notaMotoboy: nota, comentarioMotoboy: comentario || null, motoboyAvaliadoEm: new Date() },
    include: { itens: { include: { opcoesSelecionadas: true } }, motoboy: { select: { id: true, nome: true, latitudeAtual: true, longitudeAtual: true, localizacaoAtualizadaEm: true } } },
  });

  res.json(atualizado);
}));

module.exports = router;
