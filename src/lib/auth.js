const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('Variável de ambiente JWT_SECRET não definida.');
}

const signToken = (payload, expiresIn) => jwt.sign(payload, JWT_SECRET, { expiresIn });

/**
 * Montado uma vez, globalmente, logo após express.json(). Nunca rejeita a requisição — só
 * popula req.auth com o payload do token (se houver um válido) ou null. A decisão de exigir
 * autenticação fica com os middlewares requireX, aplicados rota a rota.
 */
const authenticate = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    req.auth = null;
    return next();
  }
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
  } catch {
    req.auth = null;
  }
  next();
};

/**
 * Exige um token de admin da própria loja (empresaId do token bate com o parâmetro de rota
 * indicado — "empresaId" por padrão, já que é o nome usado por quase todo router montado sob
 * /empresas/:empresaId/*; em empresas.js, onde a própria rota usa :id, passe requireEmpresaAdmin('id')).
 * Quando req.empresa já foi carregado (loadEmpresa rodou antes), reaproveita essa consulta para
 * cortar o acesso na hora se a loja ou o admin foram desativados pelo Super Admin, sem esperar
 * o token expirar.
 */
const requireEmpresaAdmin = (paramName = 'empresaId') => (req, res, next) => {
  if (!req.auth || req.auth.role !== 'EMPRESA_ADMIN') {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  if (req.auth.empresaId !== req.params[paramName]) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  if (req.empresa && (!req.empresa.empresaAtiva || !req.empresa.adminAtivo)) {
    return res.status(403).json({ error: 'Acesso desativado. Fale com o suporte da plataforma.' });
  }
  next();
};

/**
 * Exige um token de cliente da própria loja. Quando paramName é passado, também confere que o
 * :paramName da URL é o próprio cliente do token (perfil, endereços etc). Quando omitido, só
 * confere role + empresa — usado em rotas onde o dono do recurso é conferido no handler (ex:
 * avaliar um pedido, onde o "dono" é o pedido, não um :id de cliente na URL).
 */
const requireCliente = (paramName) => (req, res, next) => {
  if (!req.auth || req.auth.role !== 'CLIENTE') {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  if (req.auth.empresaId !== req.params.empresaId) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  if (paramName && req.auth.clienteId !== req.params[paramName]) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  next();
};

/** Mesma forma que requireCliente, para o motoboy (usado na rota de atualizar a própria localização). */
const requireMotoboy = (paramName) => (req, res, next) => {
  if (!req.auth || req.auth.role !== 'MOTOBOY') {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  if (req.auth.empresaId !== req.params.empresaId) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  if (paramName && req.auth.motoboyId !== req.params[paramName]) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  next();
};

/** Exige um token de Super Admin — não é escopado a nenhuma empresa. */
const requireSuperAdmin = (req, res, next) => {
  if (!req.auth || req.auth.role !== 'SUPER_ADMIN') {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  next();
};

module.exports = {
  signToken,
  authenticate,
  requireEmpresaAdmin,
  requireCliente,
  requireMotoboy,
  requireSuperAdmin,
};
