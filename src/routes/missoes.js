const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { requireEmpresaAdmin, requireCliente } = require('../lib/auth');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);

const validarPayload = ({ titulo, metaPedidos, periodoDias, recompensaUnidades }) => {
  const erros = [];
  if (!titulo) erros.push('Campo "titulo" é obrigatório');
  if (!Number.isInteger(Number(metaPedidos)) || Number(metaPedidos) < 1) erros.push('Campo "metaPedidos" deve ser um inteiro maior que zero');
  if (!Number.isInteger(Number(periodoDias)) || Number(periodoDias) < 1) erros.push('Campo "periodoDias" deve ser um inteiro maior que zero');
  if (!Number.isInteger(Number(recompensaUnidades)) || Number(recompensaUnidades) < 1) erros.push('Campo "recompensaUnidades" deve ser um inteiro maior que zero');
  return erros;
};

const handlePrismaError = (error, res) => {
  if (error.code === 'P2025') return res.status(404).json({ error: 'Missão não encontrada' });
  throw error;
};

/**
 * @openapi
 * /empresas/{empresaId}/missoes:
 *   get:
 *     summary: Lista as missões da loja (admin vê todas; cliente logado vê só as ativas, com a própria participação)
 *     tags: [Missoes]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Lista de missões
 */
router.get('/', asyncHandler(async (req, res) => {
  const souAdmin = req.auth && req.auth.role === 'EMPRESA_ADMIN' && req.auth.empresaId === req.params.empresaId;
  const meuClienteId = (req.auth && req.auth.role === 'CLIENTE' && req.auth.empresaId === req.params.empresaId)
    ? req.auth.clienteId
    : null;

  const missoes = await prisma.missao.findMany({
    where: { empresaId: req.params.empresaId, ...(souAdmin ? {} : { ativo: true }) },
    orderBy: { createdAt: 'desc' },
    include: meuClienteId ? { participacoes: { where: { clienteId: meuClienteId }, orderBy: { iniciadaEm: 'desc' }, take: 1 } } : undefined,
  });

  if (!meuClienteId) {
    return res.json(missoes.map((m) => ({ ...m, participacoes: undefined })));
  }

  const agora = Date.now();
  const comProgresso = await Promise.all(missoes.map(async (missao) => {
    const participacaoAtual = missao.participacoes?.[0] || null;
    let progresso = null;
    if (participacaoAtual && !participacaoAtual.concluidaEm) {
      const expiraEm = new Date(participacaoAtual.iniciadaEm).getTime() + missao.periodoDias * 86400000;
      const expirada = agora > expiraEm;
      if (!expirada) {
        const pedidosCount = await prisma.pedido.count({
          where: { clienteId: meuClienteId, status: 'ENTREGUE', createdAt: { gte: participacaoAtual.iniciadaEm } },
        });
        progresso = { pedidosCount, expiraEm: new Date(expiraEm), expirada: false };
      } else {
        progresso = { pedidosCount: 0, expiraEm: new Date(expiraEm), expirada: true };
      }
    }
    return { ...missao, participacaoAtual, progresso };
  }));

  res.json(comProgresso);
}));

/**
 * @openapi
 * /empresas/{empresaId}/missoes:
 *   post:
 *     summary: Cria uma nova missão
 *     tags: [Missoes]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: Missão criada
 */
router.post('/', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { titulo, descricao, metaPedidos, periodoDias, recompensaUnidades, ativo } = req.body;
  const erros = validarPayload(req.body);
  if (erros.length) return res.status(400).json({ error: erros.join('; ') });

  const missao = await prisma.missao.create({
    data: {
      empresaId: req.params.empresaId,
      titulo,
      descricao: descricao || null,
      metaPedidos: Number(metaPedidos),
      periodoDias: Number(periodoDias),
      recompensaUnidades: Number(recompensaUnidades),
      ...(ativo !== undefined ? { ativo } : {}),
    },
  });
  res.status(201).json(missao);
}));

/**
 * @openapi
 * /empresas/{empresaId}/missoes/{id}:
 *   put:
 *     summary: Atualiza uma missão
 *     tags: [Missoes]
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
 *         description: Missão atualizada
 */
router.put('/:id', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { titulo, descricao, metaPedidos, periodoDias, recompensaUnidades, ativo } = req.body;
  const erros = validarPayload(req.body);
  if (erros.length) return res.status(400).json({ error: erros.join('; ') });

  const existente = await prisma.missao.findFirst({ where: { id: req.params.id, empresaId: req.params.empresaId } });
  if (!existente) return res.status(404).json({ error: 'Missão não encontrada' });

  try {
    const missao = await prisma.missao.update({
      where: { id: req.params.id },
      data: {
        titulo,
        descricao: descricao || null,
        metaPedidos: Number(metaPedidos),
        periodoDias: Number(periodoDias),
        recompensaUnidades: Number(recompensaUnidades),
        ...(ativo !== undefined ? { ativo } : {}),
      },
    });
    res.json(missao);
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{empresaId}/missoes/{id}/status:
 *   patch:
 *     summary: Ativa ou inativa uma missão
 *     tags: [Missoes]
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
 *         description: Status atualizado
 */
router.patch('/:id/status', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { ativo } = req.body;
  if (typeof ativo !== 'boolean') return res.status(400).json({ error: 'Campo "ativo" é obrigatório e deve ser booleano' });

  const existente = await prisma.missao.findFirst({ where: { id: req.params.id, empresaId: req.params.empresaId } });
  if (!existente) return res.status(404).json({ error: 'Missão não encontrada' });

  const missao = await prisma.missao.update({ where: { id: req.params.id }, data: { ativo } });
  res.json(missao);
}));

/**
 * @openapi
 * /empresas/{empresaId}/missoes/{id}:
 *   delete:
 *     summary: Remove uma missão
 *     tags: [Missoes]
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
 *         description: Missão removida
 */
router.delete('/:id', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const existente = await prisma.missao.findFirst({ where: { id: req.params.id, empresaId: req.params.empresaId } });
  if (!existente) return res.status(404).json({ error: 'Missão não encontrada' });
  await prisma.missao.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

/**
 * @openapi
 * /empresas/{empresaId}/missoes/{id}/aceitar:
 *   post:
 *     summary: Cliente aceita uma missão (começa a valer a partir de agora)
 *     tags: [Missoes]
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
 *       201:
 *         description: Missão aceita
 *       400:
 *         description: Missão inativa, loja não habilitou missões, ou já existe uma participação ativa
 *       404:
 *         description: Missão não encontrada
 */
router.post('/:id/aceitar', requireCliente(), asyncHandler(async (req, res) => {
  if (!req.empresa.habilitarMissoes) {
    return res.status(400).json({ error: 'Esta loja não habilitou missões de fidelidade' });
  }

  const missao = await prisma.missao.findFirst({ where: { id: req.params.id, empresaId: req.params.empresaId, ativo: true } });
  if (!missao) return res.status(404).json({ error: 'Missão não encontrada' });

  const ultimaParticipacao = await prisma.missaoCliente.findFirst({
    where: { missaoId: missao.id, clienteId: req.auth.clienteId },
    orderBy: { iniciadaEm: 'desc' },
  });
  if (ultimaParticipacao && !ultimaParticipacao.concluidaEm) {
    const expiraEm = new Date(ultimaParticipacao.iniciadaEm).getTime() + missao.periodoDias * 86400000;
    if (Date.now() <= expiraEm) {
      return res.status(400).json({ error: 'Você já está participando desta missão' });
    }
  }

  const participacao = await prisma.missaoCliente.create({
    data: { missaoId: missao.id, clienteId: req.auth.clienteId },
  });
  res.status(201).json(participacao);
}));

module.exports = router;
