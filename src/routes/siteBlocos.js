const { Router } = require('express');
const prisma = require('../lib/prisma');
const { registrarLog } = require('../lib/auditLog');
const { requireSuperAdmin } = require('../lib/auth');

const router = Router();

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const PAGINAS_VALIDAS = ['LANDING', 'PARCEIRO', 'RECURSOS', 'POLITICA_PRIVACIDADE'];
const TIPOS_VALIDOS = ['HERO', 'LISTA_ICONES', 'CTA_BANNER'];

/**
 * @openapi
 * /site-blocos/publico:
 *   get:
 *     summary: Lista os blocos de conteúdo ativos de uma página pública (CMS do site)
 *     tags: [SiteBlocos]
 *     responses:
 *       200:
 *         description: Lista de blocos ativos da página
 */
router.get('/publico', asyncHandler(async (req, res) => {
  const { pagina } = req.query;
  if (!pagina || !PAGINAS_VALIDAS.includes(pagina)) {
    return res.status(400).json({ error: `Parâmetro "pagina" inválido ou ausente. Use um de: ${PAGINAS_VALIDAS.join(', ')}` });
  }

  const blocos = await prisma.siteBloco.findMany({
    where: { pagina, ativo: true },
    orderBy: [{ ordem: 'asc' }, { chave: 'asc' }],
    select: {
      id: true,
      pagina: true,
      chave: true,
      tipo: true,
      eyebrow: true,
      icone: true,
      titulo: true,
      subtitulo: true,
      texto: true,
      textoBotao: true,
      linkBotao: true,
      itens: true,
    },
  });
  res.json(blocos);
}));

router.use(requireSuperAdmin);

const handlePrismaError = (error, res) => {
  if (error.code === 'P2025') {
    return res.status(404).json({ error: 'Bloco não encontrado' });
  }
  if (error.code === 'P2002') {
    return res.status(409).json({ error: 'Já existe um bloco com essa chave nesta página' });
  }
  throw error;
};

const validarPayload = ({ pagina, chave, tipo, titulo, textoBotao, linkBotao }) => {
  const erros = [];
  if (!pagina || !PAGINAS_VALIDAS.includes(pagina)) erros.push(`Campo "pagina" é obrigatório e deve ser um de: ${PAGINAS_VALIDAS.join(', ')}`);
  if (!chave || !String(chave).trim()) erros.push('Campo "chave" é obrigatório');
  if (!tipo || !TIPOS_VALIDOS.includes(tipo)) erros.push(`Campo "tipo" é obrigatório e deve ser um de: ${TIPOS_VALIDOS.join(', ')}`);
  if (tipo === 'HERO' && !titulo) erros.push('Campo "titulo" é obrigatório para blocos do tipo HERO');
  if (tipo === 'CTA_BANNER') {
    if (!titulo) erros.push('Campo "titulo" é obrigatório para blocos do tipo CTA_BANNER');
    if (!textoBotao) erros.push('Campo "textoBotao" é obrigatório para blocos do tipo CTA_BANNER');
    if (!linkBotao) erros.push('Campo "linkBotao" é obrigatório para blocos do tipo CTA_BANNER');
  }
  return erros;
};

/**
 * @openapi
 * /site-blocos:
 *   get:
 *     summary: Lista os blocos de conteúdo do site público (Super Admin, inclui inativos)
 *     tags: [SiteBlocos]
 *     responses:
 *       200:
 *         description: Lista de blocos
 */
router.get('/', asyncHandler(async (req, res) => {
  const { pagina } = req.query;
  if (pagina && !PAGINAS_VALIDAS.includes(pagina)) {
    return res.status(400).json({ error: `Parâmetro "pagina" inválido. Use um de: ${PAGINAS_VALIDAS.join(', ')}` });
  }
  const blocos = await prisma.siteBloco.findMany({
    where: { ...(pagina ? { pagina } : {}) },
    orderBy: [{ pagina: 'asc' }, { ordem: 'asc' }, { chave: 'asc' }],
  });
  res.json(blocos);
}));

/**
 * @openapi
 * /site-blocos:
 *   post:
 *     summary: Cadastra um novo bloco de conteúdo do site público
 *     tags: [SiteBlocos]
 *     responses:
 *       201:
 *         description: Bloco criado
 *       400:
 *         description: Dados inválidos
 */
router.post('/', asyncHandler(async (req, res) => {
  const {
    pagina, chave, tipo, ativo, ordem,
    eyebrow, icone, titulo, subtitulo, texto, textoBotao, linkBotao, itens,
  } = req.body;

  const erros = validarPayload(req.body);
  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }

  try {
    const bloco = await prisma.siteBloco.create({
      data: {
        pagina,
        chave: String(chave).trim(),
        tipo,
        eyebrow: eyebrow || null,
        icone: icone || null,
        titulo: titulo || null,
        subtitulo: subtitulo || null,
        texto: texto || null,
        textoBotao: textoBotao || null,
        linkBotao: linkBotao || null,
        itens: tipo === 'LISTA_ICONES' ? (Array.isArray(itens) ? itens : []) : undefined,
        ...(ativo !== undefined ? { ativo } : {}),
        ...(ordem !== undefined ? { ordem } : {}),
      },
    });
    await registrarLog({ tipo: 'ALTERACAO_CRITICA', ator: 'super-admin', acao: `Bloco "${bloco.pagina}/${bloco.chave}" criado`, detalhes: bloco });
    res.status(201).json(bloco);
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /site-blocos/{id}:
 *   put:
 *     summary: Atualiza um bloco de conteúdo do site público
 *     tags: [SiteBlocos]
 *     responses:
 *       200:
 *         description: Bloco atualizado
 *       404:
 *         description: Bloco não encontrado
 */
router.put('/:id', asyncHandler(async (req, res) => {
  const {
    pagina, chave, tipo, ativo, ordem,
    eyebrow, icone, titulo, subtitulo, texto, textoBotao, linkBotao, itens,
  } = req.body;

  const erros = validarPayload(req.body);
  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }

  try {
    const bloco = await prisma.siteBloco.update({
      where: { id: req.params.id },
      data: {
        pagina,
        chave: String(chave).trim(),
        tipo,
        eyebrow: eyebrow || null,
        icone: icone || null,
        titulo: titulo || null,
        subtitulo: subtitulo || null,
        texto: texto || null,
        textoBotao: textoBotao || null,
        linkBotao: linkBotao || null,
        itens: tipo === 'LISTA_ICONES' ? (Array.isArray(itens) ? itens : []) : null,
        ...(ativo !== undefined ? { ativo } : {}),
        ...(ordem !== undefined ? { ordem } : {}),
      },
    });
    await registrarLog({ tipo: 'ALTERACAO_CRITICA', ator: 'super-admin', acao: `Bloco "${bloco.pagina}/${bloco.chave}" atualizado`, detalhes: bloco });
    res.json(bloco);
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /site-blocos/{id}/status:
 *   patch:
 *     summary: Ativa ou inativa um bloco de conteúdo do site público
 *     tags: [SiteBlocos]
 *     responses:
 *       200:
 *         description: Status atualizado
 *       404:
 *         description: Bloco não encontrado
 */
router.patch('/:id/status', asyncHandler(async (req, res) => {
  const { ativo } = req.body;
  if (typeof ativo !== 'boolean') {
    return res.status(400).json({ error: 'Campo "ativo" é obrigatório e deve ser booleano' });
  }

  try {
    const bloco = await prisma.siteBloco.update({ where: { id: req.params.id }, data: { ativo } });
    res.json(bloco);
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /site-blocos/{id}:
 *   delete:
 *     summary: Remove um bloco de conteúdo do site público (a página volta a usar o texto padrão)
 *     tags: [SiteBlocos]
 *     responses:
 *       204:
 *         description: Bloco removido
 *       404:
 *         description: Bloco não encontrado
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  try {
    const bloco = await prisma.siteBloco.delete({ where: { id: req.params.id } });
    await registrarLog({ tipo: 'ALTERACAO_CRITICA', ator: 'super-admin', acao: `Bloco "${bloco.pagina}/${bloco.chave}" removido` });
    res.status(204).send();
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

module.exports = router;
