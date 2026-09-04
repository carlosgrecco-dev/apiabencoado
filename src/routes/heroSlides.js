const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { requireEmpresaAdmin , requireGrupo } = require('../lib/auth');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);

const handlePrismaError = (error, res) => {
  if (error.code === 'P2025') {
    return res.status(404).json({ error: 'Slide não encontrado' });
  }
  throw error;
};

const validarPayload = ({ titulo, imagemUrl }) => {
  const erros = [];
  if (!titulo) erros.push('Campo "titulo" é obrigatório');
  if (!imagemUrl) erros.push('Campo "imagemUrl" é obrigatório');
  return erros;
};

/**
 * @openapi
 * components:
 *   schemas:
 *     HeroSlide:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid, readOnly: true }
 *         empresaId: { type: string, format: uuid }
 *         imagemUrl: { type: string }
 *         titulo: { type: string }
 *         subtitulo: { type: string, nullable: true }
 *         badgeLabel: { type: string, nullable: true }
 *         linkUrl: { type: string, nullable: true }
 *         ordem: { type: integer }
 *         ativo: { type: boolean }
 *     HeroSlideInput:
 *       type: object
 *       required: [titulo, imagemUrl]
 *       properties:
 *         imagemUrl: { type: string }
 *         titulo: { type: string }
 *         subtitulo: { type: string }
 *         badgeLabel: { type: string }
 *         linkUrl: { type: string }
 *         ordem: { type: integer }
 *         ativo: { type: boolean }
 */

/**
 * @openapi
 * /empresas/{empresaId}/hero-slides:
 *   get:
 *     summary: Lista os slides do carrossel do Hero
 *     tags: [HeroSlides]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: ativo
 *         schema: { type: boolean }
 *     responses:
 *       200:
 *         description: Lista de slides
 */
router.get('/', asyncHandler(async (req, res) => {
  const { ativo } = req.query;
  const where = {
    empresaId: req.params.empresaId,
    ...(ativo !== undefined ? { ativo: ativo === 'true' } : {}),
  };

  const slides = await prisma.heroSlide.findMany({
    where,
    orderBy: [{ ordem: 'asc' }, { createdAt: 'asc' }],
  });

  res.json(slides);
}));

/**
 * @openapi
 * /empresas/{empresaId}/hero-slides:
 *   post:
 *     summary: Cria um novo slide do Hero
 *     tags: [HeroSlides]
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
 *             $ref: '#/components/schemas/HeroSlideInput'
 *     responses:
 *       201:
 *         description: Slide criado
 *       400:
 *         description: Dados inválidos
 */
router.post('/', requireEmpresaAdmin(), requireGrupo('sistema'), asyncHandler(async (req, res) => {
  const { imagemUrl, titulo, subtitulo, badgeLabel, linkUrl, ordem, ativo } = req.body;

  const erros = validarPayload(req.body);
  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }

  const slide = await prisma.heroSlide.create({
    data: {
      empresaId: req.params.empresaId,
      imagemUrl,
      titulo,
      subtitulo: subtitulo || null,
      badgeLabel: badgeLabel || null,
      linkUrl: linkUrl || null,
      ...(ordem !== undefined ? { ordem } : {}),
      ...(ativo !== undefined ? { ativo } : {}),
    },
  });

  res.status(201).json(slide);
}));

/**
 * @openapi
 * /empresas/{empresaId}/hero-slides/{id}:
 *   put:
 *     summary: Atualiza um slide do Hero
 *     tags: [HeroSlides]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/HeroSlideInput'
 *     responses:
 *       200:
 *         description: Slide atualizado
 *       404:
 *         description: Slide não encontrado
 */
router.put('/:id', requireEmpresaAdmin(), requireGrupo('sistema'), asyncHandler(async (req, res) => {
  const { imagemUrl, titulo, subtitulo, badgeLabel, linkUrl, ordem, ativo } = req.body;

  const erros = validarPayload(req.body);
  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }

  const existente = await prisma.heroSlide.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Slide não encontrado' });
  }

  try {
    const slide = await prisma.heroSlide.update({
      where: { id: req.params.id },
      data: {
        imagemUrl,
        titulo,
        subtitulo: subtitulo || null,
        badgeLabel: badgeLabel || null,
        linkUrl: linkUrl || null,
        ...(ordem !== undefined ? { ordem } : {}),
        ...(ativo !== undefined ? { ativo } : {}),
      },
    });
    res.json(slide);
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{empresaId}/hero-slides/{id}/status:
 *   patch:
 *     summary: Ativa ou inativa um slide do Hero
 *     tags: [HeroSlides]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ativo]
 *             properties:
 *               ativo: { type: boolean }
 *     responses:
 *       200:
 *         description: Status atualizado
 *       404:
 *         description: Slide não encontrado
 */
router.patch('/:id/status', requireEmpresaAdmin(), requireGrupo('sistema'), asyncHandler(async (req, res) => {
  const { ativo } = req.body;
  if (typeof ativo !== 'boolean') {
    return res.status(400).json({ error: 'Campo "ativo" é obrigatório e deve ser booleano' });
  }

  const existente = await prisma.heroSlide.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Slide não encontrado' });
  }

  const slide = await prisma.heroSlide.update({
    where: { id: req.params.id },
    data: { ativo },
  });

  res.json(slide);
}));

/**
 * @openapi
 * /empresas/{empresaId}/hero-slides/{id}:
 *   delete:
 *     summary: Remove um slide do Hero
 *     tags: [HeroSlides]
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
 *         description: Slide removido
 *       404:
 *         description: Slide não encontrado
 */
router.delete('/:id', requireEmpresaAdmin(), requireGrupo('sistema'), asyncHandler(async (req, res) => {
  const existente = await prisma.heroSlide.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Slide não encontrado' });
  }

  await prisma.heroSlide.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

module.exports = router;
