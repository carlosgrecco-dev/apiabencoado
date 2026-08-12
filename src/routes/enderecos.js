const { Router } = require('express');
const prisma = require('../lib/prisma');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/** Garante que o cliente existe e pertence à empresa da rota. */
const loadCliente = asyncHandler(async (req, res, next) => {
  const cliente = await prisma.cliente.findFirst({
    where: { id: req.params.clienteId, empresaId: req.params.empresaId },
  });
  if (!cliente) {
    return res.status(404).json({ error: 'Cliente não encontrado' });
  }
  req.cliente = cliente;
  next();
});

router.use(loadCliente);

const handlePrismaError = (error, res) => {
  if (error.code === 'P2025') {
    return res.status(404).json({ error: 'Endereço não encontrado' });
  }
  throw error;
};

/**
 * @openapi
 * components:
 *   schemas:
 *     EnderecoCliente:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid }
 *         clienteId: { type: string, format: uuid }
 *         rotulo: { type: string }
 *         cep: { type: string, nullable: true }
 *         endereco: { type: string }
 *         numero: { type: string, nullable: true }
 *         bairro: { type: string, nullable: true }
 *         cidade: { type: string, nullable: true }
 *         referencia: { type: string, nullable: true }
 *         principal: { type: boolean }
 *     EnderecoClienteInput:
 *       type: object
 *       required: [rotulo, endereco]
 *       properties:
 *         rotulo: { type: string }
 *         cep: { type: string }
 *         endereco: { type: string }
 *         numero: { type: string }
 *         bairro: { type: string }
 *         cidade: { type: string }
 *         referencia: { type: string }
 *         principal: { type: boolean }
 */

/**
 * @openapi
 * /empresas/{empresaId}/clientes/{clienteId}/enderecos:
 *   get:
 *     summary: Lista os endereços salvos do cliente
 *     tags: [Enderecos]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: clienteId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Lista de endereços
 */
router.get('/', asyncHandler(async (req, res) => {
  const enderecos = await prisma.enderecoCliente.findMany({
    where: { clienteId: req.params.clienteId },
    orderBy: [{ principal: 'desc' }, { createdAt: 'asc' }],
  });
  res.json(enderecos);
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes/{clienteId}/enderecos:
 *   post:
 *     summary: Cadastra um novo endereço para o cliente
 *     tags: [Enderecos]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: clienteId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/EnderecoClienteInput'
 *     responses:
 *       201:
 *         description: Endereço criado
 *       400:
 *         description: Dados inválidos
 */
router.post('/', asyncHandler(async (req, res) => {
  const { rotulo, cep, endereco, numero, bairro, cidade, referencia, principal } = req.body;

  if (!rotulo || !endereco) {
    return res.status(400).json({ error: 'Campos "rotulo" e "endereco" são obrigatórios' });
  }

  const totalExistentes = await prisma.enderecoCliente.count({ where: { clienteId: req.params.clienteId } });
  const tornarPrincipal = Boolean(principal) || totalExistentes === 0;

  const criado = await prisma.$transaction(async (tx) => {
    if (tornarPrincipal) {
      await tx.enderecoCliente.updateMany({
        where: { clienteId: req.params.clienteId },
        data: { principal: false },
      });
    }
    return tx.enderecoCliente.create({
      data: {
        clienteId: req.params.clienteId,
        rotulo,
        cep: cep || null,
        endereco,
        numero: numero || null,
        bairro: bairro || null,
        cidade: cidade || null,
        referencia: referencia || null,
        principal: tornarPrincipal,
      },
    });
  });

  res.status(201).json(criado);
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes/{clienteId}/enderecos/{id}:
 *   put:
 *     summary: Atualiza um endereço salvo
 *     tags: [Enderecos]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: clienteId
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
 *             $ref: '#/components/schemas/EnderecoClienteInput'
 *     responses:
 *       200:
 *         description: Endereço atualizado
 *       404:
 *         description: Endereço não encontrado
 */
router.put('/:id', asyncHandler(async (req, res) => {
  const { rotulo, cep, endereco, numero, bairro, cidade, referencia, principal } = req.body;

  if (!rotulo || !endereco) {
    return res.status(400).json({ error: 'Campos "rotulo" e "endereco" são obrigatórios' });
  }

  const existente = await prisma.enderecoCliente.findFirst({
    where: { id: req.params.id, clienteId: req.params.clienteId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Endereço não encontrado' });
  }

  try {
    const atualizado = await prisma.$transaction(async (tx) => {
      if (principal) {
        await tx.enderecoCliente.updateMany({
          where: { clienteId: req.params.clienteId },
          data: { principal: false },
        });
      }
      return tx.enderecoCliente.update({
        where: { id: req.params.id },
        data: {
          rotulo,
          cep: cep || null,
          endereco,
          numero: numero || null,
          bairro: bairro || null,
          cidade: cidade || null,
          referencia: referencia || null,
          ...(principal !== undefined ? { principal: Boolean(principal) } : {}),
        },
      });
    });
    res.json(atualizado);
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes/{clienteId}/enderecos/{id}/principal:
 *   patch:
 *     summary: Define este endereço como o principal (desmarca os demais)
 *     tags: [Enderecos]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: clienteId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Endereço definido como principal
 *       404:
 *         description: Endereço não encontrado
 */
router.patch('/:id/principal', asyncHandler(async (req, res) => {
  const existente = await prisma.enderecoCliente.findFirst({
    where: { id: req.params.id, clienteId: req.params.clienteId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Endereço não encontrado' });
  }

  const atualizado = await prisma.$transaction(async (tx) => {
    await tx.enderecoCliente.updateMany({
      where: { clienteId: req.params.clienteId },
      data: { principal: false },
    });
    return tx.enderecoCliente.update({ where: { id: req.params.id }, data: { principal: true } });
  });

  res.json(atualizado);
}));

/**
 * @openapi
 * /empresas/{empresaId}/clientes/{clienteId}/enderecos/{id}:
 *   delete:
 *     summary: Remove um endereço salvo
 *     tags: [Enderecos]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: clienteId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204:
 *         description: Endereço removido
 *       404:
 *         description: Endereço não encontrado
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const existente = await prisma.enderecoCliente.findFirst({
    where: { id: req.params.id, clienteId: req.params.clienteId },
  });
  if (!existente) {
    return res.status(404).json({ error: 'Endereço não encontrado' });
  }

  await prisma.enderecoCliente.delete({ where: { id: req.params.id } });

  if (existente.principal) {
    const proximo = await prisma.enderecoCliente.findFirst({
      where: { clienteId: req.params.clienteId },
      orderBy: { createdAt: 'asc' },
    });
    if (proximo) {
      await prisma.enderecoCliente.update({ where: { id: proximo.id }, data: { principal: true } });
    }
  }

  res.status(204).send();
}));

module.exports = router;
