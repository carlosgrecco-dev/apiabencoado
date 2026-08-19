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

  const [totalEmpresas, empresasAtivas, totalClientes, totalMotoboysAtivos, novosTenantsNoPeriodo, entregues, ultimoPedidoPorEmpresa, empresas] = await Promise.all([
    prisma.empresa.count(),
    prisma.empresa.count({ where: { empresaAtiva: true } }),
    prisma.cliente.count(),
    prisma.motoboy.count({ where: { ativo: true } }),
    prisma.empresa.count({ where: { createdAt: range } }),
    prisma.pedido.findMany({
      where: { status: 'ENTREGUE', createdAt: range },
      select: { total: true, empresaId: true, createdAt: true, userAgent: true },
    }),
    prisma.pedido.groupBy({ by: ['empresaId'], where: { status: 'ENTREGUE' }, _max: { createdAt: true } }),
    prisma.empresa.findMany({
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

module.exports = router;
