const { Router } = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { signToken, requireSuperAdmin } = require('../lib/auth');
const { agregarDispositivos } = require('../lib/userAgentStats');

const router = Router();

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const SUPER_ADMIN_TOKEN_TTL = '8h';

/**
 * @openapi
 * /super-admin/login:
 *   post:
 *     summary: Login do Super Admin (dono da plataforma) — credencial única, guardada em variáveis de ambiente
 *     tags: [SuperAdmin]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [usuario, senha]
 *             properties:
 *               usuario: { type: string }
 *               senha: { type: string }
 *     responses:
 *       200:
 *         description: Login válido
 *       401:
 *         description: Usuário ou senha inválidos
 */
router.post('/login', asyncHandler(async (req, res) => {
  const { usuario, senha } = req.body;
  if (!usuario || !senha) {
    return res.status(400).json({ error: 'Campos "usuario" e "senha" são obrigatórios' });
  }

  const usuarioEsperado = process.env.SUPER_ADMIN_USERNAME;
  const senhaHashEsperada = process.env.SUPER_ADMIN_PASSWORD_HASH;
  if (!usuarioEsperado || !senhaHashEsperada) {
    return res.status(500).json({ error: 'Login de Super Admin não configurado no servidor' });
  }

  if (usuario !== usuarioEsperado) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  }

  const senhaValida = await bcrypt.compare(senha, senhaHashEsperada);
  if (!senhaValida) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  }

  const token = signToken({ role: 'SUPER_ADMIN', sub: usuario }, SUPER_ADMIN_TOKEN_TTL);
  res.json({ usuario, token });
}));

/**
 * @openapi
 * /super-admin/dashboard:
 *   get:
 *     summary: Visão geral da plataforma (GMV, lojas ativas, comissão, ticket médio) — todos os tenants
 *     tags: [SuperAdmin]
 *     parameters:
 *       - in: query
 *         name: de
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: ate
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: Métricas agregadas da plataforma
 */
/** Toggles opt-in existentes hoje — usados só pra contar quantos tenants ligaram cada um. */
const FUNCIONALIDADES = [
  { campo: 'habilitarFavoritos', label: 'Favoritos' },
  { campo: 'habilitarPedirDeNovo', label: 'Peça de novo' },
  { campo: 'habilitarRankingFidelidade', label: 'Nível de fidelidade' },
  { campo: 'habilitarAgendamento', label: 'Agendar pedido' },
  { campo: 'habilitarAvaliacaoComFotos', label: 'Fotos na avaliação' },
  { campo: 'habilitarNotificacoesInApp', label: 'Central de notificações' },
  { campo: 'habilitarMissoes', label: 'Missões de fidelidade' },
  { campo: 'habilitarIndicacaoAvancada', label: 'Indicação avançada' },
  { campo: 'habilitarAvaliacaoDetalhada', label: 'Avaliação detalhada' },
  { campo: 'habilitarCentralSuporte', label: 'Central de suporte' },
];

router.get('/dashboard', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { de, ate } = req.query;
  const range = {
    gte: de ? new Date(`${de}T00:00:00`) : undefined,
    lte: ate ? new Date(`${ate}T23:59:59`) : undefined,
  };

  // Lojas de demonstração (ehDemo=true) ficam fora de todo agregado da plataforma — funcionam
  // normalmente (têm pedidos, clientes etc.), mas não podem distorcer GMV/comissão/contagens
  // reais mostradas aqui pro Super Admin.
  const trintaDiasAtras = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [
    totalEmpresas, empresasAtivas, totalClientes, totalMotoboysAtivos, novosTenantsNoPeriodo,
    entregues, ultimoPedidoPorEmpresa, empresas, faturasPendentes, tenantsInativos30Dias,
  ] = await Promise.all([
    prisma.empresa.count({ where: { ehDemo: false } }),
    prisma.empresa.count({ where: { empresaAtiva: true, ehDemo: false } }),
    prisma.cliente.count({ where: { empresa: { ehDemo: false } } }),
    prisma.motoboy.count({ where: { ativo: true, empresa: { ehDemo: false } } }),
    prisma.empresa.count({ where: { createdAt: range, ehDemo: false } }),
    prisma.pedido.findMany({
      where: { status: 'ENTREGUE', createdAt: range, empresa: { ehDemo: false } },
      select: {
        total: true, empresaId: true, createdAt: true, userAgent: true, formaPagamento: true,
        itens: { select: { quantidade: true, precoUnitario: true, produto: { select: { categoriaId: true, categoria: { select: { nome: true } } } } } },
      },
    }),
    prisma.pedido.groupBy({ by: ['empresaId'], where: { status: 'ENTREGUE', empresa: { ehDemo: false } }, _max: { createdAt: true } }),
    prisma.empresa.findMany({
      where: { ehDemo: false },
      select: {
        id: true, nome: true, slug: true, empresaAtiva: true, comissaoPercent: true,
        ultimoAcessoAdminEm: true, createdAt: true, cashbackPercent: true,
        habilitarFavoritos: true, habilitarPedirDeNovo: true, habilitarRankingFidelidade: true,
        habilitarAgendamento: true, habilitarAvaliacaoComFotos: true, habilitarNotificacoesInApp: true,
        habilitarMissoes: true, habilitarIndicacaoAvancada: true, habilitarAvaliacaoDetalhada: true,
        habilitarCentralSuporte: true,
      },
    }),
    prisma.fatura.count({ where: { status: 'PENDENTE', empresa: { ehDemo: false } } }),
    // Só conta como inativo quem já é tenant há mais de 30 dias (senão todo cadastro novo, que
    // ainda não teve tempo de logar, apareceria injustamente como "inativo").
    prisma.empresa.count({
      where: {
        ehDemo: false, empresaAtiva: true, createdAt: { lt: trintaDiasAtras },
        OR: [{ ultimoAcessoAdminEm: null }, { ultimoAcessoAdminEm: { lt: trintaDiasAtras } }],
      },
    }),
  ]);

  const comissaoPorEmpresa = new Map(empresas.map((e) => [e.id, Number(e.comissaoPercent)]));

  const gmv = entregues.reduce((sum, p) => sum + Number(p.total), 0);
  const totalPedidos = entregues.length;
  const ticketMedio = totalPedidos > 0 ? gmv / totalPedidos : 0;
  const comissaoTotal = entregues.reduce((sum, p) => {
    const percent = comissaoPorEmpresa.get(p.empresaId) ?? 0;
    return sum + Number(p.total) * (percent / 100);
  }, 0);

  const porEmpresaMap = new Map();
  const faturamentoPorEmpresaMap = new Map();
  for (const p of entregues) {
    porEmpresaMap.set(p.empresaId, (porEmpresaMap.get(p.empresaId) || 0) + 1);
    faturamentoPorEmpresaMap.set(p.empresaId, (faturamentoPorEmpresaMap.get(p.empresaId) || 0) + Number(p.total));
  }
  const lojasComVendaNoPeriodo = porEmpresaMap.size;

  // Tendência de faturamento + pedidos por dia (plataforma inteira) — mesmo padrão já usado no CRM de cada loja.
  const porDiaMap = new Map();
  for (const p of entregues) {
    const dia = p.createdAt.toISOString().slice(0, 10);
    const atual = porDiaMap.get(dia) || { pedidos: 0, faturamento: 0 };
    atual.pedidos += 1;
    atual.faturamento += Number(p.total);
    porDiaMap.set(dia, atual);
  }
  const pedidosPorDia = Array.from(porDiaMap.entries())
    .map(([data, v]) => ({ data, pedidos: v.pedidos, faturamento: v.faturamento }))
    .sort((a, b) => a.data.localeCompare(b.data));

  // Dispositivo/navegador agregado — a partir do User-Agent salvo em cada pedido do período.
  const { dispositivos, navegadores } = agregarDispositivos(entregues.map((p) => p.userAgent));

  // Forma de pagamento — mesmas 4 formas reais do sistema (PIX/Dinheiro/Cartão/Múltiplo).
  const porFormaPagamentoMap = new Map();
  for (const p of entregues) {
    porFormaPagamentoMap.set(p.formaPagamento, (porFormaPagamentoMap.get(p.formaPagamento) || 0) + 1);
  }
  const porFormaPagamento = Array.from(porFormaPagamentoMap.entries()).map(([forma, quantidade]) => ({ forma, quantidade }));

  // Categoria — junta PedidoItem → Produto → Categoria (mesmo padrão do CRM/Dashboard de cada loja).
  const porCategoriaMap = new Map();
  for (const p of entregues) {
    for (const item of p.itens) {
      const categoriaId = item.produto?.categoriaId || 'sem-categoria';
      const nome = item.produto?.categoria?.nome || 'Sem categoria';
      const atual = porCategoriaMap.get(categoriaId) || { categoriaId, nome, quantidade: 0, receita: 0 };
      atual.quantidade += item.quantidade;
      atual.receita += Number(item.precoUnitario) * item.quantidade;
      porCategoriaMap.set(categoriaId, atual);
    }
  }
  const receitaTotalCategorias = Array.from(porCategoriaMap.values()).reduce((s, c) => s + c.receita, 0);
  const porCategoria = Array.from(porCategoriaMap.values())
    .map((c) => ({ ...c, percentual: receitaTotalCategorias > 0 ? (c.receita / receitaTotalCategorias) * 100 : 0 }))
    .sort((a, b) => b.receita - a.receita)
    .slice(0, 10);

  // Uso de funcionalidades — quantos tenants ligaram cada opt-in (+ cashback, que usa um percentual em vez de boolean).
  const usoFuncionalidades = FUNCIONALIDADES.map(({ campo, label }) => {
    const tenantsUsando = empresas.filter((e) => e[campo]).length;
    return { recurso: label, tenantsUsando, percentual: totalEmpresas > 0 ? Math.round((tenantsUsando / totalEmpresas) * 100) : 0 };
  });
  const tenantsComCashback = empresas.filter((e) => Number(e.cashbackPercent || 0) > 0).length;
  usoFuncionalidades.push({
    recurso: 'Cashback',
    tenantsUsando: tenantsComCashback,
    percentual: totalEmpresas > 0 ? Math.round((tenantsComCashback / totalEmpresas) * 100) : 0,
  });

  // Saúde por tenant — pedidos/faturamento/ticket médio no período selecionado, último pedido de
  // todos os tempos, último acesso ao admin.
  const ultimoPedidoMap = new Map(ultimoPedidoPorEmpresa.map((r) => [r.empresaId, r._max.createdAt]));
  const porTenant = empresas
    .map((e) => {
      const pedidosNoPeriodo = porEmpresaMap.get(e.id) || 0;
      const faturamentoNoPeriodo = faturamentoPorEmpresaMap.get(e.id) || 0;
      return {
        id: e.id,
        nome: e.nome,
        slug: e.slug,
        ativo: e.empresaAtiva,
        pedidosNoPeriodo,
        faturamentoNoPeriodo,
        ticketMedioNoPeriodo: pedidosNoPeriodo > 0 ? faturamentoNoPeriodo / pedidosNoPeriodo : 0,
        ultimoPedidoEm: ultimoPedidoMap.get(e.id) || null,
        ultimoAcessoAdminEm: e.ultimoAcessoAdminEm,
      };
    })
    .sort((a, b) => b.faturamentoNoPeriodo - a.faturamentoNoPeriodo);

  // Atividade recente — cruza direto Empresa/Pedido/TicketSuporte/LogAuditoria (não existe uma
  // única tabela de eventos hoje), pega os 8 mais recentes de cada fonte e intercala por data.
  const [novosTenants, pedidosRecentes, chamadosRecentes, alteracoesRecentes] = await Promise.all([
    prisma.empresa.findMany({ where: { ehDemo: false }, orderBy: { createdAt: 'desc' }, take: 8, select: { id: true, nome: true, createdAt: true } }),
    prisma.pedido.findMany({
      where: { empresa: { ehDemo: false } },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { id: true, numero: true, createdAt: true, empresa: { select: { nome: true } } },
    }),
    prisma.ticketSuporte.findMany({
      where: { empresa: { ehDemo: false } },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { id: true, assunto: true, createdAt: true, empresa: { select: { nome: true } } },
    }),
    prisma.logAuditoria.findMany({
      where: { tipo: 'ALTERACAO_CRITICA' },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { id: true, acao: true, empresaNome: true, createdAt: true },
    }),
  ]);
  const atividadeRecente = [
    ...novosTenants.map((e) => ({ tipo: 'NOVO_TENANT', descricao: `Novo tenant cadastrado: ${e.nome}`, data: e.createdAt })),
    ...pedidosRecentes.map((p) => ({ tipo: 'NOVO_PEDIDO', descricao: `Novo pedido #${p.numero} em ${p.empresa.nome}`, data: p.createdAt })),
    ...chamadosRecentes.map((c) => ({ tipo: 'NOVO_CHAMADO', descricao: `Novo chamado em ${c.empresa.nome}: ${c.assunto}`, data: c.createdAt })),
    ...alteracoesRecentes.map((a) => ({ tipo: 'ALTERACAO', descricao: a.empresaNome ? `${a.acao} (${a.empresaNome})` : a.acao, data: a.createdAt })),
  ]
    .sort((a, b) => new Date(b.data).getTime() - new Date(a.data).getTime())
    .slice(0, 12);

  res.json({
    totalEmpresas,
    empresasAtivas,
    empresasInativas: totalEmpresas - empresasAtivas,
    novosTenantsNoPeriodo,
    lojasComVendaNoPeriodo,
    totalClientes,
    totalMotoboysAtivos,
    gmv,
    totalPedidos,
    ticketMedio,
    comissaoTotal,
    pedidosPorDia,
    porFormaPagamento,
    porCategoria,
    dispositivos,
    navegadores,
    usoFuncionalidades,
    porTenant,
    atividadeRecente,
    alertas: {
      faturasPendentes,
      tenantsInativos30Dias,
    },
  });
}));

/**
 * @openapi
 * /super-admin/saltfood-coins:
 *   get:
 *     summary: Relatório do SaltFood Coins — ganho/gasto por loja no período + saldo atual da carteira compartilhada
 *     tags: [SuperAdmin]
 *     parameters:
 *       - in: query
 *         name: de
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: ate
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: Métricas agregadas do SaltFood Coins
 */
router.get('/saltfood-coins', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { de, ate } = req.query;
  const range = {
    gte: de ? new Date(`${de}T00:00:00`) : undefined,
    lte: ate ? new Date(`${ate}T23:59:59`) : undefined,
  };

  const [movimentosPorEmpresa, empresas, saldoAgregado, totalContasPlataforma] = await Promise.all([
    prisma.coinsMovimento.groupBy({
      by: ['empresaId', 'tipo'],
      where: { createdAt: range },
      _sum: { valor: true },
    }),
    prisma.empresa.findMany({
      select: { id: true, nome: true, slug: true, participaSaltfoodCoins: true, saltfoodCoinsPercent: true },
    }),
    prisma.contaPlataforma.aggregate({ _sum: { saldoCoins: true } }),
    prisma.contaPlataforma.count(),
  ]);

  // Ganho/gasto por loja no período — cada loja participa como origem (GANHO) e/ou destino (GASTO)
  // dos coins gastos por clientes que ganharam em outra loja, então o "líquido" pode ser negativo
  // (loja que mais recebe clientes gastando coins ganhos alhures) ou positivo (loja que mais credita).
  const porEmpresaMap = new Map();
  for (const m of movimentosPorEmpresa) {
    const atual = porEmpresaMap.get(m.empresaId) || { ganho: 0, gasto: 0 };
    if (m.tipo === 'GANHO') atual.ganho = Number(m._sum.valor || 0);
    else atual.gasto = Number(m._sum.valor || 0);
    porEmpresaMap.set(m.empresaId, atual);
  }

  const porLoja = empresas
    .map((e) => {
      const { ganho, gasto } = porEmpresaMap.get(e.id) || { ganho: 0, gasto: 0 };
      return {
        id: e.id,
        nome: e.nome,
        slug: e.slug,
        participa: e.participaSaltfoodCoins,
        percentual: e.saltfoodCoinsPercent != null ? Number(e.saltfoodCoinsPercent) : null,
        ganhoNoPeriodo: ganho,
        gastoNoPeriodo: gasto,
        liquidoNoPeriodo: ganho - gasto,
      };
    })
    .filter((l) => l.participa || l.ganhoNoPeriodo > 0 || l.gastoNoPeriodo > 0)
    .sort((a, b) => (b.ganhoNoPeriodo + b.gastoNoPeriodo) - (a.ganhoNoPeriodo + a.gastoNoPeriodo));

  const totalGanhoPeriodo = porLoja.reduce((sum, l) => sum + l.ganhoNoPeriodo, 0);
  const totalGastoPeriodo = porLoja.reduce((sum, l) => sum + l.gastoNoPeriodo, 0);

  res.json({
    tenantsParticipando: empresas.filter((e) => e.participaSaltfoodCoins).length,
    totalContasPlataforma,
    saldoTotalAtual: Number(saldoAgregado._sum.saldoCoins || 0),
    totalGanhoPeriodo,
    totalGastoPeriodo,
    porLoja,
  });
}));

/**
 * @openapi
 * /super-admin/saltfood-coins/movimentos:
 *   get:
 *     summary: Ledger do SaltFood Coins — últimos ganhos/gastos, com loja, cliente e pedido de origem
 *     tags: [SuperAdmin]
 *     parameters:
 *       - in: query
 *         name: empresaId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: tipo
 *         schema: { type: string, enum: [GANHO, GASTO] }
 *       - in: query
 *         name: de
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: ate
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: Últimas 200 movimentações que casam com o filtro
 */
router.get('/saltfood-coins/movimentos', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { empresaId, tipo, de, ate } = req.query;
  const range = {
    gte: de ? new Date(`${de}T00:00:00`) : undefined,
    lte: ate ? new Date(`${ate}T23:59:59`) : undefined,
  };

  const movimentos = await prisma.coinsMovimento.findMany({
    where: {
      ...(empresaId ? { empresaId } : {}),
      ...(tipo === 'GANHO' || tipo === 'GASTO' ? { tipo } : {}),
      createdAt: range,
    },
    include: {
      empresa: { select: { id: true, nome: true, slug: true } },
      cliente: { select: { id: true, nome: true, email: true } },
      pedido: { select: { id: true, numero: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  res.json(movimentos);
}));

/**
 * @openapi
 * /super-admin/saltfood-coins/contas:
 *   get:
 *     summary: Contas de plataforma do SaltFood Coins — saldo e em quais lojas cada cliente está vinculado
 *     tags: [SuperAdmin]
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Filtra por e-mail (contém)
 *     responses:
 *       200:
 *         description: Até 200 contas, saldo decrescente
 */
router.get('/saltfood-coins/contas', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { q } = req.query;

  const contas = await prisma.contaPlataforma.findMany({
    where: q ? { email: { contains: q, mode: 'insensitive' } } : undefined,
    select: {
      id: true,
      email: true,
      telefone: true,
      saldoCoins: true,
      createdAt: true,
      clientes: { select: { id: true, nome: true, empresa: { select: { id: true, nome: true } } } },
    },
    orderBy: { saldoCoins: 'desc' },
    take: 200,
  });

  res.json(contas);
}));

const STATUS_CHAMADO_VALIDOS = ['ABERTO', 'EM_ANDAMENTO', 'RESOLVIDO'];

/**
 * @openapi
 * /super-admin/chamados-lojistas:
 *   get:
 *     summary: Lista chamados que lojistas abriram diretamente com a plataforma (clienteId null)
 *     tags: [SuperAdmin]
 *     responses:
 *       200:
 *         description: Chamados de todas as empresas, mais recentes primeiro
 */
router.get('/chamados-lojistas', requireSuperAdmin, asyncHandler(async (req, res) => {
  const chamados = await prisma.ticketSuporte.findMany({
    where: { clienteId: null },
    include: { empresa: { select: { id: true, nome: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(chamados);
}));

/**
 * @openapi
 * /super-admin/chamados-lojistas/{id}:
 *   patch:
 *     summary: Super Admin responde e/ou atualiza o status de um chamado de lojista
 *     tags: [SuperAdmin]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status: { type: string, enum: [ABERTO, EM_ANDAMENTO, RESOLVIDO] }
 *               respostaAdmin: { type: string }
 *     responses:
 *       200:
 *         description: Chamado atualizado
 *       404:
 *         description: Chamado não encontrado
 */
router.patch('/chamados-lojistas/:id', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { status, respostaAdmin } = req.body;
  if (status !== undefined && !STATUS_CHAMADO_VALIDOS.includes(status)) {
    return res.status(400).json({ error: `Campo "status" deve ser um de: ${STATUS_CHAMADO_VALIDOS.join(', ')}` });
  }

  const existente = await prisma.ticketSuporte.findFirst({ where: { id: req.params.id, clienteId: null } });
  if (!existente) {
    return res.status(404).json({ error: 'Chamado não encontrado' });
  }

  const chamado = await prisma.ticketSuporte.update({
    where: { id: req.params.id },
    data: {
      ...(status !== undefined ? { status } : {}),
      ...(respostaAdmin !== undefined ? { respostaAdmin: respostaAdmin || null } : {}),
    },
    include: { empresa: { select: { id: true, nome: true } } },
  });

  res.json(chamado);
}));

/**
 * @openapi
 * /super-admin/notificacoes:
 *   get:
 *     summary: Agrega sinais reais que pedem atenção do Super Admin (faturas pendentes, leads novos, chamados abertos, tenants inativos) num feed único
 *     tags: [SuperAdmin]
 *     responses:
 *       200:
 *         description: Lista de notificações, mais recente primeiro
 */
router.get('/notificacoes', requireSuperAdmin, asyncHandler(async (req, res) => {
  const trintaDiasAtras = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [faturasPendentes, leadsNovos, chamadosAbertos, tenantsInativos] = await Promise.all([
    prisma.fatura.findMany({
      where: { status: 'PENDENTE', empresa: { ehDemo: false } },
      include: { empresa: { select: { nome: true } } },
      orderBy: { vencimento: 'asc' },
      take: 10,
    }),
    prisma.leadComercial.findMany({
      where: { status: 'NOVO' },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    prisma.ticketSuporte.findMany({
      where: { clienteId: null, status: 'ABERTO' },
      include: { empresa: { select: { nome: true } } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    prisma.empresa.findMany({
      where: {
        ehDemo: false, empresaAtiva: true, createdAt: { lt: trintaDiasAtras },
        OR: [{ ultimoAcessoAdminEm: null }, { ultimoAcessoAdminEm: { lt: trintaDiasAtras } }],
      },
      select: { id: true, nome: true, ultimoAcessoAdminEm: true },
      take: 10,
    }),
  ]);

  const notificacoes = [
    ...faturasPendentes.map((f) => ({
      tipo: 'FATURA_PENDENTE',
      descricao: `Fatura de ${f.empresa.nome} pendente (vence ${new Date(f.vencimento).toLocaleDateString('pt-BR')})`,
      data: f.vencimento,
    })),
    ...leadsNovos.map((l) => ({ tipo: 'LEAD_NOVO', descricao: `Novo lead: ${l.nome}`, data: l.createdAt })),
    ...chamadosAbertos.map((c) => ({ tipo: 'CHAMADO_ABERTO', descricao: `Chamado aberto de ${c.empresa.nome}: ${c.assunto}`, data: c.createdAt })),
    ...tenantsInativos.map((t) => ({
      tipo: 'TENANT_INATIVO',
      descricao: `${t.nome} sem acesso ao admin há mais de 30 dias`,
      data: t.ultimoAcessoAdminEm || new Date(0),
    })),
  ].sort((a, b) => new Date(b.data).getTime() - new Date(a.data).getTime());

  res.json({ notificacoes, total: notificacoes.length });
}));

module.exports = router;
