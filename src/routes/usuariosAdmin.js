const { Router } = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const loadEmpresa = require('../lib/loadEmpresa');
const { signToken, requireEmpresaAdmin } = require('../lib/auth');
const { registrarAtividadeLoja } = require('../lib/atividadeLoja');

const router = Router({ mergeParams: true });

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const SALT_ROUNDS = 10;
const USUARIO_ADMIN_TOKEN_TTL = '8h';
const PAPEIS_VALIDOS = ['GERENTE', 'OPERADOR_CAIXA', 'ATENDENTE'];

router.use(loadEmpresa);

/** Nunca devolve o hash da senha. */
const serializeUsuario = (usuario) => {
  const { senhaHash, ...rest } = usuario;
  return rest;
};

/**
 * Só o login master (token sem usuarioAdminId) pode gerenciar usuários — um usuário secundário
 * não pode criar/editar/remover outros usuários, mesmo sendo papel GERENTE. Mantém a gestão de
 * acesso centralizada em quem sempre teve controle total da loja.
 */
const requireLoginMaster = (req, res, next) => {
  if (req.auth.usuarioAdminId) {
    return res.status(403).json({ error: 'Só o login principal da loja pode gerenciar usuários' });
  }
  next();
};

/**
 * @openapi
 * /empresas/{empresaId}/usuarios-admin/login:
 *   post:
 *     summary: Login de um usuário secundário da loja (papel GERENTE/OPERADOR_CAIXA/ATENDENTE) — aditivo ao login master, que continua funcionando normalmente
 *     tags: [Sistema]
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
 *         description: E-mail ou senha inválidos, ou usuário desativado
 */
router.post('/login', asyncHandler(async (req, res) => {
  const { senha } = req.body;
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email || !senha) {
    return res.status(400).json({ error: 'Campos "email" e "senha" são obrigatórios' });
  }
  if (!req.empresa.empresaAtiva) {
    return res.status(401).json({ error: 'Acesso desativado. Fale com o suporte da plataforma.' });
  }

  const usuario = await prisma.usuarioAdmin.findFirst({
    where: { empresaId: req.params.empresaId, email },
  });
  if (!usuario || !usuario.ativo) {
    return res.status(401).json({ error: 'E-mail ou senha inválidos' });
  }
  const senhaValida = await bcrypt.compare(senha, usuario.senhaHash);
  if (!senhaValida) {
    return res.status(401).json({ error: 'E-mail ou senha inválidos' });
  }

  const token = signToken(
    { role: 'EMPRESA_ADMIN', empresaId: req.params.empresaId, usuarioAdminId: usuario.id, papel: usuario.papel },
    USUARIO_ADMIN_TOKEN_TTL
  );
  res.json({ ...serializeUsuario(usuario), token });
}));

/**
 * @openapi
 * /empresas/{empresaId}/usuarios-admin:
 *   get:
 *     summary: Lista os usuários secundários da loja (só o login master vê)
 *     tags: [Sistema]
 *     parameters:
 *       - in: path
 *         name: empresaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Lista de usuários
 */
router.get('/', requireEmpresaAdmin(), requireLoginMaster, asyncHandler(async (req, res) => {
  const usuarios = await prisma.usuarioAdmin.findMany({
    where: { empresaId: req.params.empresaId },
    orderBy: { nome: 'asc' },
  });
  res.json(usuarios.map(serializeUsuario));
}));

/**
 * @openapi
 * /empresas/{empresaId}/usuarios-admin:
 *   post:
 *     summary: Cria um usuário secundário da loja
 *     tags: [Sistema]
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
 *             required: [nome, email, senha, papel]
 *             properties:
 *               nome: { type: string }
 *               email: { type: string }
 *               senha: { type: string }
 *               papel: { type: string, enum: [GERENTE, OPERADOR_CAIXA, ATENDENTE] }
 *     responses:
 *       201:
 *         description: Usuário criado
 *       400:
 *         description: Dados inválidos
 *       409:
 *         description: Já existe um usuário com este e-mail nesta loja
 */
router.post('/', requireEmpresaAdmin(), requireLoginMaster, asyncHandler(async (req, res) => {
  const nome = (req.body.nome || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const { senha, papel } = req.body;

  if (!nome) return res.status(400).json({ error: 'Campo "nome" é obrigatório' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Campo "email" inválido' });
  if (!senha || String(senha).length < 6) return res.status(400).json({ error: 'Campo "senha" deve ter ao menos 6 caracteres' });
  if (!PAPEIS_VALIDOS.includes(papel)) return res.status(400).json({ error: `Campo "papel" deve ser um de: ${PAPEIS_VALIDOS.join(', ')}` });

  const jaExiste = await prisma.usuarioAdmin.findFirst({ where: { empresaId: req.params.empresaId, email } });
  if (jaExiste) {
    return res.status(409).json({ error: 'Já existe um usuário com este e-mail nesta loja' });
  }

  const senhaHash = await bcrypt.hash(String(senha), SALT_ROUNDS);
  const usuario = await prisma.usuarioAdmin.create({
    data: { empresaId: req.params.empresaId, nome, email, senhaHash, papel },
  });

  registrarAtividadeLoja({
    empresaId: req.params.empresaId,
    tipo: 'USUARIO_ADMIN_CRIADO',
    ator: 'Admin',
    descricao: `Usuário "${nome}" (${papel}) criado`,
  });

  res.status(201).json(serializeUsuario(usuario));
}));

/**
 * @openapi
 * /empresas/{empresaId}/usuarios-admin/{id}:
 *   patch:
 *     summary: Atualiza nome/papel/status/senha de um usuário secundário
 *     tags: [Sistema]
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
 *               nome: { type: string }
 *               papel: { type: string, enum: [GERENTE, OPERADOR_CAIXA, ATENDENTE] }
 *               ativo: { type: boolean }
 *               senha: { type: string }
 *     responses:
 *       200:
 *         description: Usuário atualizado
 *       404:
 *         description: Usuário não encontrado
 */
router.patch('/:id', requireEmpresaAdmin(), requireLoginMaster, asyncHandler(async (req, res) => {
  const existente = await prisma.usuarioAdmin.findFirst({ where: { id: req.params.id, empresaId: req.params.empresaId } });
  if (!existente) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  const { nome, papel, ativo, senha } = req.body;
  const data = {};
  if (nome !== undefined) {
    if (!String(nome).trim()) return res.status(400).json({ error: 'Campo "nome" não pode ficar vazio' });
    data.nome = String(nome).trim();
  }
  if (papel !== undefined) {
    if (!PAPEIS_VALIDOS.includes(papel)) return res.status(400).json({ error: `Campo "papel" deve ser um de: ${PAPEIS_VALIDOS.join(', ')}` });
    data.papel = papel;
  }
  if (ativo !== undefined) data.ativo = Boolean(ativo);
  if (senha !== undefined) {
    if (String(senha).length < 6) return res.status(400).json({ error: 'Campo "senha" deve ter ao menos 6 caracteres' });
    data.senhaHash = await bcrypt.hash(String(senha), SALT_ROUNDS);
  }

  const usuario = await prisma.usuarioAdmin.update({ where: { id: req.params.id }, data });
  res.json(serializeUsuario(usuario));
}));

/**
 * @openapi
 * /empresas/{empresaId}/usuarios-admin/{id}:
 *   delete:
 *     summary: Remove um usuário secundário
 *     tags: [Sistema]
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
 *         description: Usuário removido
 *       404:
 *         description: Usuário não encontrado
 */
router.delete('/:id', requireEmpresaAdmin(), requireLoginMaster, asyncHandler(async (req, res) => {
  const existente = await prisma.usuarioAdmin.findFirst({ where: { id: req.params.id, empresaId: req.params.empresaId } });
  if (!existente) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }
  await prisma.usuarioAdmin.delete({ where: { id: req.params.id } });

  registrarAtividadeLoja({
    empresaId: req.params.empresaId,
    tipo: 'USUARIO_ADMIN_REMOVIDO',
    ator: 'Admin',
    descricao: `Usuário "${existente.nome}" removido`,
  });

  res.status(204).send();
}));

module.exports = router;
