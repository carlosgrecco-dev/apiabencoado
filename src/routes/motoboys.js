const { Router } = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { signToken, requireEmpresaAdmin, requireMotoboy } = require('../lib/auth');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const SALT_ROUNDS = 10;
const MOTOBOY_TOKEN_TTL = '30d';

router.use(loadEmpresa);

/** Remove o hash do PIN antes de devolver o motoboy para o cliente. */
const serializeMotoboy = (motoboy) => {
  const { pinHash, ...rest } = motoboy;
  return rest;
};

const handlePrismaError = (error, res) => {
  if (error.code === 'P2025') {
    return res.status(404).json({ error: 'Motoboy não encontrado' });
  }
  throw error;
};

/**
 * @openapi
 * components:
 *   schemas:
 *     Motoboy:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid, readOnly: true }
 *         empresaId: { type: string, format: uuid }
 *         nome: { type: string }
 *         telefone: { type: string, nullable: true }
 *         taxaPadrao: { type: number }
 *         ativo: { type: boolean }
 *     MotoboyInput:
 *       type: object
 *       required: [nome]
 *       properties:
 *         nome: { type: string }
 *         telefone: { type: string }
 *         taxaPadrao: { type: number }
 *         ativo: { type: boolean }
 *     PinInput:
 *       type: object
 *       required: [pin]
 *       properties:
 *         pin: { type: string }
 */

/**
 * @openapi
 * /empresas/{empresaId}/motoboys/login:
 *   post:
 *     summary: Login do motoboy no portal dele (telefone + PIN)
 *     tags: [Motoboys]
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
 *             required: [telefone, pin]
 *             properties:
 *               telefone: { type: string }
 *               pin: { type: string }
 *     responses:
 *       200:
 *         description: Login válido
 *       401:
 *         description: Telefone ou PIN inválidos
 */
router.post('/login', asyncHandler(async (req, res) => {
  const { telefone, pin } = req.body;
  if (!telefone || !pin) {
    return res.status(400).json({ error: 'Campos "telefone" e "pin" são obrigatórios' });
  }

  const digitos = String(telefone).replace(/\D/g, '');

  const motoboys = await prisma.motoboy.findMany({
    where: { empresaId: req.params.empresaId, ativo: true, pinHash: { not: null } },
  });

  const motoboy = motoboys.find((m) => (m.telefone || '').replace(/\D/g, '') === digitos);
  if (!motoboy) {
    return res.status(401).json({ error: 'Telefone ou PIN inválidos' });
  }

  const pinValido = await bcrypt.compare(String(pin), motoboy.pinHash);
  if (!pinValido) {
    return res.status(401).json({ error: 'Telefone ou PIN inválidos' });
  }

  const token = signToken({ role: 'MOTOBOY', empresaId: req.params.empresaId, motoboyId: motoboy.id }, MOTOBOY_TOKEN_TTL);
  res.json({ id: motoboy.id, nome: motoboy.nome, disponivel: motoboy.disponivel, token });
}));

/**
 * @openapi
 * /empresas/{empresaId}/motoboys:
 *   get:
 *     summary: Lista os motoboys de uma empresa
 *     tags: [Motoboys]
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
 *         description: Lista de motoboys
 */
router.get('/', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { ativo } = req.query;
  const where = {
    empresaId: req.params.empresaId,
    ...(ativo !== undefined ? { ativo: ativo === 'true' } : {}),
  };

  const motoboys = await prisma.motoboy.findMany({ where, orderBy: { nome: 'asc' } });
  res.json(motoboys.map(serializeMotoboy));
}));

/**
 * @openapi
 * /empresas/{empresaId}/motoboys/{id}:
 *   get:
 *     summary: Busca um motoboy pelo id
 *     tags: [Motoboys]
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
 *         description: Motoboy encontrado
 *       404:
 *         description: Motoboy não encontrado
 */
router.get('/:id', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const motoboy = await prisma.motoboy.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });

  if (!motoboy) {
    return res.status(404).json({ error: 'Motoboy não encontrado' });
  }

  res.json(serializeMotoboy(motoboy));
}));

/**
 * @openapi
 * /empresas/{empresaId}/motoboys:
 *   post:
 *     summary: Cadastra um novo motoboy para a empresa
 *     tags: [Motoboys]
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
 *             $ref: '#/components/schemas/MotoboyInput'
 *     responses:
 *       201:
 *         description: Motoboy criado
 *       400:
 *         description: Dados inválidos
 */
router.post('/', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { nome, telefone, taxaPadrao, ativo } = req.body;

  if (!nome) {
    return res.status(400).json({ error: 'Campo "nome" é obrigatório' });
  }

  const motoboy = await prisma.motoboy.create({
    data: {
      empresaId: req.params.empresaId,
      nome,
      telefone: telefone || null,
      ...(taxaPadrao !== undefined ? { taxaPadrao } : {}),
      ...(ativo !== undefined ? { ativo } : {}),
    },
  });

  res.status(201).json(serializeMotoboy(motoboy));
}));

/**
 * @openapi
 * /empresas/{empresaId}/motoboys/{id}:
 *   put:
 *     summary: Atualiza os dados de um motoboy
 *     tags: [Motoboys]
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
 *             $ref: '#/components/schemas/MotoboyInput'
 *     responses:
 *       200:
 *         description: Motoboy atualizado
 *       404:
 *         description: Motoboy não encontrado
 */
router.put('/:id', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { nome, telefone, taxaPadrao, ativo } = req.body;

  if (!nome) {
    return res.status(400).json({ error: 'Campo "nome" é obrigatório' });
  }

  const existente = await prisma.motoboy.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Motoboy não encontrado' });
  }

  try {
    const motoboy = await prisma.motoboy.update({
      where: { id: req.params.id },
      data: {
        nome,
        telefone: telefone || null,
        ...(taxaPadrao !== undefined ? { taxaPadrao } : {}),
        ...(ativo !== undefined ? { ativo } : {}),
      },
    });

    res.json(serializeMotoboy(motoboy));
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{empresaId}/motoboys/{id}/status:
 *   patch:
 *     summary: Ativa ou inativa um motoboy
 *     tags: [Motoboys]
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
 *         description: Motoboy não encontrado
 */
router.patch('/:id/status', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { ativo } = req.body;
  if (typeof ativo !== 'boolean') {
    return res.status(400).json({ error: 'Campo "ativo" é obrigatório e deve ser booleano' });
  }

  const existente = await prisma.motoboy.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Motoboy não encontrado' });
  }

  const motoboy = await prisma.motoboy.update({
    where: { id: req.params.id },
    data: { ativo },
  });

  res.json(serializeMotoboy(motoboy));
}));

/**
 * @openapi
 * /empresas/{empresaId}/motoboys/{id}/pin:
 *   post:
 *     summary: Define/redefine o PIN de acesso do motoboy ao portal dele
 *     tags: [Motoboys]
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
 *             $ref: '#/components/schemas/PinInput'
 *     responses:
 *       200:
 *         description: PIN atualizado
 *       404:
 *         description: Motoboy não encontrado
 */
router.post('/:id/pin', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { pin } = req.body;
  if (!pin || String(pin).length < 4) {
    return res.status(400).json({ error: 'Campo "pin" é obrigatório e deve ter ao menos 4 dígitos' });
  }

  const existente = await prisma.motoboy.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Motoboy não encontrado' });
  }

  const pinHash = await bcrypt.hash(String(pin), SALT_ROUNDS);
  const motoboy = await prisma.motoboy.update({
    where: { id: req.params.id },
    data: { pinHash },
  });

  res.json(serializeMotoboy(motoboy));
}));

/**
 * @openapi
 * /empresas/{empresaId}/motoboys/{id}/localizacao:
 *   patch:
 *     summary: Atualiza a posição GPS atual do motoboy (enviado periodicamente pelo navigator.geolocation do navegador)
 *     tags: [Motoboys]
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
 *             required: [latitude, longitude]
 *             properties:
 *               latitude: { type: number }
 *               longitude: { type: number }
 *     responses:
 *       200:
 *         description: Localização atualizada
 *       400:
 *         description: Coordenadas inválidas
 *       404:
 *         description: Motoboy não encontrado
 */
router.patch('/:id/localizacao', requireMotoboy('id'), asyncHandler(async (req, res) => {
  const { latitude, longitude } = req.body;
  const lat = Number(latitude);
  const lng = Number(longitude);

  if (Number.isNaN(lat) || lat < -90 || lat > 90 || Number.isNaN(lng) || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'Coordenadas inválidas' });
  }

  const existente = await prisma.motoboy.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Motoboy não encontrado' });
  }

  const motoboy = await prisma.motoboy.update({
    where: { id: req.params.id },
    data: { latitudeAtual: lat, longitudeAtual: lng, localizacaoAtualizadaEm: new Date() },
  });

  res.json(serializeMotoboy(motoboy));
}));

/**
 * @openapi
 * /empresas/{empresaId}/motoboys/{id}/disponibilidade:
 *   patch:
 *     summary: O próprio motoboy liga/desliga o status "disponível pra corrida" no portal dele
 *     tags: [Motoboys]
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
 *             required: [disponivel]
 *             properties:
 *               disponivel: { type: boolean }
 *     responses:
 *       200:
 *         description: Disponibilidade atualizada
 *       404:
 *         description: Motoboy não encontrado
 */
router.patch('/:id/disponibilidade', requireMotoboy('id'), asyncHandler(async (req, res) => {
  const { disponivel } = req.body;
  if (typeof disponivel !== 'boolean') {
    return res.status(400).json({ error: 'Campo "disponivel" é obrigatório e deve ser booleano' });
  }

  const existente = await prisma.motoboy.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Motoboy não encontrado' });
  }

  const motoboy = await prisma.motoboy.update({
    where: { id: req.params.id },
    data: { disponivel },
  });

  res.json(serializeMotoboy(motoboy));
}));

/**
 * @openapi
 * /empresas/{empresaId}/motoboys/{id}:
 *   delete:
 *     summary: Remove um motoboy
 *     tags: [Motoboys]
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
 *         description: Motoboy removido
 *       404:
 *         description: Motoboy não encontrado
 */
router.delete('/:id', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const existente = await prisma.motoboy.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Motoboy não encontrado' });
  }

  await prisma.motoboy.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

module.exports = router;
