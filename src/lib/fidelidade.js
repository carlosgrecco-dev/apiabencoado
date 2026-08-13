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

module.exports = { disponibilidadeFidelidade };
