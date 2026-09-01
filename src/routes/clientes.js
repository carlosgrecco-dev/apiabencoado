const { Router } = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { disponibilidadeFidelidade, creditarUnidadesFidelidade } = require('../lib/fidelidade');
const { gerarCodigoIndicacaoUnico } = require('../lib/indicacao');
const { signToken, requireEmpresaAdmin, requireCliente } = require('../lib/auth');
const { criarContaIsolada, buscarContaPorEmail, confirmarVinculo } = require('../lib/contaPlataforma');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const SALT_ROUNDS = 10;
const CLIENTE_TOKEN_TTL = '30d';

router.use(loadEmpresa);

/** Remove o hash da senha antes de devolver o cliente. */
const serializeCliente = (cliente) => {
  const { senhaHash, ...rest } = cliente;
  return rest;
};

/** Clientes criados antes do sistema de indicação existir não têm codigoIndicacao — gera na primeira vez que aparecem. */
const garantirCodigoIndicacao = async (cliente) => {
  if (cliente.codigoIndicacao) return cliente;
  const codigoIndicacao = await gerarCodigoIndicacaoUnico(cliente.empresaId);
  return prisma.cliente.update({ where: { id: cliente.id }, data: { codigoIndicacao } });
};

/** Saldo de SaltFood Coins da conta de plataforma vinculada (0 se o cliente ainda não tiver uma) — mesmo formato plano de saldoCashback. */
const saldoCoinsDe = async (cliente) => {
  if (!cliente.contaPlataformaId) return 0;
  const conta = await prisma.contaPlataforma.findUnique({
    where: { id: cliente.contaPlataformaId },
    select: { saldoCoins: true },
  });
  return conta ? Number(conta.saldoCoins) : 0;
};

/**
 * @openapi
 * components:
 *   schemas:
 *     Cliente:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid }
 *         nome: { type: string }
 *         telefone: { type: string, nullable: true }
 *         email: { type: string }
 *         totalUnidadesCompradas: { type: integer }
 *         itensGratisGanhos: { type: integer }
 *         itensGratisResgatados: { type: integer }
 */

/**
 * @openapi
 * /empresas/{empresaId}/clientes/signup:
 *   post:
 *     summary: Cria a conta do cliente na loja
 *     tags: [Clientes]
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
 *             required: [nome, email, senha]
 *             properties:
 *               nome: { type: string }
 *               telefone: { type: string }
 *               email: { type: string }
 *               senha: { type: string }
 *     responses:
 *       201:
 *         description: Conta criada
 *       400:
 *         description: Dados inválidos
 *       409:
 *         description: E-mail já cadastrado
 */
router.post('/signup', asyncHandler(async (req, res) => {
  const { nome, telefone, email, senha, indicadoPor } = req.body;

  if (!nome || !email || !senha) {
    return res.status(400).json({ error: 'Campos "nome", "email" e "senha" são obrigatórios' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'E-mail inválido' });
  }
  if (String(senha).length < 6) {
    return res.status(400).json({ error: 'A senha precisa ter pelo menos 6 caracteres' });
  }

  const existente = await prisma.cliente.findUnique({
    where: { empresaId_email: { empresaId: req.params.empresaId, email } },
  });
  if (existente) {
    return res.status(409).json({ error: 'Este e-mail já está cadastrado' });
  }

  // Código de quem indicou é opcional e silenciosamente ignorado se inválido — não trava o cadastro.
  let indicadoPorId = null;
  if (typeof indicadoPor === 'string' && indicadoPor.trim()) {
    const referenciador = await prisma.cliente.findFirst({
      where: { empresaId: req.params.empresaId, codigoIndicacao: indicadoPor.trim().toUpperCase() },
    });
    if (referenciador) indicadoPorId = referenciador.id;
  }

  const codigoIndicacao = await gerarCodigoIndicacaoUnico(req.params.empresaId);
  const senhaHash = await bcrypt.hash(senha, SALT_ROUNDS);
  let cliente = await prisma.cliente.create({
    data: { empresaId: req.params.empresaId, nome, telefone: telefone || null, email, senhaHash, codigoIndicacao, indicadoPorId },
  });

  // SaltFood Coins: se ninguém mais usa este e-mail ainda, a conta de plataforma nasce junto, sem
  // fricção nenhuma. Se já existe uma (de outra loja), NÃO vincula sozinho — só por bater o
  // e-mail não prova que é a mesma pessoa (ver contaPlataforma.js). O front oferece vincular
  // depois, com confirmação de senha.
  let contaPlataformaDetectada = false;
  const contaExistente = await buscarContaPorEmail(prisma, email);
  if (!contaExistente) {
    const novaConta = await criarContaIsolada(prisma, { email, telefone, senhaHash });
    cliente = await prisma.cliente.update({ where: { id: cliente.id }, data: { contaPlataformaId: novaConta.id } });
  } else {
    contaPlataformaDetectada = true;
  }

  const token = signToken({ role: 'CLIENTE', empresaId: req.params.empresaId, clienteId: cliente.id }, CLIENTE_TOKEN_TTL);
  res.status(201).json({ ...serializeCliente(cliente), token, contaPlataformaDetectada, saldoCoinsPlataforma: await saldoCoinsDe(cliente) });
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes/cadastro-rapido:
 *   post:
 *     summary: Cadastra um cliente só com nome/telefone (PDV) — sem e-mail/senha, não consegue logar sozinho depois
 *     tags: [Clientes]
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
 *             required: [nome]
 *             properties:
 *               nome: { type: string }
 *               telefone: { type: string }
 *     responses:
 *       201:
 *         description: Cliente criado
 *       400:
 *         description: Dados inválidos
 */
router.post('/cadastro-rapido', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { nome, telefone } = req.body;
  if (!nome) {
    return res.status(400).json({ error: 'Campo "nome" é obrigatório' });
  }

  const cliente = await prisma.cliente.create({
    data: { empresaId: req.params.empresaId, nome, telefone: telefone || null },
  });

  res.status(201).json(serializeCliente(cliente));
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes/login:
 *   post:
 *     summary: Login do cliente na loja
 *     tags: [Clientes]
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
 *             required: [email, senha]
 *             properties:
 *               email: { type: string }
 *               senha: { type: string }
 *     responses:
 *       200:
 *         description: Login válido
 *       401:
 *         description: E-mail ou senha inválidos
 */
router.post('/login', asyncHandler(async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) {
    return res.status(400).json({ error: 'Campos "email" e "senha" são obrigatórios' });
  }

  const cliente = await prisma.cliente.findUnique({
    where: { empresaId_email: { empresaId: req.params.empresaId, email } },
  });
  if (!cliente) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos' });
  }

  const senhaValida = await bcrypt.compare(senha, cliente.senhaHash);
  if (!senhaValida) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos' });
  }

  const clienteComCodigo = await garantirCodigoIndicacao(cliente);

  // Self-heal: cliente criado antes de existir SaltFood Coins, ou que nunca vinculou — avisa se
  // já existe uma conta de plataforma pra este e-mail, mas não vincula sozinho (login só prova a
  // senha desta loja, não da conta de outra loja).
  let contaPlataformaDetectada = false;
  if (!clienteComCodigo.contaPlataformaId) {
    contaPlataformaDetectada = Boolean(await buscarContaPorEmail(prisma, email));
  }

  const token = signToken({ role: 'CLIENTE', empresaId: req.params.empresaId, clienteId: cliente.id }, CLIENTE_TOKEN_TTL);
  res.json({ ...serializeCliente(clienteComCodigo), token, contaPlataformaDetectada, saldoCoinsPlataforma: await saldoCoinsDe(clienteComCodigo) });
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes:
 *   get:
 *     summary: Lista os clientes da loja, com o progresso de fidelidade de cada um
 *     tags: [Clientes]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Lista de clientes
 */
router.get('/', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const clientes = await prisma.cliente.findMany({
    where: { empresaId: req.params.empresaId },
    orderBy: { nome: 'asc' },
  });
  res.json(clientes.map(serializeCliente));
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes/admin-resumo:
 *   get:
 *     summary: Clientes com pedidos/gasto/último pedido/atividade agregados, estatísticas do programa de fidelidade no período (com variação vs período anterior), ranking e atividades recentes — pra tela de gestão do admin
 *     tags: [Clientes]
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
 *         description: Resumo de fidelidade
 */
router.get('/admin-resumo', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const empresaId = req.params.empresaId;
  const agora = new Date();

  const inicioAtual = req.query.de ? new Date(`${req.query.de}T00:00:00`) : new Date(agora.getFullYear(), agora.getMonth(), 1);
  const fimAtual = req.query.ate ? new Date(`${req.query.ate}T23:59:59.999`) : agora;
  const duracaoMs = fimAtual.getTime() - inicioAtual.getTime();
  const fimAnterior = new Date(inicioAtual.getTime() - 1);
  const inicioAnterior = new Date(fimAnterior.getTime() - duracaoMs);

  const clientes = await prisma.cliente.findMany({ where: { empresaId } });

  const WINDOW_ATIVO_DIAS = 60;
  const limiteAtivo = new Date(agora);
  limiteAtivo.setDate(limiteAtivo.getDate() - WINDOW_ATIVO_DIAS);

  const [entreguesAgg, ultimoPedidoAgg, ativosRows] = await Promise.all([
    prisma.pedido.groupBy({
      by: ['clienteId'],
      where: { empresaId, clienteId: { not: null }, status: 'ENTREGUE' },
      _count: { _all: true },
      _sum: { total: true },
    }),
    prisma.pedido.groupBy({
      by: ['clienteId'],
      where: { empresaId, clienteId: { not: null } },
      _max: { createdAt: true },
    }),
    prisma.pedido.findMany({
      where: { empresaId, clienteId: { not: null }, status: 'ENTREGUE', entregueEm: { gte: limiteAtivo } },
      select: { clienteId: true },
      distinct: ['clienteId'],
    }),
  ]);

  const entreguesMap = new Map(entreguesAgg.map((r) => [r.clienteId, { pedidosCount: r._count._all, gastoTotal: Number(r._sum.total || 0) }]));
  const ultimoPedidoMap = new Map(ultimoPedidoAgg.map((r) => [r.clienteId, r._max.createdAt]));
  const ativosSet = new Set(ativosRows.map((r) => r.clienteId));

  const clientesComDados = clientes.map((c) => ({
    ...serializeCliente(c),
    pedidosCount: entreguesMap.get(c.id)?.pedidosCount || 0,
    gastoTotal: entreguesMap.get(c.id)?.gastoTotal || 0,
    ultimoPedidoEm: ultimoPedidoMap.get(c.id) || null,
    ativo: ativosSet.has(c.id),
  }));

  /** Economia gerada pra fidelidade (cashback usado + valor do item grátis) num intervalo — só o que dá pra reconstruir com dado real, sem tabela de log dedicada. */
  const economiaNoIntervalo = async (inicio, fim) => {
    const [cashbackAgg, pedidosGratis] = await Promise.all([
      prisma.pedido.aggregate({
        where: { empresaId, createdAt: { gte: inicio, lte: fim }, cashbackUsado: { not: null } },
        _sum: { cashbackUsado: true },
      }),
      prisma.pedido.findMany({
        where: { empresaId, createdAt: { gte: inicio, lte: fim }, itemGratisResgatado: true },
        include: { itens: { select: { precoUnitario: true } } },
      }),
    ]);
    const valorItensGratis = pedidosGratis.reduce((soma, p) => {
      if (p.itens.length === 0) return soma;
      return soma + Math.min(...p.itens.map((i) => Number(i.precoUnitario)));
    }, 0);
    return Number(cashbackAgg._sum.cashbackUsado || 0) + valorItensGratis;
  };

  const carimbosNoIntervalo = async (inicio, fim) => {
    const agg = await prisma.pedido.aggregate({
      where: { empresaId, status: 'ENTREGUE', entregueEm: { gte: inicio, lte: fim }, unidadesFidelidadeCreditadas: { not: null } },
      _sum: { unidadesFidelidadeCreditadas: true },
    });
    return agg._sum.unidadesFidelidadeCreditadas || 0;
  };

  const resgatesNoIntervalo = (inicio, fim) => prisma.pedido.count({
    where: { empresaId, createdAt: { gte: inicio, lte: fim }, itemGratisResgatado: true },
  });

  const [
    carimbosAtual, carimbosAnterior,
    resgatesAtual, resgatesAnterior,
    economiaAtual, economiaAnterior,
  ] = await Promise.all([
    carimbosNoIntervalo(inicioAtual, fimAtual),
    carimbosNoIntervalo(inicioAnterior, fimAnterior),
    resgatesNoIntervalo(inicioAtual, fimAtual),
    resgatesNoIntervalo(inicioAnterior, fimAnterior),
    economiaNoIntervalo(inicioAtual, fimAtual),
    economiaNoIntervalo(inicioAnterior, fimAnterior),
  ]);

  const clientesCadastradosAtual = clientes.length;
  const clientesCadastradosAnterior = clientes.filter((c) => c.createdAt <= fimAnterior).length;

  const ranking = [...clientes]
    .sort((a, b) => b.totalUnidadesCompradas - a.totalUnidadesCompradas)
    .slice(0, 5)
    .map((c) => ({ id: c.id, nome: c.nome, totalUnidadesCompradas: c.totalUnidadesCompradas }));

  // Atividades recentes: eventos reais de fidelidade/cashback extraídos dos próprios pedidos (sem tabela de log dedicada).
  const pedidosComEventos = await prisma.pedido.findMany({
    where: {
      empresaId,
      clienteId: { not: null },
      OR: [
        { unidadesFidelidadeCreditadas: { not: null } },
        { itemGratisResgatado: true },
        { cashbackUsado: { not: null } },
        { cashbackCreditado: { not: null } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 30,
    include: { cliente: { select: { nome: true } } },
  });

  const atividades = [];
  for (const p of pedidosComEventos) {
    const nome = p.cliente?.nome || '—';
    if (p.itemGratisResgatado) {
      atividades.push({ tipo: 'RESGATE', clienteNome: nome, pedidoNumero: p.numero, data: p.createdAt });
    }
    if (p.cashbackUsado != null) {
      atividades.push({ tipo: 'CASHBACK_USADO', clienteNome: nome, valor: Number(p.cashbackUsado), pedidoNumero: p.numero, data: p.createdAt });
    }
    if (p.unidadesFidelidadeCreditadas) {
      atividades.push({ tipo: 'CARIMBO', clienteNome: nome, unidades: p.unidadesFidelidadeCreditadas, pedidoNumero: p.numero, data: p.entregueEm || p.createdAt });
    }
    if (p.cashbackCreditado != null) {
      atividades.push({ tipo: 'CASHBACK_CREDITADO', clienteNome: nome, valor: Number(p.cashbackCreditado), pedidoNumero: p.numero, data: p.entregueEm || p.createdAt });
    }
  }
  atividades.sort((a, b) => new Date(b.data).getTime() - new Date(a.data).getTime());

  res.json({
    periodo: { de: inicioAtual.toISOString(), ate: fimAtual.toISOString() },
    stats: {
      clientesCadastrados: { atual: clientesCadastradosAtual, anterior: clientesCadastradosAnterior },
      clientesAtivos: ativosSet.size,
      clientesAtivosPercent: clientes.length > 0 ? (ativosSet.size / clientes.length) * 100 : 0,
      carimbosEmitidos: { atual: carimbosAtual, anterior: carimbosAnterior },
      itensGratisResgatados: { atual: resgatesAtual, anterior: resgatesAnterior },
      economiaGerada: { atual: economiaAtual, anterior: economiaAnterior },
    },
    clientes: clientesComDados,
    ranking,
    atividadesRecentes: atividades.slice(0, 10),
    config: {
      fidelidadeValidadeDias: req.empresa.fidelidadeValidadeDias,
      cashbackPercent: req.empresa.cashbackPercent != null ? Number(req.empresa.cashbackPercent) : 0,
      fidelidadeNomeItem: req.empresa.fidelidadeNomeItem,
      indicacaoRecompensaUnidades: req.empresa.indicacaoRecompensaUnidades,
      unidadesParaPremio: 10,
    },
  });
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes/{id}:
 *   get:
 *     summary: Busca o perfil do cliente (dados de fidelidade)
 *     tags: [Clientes]
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
 *         description: Cliente encontrado
 *       404:
 *         description: Cliente não encontrado
 */
router.get('/:id', requireCliente('id'), asyncHandler(async (req, res) => {
  const cliente = await prisma.cliente.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!cliente) {
    return res.status(404).json({ error: 'Cliente não encontrado' });
  }
  const clienteComCodigo = await garantirCodigoIndicacao(cliente);

  let contaPlataformaDetectada = false;
  if (!clienteComCodigo.contaPlataformaId) {
    contaPlataformaDetectada = Boolean(await buscarContaPorEmail(prisma, clienteComCodigo.email));
  }

  res.json({ ...serializeCliente(clienteComCodigo), contaPlataformaDetectada, saldoCoinsPlataforma: await saldoCoinsDe(clienteComCodigo) });
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes/{id}/pedidos:
 *   get:
 *     summary: Histórico de pedidos do cliente
 *     tags: [Clientes]
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
 *         description: Lista de pedidos do cliente
 */
router.get('/:id/pedidos', requireCliente('id'), asyncHandler(async (req, res) => {
  const pedidos = await prisma.pedido.findMany({
    where: { clienteId: req.params.id, empresaId: req.params.empresaId },
    include: { itens: { include: { opcoesSelecionadas: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(pedidos);
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes/{id}/vincular-conta-plataforma:
 *   post:
 *     summary: Vincula o cliente a uma conta SaltFood Coins existente de outra loja, confirmando com a senha de lá
 *     tags: [Clientes]
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
 *             required: [email, senha]
 *             properties:
 *               email: { type: string }
 *               senha: { type: string }
 *     responses:
 *       200:
 *         description: Contas vinculadas
 *       400:
 *         description: Nenhuma conta encontrada, ou senha não confere
 */
router.post('/:id/vincular-conta-plataforma', requireCliente('id'), asyncHandler(async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) {
    return res.status(400).json({ error: 'Campos "email" e "senha" são obrigatórios' });
  }

  const conta = await buscarContaPorEmail(prisma, email);
  if (!conta) {
    return res.status(400).json({ error: 'Nenhuma conta SaltFood encontrada com este e-mail' });
  }

  const senhaConfere = await confirmarVinculo(prisma, conta.id, senha);
  if (!senhaConfere) {
    return res.status(400).json({ error: 'Senha incorreta' });
  }

  const cliente = await prisma.cliente.update({
    where: { id: req.params.id },
    data: { contaPlataformaId: conta.id },
  });

  res.json({ ...serializeCliente(cliente), contaPlataformaDetectada: false, saldoCoinsPlataforma: await saldoCoinsDe(cliente) });
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes/{id}/liberar-resgate:
 *   post:
 *     summary: Marca 1 item grátis da fidelidade do cliente como resgatado (retirada balcão/telefone, sem pedido online)
 *     tags: [Clientes]
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
 *         description: Resgate registrado
 *       400:
 *         description: Cliente sem item grátis disponível (ou prazo expirado)
 *       404:
 *         description: Cliente não encontrado
 */
router.post('/:id/liberar-resgate', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const cliente = await prisma.cliente.findFirst({ where: { id: req.params.id, empresaId: req.params.empresaId } });
  if (!cliente) {
    return res.status(404).json({ error: 'Cliente não encontrado' });
  }

  const { disponiveis, expirado } = disponibilidadeFidelidade(cliente, req.empresa);
  if (disponiveis <= 0) {
    return res.status(400).json({
      error: expirado ? 'O prazo para resgatar o item grátis deste cliente já expirou' : 'Este cliente não tem itens grátis disponíveis para resgate',
    });
  }

  const atualizado = await prisma.cliente.update({
    where: { id: cliente.id },
    data: { itensGratisResgatados: { increment: 1 } },
  });

  res.json(serializeCliente(atualizado));
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes/{id}/adicionar-unidades:
 *   post:
 *     summary: Credita unidades manualmente no cartão fidelidade do cliente (compra por telefone/balcão, fora do pedido online)
 *     tags: [Clientes]
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
 *             required: [unidades]
 *             properties:
 *               unidades: { type: integer, minimum: 1 }
 *     responses:
 *       200:
 *         description: Unidades creditadas
 *       400:
 *         description: Campo "unidades" inválido
 *       404:
 *         description: Cliente não encontrado
 */
router.post('/:id/adicionar-unidades', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const unidades = Number(req.body.unidades);
  if (!Number.isInteger(unidades) || unidades < 1) {
    return res.status(400).json({ error: 'Campo "unidades" deve ser um número inteiro maior que zero' });
  }

  const cliente = await prisma.cliente.findFirst({ where: { id: req.params.id, empresaId: req.params.empresaId } });
  if (!cliente) {
    return res.status(404).json({ error: 'Cliente não encontrado' });
  }

  const atualizado = await prisma.$transaction((tx) => creditarUnidadesFidelidade(tx, cliente.id, unidades));

  res.json(serializeCliente(atualizado));
}));

module.exports = router;
