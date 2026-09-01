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
/**
 * @openapi
 * /empresas/{empresaId}/motoboys/admin-resumo:
 *   get:
 *     summary: Motoboys com status calculado (disponível/em entrega/offline/inativo), avaliação média e entregas totais, mais estatísticas da equipe — pra tela de gestão do admin
 *     tags: [Motoboys]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Motoboys + estatísticas agregadas
 */
router.get('/admin-resumo', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const motoboys = await prisma.motoboy.findMany({ where: { empresaId: req.params.empresaId }, orderBy: { nome: 'asc' } });

  const emEntregaRaw = await prisma.pedido.groupBy({
    by: ['motoboyId'],
    where: { empresaId: req.params.empresaId, status: 'SAIU_ENTREGA', motoboyId: { not: null } },
    _count: { _all: true },
  });
  const emEntregaSet = new Set(emEntregaRaw.map((r) => r.motoboyId));

  const avaliacoesRaw = await prisma.pedido.groupBy({
    by: ['motoboyId'],
    where: { empresaId: req.params.empresaId, motoboyId: { not: null }, notaMotoboy: { not: null } },
    _avg: { notaMotoboy: true },
    _count: { notaMotoboy: true },
  });
  const avaliacaoMap = new Map(avaliacoesRaw.map((r) => [r.motoboyId, { media: r._avg.notaMotoboy, quantidade: r._count.notaMotoboy }]));

  const entregasRaw = await prisma.pedido.groupBy({
    by: ['motoboyId'],
    where: { empresaId: req.params.empresaId, motoboyId: { not: null }, status: 'ENTREGUE' },
    _count: { _all: true },
  });
  const entregasMap = new Map(entregasRaw.map((r) => [r.motoboyId, r._count._all]));

  const statusDe = (m) => {
    if (!m.ativo) return 'INATIVO';
    if (emEntregaSet.has(m.id)) return 'EM_ENTREGA';
    return m.disponivel ? 'DISPONIVEL' : 'OFFLINE';
  };

  const motoboysComDados = motoboys.map((m) => ({
    ...serializeMotoboy(m),
    statusCalculado: statusDe(m),
    avaliacaoMedia: avaliacaoMap.get(m.id)?.media ?? null,
    avaliacaoQuantidade: avaliacaoMap.get(m.id)?.quantidade ?? 0,
    entregasTotais: entregasMap.get(m.id) || 0,
  }));

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const amanha = new Date(hoje);
  amanha.setDate(amanha.getDate() + 1);
  const inicioSemana = new Date(hoje);
  inicioSemana.setDate(inicioSemana.getDate() - inicioSemana.getDay());
  const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);

  const [entregasHoje, entregasSemana, entregasMes, entreguesComMotoboy, canceladosComMotoboy] = await Promise.all([
    prisma.pedido.count({ where: { empresaId: req.params.empresaId, status: 'ENTREGUE', motoboyId: { not: null }, entregueEm: { gte: hoje, lt: amanha } } }),
    prisma.pedido.count({ where: { empresaId: req.params.empresaId, status: 'ENTREGUE', motoboyId: { not: null }, entregueEm: { gte: inicioSemana } } }),
    prisma.pedido.count({ where: { empresaId: req.params.empresaId, status: 'ENTREGUE', motoboyId: { not: null }, entregueEm: { gte: inicioMes } } }),
    prisma.pedido.count({ where: { empresaId: req.params.empresaId, motoboyId: { not: null }, status: 'ENTREGUE' } }),
    prisma.pedido.count({ where: { empresaId: req.params.empresaId, motoboyId: { not: null }, status: 'CANCELADO' } }),
  ]);

  const totalComMotoboy = entreguesComMotoboy + canceladosComMotoboy;
  const taxaAceitacao = totalComMotoboy > 0 ? (entreguesComMotoboy / totalComMotoboy) * 100 : 0;
  const taxaCancelamento = totalComMotoboy > 0 ? (canceladosComMotoboy / totalComMotoboy) * 100 : 0;

  const somaNotas = avaliacoesRaw.reduce((s, r) => s + (r._avg.notaMotoboy || 0) * r._count.notaMotoboy, 0);
  const totalNotas = avaliacoesRaw.reduce((s, r) => s + r._count.notaMotoboy, 0);
  const avaliacaoMediaGeral = totalNotas > 0 ? somaNotas / totalNotas : 0;

  const taxaMediaEntrega = motoboys.length > 0 ? motoboys.reduce((s, m) => s + Number(m.taxaPadrao), 0) / motoboys.length : 0;

  res.json({
    motoboys: motoboysComDados,
    stats: {
      total: motoboys.length,
      ativos: motoboys.filter((m) => m.ativo).length,
      emEntrega: emEntregaSet.size,
      disponiveis: motoboys.filter((m) => m.ativo && m.disponivel && !emEntregaSet.has(m.id)).length,
      inativos: motoboys.filter((m) => !m.ativo).length,
      documentos: {
        totalMotoboys: motoboys.length,
        cnh: motoboys.filter((m) => m.cnhUrl).length,
        veiculo: motoboys.filter((m) => m.documentoVeiculoUrl).length,
        seguro: motoboys.filter((m) => m.seguroUrl).length,
        comprovante: motoboys.filter((m) => m.comprovanteResidenciaUrl).length,
        foto: motoboys.filter((m) => m.fotoPerfilUrl).length,
      },
      entregasHoje,
      entregasSemana,
      entregasMes,
      taxaMediaEntrega,
      avaliacaoMediaGeral,
      taxaAceitacao,
      taxaCancelamento,
    },
  });
}));

/**
 * @openapi
 * /empresas/{empresaId}/motoboys/pagamentos-resumo:
 *   get:
 *     summary: Histórico de pagamentos por motoboy (pendente + já pago, com período/entregas/valores reconstruídos) + estatísticas
 *     tags: [Motoboys]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: de
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: ate
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: Linhas de pagamento (pendente/pago) + estatísticas agregadas
 */
router.get('/pagamentos-resumo', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { de, ate } = req.query;
  const motoboys = await prisma.motoboy.findMany({ where: { empresaId: req.params.empresaId } });

  // "A pagar" — tudo que ainda não foi quitado, sem filtro de data (é sempre o pendente até agora).
  const pendentes = await prisma.pedido.findMany({
    where: { empresaId: req.params.empresaId, motoboyId: { not: null }, status: 'ENTREGUE', motoboyPago: false },
    select: { motoboyId: true, total: true, taxaEntregaMotoboy: true, createdAt: true },
  });
  const pendentesPorMotoboy = new Map();
  for (const p of pendentes) {
    const atual = pendentesPorMotoboy.get(p.motoboyId) || { entregas: 0, valorBruto: 0, total: 0, min: p.createdAt, max: p.createdAt };
    atual.entregas += 1;
    atual.valorBruto += Number(p.total);
    atual.total += Number(p.taxaEntregaMotoboy || 0);
    if (p.createdAt < atual.min) atual.min = p.createdAt;
    if (p.createdAt > atual.max) atual.max = p.createdAt;
    pendentesPorMotoboy.set(p.motoboyId, atual);
  }

  // "Pago" — cada MovimentoCaixa de pagamento é um evento real e datado; os pedidos que ele
  // quitou (Pedido.pagamentoMotoboyId) permitem reconstruir período/entregas/valor bruto exatos.
  const pagamentos = await prisma.movimentoCaixa.findMany({
    where: {
      empresaId: req.params.empresaId,
      tipo: 'SAIDA',
      motoboyId: { not: null },
      ...(de || ate
        ? { dataMovimento: { ...(de ? { gte: new Date(de) } : {}), ...(ate ? { lte: new Date(ate) } : {}) } }
        : {}),
    },
    include: {
      motoboy: { select: { id: true, nome: true } },
      pedidosPagos: { select: { total: true, createdAt: true } },
    },
    orderBy: { dataMovimento: 'desc' },
  });

  const linhasPagas = pagamentos.map((mov) => {
    const datas = mov.pedidosPagos.map((p) => p.createdAt.getTime());
    const valorBruto = mov.pedidosPagos.reduce((s, p) => s + Number(p.total), 0);
    return {
      id: mov.id,
      motoboyId: mov.motoboyId,
      motoboyNome: mov.motoboy?.nome || '—',
      periodoDe: (datas.length ? new Date(Math.min(...datas)) : mov.dataMovimento).toISOString(),
      periodoAte: (datas.length ? new Date(Math.max(...datas)) : mov.dataMovimento).toISOString(),
      entregas: mov.pedidosPagos.length,
      valorBruto,
      descontos: 0,
      total: Number(mov.valor),
      status: 'PAGO',
    };
  });

  const linhasPendentes = Array.from(pendentesPorMotoboy.entries()).map(([motoboyId, dados]) => ({
    id: `pendente-${motoboyId}`,
    motoboyId,
    motoboyNome: motoboys.find((m) => m.id === motoboyId)?.nome || '—',
    periodoDe: dados.min.toISOString(),
    periodoAte: dados.max.toISOString(),
    entregas: dados.entregas,
    valorBruto: dados.valorBruto,
    descontos: 0,
    total: dados.total,
    status: 'A_PAGAR',
  }));

  const todasLinhas = [...linhasPendentes, ...linhasPagas].sort(
    (a, b) => new Date(b.periodoAte).getTime() - new Date(a.periodoAte).getTime()
  );

  const aReceber = linhasPendentes.reduce((s, l) => s + l.total, 0);
  const jaPago = pagamentos.reduce((s, p) => s + Number(p.valor), 0);
  const agora = new Date();
  const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1);
  const pagamentosEsteMes = pagamentos.filter((p) => new Date(p.dataMovimento) >= inicioMes);
  const esteMes = pagamentosEsteMes.reduce((s, p) => s + Number(p.valor), 0);
  const totalEntregasGeral = linhasPagas.reduce((s, l) => s + l.entregas, 0) + linhasPendentes.reduce((s, l) => s + l.entregas, 0);
  const mediaPorEntrega = totalEntregasGeral > 0 ? (jaPago + aReceber) / totalEntregasGeral : 0;

  const formaPagamentoRaw = await prisma.pedido.groupBy({
    by: ['formaPagamento'],
    where: { empresaId: req.params.empresaId, motoboyId: { not: null }, status: 'ENTREGUE' },
    _sum: { total: true },
  });

  res.json({
    linhas: todasLinhas,
    stats: {
      aReceber,
      motoboysAReceber: new Set(linhasPendentes.map((l) => l.motoboyId)).size,
      jaPago,
      motoboysJaPago: new Set(pagamentos.map((p) => p.motoboyId)).size,
      esteMes,
      totalPagamentosEsteMes: pagamentosEsteMes.length,
      mediaPorEntrega,
      formaPagamento: formaPagamentoRaw.map((f) => ({ formaPagamento: f.formaPagamento, total: Number(f._sum.total || 0) })),
      proximosPagamentos: [...linhasPendentes].sort((a, b) => b.total - a.total).slice(0, 5),
    },
  });
}));

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
  const {
    nome, telefone, taxaPadrao, ativo, veiculoTipo, veiculoPlaca, turno,
    fotoPerfilUrl, cnhUrl, documentoVeiculoUrl, seguroUrl, comprovanteResidenciaUrl,
  } = req.body;

  if (!nome) {
    return res.status(400).json({ error: 'Campo "nome" é obrigatório' });
  }

  const motoboy = await prisma.motoboy.create({
    data: {
      empresaId: req.params.empresaId,
      nome,
      telefone: telefone || null,
      veiculoTipo: veiculoTipo || null,
      veiculoPlaca: veiculoPlaca || null,
      turno: turno || null,
      fotoPerfilUrl: fotoPerfilUrl || null,
      cnhUrl: cnhUrl || null,
      documentoVeiculoUrl: documentoVeiculoUrl || null,
      seguroUrl: seguroUrl || null,
      comprovanteResidenciaUrl: comprovanteResidenciaUrl || null,
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
  const {
    nome, telefone, taxaPadrao, ativo, veiculoTipo, veiculoPlaca, turno,
    fotoPerfilUrl, cnhUrl, documentoVeiculoUrl, seguroUrl, comprovanteResidenciaUrl,
  } = req.body;

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
        veiculoTipo: veiculoTipo || null,
        veiculoPlaca: veiculoPlaca || null,
        turno: turno || null,
        ...(fotoPerfilUrl !== undefined ? { fotoPerfilUrl: fotoPerfilUrl || null } : {}),
        ...(cnhUrl !== undefined ? { cnhUrl: cnhUrl || null } : {}),
        ...(documentoVeiculoUrl !== undefined ? { documentoVeiculoUrl: documentoVeiculoUrl || null } : {}),
        ...(seguroUrl !== undefined ? { seguroUrl: seguroUrl || null } : {}),
        ...(comprovanteResidenciaUrl !== undefined ? { comprovanteResidenciaUrl: comprovanteResidenciaUrl || null } : {}),
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
