const { Router } = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { calcularStatusLoja } = require('../lib/statusLoja');
const { registrarLog } = require('../lib/auditLog');
const { registrarAtividadeLoja } = require('../lib/atividadeLoja');
const { signToken, requireSuperAdmin, requireEmpresaAdmin } = require('../lib/auth');
const { gerarCodigoIndicacaoEmpresaUnico } = require('../lib/indicacaoEmpresa');
const { gerarIconePwa, TAMANHOS_VALIDOS } = require('../lib/pwaIcon');
const { CAMPOS_FUNCIONALIDADES } = require('../lib/funcionalidades');

const ADMIN_TOKEN_TTL = '12h';

const router = Router();

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const SALT_ROUNDS = 10;

const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const onlyDigits = (value = '') => String(value).replace(/\D/g, '');

/** Espaço em branco no início/fim passa despercebido no formulário mas quebra comparação exata
 * de login (usuario) e busca por slug único — corta sempre que o campo vier de texto livre. */
const trim = (value) => (typeof value === 'string' ? value.trim() : value);

const UNIQUE_FIELD_LABELS = {
  email: 'E-mail',
  slug: 'Slug',
  usuario: 'Usuário',
  documento: 'CNPJ/CPF',
};

/** Remove o hash da senha antes de devolver a empresa para o cliente. */
const serializeEmpresa = (empresa) => {
  const { senhaHash, ...rest } = empresa;
  return rest;
};

const validarPayload = ({ nome, responsavelNome, email, telefone, documento, slug, usuario }, { partial = false } = {}) => {
  const erros = [];

  const obrigatorio = (valor, campo) => {
    if (!partial && !valor) erros.push(`Campo "${campo}" é obrigatório`);
  };

  obrigatorio(nome, 'nome');
  obrigatorio(responsavelNome, 'responsavelNome');
  obrigatorio(email, 'email');
  obrigatorio(telefone, 'telefone');
  obrigatorio(documento, 'documento');
  obrigatorio(slug, 'slug');
  obrigatorio(usuario, 'usuario');

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    erros.push('E-mail inválido');
  }

  if (documento) {
    const digits = onlyDigits(documento);
    if (digits.length !== 11 && digits.length !== 14) {
      erros.push('Documento deve ser um CPF (11 dígitos) ou CNPJ (14 dígitos) válido');
    }
  }

  if (slug && !SLUG_REGEX.test(slug)) {
    erros.push('Slug deve conter apenas letras minúsculas, números e hífens (ex: minha-empresa)');
  }

  return erros;
};

const handlePrismaError = (error, res) => {
  if (error.code === 'P2025') {
    return res.status(404).json({ error: 'Empresa não encontrada' });
  }
  if (error.code === 'P2002') {
    const campo = Array.isArray(error.meta?.target) ? error.meta.target[0] : error.meta?.target;
    const chave = String(campo || '').replace(/^empresas_|_key$/g, '');
    const label = UNIQUE_FIELD_LABELS[chave] || 'campo';
    return res.status(409).json({ error: `Já existe uma empresa cadastrada com este ${label}` });
  }
  throw error;
};

/**
 * @openapi
 * components:
 *   schemas:
 *     Empresa:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *           readOnly: true
 *         nome:
 *           type: string
 *         responsavelNome:
 *           type: string
 *         email:
 *           type: string
 *         telefone:
 *           type: string
 *         documento:
 *           type: string
 *         slug:
 *           type: string
 *         usuario:
 *           type: string
 *         empresaAtiva:
 *           type: boolean
 *         adminAtivo:
 *           type: boolean
 *         createdAt:
 *           type: string
 *           format: date-time
 *         updatedAt:
 *           type: string
 *           format: date-time
 *       example:
 *         id: 629a6127-707c-4060-9e57-5f5bc8af057f
 *         nome: Restaurante Abençoado
 *         responsavelNome: João da Silva
 *         email: joao@abencoado.com
 *         telefone: "5581999999999"
 *         documento: "12345678000199"
 *         slug: restaurante-abencoado
 *         usuario: joao.silva
 *         empresaAtiva: true
 *         adminAtivo: true
 *     EmpresaInput:
 *       type: object
 *       required: [nome, responsavelNome, email, telefone, documento, slug, usuario, senha]
 *       properties:
 *         nome:
 *           type: string
 *         responsavelNome:
 *           type: string
 *         email:
 *           type: string
 *         telefone:
 *           type: string
 *         documento:
 *           type: string
 *         slug:
 *           type: string
 *         usuario:
 *           type: string
 *         senha:
 *           type: string
 *         empresaAtiva:
 *           type: boolean
 *         adminAtivo:
 *           type: boolean
 *     StatusInput:
 *       type: object
 *       required: [ativo]
 *       properties:
 *         ativo:
 *           type: boolean
 *     SenhaInput:
 *       type: object
 *       required: [senha]
 *       properties:
 *         senha:
 *           type: string
 */

/**
 * @openapi
 * /empresas:
 *   get:
 *     summary: Lista empresas cadastradas, com busca opcional
 *     tags: [Empresas]
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         description: Busca por nome, CNPJ/CPF, e-mail ou slug
 *     responses:
 *       200:
 *         description: Lista de empresas
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Empresa'
 */
router.get('/', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { q } = req.query;

  const where = q
    ? {
      OR: [
        { nome: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { slug: { contains: q, mode: 'insensitive' } },
        { documento: { contains: onlyDigits(q) || q, mode: 'insensitive' } },
        { responsavelNome: { contains: q, mode: 'insensitive' } },
      ],
    }
    : undefined;

  const empresas = await prisma.empresa.findMany({
    where,
    include: { indicadaPor: { select: { id: true, nome: true, codigoIndicacao: true } } },
    orderBy: { createdAt: 'desc' },
  });

  res.json(empresas.map(serializeEmpresa));
}));

/**
 * @openapi
 * /empresas/slug/{slug}:
 *   get:
 *     summary: Resolve os dados públicos de uma empresa pelo slug (usado pelo roteamento /{slug} do site)
 *     tags: [Empresas]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Dados públicos da empresa
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                   format: uuid
 *                 nome:
 *                   type: string
 *                 slug:
 *                   type: string
 *                 empresaAtiva:
 *                   type: boolean
 *                 telefone:
 *                   type: string
 *                 descricao:
 *                   type: string
 *                   nullable: true
 *                 sobre:
 *                   type: string
 *                   nullable: true
 *                 endereco:
 *                   type: string
 *                   nullable: true
 *                 horarioFuncionamento:
 *                   type: string
 *                   nullable: true
 *                 instagramUrl:
 *                   type: string
 *                   nullable: true
 *                 facebookUrl:
 *                   type: string
 *                   nullable: true
 *                 logoUrl:
 *                   type: string
 *                   nullable: true
 *                 taxaEntrega:
 *                   type: number
 *                 corPrimaria:
 *                   type: string
 *                 corSecundaria:
 *                   type: string
 *                 faviconUrl:
 *                   type: string
 *                   nullable: true
 *                 heroUsarCarrossel:
 *                   type: boolean
 *                 heroTitulo:
 *                   type: string
 *                   nullable: true
 *                 heroSubtitulo:
 *                   type: string
 *                   nullable: true
 *                 heroBadgeLabel:
 *                   type: string
 *                   nullable: true
 *                 heroImagemUrl:
 *                   type: string
 *                   nullable: true
 *                 heroLinkUrl:
 *                   type: string
 *                   nullable: true
 *       404:
 *         description: Empresa não encontrada
 */
/**
 * @openapi
 * /empresas/slug/{slug}/manifest.json:
 *   get:
 *     summary: Manifest do PWA desta loja, numa URL estável — usado pelo prompt de instalação do navegador
 *     tags: [Empresas]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Manifest da loja
 *       404:
 *         description: Empresa não encontrada
 */
/** Nome e ponto de entrada do PWA mudam conforme de onde foi instalado — sem isso, instalar o
 * atalho de dentro do admin ou do portal do motoboy abria sempre a vitrine da loja ao reabrir. */
const CONTEXTOS_MANIFEST = {
  admin: { sufixoNome: ' · Painel', caminho: '/admin' },
  motoboy: { sufixoNome: ' · Entregas', caminho: '/motoboy' },
  loja: { sufixoNome: '', caminho: '' },
};

router.get('/slug/:slug/manifest.json', asyncHandler(async (req, res) => {
  const empresa = await prisma.empresa.findUnique({
    where: { slug: req.params.slug.toLowerCase() },
    select: { nome: true, descricao: true, corPrimaria: true, logoUrl: true },
  });

  if (!empresa) {
    return res.status(404).json({ error: 'Empresa não encontrada' });
  }

  const frontOrigin = process.env.FRONT_ORIGIN || 'https://saltfood.com.br';
  const apiOrigin = `${req.protocol}://${req.get('host')}`;
  const slug = req.params.slug.toLowerCase();
  const contextoChave = CONTEXTOS_MANIFEST[req.query.contexto] ? req.query.contexto : 'loja';
  const contexto = CONTEXTOS_MANIFEST[contextoChave];
  const nome = `${empresa.nome}${contexto.sufixoNome}`;
  const startUrl = `${frontOrigin}/${slug}${contexto.caminho}`;
  const manifestUrl = `${apiOrigin}/empresas/slug/${slug}/manifest.json?contexto=${contextoChave}`;

  // Ícone dinâmico (redimensionado a partir da logo da loja) quando ela tem logo cadastrada;
  // senão cai no ícone fixo do app. Servido pela própria API (rota abaixo), nunca a logoUrl crua
  // — o navegador exige tamanhos exatos (192/512) e um ícone maskable com margem de segurança.
  // Vale pra todo contexto (loja/admin/motoboy) — cada tenant instala com a própria logo, a marca
  // fixa da plataforma (logo.png) é só pro app do Super Admin.
  const iconeUrl = (size, maskable) =>
    empresa.logoUrl
      ? `${apiOrigin}/empresas/slug/${slug}/pwa-icon.png?size=${size}&maskable=${maskable ? 1 : 0}`
      : `${frontOrigin}/logo.png`;

  res.set('Content-Type', 'application/manifest+json');
  res.json({
    // Identidade estável do app — não deve mudar quando a loja troca nome/logo, senão o Chrome
    // trata a instalação existente como um app novo e a antiga vira um atalho órfão na tela.
    id: startUrl,
    name: nome,
    short_name: nome,
    description: empresa.descricao || `Peça online na ${empresa.nome}, com entrega rápida.`,
    start_url: startUrl,
    scope: `${frontOrigin}/${slug}`,
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: empresa.corPrimaria,
    // Permite ao front checar via navigator.getInstalledRelatedApps() se ESTE app (esta
    // loja+contexto) já está instalado, sem confundir com a instalação de outra loja.
    related_applications: [{ platform: 'webapp', url: manifestUrl }],
    prefer_related_applications: false,
    icons: [
      { src: iconeUrl(192, false), sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: iconeUrl(512, false), sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: iconeUrl(192, true), sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: iconeUrl(512, true), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
}));

/**
 * @openapi
 * /empresas/slug/{slug}/pwa-icon.png:
 *   get:
 *     summary: Ícone do PWA da loja, redimensionado a partir da logo cadastrada (192 ou 512px, opcionalmente maskable)
 *     tags: [Empresas]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: size
 *         schema: { type: integer, enum: [192, 512] }
 *       - in: query
 *         name: maskable
 *         schema: { type: string, enum: ['0', '1'] }
 *     responses:
 *       200:
 *         description: Imagem PNG
 */
router.get('/slug/:slug/pwa-icon.png', asyncHandler(async (req, res) => {
  const frontOrigin = process.env.FRONT_ORIGIN || 'https://saltfood.com.br';
  const fallback = () => res.redirect(302, `${frontOrigin}/logo.png`);

  const empresa = await prisma.empresa.findUnique({
    where: { slug: req.params.slug.toLowerCase() },
    select: { logoUrl: true },
  });
  if (!empresa || !empresa.logoUrl) return fallback();

  const size = TAMANHOS_VALIDOS.includes(Number(req.query.size)) ? Number(req.query.size) : 192;
  const maskable = req.query.maskable === '1';

  try {
    const png = await gerarIconePwa(empresa.logoUrl, size, maskable);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(png);
  } catch {
    // Logo inválida, inacessível ou bloqueada pelas checagens de segurança — cai no ícone fixo
    // em vez de devolver erro, pra nunca deixar o manifest com um ícone quebrado.
    fallback();
  }
}));

/** Escapa texto pra uso seguro dentro de atributos/conteúdo HTML (título e descrição vêm do lojista). */
const escapeHtml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * @openapi
 * /empresas/slug/{slug}/embed:
 *   get:
 *     summary: Página estática com meta tags Open Graph da loja — só pra crawlers de preview de link (WhatsApp, Facebook etc.)
 *     tags: [Empresas]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: HTML com as meta tags da loja
 *       404:
 *         description: Empresa não encontrada
 */
router.get('/slug/:slug/embed', asyncHandler(async (req, res) => {
  const slug = req.params.slug.toLowerCase();
  const empresa = await prisma.empresa.findUnique({
    where: { slug },
    select: { nome: true, descricao: true, logoUrl: true },
  });

  if (!empresa) {
    return res.status(404).send('Empresa não encontrada');
  }

  const frontOrigin = process.env.FRONT_ORIGIN || 'https://saltfood.com.br';
  const url = `${frontOrigin}/${slug}`;
  const titulo = escapeHtml(empresa.nome);
  const descricao = escapeHtml(empresa.descricao || `Peça online na ${empresa.nome}, com entrega rápida.`);
  const imagem = escapeHtml(empresa.logoUrl || `${frontOrigin}/logo.png`);

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<title>${titulo}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${titulo}">
<meta property="og:description" content="${descricao}">
<meta property="og:image" content="${imagem}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${titulo}">
<meta name="twitter:description" content="${descricao}">
<meta name="twitter:image" content="${imagem}">
<meta http-equiv="refresh" content="0; url=${url}">
</head>
<body>
<p>Redirecionando para ${titulo}... <a href="${url}">clique aqui</a> se não for automático.</p>
</body>
</html>`);
}));

router.get('/slug/:slug', asyncHandler(async (req, res) => {
  const empresa = await prisma.empresa.findUnique({
    where: { slug: req.params.slug.toLowerCase() },
    select: {
      id: true,
      nome: true,
      slug: true,
      empresaAtiva: true,
      telefone: true,
      descricao: true,
      sobre: true,
      endereco: true,
      horarioFuncionamento: true,
      instagramUrl: true,
      facebookUrl: true,
      logoUrl: true,
      taxaEntrega: true,
      corPrimaria: true,
      corSecundaria: true,
      faviconUrl: true,
      heroUsarCarrossel: true,
      heroTitulo: true,
      heroSubtitulo: true,
      heroBadgeLabel: true,
      heroImagemUrl: true,
      heroLinkUrl: true,
      termosConteudo: true,
      googleBusinessReviewUrl: true,
      fidelidadeLogoUrl: true,
      fidelidadeValidadeDias: true,
      fidelidadeAvisoFaltam: true,
      fidelidadeNomeItem: true,
      cashbackPercent: true,
      participaSaltfoodCoins: true,
      saltfoodCoinsPercent: true,
      habilitarFavoritos: true,
      habilitarPedirDeNovo: true,
      habilitarRankingFidelidade: true,
      habilitarAgendamento: true,
      habilitarAvaliacaoComFotos: true,
      habilitarNotificacoesInApp: true,
      habilitarMissoes: true,
      habilitarIndicacaoAvancada: true,
      habilitarAvaliacaoDetalhada: true,
      habilitarCentralSuporte: true,
      pdvHabilitado: true,
      pdvMesaAbertaContinua: true,
      pdvPermiteSplitPagamento: true,
      indicacaoRecompensaUnidades: true,
      aceitaPix: true,
      aceitaDinheiro: true,
      aceitaCartao: true,
      lojaAbertaManual: true,
      usarHorarioAutomatico: true,
      tempoEstimadoMin: true,
      tempoEstimadoMax: true,
      pedidoMinimo: true,
      freteGratisAcimaDe: true,
      horarios: { orderBy: { diaSemana: 'asc' } },
    },
  });

  if (!empresa) {
    return res.status(404).json({ error: 'Empresa não encontrada' });
  }

  const { aberta } = calcularStatusLoja(empresa, empresa.horarios);

  res.json({ ...empresa, abertaAgora: aberta });
}));

/**
 * @openapi
 * /empresas/{id}:
 *   get:
 *     summary: Busca uma empresa pelo id
 *     tags: [Empresas]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Empresa encontrada
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Empresa'
 *       404:
 *         description: Empresa não encontrada
 */
router.get('/:id', requireEmpresaAdmin('id'), asyncHandler(async (req, res) => {
  let empresa = await prisma.empresa.findUnique({ where: { id: req.params.id } });

  if (!empresa) {
    return res.status(404).json({ error: 'Empresa não encontrada' });
  }

  // Empresas cadastradas antes do sistema de indicação de lojas existir não têm código — gera na primeira vez que aparece.
  if (!empresa.codigoIndicacao) {
    empresa = await prisma.empresa.update({
      where: { id: empresa.id },
      data: { codigoIndicacao: await gerarCodigoIndicacaoEmpresaUnico() },
    });
  }

  res.json(serializeEmpresa(empresa));
}));

/**
 * @openapi
 * /empresas:
 *   post:
 *     summary: Cadastra uma nova empresa
 *     tags: [Empresas]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/EmpresaInput'
 *     responses:
 *       201:
 *         description: Empresa criada
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Empresa'
 *       400:
 *         description: Dados inválidos
 *       409:
 *         description: Campo único já cadastrado
 */
router.post('/', requireSuperAdmin, asyncHandler(async (req, res) => {
  const {
    senha, empresaAtiva, adminAtivo, planoId, comissaoPercent, indicadoPor, ehDemo,
  } = req.body;
  const nome = trim(req.body.nome);
  const responsavelNome = trim(req.body.responsavelNome);
  const email = trim(req.body.email);
  const telefone = trim(req.body.telefone);
  const documento = trim(req.body.documento);
  const slug = trim(req.body.slug);
  const usuario = trim(req.body.usuario);

  const erros = validarPayload({ nome, responsavelNome, email, telefone, documento, slug, usuario });
  if (!senha || String(senha).length < 6) {
    erros.push('Campo "senha" é obrigatório e deve ter ao menos 6 caracteres');
  }

  let plano = null;
  if (planoId) {
    plano = await prisma.plano.findUnique({ where: { id: planoId } });
    if (!plano) {
      erros.push('Plano informado não encontrado');
    }
  }

  // Sem plano, o super admin pode definir a comissão avulsa (0 a 30%) já no cadastro.
  let comissaoAvulsa = null;
  if (!planoId && comissaoPercent !== undefined && comissaoPercent !== null && comissaoPercent !== '') {
    const valor = Number(comissaoPercent);
    if (Number.isNaN(valor) || valor < 0 || valor > 30) {
      erros.push('Campo "comissaoPercent" deve estar entre 0 e 30');
    } else {
      comissaoAvulsa = valor;
    }
  }

  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }

  // Código de quem indicou é opcional e silenciosamente ignorado se inválido — mesmo padrão da indicação de cliente.
  let indicadaPorEmpresaId = null;
  if (typeof indicadoPor === 'string' && indicadoPor.trim()) {
    const indicadora = await prisma.empresa.findUnique({ where: { codigoIndicacao: indicadoPor.trim().toUpperCase() } });
    if (indicadora) indicadaPorEmpresaId = indicadora.id;
  }

  const senhaHash = await bcrypt.hash(senha, SALT_ROUNDS);
  const codigoIndicacao = await gerarCodigoIndicacaoEmpresaUnico();

  try {
    const empresa = await prisma.empresa.create({
      data: {
        nome,
        responsavelNome,
        email,
        telefone,
        documento: onlyDigits(documento),
        slug: slug.toLowerCase(),
        usuario,
        senhaHash,
        empresaAtiva: empresaAtiva ?? true,
        adminAtivo: adminAtivo ?? true,
        ehDemo: ehDemo === true,
        codigoIndicacao,
        indicadaPorEmpresaId,
        ...(plano
          ? { planoId: plano.id, comissaoPercent: plano.comissaoPercent }
          : comissaoAvulsa !== null ? { comissaoPercent: comissaoAvulsa } : {}),
      },
    });

    if (plano) {
      await registrarLog({
        tipo: 'ALTERACAO_CRITICA', empresaId: empresa.id, empresaNome: empresa.nome, ator: 'super-admin',
        acao: `Empresa cadastrada já com o plano "${plano.nome}" (comissão ${plano.comissaoPercent}%)`,
      });
    } else if (comissaoAvulsa !== null) {
      await registrarLog({
        tipo: 'ALTERACAO_CRITICA', empresaId: empresa.id, empresaNome: empresa.nome, ator: 'super-admin',
        acao: `Empresa cadastrada sem plano, com comissão avulsa de ${comissaoAvulsa}%`,
      });
    }

    res.status(201).json(serializeEmpresa(empresa));
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{id}:
 *   put:
 *     summary: Atualiza os dados cadastrais de uma empresa (não altera a senha)
 *     tags: [Empresas]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/EmpresaInput'
 *     responses:
 *       200:
 *         description: Empresa atualizada
 *       400:
 *         description: Dados inválidos
 *       404:
 *         description: Empresa não encontrada
 *       409:
 *         description: Campo único já cadastrado
 */
router.put('/:id', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { empresaAtiva, adminAtivo } = req.body;
  const nome = trim(req.body.nome);
  const responsavelNome = trim(req.body.responsavelNome);
  const email = trim(req.body.email);
  const telefone = trim(req.body.telefone);
  const documento = trim(req.body.documento);
  const slug = trim(req.body.slug);
  const usuario = trim(req.body.usuario);

  const erros = validarPayload({ nome, responsavelNome, email, telefone, documento, slug, usuario });
  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }

  try {
    const empresa = await prisma.empresa.update({
      where: { id: req.params.id },
      data: {
        nome,
        responsavelNome,
        email,
        telefone,
        documento: onlyDigits(documento),
        slug: slug.toLowerCase(),
        usuario,
        ...(empresaAtiva !== undefined ? { empresaAtiva } : {}),
        ...(adminAtivo !== undefined ? { adminAtivo } : {}),
      },
    });

    res.json(serializeEmpresa(empresa));
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{id}/status-empresa:
 *   patch:
 *     summary: Ativa ou inativa a empresa
 *     tags: [Empresas]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/StatusInput'
 *     responses:
 *       200:
 *         description: Status atualizado
 *       404:
 *         description: Empresa não encontrada
 */
router.patch('/:id/status-empresa', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { ativo } = req.body;
  if (typeof ativo !== 'boolean') {
    return res.status(400).json({ error: 'Campo "ativo" é obrigatório e deve ser booleano' });
  }

  try {
    const empresa = await prisma.empresa.update({
      where: { id: req.params.id },
      data: { empresaAtiva: ativo },
    });
    await registrarLog({
      tipo: 'ALTERACAO_CRITICA', empresaId: empresa.id, empresaNome: empresa.nome, ator: 'super-admin',
      acao: ativo ? 'Empresa reativada' : 'Empresa bloqueada/desativada',
    });
    res.json(serializeEmpresa(empresa));
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{id}/status-admin:
 *   patch:
 *     summary: Ativa ou inativa o administrador da empresa
 *     tags: [Empresas]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/StatusInput'
 *     responses:
 *       200:
 *         description: Status atualizado
 *       404:
 *         description: Empresa não encontrada
 */
router.patch('/:id/status-admin', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { ativo } = req.body;
  if (typeof ativo !== 'boolean') {
    return res.status(400).json({ error: 'Campo "ativo" é obrigatório e deve ser booleano' });
  }

  try {
    const empresa = await prisma.empresa.update({
      where: { id: req.params.id },
      data: { adminAtivo: ativo },
    });
    await registrarLog({
      tipo: 'ALTERACAO_CRITICA', empresaId: empresa.id, empresaNome: empresa.nome, ator: 'super-admin',
      acao: ativo ? 'Acesso do admin da loja reativado' : 'Acesso do admin da loja bloqueado',
    });
    res.json(serializeEmpresa(empresa));
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{id}/reset-senha:
 *   post:
 *     summary: Redefine a senha do administrador da empresa
 *     tags: [Empresas]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SenhaInput'
 *     responses:
 *       200:
 *         description: Senha redefinida
 *       400:
 *         description: Senha inválida
 *       404:
 *         description: Empresa não encontrada
 */
router.post('/:id/reset-senha', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { senha } = req.body;
  if (!senha || String(senha).length < 6) {
    return res.status(400).json({ error: 'Campo "senha" é obrigatório e deve ter ao menos 6 caracteres' });
  }

  const senhaHash = await bcrypt.hash(senha, SALT_ROUNDS);

  try {
    const empresa = await prisma.empresa.update({
      where: { id: req.params.id },
      data: { senhaHash },
    });
    await registrarLog({
      tipo: 'ALTERACAO_CRITICA', empresaId: empresa.id, empresaNome: empresa.nome, ator: 'super-admin', acao: 'Senha do admin da loja redefinida',
    });
    res.json(serializeEmpresa(empresa));
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{id}:
 *   delete:
 *     summary: Remove uma empresa
 *     tags: [Empresas]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       204:
 *         description: Empresa removida
 *       404:
 *         description: Empresa não encontrada
 */
router.delete('/:id', requireSuperAdmin, asyncHandler(async (req, res) => {
  try {
    await prisma.empresa.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{id}/admin-login:
 *   post:
 *     summary: Login do administrador da empresa (painel /{slug}/admin)
 *     tags: [Empresas]
 *     parameters:
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
 *             required: [usuario, senha]
 *             properties:
 *               usuario: { type: string }
 *               senha: { type: string }
 *     responses:
 *       200:
 *         description: Login válido
 *       401:
 *         description: Usuário ou senha inválidos, ou acesso desativado
 */
router.post('/:id/admin-login', asyncHandler(async (req, res) => {
  const { senha } = req.body;
  const usuario = trim(req.body.usuario);
  if (!usuario || !senha) {
    return res.status(400).json({ error: 'Campos "usuario" e "senha" são obrigatórios' });
  }

  const empresa = await prisma.empresa.findUnique({ where: { id: req.params.id } });
  if (!empresa || empresa.usuario.trim() !== usuario) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  }

  if (!empresa.empresaAtiva || !empresa.adminAtivo) {
    await registrarLog({
      tipo: 'ACESSO', empresaId: empresa.id, empresaNome: empresa.nome, ator: usuario,
      acao: 'Tentativa de login no admin com acesso desativado',
    });
    return res.status(401).json({ error: 'Acesso desativado. Fale com o suporte da plataforma.' });
  }

  const senhaValida = await bcrypt.compare(senha, empresa.senhaHash);
  if (!senhaValida) {
    await registrarLog({
      tipo: 'ACESSO', empresaId: empresa.id, empresaNome: empresa.nome, ator: usuario, acao: 'Login no admin falhou (senha incorreta)',
    });
    return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  }

  await registrarLog({ tipo: 'ACESSO', empresaId: empresa.id, empresaNome: empresa.nome, ator: usuario, acao: 'Login no admin da loja' });
  await prisma.empresa.update({ where: { id: empresa.id }, data: { ultimoAcessoAdminEm: new Date() } });
  const token = signToken({ role: 'EMPRESA_ADMIN', empresaId: empresa.id }, ADMIN_TOKEN_TTL);
  res.json({ id: empresa.id, nome: empresa.nome, usuario: empresa.usuario, token });
}));

/**
 * @openapi
 * /empresas/admin-login:
 *   post:
 *     summary: Login do administrador sem informar a loja previamente — identifica a empresa pelo próprio usuário (usado pelo app mobile)
 *     tags: [Empresas]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [usuario, senha]
 *             properties:
 *               usuario: { type: string }
 *               senha: { type: string }
 *     responses:
 *       200:
 *         description: Login válido — retorna a sessão do admin já com os dados da loja vinculada (incluindo slug)
 *       401:
 *         description: Usuário ou senha inválidos, ou acesso desativado
 */
router.post('/admin-login', asyncHandler(async (req, res) => {
  const { senha } = req.body;
  const usuario = trim(req.body.usuario);
  if (!usuario || !senha) {
    return res.status(400).json({ error: 'Campos "usuario" e "senha" são obrigatórios' });
  }

  const empresa = await prisma.empresa.findUnique({ where: { usuario } });
  if (!empresa) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  }

  if (!empresa.empresaAtiva || !empresa.adminAtivo) {
    await registrarLog({
      tipo: 'ACESSO', empresaId: empresa.id, empresaNome: empresa.nome, ator: usuario,
      acao: 'Tentativa de login no admin com acesso desativado',
    });
    return res.status(401).json({ error: 'Acesso desativado. Fale com o suporte da plataforma.' });
  }

  const senhaValida = await bcrypt.compare(senha, empresa.senhaHash);
  if (!senhaValida) {
    await registrarLog({
      tipo: 'ACESSO', empresaId: empresa.id, empresaNome: empresa.nome, ator: usuario, acao: 'Login no admin falhou (senha incorreta)',
    });
    return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  }

  await registrarLog({ tipo: 'ACESSO', empresaId: empresa.id, empresaNome: empresa.nome, ator: usuario, acao: 'Login no admin da loja (app)' });
  await prisma.empresa.update({ where: { id: empresa.id }, data: { ultimoAcessoAdminEm: new Date() } });
  const token = signToken({ role: 'EMPRESA_ADMIN', empresaId: empresa.id }, ADMIN_TOKEN_TTL);
  res.json({
    id: empresa.id,
    nome: empresa.nome,
    usuario: empresa.usuario,
    slug: empresa.slug,
    corPrimaria: empresa.corPrimaria,
    corSecundaria: empresa.corSecundaria,
    logoUrl: empresa.logoUrl,
    pdvHabilitado: empresa.pdvHabilitado,
    pdvMesaAbertaContinua: empresa.pdvMesaAbertaContinua,
    pdvPermiteSplitPagamento: empresa.pdvPermiteSplitPagamento,
    impressoraNome: empresa.impressoraNome,
    impressoraMacAddress: empresa.impressoraMacAddress,
    token,
  });
}));

/**
 * @openapi
 * /empresas/{id}/comissao:
 *   patch:
 *     summary: Define o percentual de comissão da plataforma sobre as vendas desta empresa (5 a 20%)
 *     tags: [Empresas]
 *     parameters:
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
 *             required: [comissaoPercent]
 *             properties:
 *               comissaoPercent: { type: number, minimum: 0, maximum: 30 }
 *     responses:
 *       200:
 *         description: Comissão atualizada
 *       400:
 *         description: Valor fora do intervalo permitido
 *       404:
 *         description: Empresa não encontrada
 */
router.patch('/:id/comissao', requireSuperAdmin, asyncHandler(async (req, res) => {
  const valor = Number(req.body.comissaoPercent);
  if (Number.isNaN(valor) || valor < 0 || valor > 30) {
    return res.status(400).json({ error: 'O percentual de comissão deve estar entre 0 e 30' });
  }

  try {
    const empresa = await prisma.empresa.update({
      where: { id: req.params.id },
      data: { comissaoPercent: valor },
    });
    await registrarLog({
      tipo: 'ALTERACAO_CRITICA', empresaId: empresa.id, empresaNome: empresa.nome, ator: 'super-admin',
      acao: `Comissão alterada para ${valor}%`,
    });
    res.json(serializeEmpresa(empresa));
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{id}/saltfood-coins:
 *   patch:
 *     summary: Liga/desliga a participação da empresa no SaltFood Coins (carteira de fidelidade entre lojas) e define o percentual — só o Super Admin controla, diferente das demais funcionalidades opt-in do próprio lojista
 *     tags: [Empresas]
 *     parameters:
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
 *             required: [participaSaltfoodCoins]
 *             properties:
 *               participaSaltfoodCoins: { type: boolean }
 *               saltfoodCoinsPercent: { type: number, nullable: true }
 *     responses:
 *       200:
 *         description: Configuração atualizada
 *       400:
 *         description: Dados inválidos
 *       404:
 *         description: Empresa não encontrada
 */
router.patch('/:id/saltfood-coins', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { participaSaltfoodCoins, saltfoodCoinsPercent } = req.body;

  if (typeof participaSaltfoodCoins !== 'boolean') {
    return res.status(400).json({ error: 'Campo "participaSaltfoodCoins" é obrigatório e deve ser booleano' });
  }
  let percentValor = null;
  if (saltfoodCoinsPercent !== undefined && saltfoodCoinsPercent !== null && saltfoodCoinsPercent !== '') {
    percentValor = Number(saltfoodCoinsPercent);
    if (Number.isNaN(percentValor) || percentValor < 0 || percentValor > 100) {
      return res.status(400).json({ error: 'O percentual de SaltFood Coins deve estar entre 0 e 100' });
    }
  }

  try {
    const empresa = await prisma.empresa.update({
      where: { id: req.params.id },
      data: { participaSaltfoodCoins, saltfoodCoinsPercent: percentValor },
    });
    await registrarLog({
      tipo: 'ALTERACAO_CRITICA', empresaId: empresa.id, empresaNome: empresa.nome, ator: 'super-admin',
      acao: `SaltFood Coins ${participaSaltfoodCoins ? 'ativado' : 'desativado'}${percentValor != null ? ` (${percentValor}%)` : ''}`,
    });
    res.json(serializeEmpresa(empresa));
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{id}/comissao-visibilidade:
 *   patch:
 *     summary: Mostra ou oculta o card "Comissão da plataforma" no CRM do próprio tenant
 *     tags: [Empresas]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ocultarComissaoTenant]
 *             properties:
 *               ocultarComissaoTenant: { type: boolean }
 *     responses:
 *       200:
 *         description: Visibilidade atualizada
 *       404:
 *         description: Empresa não encontrada
 */
router.patch('/:id/comissao-visibilidade', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { ocultarComissaoTenant } = req.body;
  if (typeof ocultarComissaoTenant !== 'boolean') {
    return res.status(400).json({ error: 'Campo "ocultarComissaoTenant" é obrigatório e deve ser booleano' });
  }

  try {
    const empresa = await prisma.empresa.update({
      where: { id: req.params.id },
      data: { ocultarComissaoTenant },
    });
    await registrarLog({
      tipo: 'ALTERACAO_CRITICA', empresaId: empresa.id, empresaNome: empresa.nome, ator: 'super-admin',
      acao: `Comissão da plataforma ${ocultarComissaoTenant ? 'ocultada' : 'exibida'} para o lojista`,
    });
    res.json(serializeEmpresa(empresa));
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{id}/plano:
 *   patch:
 *     summary: Atribui (ou remove) o plano de assinatura da empresa; ao atribuir, sincroniza a comissão com a do plano
 *     tags: [Empresas]
 *     parameters:
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
 *               planoId: { type: string, format: uuid, nullable: true }
 *     responses:
 *       200:
 *         description: Plano atribuído
 *       404:
 *         description: Empresa ou plano não encontrado
 */
router.patch('/:id/plano', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { planoId } = req.body;

  if (!planoId) {
    try {
      const empresa = await prisma.empresa.update({ where: { id: req.params.id }, data: { planoId: null } });
      return res.json(serializeEmpresa(empresa));
    } catch (error) {
      return handlePrismaError(error, res);
    }
  }

  const plano = await prisma.plano.findUnique({ where: { id: planoId } });
  if (!plano) {
    return res.status(404).json({ error: 'Plano não encontrado' });
  }

  try {
    const empresa = await prisma.empresa.update({
      where: { id: req.params.id },
      data: {
        planoId: plano.id,
        comissaoPercent: plano.comissaoPercent,
        ...Object.fromEntries(CAMPOS_FUNCIONALIDADES.map((campo) => [campo, plano[campo]])),
      },
    });
    await registrarLog({
      tipo: 'ALTERACAO_CRITICA', empresaId: empresa.id, empresaNome: empresa.nome, ator: 'super-admin',
      acao: `Plano "${plano.nome}" atribuído (comissão e funcionalidades sincronizadas com o pacote do plano)`,
    });
    res.json(serializeEmpresa(empresa));
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{id}/loja-aberta:
 *   patch:
 *     summary: Botão de emergência — abre ou fecha a loja manualmente, independente do horário automático
 *     tags: [Empresas]
 *     parameters:
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
 *             required: [aberta]
 *             properties:
 *               aberta: { type: boolean }
 *     responses:
 *       200:
 *         description: Status atualizado
 *       404:
 *         description: Empresa não encontrada
 */
router.patch('/:id/loja-aberta', requireEmpresaAdmin('id'), asyncHandler(async (req, res) => {
  const { aberta } = req.body;
  if (typeof aberta !== 'boolean') {
    return res.status(400).json({ error: 'Campo "aberta" é obrigatório e deve ser booleano' });
  }

  try {
    const empresa = await prisma.empresa.update({
      where: { id: req.params.id },
      data: { lojaAbertaManual: aberta },
    });
    res.json(serializeEmpresa(empresa));
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{id}/operacional:
 *   put:
 *     summary: Atualiza as configurações operacionais (horário automático, tempo estimado, pedido mínimo)
 *     tags: [Empresas]
 *     parameters:
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
 *             properties:
 *               usarHorarioAutomatico: { type: boolean }
 *               tempoEstimadoMin: { type: integer, nullable: true }
 *               tempoEstimadoMax: { type: integer, nullable: true }
 *               pedidoMinimo: { type: number }
 *     responses:
 *       200:
 *         description: Configurações atualizadas
 *       400:
 *         description: Dados inválidos
 *       404:
 *         description: Empresa não encontrada
 */
router.put('/:id/operacional', requireEmpresaAdmin('id'), asyncHandler(async (req, res) => {
  const { usarHorarioAutomatico, tempoEstimadoMin, tempoEstimadoMax, pedidoMinimo } = req.body;

  const erros = [];
  if (pedidoMinimo !== undefined && (Number.isNaN(Number(pedidoMinimo)) || Number(pedidoMinimo) < 0)) {
    erros.push('Campo "pedidoMinimo" deve ser maior ou igual a zero');
  }
  if (tempoEstimadoMin !== undefined && tempoEstimadoMin !== null && (!Number.isInteger(Number(tempoEstimadoMin)) || Number(tempoEstimadoMin) < 0)) {
    erros.push('Campo "tempoEstimadoMin" deve ser um inteiro maior ou igual a zero');
  }
  if (tempoEstimadoMax !== undefined && tempoEstimadoMax !== null && (!Number.isInteger(Number(tempoEstimadoMax)) || Number(tempoEstimadoMax) < 0)) {
    erros.push('Campo "tempoEstimadoMax" deve ser um inteiro maior ou igual a zero');
  }
  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }

  try {
    const empresa = await prisma.empresa.update({
      where: { id: req.params.id },
      data: {
        ...(usarHorarioAutomatico !== undefined ? { usarHorarioAutomatico } : {}),
        ...(tempoEstimadoMin !== undefined ? { tempoEstimadoMin: tempoEstimadoMin === null ? null : Number(tempoEstimadoMin) } : {}),
        ...(tempoEstimadoMax !== undefined ? { tempoEstimadoMax: tempoEstimadoMax === null ? null : Number(tempoEstimadoMax) } : {}),
        ...(pedidoMinimo !== undefined ? { pedidoMinimo: Number(pedidoMinimo) } : {}),
      },
    });
    res.json(serializeEmpresa(empresa));
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{id}/pdv-config:
 *   put:
 *     summary: Autoatendimento — o próprio lojista escolhe como o PDV se comporta na loja dele (mesa aberta contínua, split de pagamento). pdvHabilitado em si é governado só pelo Super Admin via Planos/Funcionalidades.
 *     tags: [Empresas]
 *     parameters:
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
 *             properties:
 *               pdvMesaAbertaContinua: { type: boolean }
 *               pdvPermiteSplitPagamento: { type: boolean }
 *     responses:
 *       200:
 *         description: Configuração atualizada
 *       404:
 *         description: Empresa não encontrada
 */
router.put('/:id/pdv-config', requireEmpresaAdmin('id'), asyncHandler(async (req, res) => {
  const { pdvMesaAbertaContinua, pdvPermiteSplitPagamento } = req.body;

  if (pdvMesaAbertaContinua !== undefined && typeof pdvMesaAbertaContinua !== 'boolean') {
    return res.status(400).json({ error: 'Campo "pdvMesaAbertaContinua" deve ser booleano' });
  }
  if (pdvPermiteSplitPagamento !== undefined && typeof pdvPermiteSplitPagamento !== 'boolean') {
    return res.status(400).json({ error: 'Campo "pdvPermiteSplitPagamento" deve ser booleano' });
  }

  try {
    const empresa = await prisma.empresa.update({
      where: { id: req.params.id },
      data: {
        ...(pdvMesaAbertaContinua !== undefined ? { pdvMesaAbertaContinua } : {}),
        ...(pdvPermiteSplitPagamento !== undefined ? { pdvPermiteSplitPagamento } : {}),
      },
    });
    res.json(serializeEmpresa(empresa));
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{id}/formas-pagamento:
 *   put:
 *     summary: O próprio lojista escolhe quais formas de pagamento aceita no checkout do storefront (Pix, dinheiro, cartão na entrega)
 *     tags: [Empresas]
 *     parameters:
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
 *             properties:
 *               aceitaPix: { type: boolean }
 *               aceitaDinheiro: { type: boolean }
 *               aceitaCartao: { type: boolean }
 *     responses:
 *       200:
 *         description: Configuração atualizada
 *       400:
 *         description: Dados inválidos
 *       404:
 *         description: Empresa não encontrada
 */
router.put('/:id/formas-pagamento', requireEmpresaAdmin('id'), asyncHandler(async (req, res) => {
  const { aceitaPix, aceitaDinheiro, aceitaCartao } = req.body;

  for (const [campo, valor] of Object.entries({ aceitaPix, aceitaDinheiro, aceitaCartao })) {
    if (valor !== undefined && typeof valor !== 'boolean') {
      return res.status(400).json({ error: `Campo "${campo}" deve ser booleano` });
    }
  }

  const existente = await prisma.empresa.findUnique({ where: { id: req.params.id }, select: { aceitaPix: true, aceitaDinheiro: true, aceitaCartao: true } });
  if (!existente) {
    return res.status(404).json({ error: 'Empresa não encontrada' });
  }
  const resultado = {
    aceitaPix: aceitaPix !== undefined ? aceitaPix : existente.aceitaPix,
    aceitaDinheiro: aceitaDinheiro !== undefined ? aceitaDinheiro : existente.aceitaDinheiro,
    aceitaCartao: aceitaCartao !== undefined ? aceitaCartao : existente.aceitaCartao,
  };
  if (!resultado.aceitaPix && !resultado.aceitaDinheiro && !resultado.aceitaCartao) {
    return res.status(400).json({ error: 'Pelo menos uma forma de pagamento precisa ficar ativa' });
  }

  try {
    const empresa = await prisma.empresa.update({ where: { id: req.params.id }, data: resultado });
    registrarAtividadeLoja({
      empresaId: req.params.id,
      tipo: 'CONFIG_PAGAMENTO_ALTERADA',
      ator: 'Admin',
      descricao: `Formas de pagamento atualizadas (PIX: ${resultado.aceitaPix ? 'sim' : 'não'}, Dinheiro: ${resultado.aceitaDinheiro ? 'sim' : 'não'}, Cartão: ${resultado.aceitaCartao ? 'sim' : 'não'})`,
    });
    res.json(serializeEmpresa(empresa));
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{id}/impressora-config:
 *   put:
 *     summary: Sincroniza a impressora térmica Bluetooth configurada no app do lojista — o pareamento em si só acontece no aparelho; este endpoint só espelha nome/MAC pro admin web ter visibilidade e poder resetar remotamente (envie null nos dois campos pra limpar)
 *     tags: [Empresas]
 *     parameters:
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
 *             properties:
 *               nome: { type: string, nullable: true }
 *               macAddress: { type: string, nullable: true }
 *     responses:
 *       200:
 *         description: Configuração atualizada
 *       400:
 *         description: Dados inválidos
 *       404:
 *         description: Empresa não encontrada
 */
router.put('/:id/impressora-config', requireEmpresaAdmin('id'), asyncHandler(async (req, res) => {
  const { nome, macAddress } = req.body;

  if (nome !== undefined && nome !== null && typeof nome !== 'string') {
    return res.status(400).json({ error: 'Campo "nome" deve ser texto ou null' });
  }
  if (macAddress !== undefined && macAddress !== null && typeof macAddress !== 'string') {
    return res.status(400).json({ error: 'Campo "macAddress" deve ser texto ou null' });
  }

  try {
    const empresa = await prisma.empresa.update({
      where: { id: req.params.id },
      data: {
        ...(nome !== undefined ? { impressoraNome: nome } : {}),
        ...(macAddress !== undefined ? { impressoraMacAddress: macAddress } : {}),
      },
    });
    res.json(serializeEmpresa(empresa));
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{id}/dados-contato:
 *   patch:
 *     summary: A própria loja atualiza seus dados de contato (nome do responsável, e-mail, telefone) — nome da loja, CNPJ/CPF, slug e usuário de login continuam só o Super Admin alterando
 *     tags: [Empresas]
 *     parameters:
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
 *               responsavelNome: { type: string }
 *               email: { type: string }
 *               telefone: { type: string }
 *     responses:
 *       200:
 *         description: Dados atualizados
 *       400:
 *         description: Dados inválidos
 */
router.patch('/:id/dados-contato', requireEmpresaAdmin('id'), asyncHandler(async (req, res) => {
  const { responsavelNome, email, telefone } = req.body;
  const data = {};
  if (responsavelNome !== undefined) {
    if (!String(responsavelNome).trim()) return res.status(400).json({ error: 'Campo "responsavelNome" não pode ficar vazio' });
    data.responsavelNome = String(responsavelNome).trim();
  }
  if (email !== undefined) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Campo "email" inválido' });
    data.email = String(email).trim();
  }
  if (telefone !== undefined) {
    const digitos = String(telefone).replace(/\D/g, '');
    if (digitos.length < 10) return res.status(400).json({ error: 'Campo "telefone" incompleto' });
    data.telefone = digitos;
  }

  try {
    const empresa = await prisma.empresa.update({ where: { id: req.params.id }, data });
    res.json(serializeEmpresa(empresa));
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{id}/frete-config:
 *   put:
 *     summary: Define o valor de frete grátis acima de X reais (as taxas por bairro ficam em /zonas-entrega)
 *     tags: [Empresas]
 *     parameters:
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
 *               freteGratisAcimaDe: { type: number, nullable: true }
 *     responses:
 *       200:
 *         description: Configuração atualizada
 *       404:
 *         description: Empresa não encontrada
 */
router.put('/:id/frete-config', requireEmpresaAdmin('id'), asyncHandler(async (req, res) => {
  const { freteGratisAcimaDe } = req.body;

  if (freteGratisAcimaDe !== undefined && freteGratisAcimaDe !== null && (Number.isNaN(Number(freteGratisAcimaDe)) || Number(freteGratisAcimaDe) < 0)) {
    return res.status(400).json({ error: 'Campo "freteGratisAcimaDe" deve ser maior ou igual a zero' });
  }

  try {
    const empresa = await prisma.empresa.update({
      where: { id: req.params.id },
      data: { freteGratisAcimaDe: freteGratisAcimaDe === null || freteGratisAcimaDe === '' ? null : Number(freteGratisAcimaDe) },
    });
    res.json(serializeEmpresa(empresa));
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{id}/fidelidade-config:
 *   put:
 *     summary: Atualiza as configurações do programa de fidelidade (logo, prazo de resgate, aviso e nome do item)
 *     tags: [Empresas]
 *     parameters:
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
 *               fidelidadeMetodo: { type: string, enum: [CARIMBO, PONTOS] }
 *               fidelidadeAtiva: { type: boolean }
 *               fidelidadeNomePrograma: { type: string, nullable: true }
 *               fidelidadeLogoUrl: { type: string, nullable: true }
 *               fidelidadeValidadeDias: { type: integer, nullable: true }
 *               fidelidadeAvisoFaltam: { type: integer, nullable: true }
 *               fidelidadeNomeItem: { type: string, nullable: true }
 *               fidelidadeTermos: { type: string, nullable: true }
 *               fidelidadeLimitePrata: { type: integer }
 *               fidelidadeLimiteOuro: { type: integer }
 *               pontosNomeMoeda: { type: string, nullable: true }
 *               pontosPorReal: { type: number, nullable: true }
 *               pontosValidadeMeses: { type: integer, nullable: true }
 *               pontosResgateMinimo: { type: integer, nullable: true }
 *               pontosValorReal: { type: number, nullable: true }
 *               cashbackPercent: { type: number, nullable: true }
 *               indicacaoRecompensaUnidades: { type: integer }
 *     responses:
 *       200:
 *         description: Configuração atualizada
 *       400:
 *         description: Dados inválidos
 *       404:
 *         description: Empresa não encontrada
 */
router.put('/:id/fidelidade-config', requireEmpresaAdmin('id'), asyncHandler(async (req, res) => {
  const {
    fidelidadeMetodo, fidelidadeAtiva, fidelidadeNomePrograma, fidelidadeLogoUrl, fidelidadeValidadeDias,
    fidelidadeAvisoFaltam, fidelidadeNomeItem, fidelidadeTermos, fidelidadeLimitePrata, fidelidadeLimiteOuro,
    pontosNomeMoeda, pontosPorReal, pontosValidadeMeses, pontosResgateMinimo, pontosValorReal, cashbackPercent,
    indicacaoRecompensaUnidades,
  } = req.body;

  const erros = [];
  if (fidelidadeMetodo !== undefined && !['CARIMBO', 'PONTOS'].includes(fidelidadeMetodo)) {
    erros.push('Campo "fidelidadeMetodo" deve ser um de: CARIMBO, PONTOS');
  }
  if (fidelidadeValidadeDias !== undefined && fidelidadeValidadeDias !== null && fidelidadeValidadeDias !== '') {
    if (!Number.isInteger(Number(fidelidadeValidadeDias)) || Number(fidelidadeValidadeDias) < 1) {
      erros.push('Campo "fidelidadeValidadeDias" deve ser um inteiro maior ou igual a 1');
    }
  }
  if (fidelidadeAvisoFaltam !== undefined && fidelidadeAvisoFaltam !== null && fidelidadeAvisoFaltam !== '') {
    const valor = Number(fidelidadeAvisoFaltam);
    if (!Number.isInteger(valor) || valor < 1 || valor > 9) {
      erros.push('Campo "fidelidadeAvisoFaltam" deve ser um inteiro entre 1 e 9');
    }
  }
  if (fidelidadeLimitePrata !== undefined && (!Number.isInteger(Number(fidelidadeLimitePrata)) || Number(fidelidadeLimitePrata) < 1)) {
    erros.push('Campo "fidelidadeLimitePrata" deve ser um inteiro maior ou igual a 1');
  }
  if (fidelidadeLimiteOuro !== undefined && (!Number.isInteger(Number(fidelidadeLimiteOuro)) || Number(fidelidadeLimiteOuro) <= Number(fidelidadeLimitePrata ?? 0))) {
    erros.push('Campo "fidelidadeLimiteOuro" deve ser um inteiro maior que o limite de Prata');
  }
  if (pontosPorReal !== undefined && pontosPorReal !== null && pontosPorReal !== '' && (Number.isNaN(Number(pontosPorReal)) || Number(pontosPorReal) <= 0)) {
    erros.push('Campo "pontosPorReal" deve ser um número maior que zero');
  }
  if (pontosValidadeMeses !== undefined && pontosValidadeMeses !== null && pontosValidadeMeses !== '') {
    if (!Number.isInteger(Number(pontosValidadeMeses)) || Number(pontosValidadeMeses) < 1) {
      erros.push('Campo "pontosValidadeMeses" deve ser um inteiro maior ou igual a 1');
    }
  }
  if (pontosResgateMinimo !== undefined && pontosResgateMinimo !== null && pontosResgateMinimo !== '') {
    if (!Number.isInteger(Number(pontosResgateMinimo)) || Number(pontosResgateMinimo) < 1) {
      erros.push('Campo "pontosResgateMinimo" deve ser um inteiro maior ou igual a 1');
    }
  }
  if (pontosValorReal !== undefined && pontosValorReal !== null && pontosValorReal !== '' && (Number.isNaN(Number(pontosValorReal)) || Number(pontosValorReal) <= 0)) {
    erros.push('Campo "pontosValorReal" deve ser um número maior que zero');
  }
  if (cashbackPercent !== undefined && cashbackPercent !== null && cashbackPercent !== '') {
    const valor = Number(cashbackPercent);
    if (Number.isNaN(valor) || valor < 0 || valor > 100) {
      erros.push('Campo "cashbackPercent" deve ser um número entre 0 e 100');
    }
  }
  if (indicacaoRecompensaUnidades !== undefined && (!Number.isInteger(Number(indicacaoRecompensaUnidades)) || Number(indicacaoRecompensaUnidades) < 1)) {
    erros.push('Campo "indicacaoRecompensaUnidades" deve ser um inteiro maior que zero');
  }
  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }

  try {
    const empresa = await prisma.empresa.update({
      where: { id: req.params.id },
      data: {
        ...(fidelidadeMetodo !== undefined ? { fidelidadeMetodo } : {}),
        ...(indicacaoRecompensaUnidades !== undefined ? { indicacaoRecompensaUnidades: Number(indicacaoRecompensaUnidades) } : {}),
        ...(fidelidadeAtiva !== undefined ? { fidelidadeAtiva: Boolean(fidelidadeAtiva) } : {}),
        ...(fidelidadeNomePrograma !== undefined ? { fidelidadeNomePrograma: fidelidadeNomePrograma || null } : {}),
        ...(fidelidadeLogoUrl !== undefined ? { fidelidadeLogoUrl: fidelidadeLogoUrl || null } : {}),
        ...(fidelidadeValidadeDias !== undefined
          ? { fidelidadeValidadeDias: fidelidadeValidadeDias === null || fidelidadeValidadeDias === '' ? null : Number(fidelidadeValidadeDias) }
          : {}),
        ...(fidelidadeAvisoFaltam !== undefined
          ? { fidelidadeAvisoFaltam: fidelidadeAvisoFaltam === null || fidelidadeAvisoFaltam === '' ? null : Number(fidelidadeAvisoFaltam) }
          : {}),
        ...(fidelidadeNomeItem !== undefined ? { fidelidadeNomeItem: fidelidadeNomeItem || null } : {}),
        ...(fidelidadeTermos !== undefined ? { fidelidadeTermos: fidelidadeTermos || null } : {}),
        ...(fidelidadeLimitePrata !== undefined ? { fidelidadeLimitePrata: Number(fidelidadeLimitePrata) } : {}),
        ...(fidelidadeLimiteOuro !== undefined ? { fidelidadeLimiteOuro: Number(fidelidadeLimiteOuro) } : {}),
        ...(pontosNomeMoeda !== undefined ? { pontosNomeMoeda: pontosNomeMoeda || null } : {}),
        ...(pontosPorReal !== undefined
          ? { pontosPorReal: pontosPorReal === null || pontosPorReal === '' ? null : Number(pontosPorReal) }
          : {}),
        ...(pontosValidadeMeses !== undefined
          ? { pontosValidadeMeses: pontosValidadeMeses === null || pontosValidadeMeses === '' ? null : Number(pontosValidadeMeses) }
          : {}),
        ...(pontosResgateMinimo !== undefined
          ? { pontosResgateMinimo: pontosResgateMinimo === null || pontosResgateMinimo === '' ? null : Number(pontosResgateMinimo) }
          : {}),
        ...(pontosValorReal !== undefined
          ? { pontosValorReal: pontosValorReal === null || pontosValorReal === '' ? null : Number(pontosValorReal) }
          : {}),
        ...(cashbackPercent !== undefined
          ? { cashbackPercent: cashbackPercent === null || cashbackPercent === '' ? null : Number(cashbackPercent) }
          : {}),
      },
    });
    res.json(serializeEmpresa(empresa));
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

/**
 * @openapi
 * /empresas/{id}/funcionalidades-config:
 *   put:
 *     summary: Liga/desliga funcionalidades opcionais da loja (favoritos, agendamento, notificações in-app etc.) — exceção pontual numa loja específica, fora do pacote do plano dela. Só o Super Admin.
 *     tags: [Empresas]
 *     parameters:
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
 *               habilitarFavoritos: { type: boolean }
 *               habilitarPedirDeNovo: { type: boolean }
 *               habilitarRankingFidelidade: { type: boolean }
 *               habilitarAgendamento: { type: boolean }
 *               habilitarAvaliacaoComFotos: { type: boolean }
 *               habilitarNotificacoesInApp: { type: boolean }
 *               habilitarMissoes: { type: boolean }
 *               habilitarIndicacaoAvancada: { type: boolean }
 *               habilitarAvaliacaoDetalhada: { type: boolean }
 *               habilitarCentralSuporte: { type: boolean }
 *               indicacaoRecompensaUnidades: { type: integer }
 *     responses:
 *       200:
 *         description: Configuração atualizada
 *       400:
 *         description: Dados inválidos
 *       404:
 *         description: Empresa não encontrada
 */
router.put('/:id/funcionalidades-config', requireSuperAdmin, asyncHandler(async (req, res) => {
  const data = {};
  const camposAlterados = [];
  for (const campo of CAMPOS_FUNCIONALIDADES) {
    if (req.body[campo] !== undefined) {
      if (typeof req.body[campo] !== 'boolean') {
        return res.status(400).json({ error: `Campo "${campo}" deve ser booleano` });
      }
      data[campo] = req.body[campo];
      camposAlterados.push(`${campo}=${req.body[campo]}`);
    }
  }
  if (req.body.indicacaoRecompensaUnidades !== undefined) {
    const valor = Number(req.body.indicacaoRecompensaUnidades);
    if (!Number.isInteger(valor) || valor < 1) {
      return res.status(400).json({ error: 'Campo "indicacaoRecompensaUnidades" deve ser um inteiro maior que zero' });
    }
    data.indicacaoRecompensaUnidades = valor;
    camposAlterados.push(`indicacaoRecompensaUnidades=${valor}`);
  }

  try {
    const empresa = await prisma.empresa.update({ where: { id: req.params.id }, data });
    await registrarLog({
      tipo: 'ALTERACAO_CRITICA', empresaId: empresa.id, empresaNome: empresa.nome, ator: 'super-admin',
      acao: `Funcionalidades ajustadas manualmente (exceção ao plano): ${camposAlterados.join(', ') || 'nenhum campo enviado'}`,
    });
    res.json(serializeEmpresa(empresa));
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

/**
 * @openapi
 * /empresas/{id}/aparencia:
 *   put:
 *     summary: Atualiza a aparência da loja (cores, logo, favicon e configuração do Hero)
 *     tags: [Empresas]
 *     parameters:
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
 *             properties:
 *               corPrimaria: { type: string, example: "#f97316" }
 *               corSecundaria: { type: string, example: "#dc2626" }
 *               logoUrl: { type: string }
 *               faviconUrl: { type: string }
 *               heroUsarCarrossel: { type: boolean }
 *               heroTitulo: { type: string }
 *               heroSubtitulo: { type: string }
 *               heroBadgeLabel: { type: string }
 *               heroImagemUrl: { type: string }
 *               heroLinkUrl: { type: string }
 *     responses:
 *       200:
 *         description: Aparência atualizada
 *       400:
 *         description: Dados inválidos
 *       404:
 *         description: Empresa não encontrada
 */
router.put('/:id/aparencia', requireEmpresaAdmin('id'), asyncHandler(async (req, res) => {
  const {
    corPrimaria, corSecundaria, logoUrl, faviconUrl,
    heroUsarCarrossel, heroTitulo, heroSubtitulo, heroBadgeLabel, heroImagemUrl, heroLinkUrl,
    termosConteudo, googleBusinessReviewUrl,
  } = req.body;

  const erros = [];
  if (corPrimaria !== undefined && !HEX_COLOR_REGEX.test(corPrimaria)) erros.push('Cor primária deve ser um hex válido (ex: #f97316)');
  if (corSecundaria !== undefined && !HEX_COLOR_REGEX.test(corSecundaria)) erros.push('Cor secundária deve ser um hex válido (ex: #dc2626)');
  if (erros.length) {
    return res.status(400).json({ error: erros.join('; ') });
  }

  try {
    const empresa = await prisma.empresa.update({
      where: { id: req.params.id },
      data: {
        ...(corPrimaria !== undefined ? { corPrimaria } : {}),
        ...(corSecundaria !== undefined ? { corSecundaria } : {}),
        ...(logoUrl !== undefined ? { logoUrl: logoUrl || null } : {}),
        ...(faviconUrl !== undefined ? { faviconUrl: faviconUrl || null } : {}),
        ...(heroUsarCarrossel !== undefined ? { heroUsarCarrossel } : {}),
        ...(heroTitulo !== undefined ? { heroTitulo: heroTitulo || null } : {}),
        ...(heroSubtitulo !== undefined ? { heroSubtitulo: heroSubtitulo || null } : {}),
        ...(heroBadgeLabel !== undefined ? { heroBadgeLabel: heroBadgeLabel || null } : {}),
        ...(heroImagemUrl !== undefined ? { heroImagemUrl: heroImagemUrl || null } : {}),
        ...(heroLinkUrl !== undefined ? { heroLinkUrl: heroLinkUrl || null } : {}),
        ...(termosConteudo !== undefined ? { termosConteudo: termosConteudo || null } : {}),
        ...(googleBusinessReviewUrl !== undefined ? { googleBusinessReviewUrl: googleBusinessReviewUrl || null } : {}),
      },
    });
    res.json(serializeEmpresa(empresa));
  } catch (error) {
    return handlePrismaError(error, res);
  }
}));

module.exports = router;
