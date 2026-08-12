const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);

const HORA_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * @openapi
 * /empresas/{empresaId}/horarios:
 *   get:
 *     summary: Lista os horários de funcionamento (por dia da semana) de uma empresa
 *     tags: [Horarios]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Lista de horários (0=domingo...6=sábado)
 */
router.get('/', asyncHandler(async (req, res) => {
  const horarios = await prisma.horarioFuncionamento.findMany({
    where: { empresaId: req.params.empresaId },
    orderBy: { diaSemana: 'asc' },
  });
  res.json(horarios);
}));

/**
 * @openapi
 * /empresas/{empresaId}/horarios:
 *   put:
 *     summary: Substitui os horários de funcionamento da semana (upsert por dia)
 *     tags: [Horarios]
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
 *             required: [horarios]
 *             properties:
 *               horarios:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [diaSemana]
 *                   properties:
 *                     diaSemana: { type: integer, minimum: 0, maximum: 6 }
 *                     abre: { type: string, nullable: true, example: "08:00" }
 *                     fecha: { type: string, nullable: true, example: "22:00" }
 *                     fechado: { type: boolean }
 *     responses:
 *       200:
 *         description: Horários atualizados
 *       400:
 *         description: Dados inválidos
 */
router.put('/', asyncHandler(async (req, res) => {
  const { horarios } = req.body;
  if (!Array.isArray(horarios)) {
    return res.status(400).json({ error: 'Campo "horarios" é obrigatório e deve ser uma lista' });
  }

  for (const h of horarios) {
    if (!Number.isInteger(h.diaSemana) || h.diaSemana < 0 || h.diaSemana > 6) {
      return res.status(400).json({ error: 'Campo "diaSemana" deve ser um inteiro entre 0 (domingo) e 6 (sábado)' });
    }
    if (!h.fechado) {
      if (!h.abre || !HORA_REGEX.test(h.abre)) {
        return res.status(400).json({ error: `Horário de abertura inválido para o dia ${h.diaSemana} (use HH:mm)` });
      }
      if (!h.fecha || !HORA_REGEX.test(h.fecha)) {
        return res.status(400).json({ error: `Horário de fechamento inválido para o dia ${h.diaSemana} (use HH:mm)` });
      }
    }
  }

  await prisma.$transaction(
    horarios.map((h) => prisma.horarioFuncionamento.upsert({
      where: { empresaId_diaSemana: { empresaId: req.params.empresaId, diaSemana: h.diaSemana } },
      create: {
        empresaId: req.params.empresaId,
        diaSemana: h.diaSemana,
        abre: h.fechado ? null : h.abre,
        fecha: h.fechado ? null : h.fecha,
        fechado: !!h.fechado,
      },
      update: {
        abre: h.fechado ? null : h.abre,
        fecha: h.fechado ? null : h.fecha,
        fechado: !!h.fechado,
      },
    })),
  );

  const atualizados = await prisma.horarioFuncionamento.findMany({
    where: { empresaId: req.params.empresaId },
    orderBy: { diaSemana: 'asc' },
  });
  res.json(atualizados);
}));

module.exports = router;
