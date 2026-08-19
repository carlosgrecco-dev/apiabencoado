const { Router } = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { signToken, requireSuperAdmin } = require('../lib/auth');

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
router.get('/dashboard', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { de, ate } = req.query;
  const range = {
    gte: de ? new Date(`${de}T00:00:00`) : undefined,
    lte: ate ? new Date(`${ate}T23:59:59`) : undefined,
  };

  const [totalEmpresas, empresasAtivas, totalClientes, totalMotoboysAtivos, entregues] = await Promise.all([
    prisma.empresa.count(),
    prisma.empresa.count({ where: { empresaAtiva: true } }),
    prisma.cliente.count(),
    prisma.motoboy.count({ where: { ativo: true } }),
    prisma.pedido.findMany({
      where: { status: 'ENTREGUE', createdAt: range },
      select: { total: true, empresaId: true },
    }),
  ]);

  const empresas = await prisma.empresa.findMany({ select: { id: true, comissaoPercent: true } });
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

  res.json({
    totalEmpresas,
    empresasAtivas,
    empresasInativas: totalEmpresas - empresasAtivas,
    lojasComVendaNoPeriodo,
    totalClientes,
    totalMotoboysAtivos,
    gmv,
    totalPedidos,
    ticketMedio,
    comissaoTotal,
  });
}));

module.exports = router;
