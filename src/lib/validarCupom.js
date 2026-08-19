/**
 * Valida um cupom (sem aplicar/consumir). Usado tanto pelo endpoint público de
 * validação quanto pela criação do pedido (que reaproveita a mesma regra antes
 * de efetivamente consumir o uso do cupom).
 *
 * @param {import('@prisma/client').PrismaClient} db - client ou transação Prisma
 * @param {string} empresaId
 * @param {string} codigo
 * @param {string|null} clienteId
 * @param {number} subtotal
 * @returns {Promise<{ok: true, cupom: object, desconto: number, freteGratis: boolean} | {ok: false, error: string}>}
 */
async function validarCupom(db, empresaId, codigo, clienteId, subtotal) {
  if (!codigo) {
    return { ok: false, error: 'Informe o código do cupom' };
  }

  const cupom = await db.cupom.findUnique({
    where: { empresaId_codigo: { empresaId, codigo: codigo.toUpperCase() } },
  });

  if (!cupom || !cupom.ativo) {
    return { ok: false, error: 'Cupom inválido ou inexistente' };
  }

  if (cupom.validoAte && new Date(cupom.validoAte) < new Date()) {
    return { ok: false, error: 'Este cupom expirou' };
  }

  if (cupom.clienteAlvoId && cupom.clienteAlvoId !== clienteId) {
    return { ok: false, error: 'Este cupom é pessoal e não pode ser usado nesta conta' };
  }

  if (cupom.usoMaximo != null && cupom.usosRealizados >= cupom.usoMaximo) {
    return { ok: false, error: 'Este cupom atingiu o limite de usos' };
  }

  if (cupom.valorMinimoPedido != null && subtotal < Number(cupom.valorMinimoPedido)) {
    return { ok: false, error: `Pedido mínimo de R$ ${Number(cupom.valorMinimoPedido).toFixed(2)} para usar este cupom` };
  }

  if (cupom.apenasPrimeiraCompra) {
    if (!clienteId) {
      return { ok: false, error: 'Este cupom é válido apenas para a primeira compra — entre na sua conta para usá-lo' };
    }
    const pedidosAnteriores = await db.pedido.count({ where: { clienteId } });
    if (pedidosAnteriores > 0) {
      return { ok: false, error: 'Este cupom é válido apenas na primeira compra' };
    }
  }

  let desconto = 0;
  let freteGratis = false;

  if (cupom.tipo === 'PERCENTUAL') {
    desconto = subtotal * (Number(cupom.valor) / 100);
  } else if (cupom.tipo === 'VALOR_FIXO') {
    desconto = Math.min(Number(cupom.valor), subtotal);
  } else if (cupom.tipo === 'FRETE_GRATIS') {
    freteGratis = true;
  }

  return { ok: true, cupom, desconto, freteGratis };
}

module.exports = validarCupom;
