const { Router } = require('express');
const prisma = require('../lib/prisma');
const { requireSuperAdmin } = require('../lib/auth');

const router = Router();

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const STATUS_VALIDOS = ['NOVO', 'CONTATADO', 'CONVERTIDO', 'DESCARTADO'];

/**
 * @openapi
 * components:
 *   schemas:
 *     LeadComercial:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid, readOnly: true }
 *         nome: { type: string }
 *         email: { type: string }
 *         telefone: { type: string, nullable: true }
 *         mensagem: { type: string, nullable: true }
 *         planoInteresseId: { type: string, format: uuid, nullable: true }
 *         status: { type: string, enum: [NOVO, CONTATADO, CONVERTIDO, DESCARTADO] }
 *         notaInterna: { type: string, nullable: true }
 *         origem: { type: string, nullable: true }
 */

/**
 * @openapi
 * /leads-comerciais:
 *   post:
 *     summary: Registra um contato comercial vindo do drawer de contato no site público — sem autenticação
 *     tags: [LeadsComerciais]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [nome, email]
 *             properties:
 *               nome: { type: string }
 *               email: { type: string }
 *               telefone: { type: string }
 *               mensagem: { type: string }
 *               planoInteresseId: { type: string, format: uuid }
 *               origem: { type: string }
 *     responses:
 *       201:
 *         description: Contato registrado
 *       400:
 *         description: Dados inválidos
 */
router.post('/', asyncHandler(async (req, res) => {
  const { nome, email, telefone, mensagem, planoInteresseId, origem, _hp } = req.body;

  // Campo-armadilha: invisível pro visitante humano no form, só bot preenche. Devolve 201 sem
  // gravar nada — não vale avisar o remetente que foi identificado como spam.
  if (_hp) {
    return res.status(201).json({ ok: true });
  }

  if (!nome || !email) {
    return res.status(400).json({ error: 'Campos "nome" e "email" são obrigatórios' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'E-mail inválido' });
  }

  if (planoInteresseId) {
    const plano = await prisma.plano.findUnique({ where: { id: planoInteresseId } });
    if (!plano) {
      return res.status(400).json({ error: 'Plano informado não existe' });
    }
  }

  const lead = await prisma.leadComercial.create({
    data: {
      nome,
      email,
      telefone: telefone || null,
      mensagem: mensagem || null,
      planoInteresseId: planoInteresseId || null,
      origem: origem || null,
    },
  });

  res.status(201).json({ id: lead.id });
}));

/**
 * @openapi
 * /leads-comerciais:
 *   get:
 *     summary: Lista os contatos comerciais recebidos
 *     tags: [LeadsComerciais]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [NOVO, CONTATADO, CONVERTIDO, DESCARTADO] }
 *     responses:
 *       200:
 *         description: Lista de leads
 */
router.get('/', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { status } = req.query;
  if (status && !STATUS_VALIDOS.includes(status)) {
    return res.status(400).json({ error: `Campo "status" deve ser um de: ${STATUS_VALIDOS.join(', ')}` });
  }

  const leads = await prisma.leadComercial.findMany({
    where: { ...(status ? { status } : {}) },
    include: { planoInteresse: { select: { id: true, nome: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(leads);
}));

/**
 * @openapi
 * /leads-comerciais/{id}:
 *   patch:
 *     summary: Atualiza o status/nota interna de um lead comercial
 *     tags: [LeadsComerciais]
 *     parameters:
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
 *             properties:
 *               status: { type: string, enum: [NOVO, CONTATADO, CONVERTIDO, DESCARTADO] }
 *               notaInterna: { type: string }
 *     responses:
 *       200:
 *         description: Lead atualizado
 *       404:
 *         description: Lead não encontrado
 */
router.patch('/:id', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { status, notaInterna } = req.body;
  if (status && !STATUS_VALIDOS.includes(status)) {
    return res.status(400).json({ error: `Campo "status" deve ser um de: ${STATUS_VALIDOS.join(', ')}` });
  }

  const existente = await prisma.leadComercial.findUnique({ where: { id: req.params.id } });
  if (!existente) {
    return res.status(404).json({ error: 'Lead não encontrado' });
  }

  const lead = await prisma.leadComercial.update({
    where: { id: req.params.id },
    data: {
      ...(status ? { status } : {}),
      ...(notaInterna !== undefined ? { notaInterna: notaInterna || null } : {}),
    },
    include: { planoInteresse: { select: { id: true, nome: true } } },
  });

  res.json(lead);
}));

module.exports = router;
