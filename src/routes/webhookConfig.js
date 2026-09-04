const { Router } = require('express');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { requireEmpresaAdmin, requireGrupo } = require('../lib/auth');
const { EVENTOS_WEBHOOK } = require('../lib/webhookEventos');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);
router.use(requireEmpresaAdmin());
router.use(requireGrupo('sistema'));

const gerarSecret = () => crypto.randomBytes(24).toString('hex');

/**
 * @openapi
 * /empresas/{empresaId}/webhook:
 *   get:
 *     summary: Configuração de webhook da loja (url, eventos inscritos, secret, ativo) + últimos disparos
 *     tags: [Sistema]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Configuração e histórico de disparos
 */
router.get('/', asyncHandler(async (req, res) => {
  const config = await prisma.webhookConfig.findUnique({ where: { empresaId: req.params.empresaId } });
  const logs = config
    ? await prisma.webhookLog.findMany({ where: { webhookConfigId: config.id }, orderBy: { createdAt: 'desc' }, take: 30 })
    : [];
  res.json({ config, logs, eventosDisponiveis: EVENTOS_WEBHOOK });
}));

/**
 * @openapi
 * /empresas/{empresaId}/webhook:
 *   put:
 *     summary: Cria ou atualiza a configuração de webhook da loja (a primeira gravação gera o secret automaticamente)
 *     tags: [Sistema]
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
 *             properties:
 *               url: { type: string }
 *               eventos: { type: array, items: { type: string } }
 *               ativo: { type: boolean }
 *     responses:
 *       200:
 *         description: Configuração salva
 *       400:
 *         description: Dados inválidos
 */
router.put('/', asyncHandler(async (req, res) => {
  const { url, eventos, ativo } = req.body;

  if (url !== undefined) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocolo inválido');
    } catch {
      return res.status(400).json({ error: 'Campo "url" deve ser uma URL http/https válida' });
    }
  }
  if (eventos !== undefined) {
    if (!Array.isArray(eventos) || !eventos.every((e) => EVENTOS_WEBHOOK.includes(e))) {
      return res.status(400).json({ error: `Campo "eventos" deve ser uma lista com valores entre: ${EVENTOS_WEBHOOK.join(', ')}` });
    }
  }
  if (ativo !== undefined && typeof ativo !== 'boolean') {
    return res.status(400).json({ error: 'Campo "ativo" deve ser booleano' });
  }

  const existente = await prisma.webhookConfig.findUnique({ where: { empresaId: req.params.empresaId } });

  if (!existente) {
    if (!url) {
      return res.status(400).json({ error: 'Campo "url" é obrigatório na primeira configuração' });
    }
    const config = await prisma.webhookConfig.create({
      data: {
        empresaId: req.params.empresaId,
        url,
        eventos: eventos || [],
        ativo: ativo ?? false,
        secret: gerarSecret(),
      },
    });
    return res.status(201).json(config);
  }

  const config = await prisma.webhookConfig.update({
    where: { empresaId: req.params.empresaId },
    data: {
      ...(url !== undefined ? { url } : {}),
      ...(eventos !== undefined ? { eventos } : {}),
      ...(ativo !== undefined ? { ativo } : {}),
    },
  });
  res.json(config);
}));

/**
 * @openapi
 * /empresas/{empresaId}/webhook/regenerar-secret:
 *   post:
 *     summary: Gera um novo secret pro webhook (invalida o anterior — atualize o destino em seguida)
 *     tags: [Sistema]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Novo secret gerado
 *       404:
 *         description: Nenhuma configuração de webhook encontrada
 */
router.post('/regenerar-secret', asyncHandler(async (req, res) => {
  const existente = await prisma.webhookConfig.findUnique({ where: { empresaId: req.params.empresaId } });
  if (!existente) {
    return res.status(404).json({ error: 'Nenhuma configuração de webhook encontrada' });
  }
  const config = await prisma.webhookConfig.update({
    where: { empresaId: req.params.empresaId },
    data: { secret: gerarSecret() },
  });
  res.json(config);
}));

module.exports = router;
