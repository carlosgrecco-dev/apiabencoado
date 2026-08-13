const { Router } = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const SALT_ROUNDS = 10;

router.use(loadEmpresa);

/** Remove o hash da senha antes de devolver o cliente. */
const serializeCliente = (cliente) => {
  const { senhaHash, ...rest } = cliente;
  return rest;
};

/**
 * @openapi
 * components:
 *   schemas:
 *     Cliente:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid }
 *         nome: { type: string }
 *         telefone: { type: string, nullable: true }
 *         email: { type: string }
 *         totalUnidadesCompradas: { type: integer }
 *         itensGratisGanhos: { type: integer }
 *         itensGratisResgatados: { type: integer }
 */

/**
 * @openapi
 * /empresas/{empresaId}/clientes/signup:
 *   post:
 *     summary: Cria a conta do cliente na loja
 *     tags: [Clientes]
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
 *             required: [nome, email, senha]
 *             properties:
 *               nome: { type: string }
 *               telefone: { type: string }
 *               email: { type: string }
 *               senha: { type: string }
 *     responses:
 *       201:
 *         description: Conta criada
 *       400:
 *         description: Dados inválidos
 *       409:
 *         description: E-mail já cadastrado
 */
router.post('/signup', asyncHandler(async (req, res) => {
  const { nome, telefone, email, senha } = req.body;

  if (!nome || !email || !senha) {
    return res.status(400).json({ error: 'Campos "nome", "email" e "senha" são obrigatórios' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'E-mail inválido' });
  }
  if (String(senha).length < 6) {
    return res.status(400).json({ error: 'A senha precisa ter pelo menos 6 caracteres' });
  }

  const existente = await prisma.cliente.findUnique({
    where: { empresaId_email: { empresaId: req.params.empresaId, email } },
  });
  if (existente) {
    return res.status(409).json({ error: 'Este e-mail já está cadastrado' });
  }

  const senhaHash = await bcrypt.hash(senha, SALT_ROUNDS);
  const cliente = await prisma.cliente.create({
    data: { empresaId: req.params.empresaId, nome, telefone: telefone || null, email, senhaHash },
  });

  res.status(201).json(serializeCliente(cliente));
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes/login:
 *   post:
 *     summary: Login do cliente na loja
 *     tags: [Clientes]
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
 *             required: [email, senha]
 *             properties:
 *               email: { type: string }
 *               senha: { type: string }
 *     responses:
 *       200:
 *         description: Login válido
 *       401:
 *         description: E-mail ou senha inválidos
 */
router.post('/login', asyncHandler(async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) {
    return res.status(400).json({ error: 'Campos "email" e "senha" são obrigatórios' });
  }

  const cliente = await prisma.cliente.findUnique({
    where: { empresaId_email: { empresaId: req.params.empresaId, email } },
  });
  if (!cliente) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos' });
  }

  const senhaValida = await bcrypt.compare(senha, cliente.senhaHash);
  if (!senhaValida) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos' });
  }

  res.json(serializeCliente(cliente));
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes/{id}:
 *   get:
 *     summary: Busca o perfil do cliente (dados de fidelidade)
 *     tags: [Clientes]
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
 *         description: Cliente encontrado
 *       404:
 *         description: Cliente não encontrado
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const cliente = await prisma.cliente.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!cliente) {
    return res.status(404).json({ error: 'Cliente não encontrado' });
  }
  res.json(serializeCliente(cliente));
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes/{id}/pedidos:
 *   get:
 *     summary: Histórico de pedidos do cliente
 *     tags: [Clientes]
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
 *         description: Lista de pedidos do cliente
 */
router.get('/:id/pedidos', asyncHandler(async (req, res) => {
  const pedidos = await prisma.pedido.findMany({
    where: { clienteId: req.params.id, empresaId: req.params.empresaId },
    include: { itens: { include: { opcoesSelecionadas: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(pedidos);
}));

module.exports = router;
