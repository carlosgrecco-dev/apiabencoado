const { Router } = require('express');
const prisma = require('../lib/prisma');
const { requireSuperAdmin } = require('../lib/auth');

const router = Router();

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(requireSuperAdmin);

const TIPOS_VALIDOS = ['ACESSO', 'ERRO', 'ALTERACAO_CRITICA'];

/**
 * @openapi
 * /logs:
 *   get:
 *     summary: Lista os logs de auditoria (acessos, erros do servidor e alterações críticas)
 *     tags: [Logs]
 *     parameters:
 *       - in: query
 *         name: tipo
 *         schema: { type: string, enum: [ACESSO, ERRO, ALTERACAO_CRITICA] }
 *       - in: query
 *         name: empresaId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: de
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: ate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 200 }
 *     responses:
 *       200:
 *         description: Lista de logs (mais recentes primeiro)
 */
router.get('/', asyncHandler(async (req, res) => {
  const { tipo, empresaId, de, ate, limit } = req.query;

  if (tipo && !TIPOS_VALIDOS.includes(tipo)) {
    return res.status(400).json({ error: `Campo "tipo" deve ser um de: ${TIPOS_VALIDOS.join(', ')}` });
  }

  const take = Math.min(Number(limit) || 200, 500);

  const logs = await prisma.logAuditoria.findMany({
    where: {
      ...(tipo ? { tipo } : {}),
      ...(empresaId ? { empresaId } : {}),
      ...(de || ate
        ? {
          createdAt: {
            ...(de ? { gte: new Date(`${de}T00:00:00`) } : {}),
            ...(ate ? { lte: new Date(`${ate}T23:59:59`) } : {}),
          },
        }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    take,
  });

  res.json(logs);
}));

/**
 * @openapi
 * /logs/gateways-status:
 *   get:
 *     summary: Status atual das integrações de gateway de pagamento de todas as empresas
 *     tags: [Logs]
 *     responses:
 *       200:
 *         description: Lista de gateways com a empresa e o status atual
 */
router.get('/gateways-status', asyncHandler(async (req, res) => {
  const gateways = await prisma.gatewayPagamento.findMany({
    select: {
      id: true, provider: true, nomeExibicao: true, ativo: true, updatedAt: true,
      empresa: { select: { id: true, nome: true, slug: true } },
    },
    orderBy: [{ ativo: 'desc' }, { updatedAt: 'desc' }],
  });
  res.json(gateways);
}));

module.exports = router;
