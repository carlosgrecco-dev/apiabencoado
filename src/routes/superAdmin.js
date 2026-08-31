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
  const [totalEmpresas, empresasAtivas, totalClientes, totalMotoboysAtivos, novosTenantsNoPeriodo, entregues, ultimoPedidoPorEmpresa, empresas] = await Promise.all([
    prisma.empresa.count({ where: { ehDemo: false } }),
    prisma.empresa.count({ where: { empresaAtiva: true, ehDemo: false } }),
    prisma.cliente.count({ where: { empresa: { ehDemo: false } } }),
    prisma.motoboy.count({ where: { ativo: true, empresa: { ehDemo: false } } }),
    prisma.empresa.count({ where: { createdAt: range, ehDemo: false } }),
    prisma.pedido.findMany({
      where: { status: 'ENTREGUE', createdAt: range, empresa: { ehDemo: false } },
      select: { total: true, empresaId: true, createdAt: true, userAgent: true },
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
  for (const p of entregues) {
    porEmpresaMap.set(p.empresaId, (porEmpresaMap.get(p.empresaId) || 0) + 1);
  }
  const lojasComVendaNoPeriodo = porEmpresaMap.size;

  // Tendência de pedidos por dia (plataforma inteira) — mesmo padrão já usado no CRM de cada loja.
  const porDiaMap = new Map();
  for (const p of entregues) {
    const dia = p.createdAt.toISOString().slice(0, 10);
    porDiaMap.set(dia, (porDiaMap.get(dia) || 0) + 1);
  }
  const pedidosPorDia = Array.from(porDiaMap.entries())
    .map(([data, pedidos]) => ({ data, pedidos }))
    .sort((a, b) => a.data.localeCompare(b.data));

  // Dispositivo/navegador agregado — a partir do User-Agent salvo em cada pedido do período.
  const { dispositivos, navegadores } = agregarDispositivos(entregues.map((p) => p.userAgent));

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

  // Saúde por tenant — pedidos no período selecionado, último pedido de todos os tempos, último acesso ao admin.
  const ultimoPedidoMap = new Map(ultimoPedidoPorEmpresa.map((r) => [r.empresaId, r._max.createdAt]));
  const porTenant = empresas
    .map((e) => ({
      id: e.id,
      nome: e.nome,
      slug: e.slug,
      ativo: e.empresaAtiva,
      pedidosNoPeriodo: porEmpresaMap.get(e.id) || 0,
      ultimoPedidoEm: ultimoPedidoMap.get(e.id) || null,
      ultimoAcessoAdminEm: e.ultimoAcessoAdminEm,
    }))
    .sort((a, b) => b.pedidosNoPeriodo - a.pedidosNoPeriodo);

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
    dispositivos,
    navegadores,
    usoFuncionalidades,
    porTenant,
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

module.exports = router;
