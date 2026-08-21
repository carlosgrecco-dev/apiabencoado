/**
 * Credita `valor` (R$) em SaltFood Coins na conta de plataforma e grava a linha no ledger
 * (tipo GANHO). Espelha creditarCashback em lib/cashback.js, mas com histórico — o saldo aqui é
 * compartilhado entre lojas (ganho numa, gasto noutra), então precisa de trilha auditável.
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {{ contaPlataformaId: string, empresaId: string, clienteId: string, pedidoId?: string, valor: number }} dados
 */
const creditarCoins = async (tx, { contaPlataformaId, empresaId, clienteId, pedidoId, valor }) => {
  if (valor <= 0 || !contaPlataformaId) return null;
  await tx.contaPlataforma.update({ where: { id: contaPlataformaId }, data: { saldoCoins: { increment: valor } } });
  return tx.coinsMovimento.create({
    data: { contaPlataformaId, empresaId, clienteId, pedidoId: pedidoId || null, tipo: 'GANHO', valor },
  });
};

module.exports = { creditarCoins };
