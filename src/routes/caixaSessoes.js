const { Router } = require('express');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { requireEmpresaAdmin , requireGrupo } = require('../lib/auth');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(loadEmpresa);

/**
 * Soma os movimentos de uma sessão de caixa pra montar a prévia/resultado do fechamento.
 * "Esperado em dinheiro" conta ENTRADA em DINHEIRO (ou sem forma de pagamento registrada — caso
 * de lançamento manual, que normalmente representa dinheiro mesmo) + fundo de troco + suprimentos,
 * menos saídas/sangrias. PIX e CARTAO não entram nesse cálculo porque não colocam dinheiro físico
 * na gaveta.
 */
async function calcularResumo(sessao) {
  const movimentos = await prisma.movimentoCaixa.findMany({
    where: { caixaSessaoId: sessao.id },
  });

  const somaTipo = (tipos, filtro) => movimentos
    .filter((m) => tipos.includes(m.tipo) && (!filtro || filtro(m)))
    .reduce((sum, m) => sum + Number(m.valor), 0);

  const entradasPorForma = { PIX: 0, DINHEIRO: 0, CARTAO: 0, MULTIPLO: 0, SEM_FORMA: 0 };
  for (const m of movimentos) {
    if (m.tipo !== 'ENTRADA') continue;
    if (m.formaPagamento) entradasPorForma[m.formaPagamento] += Number(m.valor);
    else entradasPorForma.SEM_FORMA += Number(m.valor);
  }

  const totalEntradas = somaTipo(['ENTRADA']);
  const totalSaidas = somaTipo(['SAIDA']);
  const totalSangrias = somaTipo(['SANGRIA']);
  const totalSuprimentos = somaTipo(['SUPRIMENTO']);

  const entradasDinheiro = entradasPorForma.DINHEIRO + entradasPorForma.SEM_FORMA;
  const valorEsperado = Number(sessao.fundoTroco) + entradasDinheiro + totalSuprimentos - totalSaidas - totalSangrias;

  return {
    fundoTroco: Number(sessao.fundoTroco),
    entradasPorForma,
    totalEntradas,
    totalSaidas,
    totalSangrias,
    totalSuprimentos,
    valorEsperado,
    quantidadeMovimentos: movimentos.length,
  };
}

/**
 * @openapi
 * components:
 *   schemas:
 *     CaixaSessao:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid, readOnly: true }
 *         empresaId: { type: string, format: uuid }
 *         operadorId: { type: string, format: uuid, nullable: true }
 *         operadorNome: { type: string }
 *         fundoTroco: { type: number }
 *         status: { type: string, enum: [ABERTO, FECHADO] }
 *         abertoEm: { type: string, format: date-time }
 *         fechadoEm: { type: string, format: date-time, nullable: true }
 *         valorContado: { type: number, nullable: true }
 *         valorEsperado: { type: number, nullable: true }
 *         diferenca: { type: number, nullable: true }
 */

/**
 * @openapi
 * /empresas/{empresaId}/caixa-sessoes:
 *   post:
 *     summary: Abre uma nova sessão de caixa (fundo de troco inicial) — rejeita se já existe uma aberta
 *     tags: [PDV]
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
 *             properties:
 *               operadorId: { type: string, format: uuid }
 *               operadorNome: { type: string }
 *               fundoTroco: { type: number }
 *     responses:
 *       201:
 *         description: Caixa aberto
 *       400:
 *         description: Já existe um caixa aberto
 */
router.post('/', requireEmpresaAdmin(), requireGrupo('operacional'), asyncHandler(async (req, res) => {
  const { operadorId, operadorNome, fundoTroco } = req.body;

  const aberta = await prisma.caixaSessao.findFirst({
    where: { empresaId: req.params.empresaId, status: 'ABERTO' },
  });
  if (aberta) {
    return res.status(400).json({ error: 'Já existe um caixa aberto para esta loja' });
  }

  let nomeOperador = operadorNome || null;
  if (operadorId) {
    const operador = await prisma.operadorPdv.findFirst({
      where: { id: operadorId, empresaId: req.params.empresaId },
    });
    if (!operador) {
      return res.status(400).json({ error: 'Operador informado não pertence a esta empresa' });
    }
    nomeOperador = operador.nome;
  }
  if (!nomeOperador) {
    return res.status(400).json({ error: 'Informe "operadorId" ou "operadorNome"' });
  }

  const valorFundo = fundoTroco != null ? Number(fundoTroco) : 0;
  if (Number.isNaN(valorFundo) || valorFundo < 0) {
    return res.status(400).json({ error: 'Campo "fundoTroco" deve ser um número maior ou igual a zero' });
  }

  const sessao = await prisma.caixaSessao.create({
    data: {
      empresaId: req.params.empresaId,
      operadorId: operadorId || null,
      operadorNome: nomeOperador,
      fundoTroco: valorFundo,
    },
  });

  res.status(201).json(sessao);
}));

/**
 * @openapi
 * /empresas/{empresaId}/caixa-sessoes/aberta:
 *   get:
 *     summary: Devolve a sessão de caixa aberta no momento, ou null se nenhuma estiver aberta
 *     tags: [PDV]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Sessão aberta (ou null)
 */
router.get('/aberta', requireEmpresaAdmin(), requireGrupo('operacional'), asyncHandler(async (req, res) => {
  const sessao = await prisma.caixaSessao.findFirst({
    where: { empresaId: req.params.empresaId, status: 'ABERTO' },
  });
  res.json(sessao || null);
}));

/**
 * @openapi
 * /empresas/{empresaId}/caixa-sessoes:
 *   get:
 *     summary: Histórico de sessões de caixa
 *     tags: [PDV]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [ABERTO, FECHADO] }
 *       - in: query
 *         name: de
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: ate
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: Lista de sessões
 */
router.get('/', requireEmpresaAdmin(), requireGrupo('operacional'), asyncHandler(async (req, res) => {
  const { status, de, ate } = req.query;
  if (status && !['ABERTO', 'FECHADO'].includes(status)) {
    return res.status(400).json({ error: 'Campo "status" deve ser um de: ABERTO, FECHADO' });
  }

  const sessoes = await prisma.caixaSessao.findMany({
    where: {
      empresaId: req.params.empresaId,
      ...(status ? { status } : {}),
      ...(de || ate
        ? {
          abertoEm: {
            ...(de ? { gte: new Date(`${de}T00:00:00`) } : {}),
            ...(ate ? { lte: new Date(`${ate}T23:59:59`) } : {}),
          },
        }
        : {}),
    },
    orderBy: { abertoEm: 'desc' },
  });

  res.json(sessoes);
}));

/**
 * @openapi
 * /empresas/{empresaId}/caixa-sessoes/{id}:
 *   get:
 *     summary: Detalhe de uma sessão de caixa, com os movimentos dela
 *     tags: [PDV]
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
 *         description: Sessão encontrada
 *       404:
 *         description: Sessão não encontrada
 */
router.get('/:id', requireEmpresaAdmin(), requireGrupo('operacional'), asyncHandler(async (req, res) => {
  const sessao = await prisma.caixaSessao.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
    include: { movimentos: { orderBy: { createdAt: 'asc' } } },
  });
  if (!sessao) {
    return res.status(404).json({ error: 'Sessão de caixa não encontrada' });
  }
  res.json(sessao);
}));

/**
 * @openapi
 * /empresas/{empresaId}/caixa-sessoes/{id}/resumo:
 *   get:
 *     summary: Prévia da conferência de fechamento (entradas por forma, saídas, sangrias, suprimentos e valor esperado em dinheiro)
 *     tags: [PDV]
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
 *         description: Resumo da sessão
 *       404:
 *         description: Sessão não encontrada
 */
router.get('/:id/resumo', requireEmpresaAdmin(), requireGrupo('operacional'), asyncHandler(async (req, res) => {
  const sessao = await prisma.caixaSessao.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!sessao) {
    return res.status(404).json({ error: 'Sessão de caixa não encontrada' });
  }

  res.json(await calcularResumo(sessao));
}));

/**
 * @openapi
 * /empresas/{empresaId}/caixa-sessoes/{id}/fechar:
 *   post:
 *     summary: Fecha a sessão de caixa, registrando o valor contado e a diferença em relação ao esperado
 *     tags: [PDV]
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
 *             required: [valorContado]
 *             properties:
 *               valorContado: { type: number }
 *               observacoesFechamento: { type: string }
 *     responses:
 *       200:
 *         description: Caixa fechado
 *       400:
 *         description: Dados inválidos ou caixa já fechado
 *       404:
 *         description: Sessão não encontrada
 */
router.post('/:id/fechar', requireEmpresaAdmin(), requireGrupo('operacional'), asyncHandler(async (req, res) => {
  const { valorContado, observacoesFechamento } = req.body;
  if (typeof valorContado !== 'number' || valorContado < 0) {
    return res.status(400).json({ error: 'Campo "valorContado" é obrigatório e deve ser um número maior ou igual a zero' });
  }

  const sessao = await prisma.caixaSessao.findFirst({
    where: { id: req.params.id, empresaId: req.params.empresaId },
  });
  if (!sessao) {
    return res.status(404).json({ error: 'Sessão de caixa não encontrada' });
  }
  if (sessao.status === 'FECHADO') {
    return res.status(400).json({ error: 'Este caixa já foi fechado' });
  }

  const resumo = await calcularResumo(sessao);
  const diferenca = valorContado - resumo.valorEsperado;

  const fechada = await prisma.caixaSessao.update({
    where: { id: sessao.id },
    data: {
      status: 'FECHADO',
      fechadoEm: new Date(),
      valorContado,
      valorEsperado: resumo.valorEsperado,
      diferenca,
      observacoesFechamento: observacoesFechamento || null,
    },
  });

  res.json({ ...fechada, resumo });
}));

module.exports = router;
