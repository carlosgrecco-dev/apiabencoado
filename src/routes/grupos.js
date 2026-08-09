const { Router } = require('express');
const prisma = require('../lib/prisma');

const router = Router();

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * @openapi
 * components:
 *   schemas:
 *     GrupoUsuario:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *           readOnly: true
 *         nome:
 *           type: string
 *       example:
 *         id: 629a6127-707c-4060-9e57-5f5bc8af057f
 *         nome: Administradores
 *     GrupoUsuarioInput:
 *       type: object
 *       required: [nome]
 *       properties:
 *         nome:
 *           type: string
 *       example:
 *         nome: Administradores
 *     Erro:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 */

/**
 * @openapi
 * /grupos:
 *   get:
 *     summary: Lista todos os grupos de usuários
 *     tags: [Grupos]
 *     responses:
 *       200:
 *         description: Lista de grupos
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/GrupoUsuario'
 */
router.get('/', asyncHandler(async (req, res) => {
  const grupos = await prisma.grupoUsuario.findMany();
  res.json(grupos);
}));

/**
 * @openapi
 * /grupos/{id}:
 *   get:
 *     summary: Busca um grupo de usuários pelo id
 *     tags: [Grupos]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Grupo encontrado
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GrupoUsuario'
 *       404:
 *         description: Grupo não encontrado
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Erro'
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const grupo = await prisma.grupoUsuario.findUnique({
    where: { id: req.params.id },
  });

  if (!grupo) {
    return res.status(404).json({ error: 'Grupo não encontrado' });
  }

  res.json(grupo);
}));

/**
 * @openapi
 * /grupos:
 *   post:
 *     summary: Cria um novo grupo de usuários
 *     tags: [Grupos]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/GrupoUsuarioInput'
 *     responses:
 *       201:
 *         description: Grupo criado
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GrupoUsuario'
 *       400:
 *         description: Dados inválidos
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Erro'
 */
router.post('/', asyncHandler(async (req, res) => {
  const { nome } = req.body;

  if (!nome) {
    return res.status(400).json({ error: 'Campo "nome" é obrigatório' });
  }

  const grupo = await prisma.grupoUsuario.create({
    data: { nome },
  });

  res.status(201).json(grupo);
}));

/**
 * @openapi
 * /grupos/{id}:
 *   put:
 *     summary: Atualiza um grupo de usuários existente
 *     tags: [Grupos]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/GrupoUsuarioInput'
 *     responses:
 *       200:
 *         description: Grupo atualizado
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GrupoUsuario'
 *       400:
 *         description: Dados inválidos
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Erro'
 *       404:
 *         description: Grupo não encontrado
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Erro'
 */
router.put('/:id', asyncHandler(async (req, res) => {
  const { nome } = req.body;

  if (!nome) {
    return res.status(400).json({ error: 'Campo "nome" é obrigatório' });
  }

  try {
    const grupo = await prisma.grupoUsuario.update({
      where: { id: req.params.id },
      data: { nome },
    });

    res.json(grupo);
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Grupo não encontrado' });
    }
    throw error;
  }
}));

/**
 * @openapi
 * /grupos/{id}:
 *   delete:
 *     summary: Remove um grupo de usuários
 *     tags: [Grupos]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       204:
 *         description: Grupo removido
 *       404:
 *         description: Grupo não encontrado
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Erro'
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  try {
    await prisma.grupoUsuario.delete({
      where: { id: req.params.id },
    });

    res.status(204).send();
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Grupo não encontrado' });
    }
    throw error;
  }
}));

module.exports = router;
