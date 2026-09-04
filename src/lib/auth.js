const jwt = require('jsonwebtoken');
const prisma = require('./prisma');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('Variável de ambiente JWT_SECRET não definida.');
}

const signToken = (payload, expiresIn) => jwt.sign(payload, JWT_SECRET, { expiresIn });

/**
 * Montado uma vez, globalmente, logo após express.json(). Nunca rejeita a requisição — só
 * popula req.auth com o payload do token (se houver um válido) ou null. A decisão de exigir
 * autenticação fica com os middlewares requireX, aplicados rota a rota.
 *
 * Motoboy é o único ator cujo token (30 dias) sobrevive muito além do tempo em que a loja pode
 * querer cortar o acesso dele (demissão etc.) — por isso, só para esse role, confere `ativo` no
 * banco a cada requisição e invalida a sessão localmente (req.auth = null) se ele foi desativado,
 * mesmo com um token ainda válido. Isso cobre de uma vez só todo lugar do código que confia num
 * token MOTOBOY (não só requireMotoboy — pedidos.js e movimentosCaixa.js também checam o role
 * inline), sem precisar caçar cada checagem espalhada.
 */
const authenticate = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    req.auth = null;
    return next();
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role === 'MOTOBOY') {
      const motoboy = await prisma.motoboy.findUnique({ where: { id: payload.motoboyId }, select: { ativo: true } });
      if (!motoboy || !motoboy.ativo) {
        req.auth = null;
        return next();
      }
    }
    req.auth = payload;
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

/**
 * Espelha GRUPOS_POR_PAPEL de front/src/components/admin/TenantAdminNav.tsx — os mesmos grupos de
 * menu que cada papel de usuário de equipe enxerga na UI, agora também aplicados no backend. Login
 * master (sem papel) nunca é afetado por isso. Manter os dois arquivos em sincronia se um papel
 * ganhar/perder acesso a um grupo.
 */
const GRUPOS_POR_PAPEL = {
  GERENTE: ['painel', 'vendas', 'delivery', 'clientes', 'financeiro', 'desempenho', 'operacional'],
  OPERADOR_CAIXA: ['painel', 'operacional', 'financeiro'],
  ATENDENTE: ['painel', 'vendas', 'delivery'],
};

/**
 * Restringe uma rota a um ou mais grupos — só tem efeito sobre um login secundário de equipe
 * (token EMPRESA_ADMIN com `papel` definido); login master, Cliente, Motoboy e Super Admin passam
 * direto (a decisão de exigir aquele role continua com requireEmpresaAdmin/requireCliente/etc.,
 * aplicado depois na cadeia). Use no mount do router (server.js) quando o recurso inteiro pertence
 * a um grupo só; para arquivos com rotas de grupos diferentes misturadas, aplique rota a rota.
 */
const requireGrupo = (...gruposPermitidos) => (req, res, next) => {
  if (req.auth?.role !== 'EMPRESA_ADMIN' || !req.auth.papel) {
    return next();
  }
  const gruposDoPapel = GRUPOS_POR_PAPEL[req.auth.papel] || [];
  const liberado = gruposPermitidos.some((g) => gruposDoPapel.includes(g));
  if (!liberado) {
    return res.status(403).json({ error: 'Seu perfil de acesso não permite usar esta função.' });
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
  requireGrupo,
};
