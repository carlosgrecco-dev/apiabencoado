const bcrypt = require('bcryptjs');

/** Cria uma ContaPlataforma nova e isolada (nenhum vínculo prévio pra confirmar) — caso comum,
 * usado quando o e-mail do cadastro não bate com nenhuma conta de plataforma existente ainda.
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {{ email: string, telefone: string|null, senhaHash: string }} dados
 */
const criarContaIsolada = (tx, { email, telefone, senhaHash }) =>
  tx.contaPlataforma.create({ data: { email, telefone: telefone || null, senhaHash } });

/** Só verifica se já existe uma ContaPlataforma pra este e-mail — não vincula nada. */
const buscarContaPorEmail = (tx, email) => tx.contaPlataforma.findUnique({ where: { email } });

/**
 * Confirma que `senhaTentativa` é a senha de algum Cliente já vinculado a `contaPlataformaId` —
 * é a prova de dono exigida antes de vincular um Cliente de outra loja à mesma conta de
 * plataforma. Sem essa confirmação, bastaria saber o e-mail de alguém pra herdar o saldo de coins
 * dela criando uma conta nova em outra loja.
 * @param {import('@prisma/client').PrismaClient | import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} contaPlataformaId
 * @param {string} senhaTentativa
 */
const confirmarVinculo = async (tx, contaPlataformaId, senhaTentativa) => {
  const clientesVinculados = await tx.cliente.findMany({
    where: { contaPlataformaId },
    select: { senhaHash: true },
  });
  for (const cliente of clientesVinculados) {
    if (await bcrypt.compare(senhaTentativa, cliente.senhaHash)) return true;
  }
  return false;
};

module.exports = { criarContaIsolada, buscarContaPorEmail, confirmarVinculo };
