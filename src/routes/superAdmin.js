const { Router } = require('express');
const bcrypt = require('bcryptjs');
const { signToken } = require('../lib/auth');

const router = Router();

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const SUPER_ADMIN_TOKEN_TTL = '8h';

/**
 * @openapi
 * /super-admin/login:
 *   post:
 *     summary: Login do Super Admin (dono da plataforma) — credencial única, guardada em variáveis de ambiente
 *     tags: [SuperAdmin]
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
 *         description: Usuário ou senha inválidos
 */
router.post('/login', asyncHandler(async (req, res) => {
  const { usuario, senha } = req.body;
  if (!usuario || !senha) {
    return res.status(400).json({ error: 'Campos "usuario" e "senha" são obrigatórios' });
  }

  const usuarioEsperado = process.env.SUPER_ADMIN_USERNAME;
  const senhaHashEsperada = process.env.SUPER_ADMIN_PASSWORD_HASH;
  if (!usuarioEsperado || !senhaHashEsperada) {
    return res.status(500).json({ error: 'Login de Super Admin não configurado no servidor' });
  }

  if (usuario !== usuarioEsperado) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  }

  const senhaValida = await bcrypt.compare(senha, senhaHashEsperada);
  if (!senhaValida) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  }

  const token = signToken({ role: 'SUPER_ADMIN', sub: usuario }, SUPER_ADMIN_TOKEN_TTL);
  res.json({ usuario, token });
}));

module.exports = router;
