const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const validarCupom = require('../lib/validarCupom');
const { calcularStatusLoja } = require('../lib/statusLoja');
const { calcularFrete } = require('../lib/calcularFrete');
const { disponibilidadeFidelidade, creditarUnidadesFidelidade } = require('../lib/fidelidade');
const { RECOMPENSA_INDICACAO_UNIDADES } = require('../lib/indicacao');
const { creditarCashback } = require('../lib/cashback');
const { notificarPedido } = require('../lib/pushNotifications');
const { criarNotificacaoCliente } = require('../lib/notificacoesCliente');
const { requireEmpresaAdmin, requireCliente } = require('../lib/auth');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);

const STATUS_VALIDOS = ['RECEBIDO', 'PREPARANDO', 'SAIU_ENTREGA', 'ENTREGUE', 'CANCELADO'];
const FORMAS_PAGAMENTO_VALIDAS = ['PIX', 'DINHEIRO', 'CARTAO'];

const TIMESTAMP_POR_STATUS = {
  PREPARANDO: 'preparandoEm',
  SAIU_ENTREGA: 'saiuEntregaEm',
  ENTREGUE: 'entregueEm',
  CANCELADO: 'canceladoEm',
};

/** Próxima transição de status válida a partir da atual (fluxo linear + cancelamento a qualquer momento). */
const PROXIMOS_STATUS_VALIDOS = {
  RECEBIDO: ['PREPARANDO', 'CANCELADO'],
  PREPARANDO: ['SAIU_ENTREGA', 'CANCELADO'],
  SAIU_ENTREGA: ['ENTREGUE', 'CANCELADO'],
  ENTREGUE: [],
  CANCELADO: [],
};

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

  const { status, motoboyPago, de, ate } = req.query;

  if (status && !STATUS_VALIDOS.includes(status)) {
    return res.status(400).json({ error: `Campo "status" deve ser um de: ${STATUS_VALIDOS.join(', ')}` });
  }

  const where = {
    empresaId: req.params.empresaId,
    ...(status ? { status } : {}),
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
    formaPagamento, trocoPara, observacoes, itens, usarItemGratis, cupomCodigo, agendadoPara, usarCashback,
  } = req.body;

  // Checkout aceita convidado (sem login) — clienteId nunca vem do corpo da requisição, só do
  // token de quem estiver logado como CLIENTE desta empresa, pra ninguém resgatar fidelidade ou
  // aplicar cupom de "primeira compra" em nome de outra pessoa.
  const clienteId = (req.auth && req.auth.role === 'CLIENTE' && req.auth.empresaId === req.params.empresaId)
    ? req.auth.clienteId
    : null;

  const erros = [];
  if (!clienteNome) erros.push('Campo "clienteNome" é obrigatório');
  if (!clienteTelefone) erros.push('Campo "clienteTelefone" é obrigatório');
  if (!endereco) erros.push('Campo "endereco" é obrigatório');
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

  const produtoIds = [...new Set(itens.map((i) => i.produtoId))];
  const produtos = await prisma.produto.findMany({
    where: { id: { in: produtoIds }, empresaId: req.params.empresaId, ativo: true },
    include: { gruposOpcao: { include: { opcoes: true } } },
  });
  const produtoPorId = new Map(produtos.map((p) => [p.id, p]));

  const itensParaCriar = [];
  for (const item of itens) {
    const produto = produtoPorId.get(item.produtoId);
    if (!produto) {
      return res.status(400).json({ error: `Produto ${item.produtoId} não encontrado ou indisponível` });
    }
    if (produto.esgotadoHoje) {
      return res.status(400).json({ error: `Produto "${produto.nome}" está esgotado hoje` });
    }
    const quantidade = Number(item.quantidade);
    if (!Number.isInteger(quantidade) || quantidade < 1) {
      return res.status(400).json({ error: `Quantidade inválida para o produto "${produto.nome}"` });
    }
    if (produto.controlarEstoque && (produto.estoqueQtd ?? 0) < quantidade) {
      return res.status(400).json({ error: `Estoque insuficiente para o produto "${produto.nome}"` });
    }

    const opcaoIdsSelecionados = Array.isArray(item.opcoes) ? [...new Set(item.opcoes)] : [];
    const opcoesSelecionadas = [];

    for (const grupo of produto.gruposOpcao) {
      const opcoesDoGrupo = new Map(grupo.opcoes.map((o) => [o.id, o]));
      const selecionadasDoGrupo = opcaoIdsSelecionados
        .map((id) => opcoesDoGrupo.get(id))
        .filter((o) => o && o.ativo);

      const minEfetivo = grupo.obrigatorio ? Math.max(1, grupo.minSelecoes) : grupo.minSelecoes;
      if (selecionadasDoGrupo.length < minEfetivo) {
        return res.status(400).json({
          error: `Selecione ao menos ${minEfetivo} opção(ões) em "${grupo.nome}" para o produto "${produto.nome}"`,
        });
      }
      const maxEfetivo = !grupo.selecaoMultipla ? 1 : (grupo.maxSelecoes ?? Infinity);
      if (selecionadasDoGrupo.length > maxEfetivo) {
        return res.status(400).json({
          error: `Selecione no máximo ${maxEfetivo} opção(ões) em "${grupo.nome}" para o produto "${produto.nome}"`,
        });
      }

      for (const opcao of selecionadasDoGrupo) {
        opcoesSelecionadas.push({
          opcaoId: opcao.id,
          nomeGrupo: grupo.nome,
          nomeOpcao: opcao.nome,
          precoAdicional: opcao.precoAdicional,
        });
      }
    }

    const precoBase = Number(produto.precoPromocional ?? produto.preco);
    const precoAdicionais = opcoesSelecionadas.reduce((sum, o) => sum + Number(o.precoAdicional), 0);
    const precoUnitario = precoBase + precoAdicionais;

    itensParaCriar.push({
      produtoId: produto.id,
      nomeProduto: produto.nome,
      ehCombo: produto.ehCombo,
      precoUnitario,
      quantidade,
      observacoes: item.observacoes || null,
      ...(opcoesSelecionadas.length > 0 ? { opcoesSelecionadas: { create: opcoesSelecionadas } } : {}),
    });
  }

  let subtotal = itensParaCriar.reduce((sum, i) => sum + Number(i.precoUnitario) * i.quantidade, 0);

  const pedidoMinimo = Number(req.empresa.pedidoMinimo);
  if (pedidoMinimo > 0 && subtotal < pedidoMinimo) {
    return res.status(400).json({ error: `Pedido mínimo de R$ ${pedidoMinimo.toFixed(2)}` });
  }

  const zonas = await prisma.zonaEntrega.findMany({
    where: { empresaId: req.params.empresaId, tipo: 'BAIRRO', ativo: true },
  });
  const { taxa: taxaEntrega } = calcularFrete({
    zonas,
    bairro,
    subtotal,
    taxaPadrao: req.empresa.taxaEntrega,
    freteGratisAcimaDe: req.empresa.freteGratisAcimaDe,
  });

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

  const total = subtotal + taxaEntregaFinal;

  const pedido = await prisma.$transaction(async (tx) => {
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
        clienteNome,
        clienteTelefone,
        endereco,
        bairro: bairro || null,
        referencia: referencia || null,
        subtotal,
        taxaEntrega: taxaEntregaFinal,
        total,
        formaPagamento,
        trocoPara: trocoPara || null,
        observacoes: observacoes || null,
        agendadoPara: agendadoParaData,
        clienteId: cliente?.id || null,
        itemGratisResgatado: resgatouItemGratis,
        cupomId: cupomAplicado?.id || null,
        cupomCodigo: cupomAplicado?.codigo || null,
        descontoCupom,
        cashbackUsado: cashbackUsadoValor > 0 ? cashbackUsadoValor : null,
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

    if (cupomAplicado) {
      await tx.cupom.update({
        where: { id: cupomAplicado.id },
        data: { usosRealizados: { increment: 1 } },
      });
    }

    for (const item of itensParaCriar) {
      const produto = produtoPorId.get(item.produtoId);
      if (produto.controlarEstoque) {
        await tx.produto.update({
          where: { id: produto.id },
          data: { estoqueQtd: Math.max(0, (produto.estoqueQtd ?? 0) - item.quantidade) },
        });
      }
    }

    return criado;
  });

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
  const { status, fotoEntrega } = req.body;
  if (!status || !STATUS_VALIDOS.includes(status)) {
    return res.status(400).json({ error: `Campo "status" é obrigatório e deve ser um de: ${STATUS_VALIDOS.join(', ')}` });
  }
  if (req.auth.role === 'MOTOBOY' && status !== 'ENTREGUE') {
    return res.status(403).json({ error: 'Motoboys só podem confirmar a entrega de um pedido' });
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

  if (!PROXIMOS_STATUS_VALIDOS[pedido.status].includes(status)) {
    return res.status(400).json({
      error: `Não é possível mudar de "${pedido.status}" para "${status}"`,
    });
  }

  const carimboCampo = TIMESTAMP_POR_STATUS[status];

  const atualizado = await prisma.$transaction(async (tx) => {
    let salvo = await tx.pedido.update({
      where: { id: pedido.id },
      data: {
        status,
        ...(carimboCampo ? { [carimboCampo]: new Date() } : {}),
        ...(status === 'ENTREGUE' && typeof fotoEntrega === 'string' && fotoEntrega ? { fotoEntrega } : {}),
      },
      include: { itens: { include: { opcoesSelecionadas: true } }, motoboy: { select: { id: true, nome: true, latitudeAtual: true, longitudeAtual: true, localizacaoAtualizadaEm: true } } },
    });

    // Ao confirmar a entrega, registra a venda como entrada no caixa unificado.
    if (status === 'ENTREGUE') {
      await tx.movimentoCaixa.create({
        data: {
          empresaId: req.params.empresaId,
          tipo: 'ENTRADA',
          descricao: `Pedido #${salvo.numero} — ${salvo.clienteNome}`,
          valor: salvo.total,
          dataMovimento: new Date(),
        },
      });

      // Credita fidelidade (1x por pedido, guardado por unidadesFidelidadeCreditadas).
      if (salvo.clienteId && salvo.unidadesFidelidadeCreditadas == null) {
        const unidades = salvo.itens.reduce((sum, item) => sum + item.quantidade, 0);
        await creditarUnidadesFidelidade(tx, salvo.clienteId, unidades);
        await tx.pedido.update({
          where: { id: salvo.id },
          data: { unidadesFidelidadeCreditadas: unidades },
        });
        // Reflete no objeto que a rota devolve — sem isso, o response deste PATCH ficava com o
        // valor antigo mesmo já tendo sido atualizado no banco acima.
        salvo = { ...salvo, unidadesFidelidadeCreditadas: unidades };
      }

      // Credita cashback sobre o subtotal (1x por pedido, guardado por cashbackCreditado).
      const cashbackPercent = req.empresa.cashbackPercent ? Number(req.empresa.cashbackPercent) : 0;
      if (salvo.clienteId && cashbackPercent > 0 && salvo.cashbackCreditado == null) {
        const valorCashback = Number(salvo.subtotal) * (cashbackPercent / 100);
        await creditarCashback(tx, salvo.clienteId, valorCashback);
        await tx.pedido.update({
          where: { id: salvo.id },
          data: { cashbackCreditado: valorCashback },
        });
        salvo = { ...salvo, cashbackCreditado: valorCashback };
      }

      // Indicação: se esse pedido é a primeira compra concluída de um cliente indicado por
      // outro, credita fidelidade pros dois lados — uma única vez (indicacaoRecompensada trava).
      if (salvo.clienteId) {
        const cliente = await tx.cliente.findUnique({ where: { id: salvo.clienteId } });
        if (cliente?.indicadoPorId && !cliente.indicacaoRecompensada) {
          const pedidosAnterioresEntregues = await tx.pedido.count({
            where: { clienteId: cliente.id, status: 'ENTREGUE', id: { not: salvo.id } },
          });
          if (pedidosAnterioresEntregues === 0) {
            await creditarUnidadesFidelidade(tx, cliente.id, RECOMPENSA_INDICACAO_UNIDADES);
            await creditarUnidadesFidelidade(tx, cliente.indicadoPorId, RECOMPENSA_INDICACAO_UNIDADES);
            await tx.cliente.update({ where: { id: cliente.id }, data: { indicacaoRecompensada: true } });
          }
        }
      }
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
  const { nota, comentario, fotos } = req.body;

  if (!Number.isInteger(nota) || nota < 1 || nota > 5) {
    return res.status(400).json({ error: 'A nota precisa ser um número inteiro entre 1 e 5' });
  }
  if (fotos !== undefined && (!Array.isArray(fotos) || !fotos.every((f) => typeof f === 'string'))) {
    return res.status(400).json({ error: 'Campo "fotos" deve ser uma lista de URLs' });
  }
  if (Array.isArray(fotos) && fotos.length > 0 && !req.empresa.habilitarAvaliacaoComFotos) {
    return res.status(400).json({ error: 'Esta loja não habilitou fotos na avaliação' });
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
