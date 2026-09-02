const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { requireEmpresaAdmin } = require('../lib/auth');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);
router.use(requireEmpresaAdmin());

/**
 * @openapi
 * /empresas/{empresaId}/logs-atividade:
 *   get:
 *     summary: Log de atividade da própria loja (pedido cancelado, produto criado/removido, config de pagamento alterada, usuário admin criado/removido) — diferente do log de auditoria da plataforma, que só o Super Admin vê
 *     tags: [Sistema]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: limite
 *         schema: { type: integer, default: 100 }
 *     responses:
 *       200:
 *         description: Lista de atividades, mais recente primeiro
 */
router.get('/', asyncHandler(async (req, res) => {
  const limite = Math.min(500, Math.max(1, Number(req.query.limite) || 100));
  const logs = await prisma.logAtividadeLoja.findMany({
    where: { empresaId: req.params.empresaId },
    orderBy: { createdAt: 'desc' },
    take: limite,
  });
  res.json(logs);
}));

module.exports = router;
