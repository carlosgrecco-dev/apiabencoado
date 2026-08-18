const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { requireEmpresaAdmin } = require('../lib/auth');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);
router.use(requireEmpresaAdmin());

const PROVIDERS_VALIDOS = ['PIX_MANUAL', 'PAGSEGURO', 'MERCADOPAGO', 'STRIPE'];
const NOMES_PADRAO = {
  PIX_MANUAL: 'PIX manual',
  PAGSEGURO: 'PagSeguro',
  MERCADOPAGO: 'Mercado Pago',
  STRIPE: 'Stripe',
};

/** Remove as chaves sensíveis antes de devolver — a UI mostra "configurado"/"não configurado", não o valor. */
const serializeGateway = (gateway, { comChaves = false } = {}) => {
  if (comChaves) return gateway;
  const { chaveSecreta, webhookSecret, ...rest } = gateway;
  return { ...rest, chaveSecreta: chaveSecreta ? '••••••••' : null, webhookSecret: webhookSecret ? '••••••••' : null };
};

/**
 * @openapi
 * /empresas/{empresaId}/gateways-pagamento:
 *   get:
 *     summary: Lista as credenciais de gateway de pagamento da empresa (chaves secretas mascaradas)
 *     tags: [GatewaysPagamento]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Lista de gateways (existentes + padrão para os ainda não configurados)
 */
router.get('/', asyncHandler(async (req, res) => {
  const existentes = await prisma.gatewayPagamento.findMany({ where: { empresaId: req.params.empresaId } });
  const existentesPorProvider = new Map(existentes.map((g) => [g.provider, g]));

  const lista = PROVIDERS_VALIDOS.map((provider) => {
    const existente = existentesPorProvider.get(provider);
    if (existente) return serializeGateway(existente);
    return {
      id: null,
      empresaId: req.params.empresaId,
      provider,
      nomeExibicao: NOMES_PADRAO[provider],
      ativo: false,
      chavePublica: null,
      chaveSecreta: null,
      webhookSecret: null,
    };
  });

  res.json(lista);
}));

/**
 * @openapi
 * /empresas/{empresaId}/gateways-pagamento/{provider}:
 *   put:
 *     summary: Cria ou atualiza as credenciais de um provedor de pagamento
 *     tags: [GatewaysPagamento]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: provider
 *         required: true
 *         schema: { type: string, enum: [PIX_MANUAL, PAGSEGURO, MERCADOPAGO, STRIPE] }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ativo: { type: boolean }
 *               chavePublica: { type: string }
 *               chaveSecreta: { type: string }
 *               webhookSecret: { type: string }
 *     responses:
 *       200:
 *         description: Gateway atualizado
 *       400:
 *         description: Provider inválido
 */
router.put('/:provider', asyncHandler(async (req, res) => {
  const provider = req.params.provider.toUpperCase();
  if (!PROVIDERS_VALIDOS.includes(provider)) {
    return res.status(400).json({ error: `Provider deve ser um de: ${PROVIDERS_VALIDOS.join(', ')}` });
  }

  const { ativo, chavePublica, chaveSecreta, webhookSecret } = req.body;

  const gateway = await prisma.gatewayPagamento.upsert({
    where: { empresaId_provider: { empresaId: req.params.empresaId, provider } },
    create: {
      empresaId: req.params.empresaId,
      provider,
      nomeExibicao: NOMES_PADRAO[provider],
      ativo: Boolean(ativo),
      chavePublica: chavePublica || null,
      chaveSecreta: chaveSecreta || null,
      webhookSecret: webhookSecret || null,
    },
    update: {
      ...(ativo !== undefined ? { ativo } : {}),
      ...(chavePublica !== undefined ? { chavePublica: chavePublica || null } : {}),
      ...(chaveSecreta !== undefined ? { chaveSecreta: chaveSecreta || null } : {}),
      ...(webhookSecret !== undefined ? { webhookSecret: webhookSecret || null } : {}),
    },
  });

  res.json(serializeGateway(gateway));
}));

module.exports = router;
