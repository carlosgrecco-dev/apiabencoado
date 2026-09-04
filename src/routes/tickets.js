const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { requireEmpresaAdmin, requireCliente, requireGrupo } = require('../lib/auth');
const { criarNotificacaoCliente } = require('../lib/notificacoesCliente');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);
// Só afeta token EMPRESA_ADMIN com papel (login secundário) — Cliente passa direto, nunca é bloqueado aqui.
router.use(requireGrupo('sistema'));

const STATUS_VALIDOS = ['ABERTO', 'EM_ANDAMENTO', 'RESOLVIDO'];
const PRIORIDADE_CHAMADO_VALIDOS = ['RELEVANTE', 'PRIORITARIA', 'URGENTE'];

/**
 * @openapi
 * /empresas/{empresaId}/tickets:
 *   get:
 *     summary: Lista tickets — admin vê todos da loja; cliente logado vê só os próprios
 *     tags: [Tickets]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Lista de tickets
 *       401:
 *         description: Não autenticado
 */
router.get('/', asyncHandler(async (req, res) => {
  const souAdmin = req.auth && req.auth.role === 'EMPRESA_ADMIN' && req.auth.empresaId === req.params.empresaId;
  const souCliente = req.auth && req.auth.role === 'CLIENTE' && req.auth.empresaId === req.params.empresaId;

  if (!souAdmin && !souCliente) {
    return res.status(401).json({ error: 'Não autenticado' });
  }

  const tickets = await prisma.ticketSuporte.findMany({
    where: {
      empresaId: req.params.empresaId,
      ...(souAdmin ? {} : { clienteId: req.auth.clienteId }),
    },
    include: { pedido: { select: { id: true, numero: true } }, cliente: { select: { id: true, nome: true, telefone: true, email: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(tickets);
}));

/**
 * @openapi
 * /empresas/{empresaId}/tickets:
 *   post:
 *     summary: Cliente abre um ticket de suporte, opcionalmente ligado a um pedido
 *     tags: [Tickets]
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
 *             required: [assunto, mensagem]
 *             properties:
 *               pedidoId: { type: string, format: uuid, nullable: true }
 *               assunto: { type: string }
 *               mensagem: { type: string }
 *     responses:
 *       201:
 *         description: Ticket criado
 *       400:
 *         description: Dados inválidos, ou loja não habilitou a central de suporte
 */
router.post('/', requireCliente(), asyncHandler(async (req, res) => {
  if (!req.empresa.habilitarCentralSuporte) {
    return res.status(400).json({ error: 'Esta loja não habilitou a central de suporte' });
  }

  const { pedidoId, assunto, mensagem } = req.body;
  if (!assunto || !mensagem) {
    return res.status(400).json({ error: 'Campos "assunto" e "mensagem" são obrigatórios' });
  }

  let pedidoValido = null;
  if (pedidoId) {
    pedidoValido = await prisma.pedido.findFirst({ where: { id: pedidoId, empresaId: req.params.empresaId, clienteId: req.auth.clienteId } });
    if (!pedidoValido) {
      return res.status(400).json({ error: 'Pedido informado não pertence a este cliente' });
    }
  }

  const ticket = await prisma.ticketSuporte.create({
    data: {
      empresaId: req.params.empresaId,
      clienteId: req.auth.clienteId,
      pedidoId: pedidoValido?.id || null,
      assunto,
      mensagem,
    },
    include: { pedido: { select: { id: true, numero: true } } },
  });
  res.status(201).json(ticket);
}));

/**
 * @openapi
 * /empresas/{empresaId}/tickets/lojista:
 *   post:
 *     summary: Lojista abre um chamado direto com a Sigma/plataforma (não é chamado de cliente)
 *     tags: [Tickets]
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
 *             required: [assunto, mensagem, prioridade]
 *             properties:
 *               assunto: { type: string }
 *               mensagem: { type: string }
 *               prioridade: { type: string, enum: [RELEVANTE, PRIORITARIA, URGENTE] }
 *     responses:
 *       201:
 *         description: Chamado criado
 *       400:
 *         description: Dados inválidos
 */
router.post('/lojista', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { assunto, mensagem, prioridade } = req.body;
  if (!assunto || !mensagem) {
    return res.status(400).json({ error: 'Campos "assunto" e "mensagem" são obrigatórios' });
  }
  if (!PRIORIDADE_CHAMADO_VALIDOS.includes(prioridade)) {
    return res.status(400).json({ error: `Campo "prioridade" deve ser um de: ${PRIORIDADE_CHAMADO_VALIDOS.join(', ')}` });
  }

  const ticket = await prisma.ticketSuporte.create({
    data: {
      empresaId: req.params.empresaId,
      clienteId: null,
      assunto,
      mensagem,
      prioridade,
    },
  });
  res.status(201).json(ticket);
}));

/**
 * @openapi
 * /empresas/{empresaId}/tickets/{id}:
 *   patch:
 *     summary: Admin responde e/ou atualiza o status de um ticket
 *     tags: [Tickets]
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
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status: { type: string, enum: [ABERTO, EM_ANDAMENTO, RESOLVIDO] }
 *               respostaAdmin: { type: string }
 *     responses:
 *       200:
 *         description: Ticket atualizado
 *       404:
 *         description: Ticket não encontrado
 */
router.patch('/:id', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { status, respostaAdmin } = req.body;
  if (status !== undefined && !STATUS_VALIDOS.includes(status)) {
    return res.status(400).json({ error: `Campo "status" deve ser um de: ${STATUS_VALIDOS.join(', ')}` });
  }

  const existente = await prisma.ticketSuporte.findFirst({ where: { id: req.params.id, empresaId: req.params.empresaId } });
  if (!existente) {
    return res.status(404).json({ error: 'Ticket não encontrado' });
  }

  const ticket = await prisma.ticketSuporte.update({
    where: { id: req.params.id },
    data: {
      ...(status !== undefined ? { status } : {}),
      ...(respostaAdmin !== undefined ? { respostaAdmin: respostaAdmin || null } : {}),
    },
  });

  if (ticket.clienteId && (status || respostaAdmin) && req.empresa.habilitarNotificacoesInApp) {
    criarNotificacaoCliente(ticket.clienteId, {
      titulo: `Resposta no seu chamado: ${ticket.assunto}`,
      corpo: respostaAdmin || `Status atualizado para ${ticket.status}`,
    }).catch(() => {});
  }

  res.json(ticket);
}));

module.exports = router;
