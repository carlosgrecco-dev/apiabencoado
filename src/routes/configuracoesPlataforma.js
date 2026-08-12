const { Router } = require('express');
const prisma = require('../lib/prisma');
const { registrarLog } = require('../lib/auditLog');

const router = Router();

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/** Busca a linha única de configurações globais, criando-a com valores padrão se ainda não existir. */
const getOuCriar = async () => {
  const existente = await prisma.configuracaoPlataforma.findFirst();
  if (existente) return existente;
  return prisma.configuracaoPlataforma.create({ data: {} });
};

/**
 * @openapi
 * /configuracoes-plataforma:
 *   get:
 *     summary: Retorna as configurações globais da plataforma (dados da Sigma, termos padrão, chaves globais)
 *     tags: [ConfiguracoesPlataforma]
 *     responses:
 *       200:
 *         description: Configurações atuais
 */
router.get('/', asyncHandler(async (req, res) => {
  const config = await getOuCriar();
  res.json(config);
}));

/**
 * @openapi
 * /configuracoes-plataforma:
 *   put:
 *     summary: Atualiza as configurações globais da plataforma
 *     tags: [ConfiguracoesPlataforma]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nomeEmpresa: { type: string }
 *               documento: { type: string }
 *               emailSuporte: { type: string }
 *               telefoneSuporte: { type: string }
 *               endereco: { type: string }
 *               termosPadraoLojistas: { type: string }
 *               chavesGlobais: { type: object }
 *     responses:
 *       200:
 *         description: Configurações atualizadas
 */
router.put('/', asyncHandler(async (req, res) => {
  const { nomeEmpresa, documento, emailSuporte, telefoneSuporte, endereco, termosPadraoLojistas, chavesGlobais } = req.body;

  const atual = await getOuCriar();

  const config = await prisma.configuracaoPlataforma.update({
    where: { id: atual.id },
    data: {
      ...(nomeEmpresa !== undefined ? { nomeEmpresa } : {}),
      ...(documento !== undefined ? { documento: documento || null } : {}),
      ...(emailSuporte !== undefined ? { emailSuporte: emailSuporte || null } : {}),
      ...(telefoneSuporte !== undefined ? { telefoneSuporte: telefoneSuporte || null } : {}),
      ...(endereco !== undefined ? { endereco: endereco || null } : {}),
      ...(termosPadraoLojistas !== undefined ? { termosPadraoLojistas: termosPadraoLojistas || null } : {}),
      ...(chavesGlobais !== undefined ? { chavesGlobais } : {}),
    },
  });

  await registrarLog({ tipo: 'ALTERACAO_CRITICA', ator: 'super-admin', acao: 'Configurações globais da plataforma atualizadas' });
  res.json(config);
}));

module.exports = router;
