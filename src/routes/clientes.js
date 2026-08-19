const { Router } = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { disponibilidadeFidelidade, creditarUnidadesFidelidade } = require('../lib/fidelidade');
const { gerarCodigoIndicacaoUnico } = require('../lib/indicacao');
const { signToken, requireEmpresaAdmin, requireCliente } = require('../lib/auth');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const SALT_ROUNDS = 10;
const CLIENTE_TOKEN_TTL = '30d';

router.use(loadEmpresa);

/** Remove o hash da senha antes de devolver o cliente. */
const serializeCliente = (cliente) => {
  const { senhaHash, ...rest } = cliente;
  return rest;
};

/** Clientes criados antes do sistema de indicação existir não têm codigoIndicacao — gera na primeira vez que aparecem. */
const garantirCodigoIndicacao = async (cliente) => {
  if (cliente.codigoIndicacao) return cliente;
  const codigoIndicacao = await gerarCodigoIndicacaoUnico(cliente.empresaId);
  return prisma.cliente.update({ where: { id: cliente.id }, data: { codigoIndicacao } });
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
  const { nome, telefone, email, senha, indicadoPor } = req.body;

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

  // Código de quem indicou é opcional e silenciosamente ignorado se inválido — não trava o cadastro.
  let indicadoPorId = null;
  if (typeof indicadoPor === 'string' && indicadoPor.trim()) {
    const referenciador = await prisma.cliente.findFirst({
      where: { empresaId: req.params.empresaId, codigoIndicacao: indicadoPor.trim().toUpperCase() },
    });
    if (referenciador) indicadoPorId = referenciador.id;
  }

  const codigoIndicacao = await gerarCodigoIndicacaoUnico(req.params.empresaId);
  const senhaHash = await bcrypt.hash(senha, SALT_ROUNDS);
  const cliente = await prisma.cliente.create({
    data: { empresaId: req.params.empresaId, nome, telefone: telefone || null, email, senhaHash, codigoIndicacao, indicadoPorId },
  });

  const token = signToken({ role: 'CLIENTE', empresaId: req.params.empresaId, clienteId: cliente.id }, CLIENTE_TOKEN_TTL);
  res.status(201).json({ ...serializeCliente(cliente), token });
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

  const clienteComCodigo = await garantirCodigoIndicacao(cliente);
  const token = signToken({ role: 'CLIENTE', empresaId: req.params.empresaId, clienteId: cliente.id }, CLIENTE_TOKEN_TTL);
  res.json({ ...serializeCliente(clienteComCodigo), token });
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes:
 *   get:
 *     summary: Lista os clientes da loja, com o progresso de fidelidade de cada um
 *     tags: [Clientes]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Lista de clientes
 */
router.get('/', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const clientes = await prisma.cliente.findMany({
    where: { empresaId: req.params.empresaId },
    orderBy: { nome: 'asc' },
  });
  res.json(clientes.map(serializeCliente));
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
router.get('/:id', requireCliente('id'), asyncHandler(async (req, res) => {
  const cliente = await prisma.cliente.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!cliente) {
    return res.status(404).json({ error: 'Cliente não encontrado' });
  }
  const clienteComCodigo = await garantirCodigoIndicacao(cliente);
  res.json(serializeCliente(clienteComCodigo));
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
router.get('/:id/pedidos', requireCliente('id'), asyncHandler(async (req, res) => {
  const pedidos = await prisma.pedido.findMany({
    where: { clienteId: req.params.id, empresaId: req.params.empresaId },
    include: { itens: { include: { opcoesSelecionadas: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(pedidos);
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes/{id}/liberar-resgate:
 *   post:
 *     summary: Marca 1 item grátis da fidelidade do cliente como resgatado (retirada balcão/telefone, sem pedido online)
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
 *         description: Resgate registrado
 *       400:
 *         description: Cliente sem item grátis disponível (ou prazo expirado)
 *       404:
 *         description: Cliente não encontrado
 */
router.post('/:id/liberar-resgate', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const cliente = await prisma.cliente.findFirst({ where: { id: req.params.id, empresaId: req.params.empresaId } });
  if (!cliente) {
    return res.status(404).json({ error: 'Cliente não encontrado' });
  }

  const { disponiveis, expirado } = disponibilidadeFidelidade(cliente, req.empresa);
  if (disponiveis <= 0) {
    return res.status(400).json({
      error: expirado ? 'O prazo para resgatar o item grátis deste cliente já expirou' : 'Este cliente não tem itens grátis disponíveis para resgate',
    });
  }

  const atualizado = await prisma.cliente.update({
    where: { id: cliente.id },
    data: { itensGratisResgatados: { increment: 1 } },
  });

  res.json(serializeCliente(atualizado));
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes/{id}/adicionar-unidades:
 *   post:
 *     summary: Credita unidades manualmente no cartão fidelidade do cliente (compra por telefone/balcão, fora do pedido online)
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
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [unidades]
 *             properties:
 *               unidades: { type: integer, minimum: 1 }
 *     responses:
 *       200:
 *         description: Unidades creditadas
 *       400:
 *         description: Campo "unidades" inválido
 *       404:
 *         description: Cliente não encontrado
 */
router.post('/:id/adicionar-unidades', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const unidades = Number(req.body.unidades);
  if (!Number.isInteger(unidades) || unidades < 1) {
    return res.status(400).json({ error: 'Campo "unidades" deve ser um número inteiro maior que zero' });
  }

  const cliente = await prisma.cliente.findFirst({ where: { id: req.params.id, empresaId: req.params.empresaId } });
  if (!cliente) {
    return res.status(404).json({ error: 'Cliente não encontrado' });
  }

  const atualizado = await prisma.$transaction((tx) => creditarUnidadesFidelidade(tx, cliente.id, unidades));

  res.json(serializeCliente(atualizado));
}));

module.exports = router;
