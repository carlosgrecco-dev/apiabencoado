const { Router } = require('express');
const loadEmpresa = require('../lib/loadEmpresa');
const { requireEmpresaAdmin } = require('../lib/auth');
const presence = require('../lib/presence');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);

/**
 * @openapi
 * /empresas/{empresaId}/presence/ping:
 *   post:
 *     summary: Ping do storefront pra contagem de "usuários online" — sem autenticação, sem dado pessoal, só um id de sessão de navegador (sessionStorage)
 *     tags: [Dashboard]
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
 *             required: [sessionId]
 *             properties:
 *               sessionId: { type: string }
 *     responses:
 *       204:
 *         description: Ping registrado
 *       400:
 *         description: sessionId inválido
 */
router.post('/ping', asyncHandler(async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 100) {
    return res.status(400).json({ error: 'sessionId inválido' });
  }
  presence.ping(req.params.empresaId, sessionId);
  res.status(204).end();
}));

/**
 * @openapi
 * /empresas/{empresaId}/presence/count:
 *   get:
 *     summary: Quantos navegadores estão navegando na loja agora
 *     tags: [Dashboard]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Contagem atual
 */
router.get('/count', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  res.json({ online: presence.contar(req.params.empresaId) });
}));

module.exports = router;
