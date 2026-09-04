const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { requireEmpresaAdmin, requireGrupo } = require('../lib/auth');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);
router.use(requireEmpresaAdmin());
router.use(requireGrupo('delivery'));

const TIPOS_VALIDOS = ['BAIRRO', 'RAIO_KM', 'FAIXA_DISTANCIA'];

const handlePrismaError = (error, res) => {
  if (error.code === 'P2025') {
    return res.status(404).json({ error: 'Zona de entrega não encontrada' });
  }
  throw error;
};

const validarPayload = ({ tipo, bairro, taxa, distanciaDeKm, distanciaAteKm }) => {
  const erros = [];
  if (tipo && !TIPOS_VALIDOS.includes(tipo)) {
    erros.push(`Campo "tipo" deve ser um de: ${TIPOS_VALIDOS.join(', ')}`);
  }
  if (taxa === undefined || Number.isNaN(Number(taxa)) || Number(taxa) < 0) {
    erros.push('Campo "taxa" é obrigatório e deve ser maior ou igual a zero');
  }
  if ((tipo || 'BAIRRO') === 'BAIRRO' && !bairro) {
    erros.push('Campo "bairro" é obrigatório para zonas do tipo BAIRRO');
  }
  if ((tipo === 'RAIO_KM' || tipo === 'FAIXA_DISTANCIA')) {
    if (distanciaDeKm === undefined || distanciaAteKm === undefined) {
      erros.push('Campos "distanciaDeKm" e "distanciaAteKm" são obrigatórios para este tipo de zona');
    }
  }
  return erros;
};

/**
 * @openapi
 * /empresas/{empresaId}/zonas-entrega:
 *   get:
 *     summary: Lista as zonas de entrega (taxas por bairro/raio/faixa) de uma empresa
 *     tags: [ZonasEntrega]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Lista de zonas de entrega
 */
router.get('/', asyncHandler(async (req, res) => {
  const zonas = await prisma.zonaEntrega.findMany({
    where: { empresaId: req.params.empresaId },
    orderBy: [{ ordem: 'asc' }, { createdAt: 'asc' }],
  });
  res.json(zonas);
}));

/**
 * @openapi
 * /empresas/{empresaId}/zonas-entrega:
 *   post:
 *     summary: Cadastra uma nova zona de entrega
 *     tags: [ZonasEntrega]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: Zona criada
 *       400:
 *         description: Dados inválidos
 */
router.post('/', asyncHandler(async (req, res) => {
  const { tipo, bairro, distanciaDeKm, distanciaAteKm, taxa, ativo, ordem } = req.body;

  const erros = validarPayload(req.body);
  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }

  const zona = await prisma.zonaEntrega.create({
    data: {
      empresaId: req.params.empresaId,
      tipo: tipo || 'BAIRRO',
      bairro: bairro || null,
      distanciaDeKm: distanciaDeKm ?? null,
      distanciaAteKm: distanciaAteKm ?? null,
      taxa,
      ...(ativo !== undefined ? { ativo } : {}),
      ...(ordem !== undefined ? { ordem } : {}),
    },
  });

  res.status(201).json(zona);
}));

/**
 * @openapi
 * /empresas/{empresaId}/zonas-entrega/{id}:
 *   put:
 *     summary: Atualiza uma zona de entrega
 *     tags: [ZonasEntrega]
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
 *         description: Zona atualizada
 *       404:
 *         description: Zona não encontrada
 */
router.put('/:id', asyncHandler(async (req, res) => {
  const { tipo, bairro, distanciaDeKm, distanciaAteKm, taxa, ativo, ordem } = req.body;

  const erros = validarPayload(req.body);
  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }

  const existente = await prisma.zonaEntrega.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Zona de entrega não encontrada' });
  }

  const zona = await prisma.zonaEntrega.update({
    where: { id: req.params.id },
    data: {
      tipo: tipo || 'BAIRRO',
      bairro: bairro || null,
      distanciaDeKm: distanciaDeKm ?? null,
      distanciaAteKm: distanciaAteKm ?? null,
      taxa,
      ...(ativo !== undefined ? { ativo } : {}),
      ...(ordem !== undefined ? { ordem } : {}),
    },
  });

  res.json(zona);
}));

/**
 * @openapi
 * /empresas/{empresaId}/zonas-entrega/{id}/status:
 *   patch:
 *     summary: Ativa ou inativa uma zona de entrega
 *     tags: [ZonasEntrega]
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
 *         description: Status atualizado
 *       404:
 *         description: Zona não encontrada
 */
router.patch('/:id/status', asyncHandler(async (req, res) => {
  const { ativo } = req.body;
  if (typeof ativo !== 'boolean') {
    return res.status(400).json({ error: 'Campo "ativo" é obrigatório e deve ser booleano' });
  }

  const existente = await prisma.zonaEntrega.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Zona de entrega não encontrada' });
  }

  try {
    const zona = await prisma.zonaEntrega.update({
      where: { id: req.params.id },
      data: { ativo },
    });
    res.json(zona);
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{empresaId}/zonas-entrega/{id}:
 *   delete:
 *     summary: Remove uma zona de entrega
 *     tags: [ZonasEntrega]
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
 *       204:
 *         description: Zona removida
 *       404:
 *         description: Zona não encontrada
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const existente = await prisma.zonaEntrega.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Zona de entrega não encontrada' });
  }

  await prisma.zonaEntrega.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

module.exports = router;
