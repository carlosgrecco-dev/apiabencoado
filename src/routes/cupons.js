const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const validarCupom = require('../lib/validarCupom');
const { requireEmpresaAdmin } = require('../lib/auth');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);

const TIPOS_VALIDOS = ['PERCENTUAL', 'VALOR_FIXO', 'FRETE_GRATIS'];
const FORMAS_PAGAMENTO_VALIDAS = ['PIX', 'DINHEIRO', 'CARTAO'];

const handlePrismaError = (error, res) => {
  if (error.code === 'P2025') {
    return res.status(404).json({ error: 'Cupom não encontrado' });
  }
  if (error.code === 'P2002') {
    return res.status(409).json({ error: 'Já existe um cupom com este código' });
  }
  throw error;
};

const validarPayload = ({ codigo, tipo, valor }) => {
  const erros = [];
  if (!codigo) erros.push('Campo "codigo" é obrigatório');
  if (!tipo || !TIPOS_VALIDOS.includes(tipo)) erros.push(`Campo "tipo" deve ser um de: ${TIPOS_VALIDOS.join(', ')}`);
  if (tipo && tipo !== 'FRETE_GRATIS' && (valor === undefined || valor === null || Number(valor) <= 0)) {
    erros.push('Campo "valor" é obrigatório e deve ser maior que zero para este tipo de cupom');
  }
  if (tipo === 'PERCENTUAL' && Number(valor) > 100) {
    erros.push('O percentual do cupom não pode passar de 100');
  }
  return erros;
};

const validarRestricoes = ({ formaPagamentoRestrita, diaSemanaRestrito }) => {
  const erros = [];
  if (formaPagamentoRestrita !== undefined && formaPagamentoRestrita !== null && !FORMAS_PAGAMENTO_VALIDAS.includes(formaPagamentoRestrita)) {
    erros.push(`Campo "formaPagamentoRestrita" deve ser um de: ${FORMAS_PAGAMENTO_VALIDAS.join(', ')}`);
  }
  if (diaSemanaRestrito !== undefined && diaSemanaRestrito !== null && (Number(diaSemanaRestrito) < 0 || Number(diaSemanaRestrito) > 6)) {
    erros.push('Campo "diaSemanaRestrito" deve ser um número de 0 (domingo) a 6 (sábado)');
  }
  return erros;
};

/**
 * @openapi
 * components:
 *   schemas:
 *     Cupom:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid }
 *         codigo: { type: string }
 *         descricao: { type: string, nullable: true }
 *         tipo: { type: string, enum: [PERCENTUAL, VALOR_FIXO, FRETE_GRATIS] }
 *         valor: { type: number, nullable: true }
 *         apenasPrimeiraCompra: { type: boolean }
 *         valorMinimoPedido: { type: number, nullable: true }
 *         usoMaximo: { type: integer, nullable: true }
 *         usosRealizados: { type: integer }
 *         validoAte: { type: string, format: date-time, nullable: true }
 *         ativo: { type: boolean }
 *     CupomInput:
 *       type: object
 *       required: [codigo, tipo]
 *       properties:
 *         codigo: { type: string }
 *         descricao: { type: string }
 *         tipo: { type: string, enum: [PERCENTUAL, VALOR_FIXO, FRETE_GRATIS] }
 *         valor: { type: number }
 *         apenasPrimeiraCompra: { type: boolean }
 *         valorMinimoPedido: { type: number }
 *         usoMaximo: { type: integer }
 *         validoAte: { type: string, format: date-time }
 *         ativo: { type: boolean }
 */

/**
 * @openapi
 * /empresas/{empresaId}/cupons:
 *   get:
 *     summary: Lista os cupons da empresa
 *     tags: [Cupons]
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
 *         description: Lista de cupons
 */
router.get('/', asyncHandler(async (req, res) => {
  const { ativo } = req.query;

  // Rota pública (sem guard — usada tanto pelo admin quanto pela vitrine da loja). Cupons com
  // clienteAlvoId só aparecem pro admin (gestão) ou pro próprio cliente-alvo — nunca pra outros.
  const souAdmin = req.auth && req.auth.role === 'EMPRESA_ADMIN' && req.auth.empresaId === req.params.empresaId;
  const meuClienteId = (req.auth && req.auth.role === 'CLIENTE' && req.auth.empresaId === req.params.empresaId)
    ? req.auth.clienteId
    : null;

  const where = {
    empresaId: req.params.empresaId,
    ...(ativo !== undefined ? { ativo: ativo === 'true' } : {}),
    ...(souAdmin ? {} : { OR: [{ clienteAlvoId: null }, ...(meuClienteId ? [{ clienteAlvoId: meuClienteId }] : [])] }),
  };
  const cupons = await prisma.cupom.findMany({ where, orderBy: { createdAt: 'desc' } });
  res.json(cupons);
}));

/**
 * @openapi
 * /empresas/{empresaId}/cupons:
 *   post:
 *     summary: Cria um novo cupom
 *     tags: [Cupons]
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
 *             $ref: '#/components/schemas/CupomInput'
 *     responses:
 *       201:
 *         description: Cupom criado
 *       400:
 *         description: Dados inválidos
 *       409:
 *         description: Código já cadastrado
 */
router.post('/', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const {
    codigo, descricao, tipo, valor, apenasPrimeiraCompra, valorMinimoPedido, usoMaximo, validoDe, validoAte, ativo, clienteAlvoId,
    bairrosRestritos, formaPagamentoRestrita, diaSemanaRestrito, apenasClientesFieis,
  } = req.body;

  const erros = [...validarPayload(req.body), ...validarRestricoes(req.body)];
  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }

  if (clienteAlvoId) {
    const clienteAlvo = await prisma.cliente.findFirst({ where: { id: clienteAlvoId, empresaId: req.params.empresaId } });
    if (!clienteAlvo) {
      return res.status(400).json({ error: 'Cliente informado para o cupom pessoal não pertence a esta empresa' });
    }
  }

  try {
    const cupom = await prisma.cupom.create({
      data: {
        empresaId: req.params.empresaId,
        codigo: codigo.trim().toUpperCase(),
        descricao: descricao || null,
        tipo,
        valor: tipo === 'FRETE_GRATIS' ? null : valor,
        apenasPrimeiraCompra: Boolean(apenasPrimeiraCompra),
        valorMinimoPedido: valorMinimoPedido || null,
        usoMaximo: usoMaximo || null,
        validoDe: validoDe ? new Date(validoDe) : null,
        validoAte: validoAte ? new Date(validoAte) : null,
        clienteAlvoId: clienteAlvoId || null,
        bairrosRestritos: Array.isArray(bairrosRestritos) ? bairrosRestritos : [],
        formaPagamentoRestrita: formaPagamentoRestrita || null,
        diaSemanaRestrito: diaSemanaRestrito === '' || diaSemanaRestrito == null ? null : Number(diaSemanaRestrito),
        apenasClientesFieis: Boolean(apenasClientesFieis),
        ...(ativo !== undefined ? { ativo } : {}),
      },
    });
    res.status(201).json(cupom);
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{empresaId}/cupons/{id}:
 *   put:
 *     summary: Atualiza um cupom
 *     tags: [Cupons]
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
 *             $ref: '#/components/schemas/CupomInput'
 *     responses:
 *       200:
 *         description: Cupom atualizado
 *       404:
 *         description: Cupom não encontrado
 */
router.put('/:id', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const {
    codigo, descricao, tipo, valor, apenasPrimeiraCompra, valorMinimoPedido, usoMaximo, validoDe, validoAte, ativo, clienteAlvoId,
    bairrosRestritos, formaPagamentoRestrita, diaSemanaRestrito, apenasClientesFieis,
  } = req.body;

  const erros = [...validarPayload(req.body), ...validarRestricoes(req.body)];
  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }

  const existente = await prisma.cupom.findFirst({ where: { id: req.params.id, empresaId: req.params.empresaId } });
  if (!existente) {
    return res.status(404).json({ error: 'Cupom não encontrado' });
  }

  if (clienteAlvoId) {
    const clienteAlvo = await prisma.cliente.findFirst({ where: { id: clienteAlvoId, empresaId: req.params.empresaId } });
    if (!clienteAlvo) {
      return res.status(400).json({ error: 'Cliente informado para o cupom pessoal não pertence a esta empresa' });
    }
  }

  try {
    const cupom = await prisma.cupom.update({
      where: { id: req.params.id },
      data: {
        codigo: codigo.trim().toUpperCase(),
        descricao: descricao || null,
        tipo,
        valor: tipo === 'FRETE_GRATIS' ? null : valor,
        apenasPrimeiraCompra: Boolean(apenasPrimeiraCompra),
        valorMinimoPedido: valorMinimoPedido || null,
        usoMaximo: usoMaximo || null,
        validoDe: validoDe ? new Date(validoDe) : null,
        validoAte: validoAte ? new Date(validoAte) : null,
        clienteAlvoId: clienteAlvoId || null,
        bairrosRestritos: Array.isArray(bairrosRestritos) ? bairrosRestritos : [],
        formaPagamentoRestrita: formaPagamentoRestrita || null,
        diaSemanaRestrito: diaSemanaRestrito === '' || diaSemanaRestrito == null ? null : Number(diaSemanaRestrito),
        apenasClientesFieis: Boolean(apenasClientesFieis),
        ...(ativo !== undefined ? { ativo } : {}),
      },
    });
    res.json(cupom);
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{empresaId}/cupons/{id}/status:
 *   patch:
 *     summary: Ativa ou inativa um cupom
 *     tags: [Cupons]
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
 *         description: Cupom não encontrado
 */
router.patch('/:id/status', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const { ativo } = req.body;
  if (typeof ativo !== 'boolean') {
    return res.status(400).json({ error: 'Campo "ativo" é obrigatório e deve ser booleano' });
  }
  const existente = await prisma.cupom.findFirst({ where: { id: req.params.id, empresaId: req.params.empresaId } });
  if (!existente) {
    return res.status(404).json({ error: 'Cupom não encontrado' });
  }
  const cupom = await prisma.cupom.update({ where: { id: req.params.id }, data: { ativo } });
  res.json(cupom);
}));

/**
 * @openapi
 * /empresas/{empresaId}/cupons/{id}:
 *   delete:
 *     summary: Remove um cupom
 *     tags: [Cupons]
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
 *         description: Cupom removido
 *       404:
 *         description: Cupom não encontrado
 */
router.delete('/:id', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const existente = await prisma.cupom.findFirst({ where: { id: req.params.id, empresaId: req.params.empresaId } });
  if (!existente) {
    return res.status(404).json({ error: 'Cupom não encontrado' });
  }
  await prisma.cupom.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

/**
 * @openapi
 * /empresas/{empresaId}/cupons/validar:
 *   post:
 *     summary: Valida um cupom para um subtotal/cliente, sem consumir o uso
 *     tags: [Cupons]
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
 *             required: [codigo, subtotal]
 *             properties:
 *               codigo: { type: string }
 *               subtotal: { type: number }
 *               clienteId: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Cupom válido — retorna o desconto calculado
 *       400:
 *         description: Cupom inválido para este pedido
 */
router.post('/validar', asyncHandler(async (req, res) => {
  const { codigo, subtotal, bairro, formaPagamento } = req.body;

  if (subtotal === undefined || Number.isNaN(Number(subtotal))) {
    return res.status(400).json({ error: 'Campo "subtotal" é obrigatório' });
  }

  // clienteId nunca vem do corpo — só do token de quem estiver logado como CLIENTE desta
  // empresa, pra ninguém forjar elegibilidade de cupom de "primeira compra" em nome de outro.
  const clienteId = (req.auth && req.auth.role === 'CLIENTE' && req.auth.empresaId === req.params.empresaId)
    ? req.auth.clienteId
    : null;

  const resultado = await validarCupom(prisma, req.params.empresaId, codigo, clienteId, Number(subtotal), { bairro, formaPagamento });

  if (!resultado.ok) {
    return res.status(400).json({ error: resultado.error });
  }

  res.json({
    codigo: resultado.cupom.codigo,
    tipo: resultado.cupom.tipo,
    descricao: resultado.cupom.descricao,
    desconto: resultado.desconto,
    freteGratis: resultado.freteGratis,
  });
}));

/**
 * @openapi
 * /empresas/{empresaId}/cupons/admin-resumo:
 *   get:
 *     summary: Lista de cupons com status calculado (ativo/agendado/expirado) + estatísticas de uso do mês, pra tela de gestão do admin
 *     tags: [Cupons]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Cupons + estatísticas agregadas
 */
router.get('/admin-resumo', requireEmpresaAdmin(), asyncHandler(async (req, res) => {
  const cupons = await prisma.cupom.findMany({ where: { empresaId: req.params.empresaId }, orderBy: { createdAt: 'desc' } });

  const agora = new Date();
  const statusDe = (cupom) => {
    if (!cupom.ativo) return 'INATIVO';
    if (cupom.validoDe && new Date(cupom.validoDe) > agora) return 'AGENDADO';
    if (cupom.validoAte && new Date(cupom.validoAte) < agora) return 'EXPIRADO';
    if (cupom.usoMaximo != null && cupom.usosRealizados >= cupom.usoMaximo) return 'ESGOTADO';
    return 'ATIVO';
  };
  const cuponsComStatus = cupons.map((c) => ({ ...c, statusCalculado: statusDe(c) }));

  const inicioMesAtual = new Date(agora.getFullYear(), agora.getMonth(), 1);
  const inicioMesAnterior = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);

  // Pedido.cupomCodigo/descontoCupom já guardam o histórico de uso por pedido — não precisa de
  // uma tabela nova só pra saber "quantos usos e quanto desconto este mês".
  const [pedidosMesAtual, pedidosMesAnterior] = await Promise.all([
    prisma.pedido.findMany({
      where: { empresaId: req.params.empresaId, cupomCodigo: { not: null }, status: { not: 'CANCELADO' }, createdAt: { gte: inicioMesAtual } },
      select: { total: true, descontoCupom: true, cupomCodigo: true },
    }),
    prisma.pedido.findMany({
      where: {
        empresaId: req.params.empresaId, cupomCodigo: { not: null }, status: { not: 'CANCELADO' },
        createdAt: { gte: inicioMesAnterior, lt: inicioMesAtual },
      },
      select: { total: true, descontoCupom: true },
    }),
  ]);

  const somar = (lista, campo) => lista.reduce((s, p) => s + Number(p[campo] || 0), 0);
  const usosMesAtual = pedidosMesAtual.length;
  const usosMesAnterior = pedidosMesAnterior.length;
  const descontoMesAtual = somar(pedidosMesAtual, 'descontoCupom');
  const descontoMesAnterior = somar(pedidosMesAnterior, 'descontoCupom');

  const topCuponsMap = new Map();
  for (const c of cupons) {
    if (c.usosRealizados > 0) topCuponsMap.set(c.codigo, c.usosRealizados);
  }
  const topCupons = Array.from(topCuponsMap.entries())
    .map(([codigo, usos]) => ({ codigo, usos }))
    .sort((a, b) => b.usos - a.usos)
    .slice(0, 5);

  const porTipoMap = new Map();
  for (const c of cupons) {
    porTipoMap.set(c.tipo, (porTipoMap.get(c.tipo) || 0) + 1);
  }

  res.json({
    cupons: cuponsComStatus,
    stats: {
      total: cupons.length,
      ativos: cuponsComStatus.filter((c) => c.statusCalculado === 'ATIVO').length,
      agendados: cuponsComStatus.filter((c) => c.statusCalculado === 'AGENDADO').length,
      expirados: cuponsComStatus.filter((c) => c.statusCalculado === 'EXPIRADO' || c.statusCalculado === 'ESGOTADO').length,
      usosMesAtual,
      usosMesAnterior,
      descontoMesAtual,
      descontoMesAnterior,
      ticketMedioComCupom: pedidosMesAtual.length ? somar(pedidosMesAtual, 'total') / pedidosMesAtual.length : 0,
      economiaMediaPorPedido: pedidosMesAtual.length ? descontoMesAtual / pedidosMesAtual.length : 0,
      topCupons,
      porTipo: Array.from(porTipoMap.entries()).map(([tipo, quantidade]) => ({ tipo, quantidade })),
    },
  });
}));

module.exports = router;
