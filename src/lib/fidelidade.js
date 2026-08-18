/**
 * Calcula quantos itens grátis o cliente tem realmente disponíveis para resgate, considerando o
 * prazo de validade configurado pela loja (Empresa.fidelidadeValidadeDias). Se o prazo já passou
 * desde que o item mais recente foi liberado, o(s) item(ns) pendente(s) são tratados como expirados.
 * @param {{ itensGratisGanhos: number, itensGratisResgatados: number, itemGratisGanhoEm: Date|null }} cliente
 * @param {{ fidelidadeValidadeDias: number|null }} empresa
 */
const disponibilidadeFidelidade = (cliente, empresa) => {
  const disponiveis = Math.max(0, (cliente.itensGratisGanhos || 0) - (cliente.itensGratisResgatados || 0));

  if (disponiveis === 0) {
    return { disponiveis: 0, expiraEm: null, expirado: false };
  }

  if (!empresa.fidelidadeValidadeDias || !cliente.itemGratisGanhoEm) {
    return { disponiveis, expiraEm: null, expirado: false };
  }

  const expiraEm = new Date(cliente.itemGratisGanhoEm);
  expiraEm.setDate(expiraEm.getDate() + empresa.fidelidadeValidadeDias);
  const expirado = new Date() > expiraEm;

  return { disponiveis: expirado ? 0 : disponiveis, expiraEm, expirado };
};

/**
 * Credita `unidades` no contador de fidelidade do cliente e recalcula quantos itens grátis ele já
 * ganhou no total (1 a cada LOYALTY_STAMPS_GOAL unidades). Usado tanto ao marcar um pedido como
 * ENTREGUE quanto quando o admin credita unidades manualmente (compra/retirada por telefone ou balcão).
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} clienteId
 * @param {number} unidades
 */
const creditarUnidadesFidelidade = async (tx, clienteId, unidades) => {
  const clienteAntes = await tx.cliente.findUnique({ where: { id: clienteId } });
  const comNovoTotal = await tx.cliente.update({
    where: { id: clienteId },
    data: { totalUnidadesCompradas: { increment: unidades } },
  });

  const novosGanhos = Math.floor(comNovoTotal.totalUnidadesCompradas / 10);
  const ganhouNovoItem = novosGanhos > (clienteAntes?.itensGratisGanhos ?? 0);

  return tx.cliente.update({
    where: { id: clienteId },
    data: {
      itensGratisGanhos: novosGanhos,
      ...(ganhouNovoItem ? { itemGratisGanhoEm: new Date() } : {}),
    },
  });
};

module.exports = { disponibilidadeFidelidade, creditarUnidadesFidelidade };
