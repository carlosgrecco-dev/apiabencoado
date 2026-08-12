const prisma = require('./prisma');

/** Middleware para rotas aninhadas em /empresas/:empresaId/... — garante que a empresa existe. */
const loadEmpresa = async (req, res, next) => {
  try {
    const empresa = await prisma.empresa.findUnique({ where: { id: req.params.empresaId } });
    if (!empresa) {
      return res.status(404).json({ error: 'Empresa não encontrada' });
    }
    req.empresa = empresa;
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = loadEmpresa;
