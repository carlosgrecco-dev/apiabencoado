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

/**
 * Debita `valor` (R$) de SaltFood Coins, reconferindo o saldo dentro da própria transação antes
 * de decrementar — diferente do cashback local (só confere antes de abrir a transação), coins é
 * um saldo compartilhado entre lojas, então dois pedidos simultâneos em lojas diferentes gastando
 * o mesmo saldo é um risco real. O `updateMany` com `saldoCoins: { gte: valor }` no where torna a
 * checagem e o decremento atômicos: o UPDATE toma o lock da linha, então uma segunda transação
 * concorrente espera a primeira confirmar e só então reavalia o saldo já atualizado.
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {{ contaPlataformaId: string, empresaId: string, clienteId: string, pedidoId?: string, valor: number }} dados
 * @throws {Error} com message 'SALDO_COINS_INSUFICIENTE' se o saldo não cobrir o valor pedido
 */
const debitarCoins = async (tx, { contaPlataformaId, empresaId, clienteId, pedidoId, valor }) => {
  if (valor <= 0 || !contaPlataformaId) return null;
  const resultado = await tx.contaPlataforma.updateMany({
    where: { id: contaPlataformaId, saldoCoins: { gte: valor } },
    data: { saldoCoins: { decrement: valor } },
  });
  if (resultado.count === 0) {
    throw new Error('SALDO_COINS_INSUFICIENTE');
  }
  return tx.coinsMovimento.create({
    data: { contaPlataformaId, empresaId, clienteId, pedidoId: pedidoId || null, tipo: 'GASTO', valor },
  });
};

module.exports = { creditarCoins, debitarCoins };
