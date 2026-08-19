/**
 * Credita `valor` (R$) no saldo de cashback do cliente. Espelha creditarUnidadesFidelidade em
 * lib/fidelidade.js — mesmo padrão de transação, mesma responsabilidade única.
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} clienteId
 * @param {number} valor
 */
const creditarCashback = async (tx, clienteId, valor) => {
  if (valor <= 0) return tx.cliente.findUnique({ where: { id: clienteId } });
  return tx.cliente.update({
    where: { id: clienteId },
    data: { saldoCashback: { increment: valor } },
  });
};

module.exports = { creditarCashback };
