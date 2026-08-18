const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const validarCupom = require('../lib/validarCupom');
const { requireEmpresaAdmin } = require('../lib/auth');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);

const TIPOS_VALIDOS = ['PERCENTUAL', 'VALOR_FIXO', 'FRETE_GRATIS'];

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
  const where = {
    empresaId: req.params.empresaId,
    ...(ativo !== undefined ? { ativo: ativo === 'true' } : {}),
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
  const { codigo, descricao, tipo, valor, apenasPrimeiraCompra, valorMinimoPedido, usoMaximo, validoAte, ativo } = req.body;

  const erros = validarPayload(req.body);
  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }

  try {
    const cupom = await prisma.cupom.create({
      data: {
        empresaId: req.params.empresaId,
        codigo: codigo.toUpperCase(),
        descricao: descricao || null,
        tipo,
        valor: tipo === 'FRETE_GRATIS' ? null : valor,
        apenasPrimeiraCompra: Boolean(apenasPrimeiraCompra),
        valorMinimoPedido: valorMinimoPedido || null,
        usoMaximo: usoMaximo || null,
        validoAte: validoAte ? new Date(validoAte) : null,
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
  const { codigo, descricao, tipo, valor, apenasPrimeiraCompra, valorMinimoPedido, usoMaximo, validoAte, ativo } = req.body;

  const erros = validarPayload(req.body);
  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }

  const existente = await prisma.cupom.findFirst({ where: { id: req.params.id, empresaId: req.params.empresaId } });
  if (!existente) {
    return res.status(404).json({ error: 'Cupom não encontrado' });
  }

  try {
    const cupom = await prisma.cupom.update({
      where: { id: req.params.id },
      data: {
        codigo: codigo.toUpperCase(),
        descricao: descricao || null,
        tipo,
        valor: tipo === 'FRETE_GRATIS' ? null : valor,
        apenasPrimeiraCompra: Boolean(apenasPrimeiraCompra),
        valorMinimoPedido: valorMinimoPedido || null,
        usoMaximo: usoMaximo || null,
        validoAte: validoAte ? new Date(validoAte) : null,
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
  const { codigo, subtotal } = req.body;

  if (subtotal === undefined || Number.isNaN(Number(subtotal))) {
    return res.status(400).json({ error: 'Campo "subtotal" é obrigatório' });
  }

  // clienteId nunca vem do corpo — só do token de quem estiver logado como CLIENTE desta
  // empresa, pra ninguém forjar elegibilidade de cupom de "primeira compra" em nome de outro.
  const clienteId = (req.auth && req.auth.role === 'CLIENTE' && req.auth.empresaId === req.params.empresaId)
    ? req.auth.clienteId
    : null;

  const resultado = await validarCupom(prisma, req.params.empresaId, codigo, clienteId, Number(subtotal));

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

module.exports = router;
