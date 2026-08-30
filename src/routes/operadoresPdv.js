const { Router } = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { requireEmpresaAdmin } = require('../lib/auth');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const SALT_ROUNDS = 10;

router.use(loadEmpresa);

/**
 * Identidade leve de quem opera o PDV — sem login/token próprio (o app continua autenticado como
 * EMPRESA_ADMIN o tempo todo). O PIN só serve pra confirmar "é você mesmo" na hora de abrir um
 * caixa, pra depois dar pra filtrar relatório de caixa por operador. Mesmo padrão de
 * Motoboy.pinHash em motoboys.js.
 */
const serializeOperador = (operador) => {
  const { pinHash, ...rest } = operador;
  return { ...rest, temPin: Boolean(pinHash) };
};

/**
 * @openapi
 * components:
 *   schemas:
 *     OperadorPdv:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid, readOnly: true }
 *         empresaId: { type: string, format: uuid }
 *         nome: { type: string }
 *         ativo: { type: boolean }
 *         temPin: { type: boolean, readOnly: true }
 *     OperadorPdvInput:
 *       type: object
 *       required: [nome]
 *       properties:
 *         nome: { type: string }
 *         ativo: { type: boolean }
 */

/**
 * @openapi
 * /empresas/{empresaId}/operadores-pdv:
 *   get:
 *     summary: Lista os operadores de PDV cadastrados na loja
 *     tags: [PDV]
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
 *         description: Lista de operadores
 */
router.get('/', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { ativo } = req.query;
  const operadores = await prisma.operadorPdv.findMany({
    where: {
      empresaId: req.params.empresaId,
      ...(ativo !== undefined ? { ativo: ativo === 'true' } : {}),
    },
    orderBy: { nome: 'asc' },
  });
  res.json(operadores.map(serializeOperador));
}));

/**
 * @openapi
 * /empresas/{empresaId}/operadores-pdv:
 *   post:
 *     summary: Cadastra um novo operador de PDV
 *     tags: [PDV]
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
 *             $ref: '#/components/schemas/OperadorPdvInput'
 *     responses:
 *       201:
 *         description: Operador criado
 *       400:
 *         description: Dados inválidos
 */
router.post('/', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { nome, ativo } = req.body;
  if (!nome) {
    return res.status(400).json({ error: 'Campo "nome" é obrigatório' });
  }

  const operador = await prisma.operadorPdv.create({
    data: {
      empresaId: req.params.empresaId,
      nome,
      ...(ativo !== undefined ? { ativo } : {}),
    },
  });

  res.status(201).json(serializeOperador(operador));
}));

/**
 * @openapi
 * /empresas/{empresaId}/operadores-pdv/{id}:
 *   patch:
 *     summary: Atualiza nome/status de um operador de PDV
 *     tags: [PDV]
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
 *             $ref: '#/components/schemas/OperadorPdvInput'
 *     responses:
 *       200:
 *         description: Operador atualizado
 *       404:
 *         description: Operador não encontrado
 */
router.patch('/:id', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { nome, ativo } = req.body;

  const existente = await prisma.operadorPdv.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Operador não encontrado' });
  }

  const operador = await prisma.operadorPdv.update({
    where: { id: req.params.id },
    data: {
      ...(nome !== undefined ? { nome } : {}),
      ...(ativo !== undefined ? { ativo } : {}),
    },
  });

  res.json(serializeOperador(operador));
}));

/**
 * @openapi
 * /empresas/{empresaId}/operadores-pdv/{id}/pin:
 *   post:
 *     summary: Define/redefine o PIN de confirmação do operador
 *     tags: [PDV]
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
 *             required: [pin]
 *             properties:
 *               pin: { type: string }
 *     responses:
 *       200:
 *         description: PIN atualizado
 *       404:
 *         description: Operador não encontrado
 */
router.post('/:id/pin', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { pin } = req.body;
  if (!pin || String(pin).length < 4) {
    return res.status(400).json({ error: 'Campo "pin" é obrigatório e deve ter ao menos 4 dígitos' });
  }

  const existente = await prisma.operadorPdv.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Operador não encontrado' });
  }

  const pinHash = await bcrypt.hash(String(pin), SALT_ROUNDS);
  const operador = await prisma.operadorPdv.update({
    where: { id: req.params.id },
    data: { pinHash },
  });

  res.json(serializeOperador(operador));
}));

/**
 * @openapi
 * /empresas/{empresaId}/operadores-pdv/verificar-pin:
 *   post:
 *     summary: Confirma o PIN de um operador — não emite token, só confirma "é você mesmo" (a autorização real já vem do token de EMPRESA_ADMIN)
 *     tags: [PDV]
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
 *             required: [operadorId, pin]
 *             properties:
 *               operadorId: { type: string, format: uuid }
 *               pin: { type: string }
 *     responses:
 *       200:
 *         description: PIN correto
 *       401:
 *         description: PIN incorreto
 */
router.post('/verificar-pin', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { operadorId, pin } = req.body;
  if (!operadorId || !pin) {
    return res.status(400).json({ error: 'Campos "operadorId" e "pin" são obrigatórios' });
  }

  const operador = await prisma.operadorPdv.findFirst({
    where: { id: operadorId, empresaId: req.params.empresaId, ativo: true },
  });
  if (!operador || !operador.pinHash) {
    return res.status(401).json({ error: 'PIN incorreto' });
  }

  const pinValido = await bcrypt.compare(String(pin), operador.pinHash);
  if (!pinValido) {
    return res.status(401).json({ error: 'PIN incorreto' });
  }

  res.json({ ok: true });
}));

/**
 * @openapi
 * /empresas/{empresaId}/operadores-pdv/{id}:
 *   delete:
 *     summary: Remove um operador de PDV
 *     tags: [PDV]
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
 *         description: Operador removido
 *       404:
 *         description: Operador não encontrado
 */
router.delete('/:id', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const existente = await prisma.operadorPdv.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Operador não encontrado' });
  }

  await prisma.operadorPdv.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

module.exports = router;
