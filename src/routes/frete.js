const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { calcularFrete } = require('../lib/calcularFrete');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);

/**
 * @openapi
 * /empresas/{empresaId}/frete/calcular:
 *   post:
 *     summary: Calcula a taxa de entrega para um bairro/subtotal (usado no checkout)
 *     tags: [Frete]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               bairro: { type: string }
 *               subtotal: { type: number }
 *     responses:
 *       200:
 *         description: Taxa calculada
 */
router.post('/calcular', asyncHandler(async (req, res) => {
  const { bairro, subtotal } = req.body;

  const zonas = await prisma.zonaEntrega.findMany({
    where: { empresaId: req.params.empresaId, tipo: 'BAIRRO', ativo: true },
  });

  const resultado = calcularFrete({
    zonas,
    bairro,
    subtotal: Number(subtotal) || 0,
    taxaPadrao: req.empresa.taxaEntrega,
    freteGratisAcimaDe: req.empresa.freteGratisAcimaDe,
  });

  res.json({
    taxa: resultado.taxa,
    freteGratis: resultado.freteGratis,
    zonaAplicada: resultado.zona ? { id: resultado.zona.id, bairro: resultado.zona.bairro } : null,
  });
}));

module.exports = router;
