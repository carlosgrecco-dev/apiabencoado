const DIAS_SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const FORMA_PAGAMENTO_LABELS = { PIX: 'PIX', DINHEIRO: 'dinheiro', CARTAO: 'cartão na entrega', MULTIPLO: 'múltiplas formas' };
/** Mesmo corte de front/src/types/Cliente.ts:loyaltyTier — tier PRATA ou OURO. */
const MINIMO_UNIDADES_CLIENTE_FIEL = 20;

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
 * @param {{bairro?: string|null, formaPagamento?: string|null}} extras - contexto do pedido, usado pelas restrições de bairro/forma de pagamento
 * @returns {Promise<{ok: true, cupom: object, desconto: number, freteGratis: boolean} | {ok: false, error: string}>}
 */
async function validarCupom(db, empresaId, codigo, clienteId, subtotal, extras = {}) {
  const { bairro, formaPagamento } = extras;

  if (!codigo) {
    return { ok: false, error: 'Informe o código do cupom' };
  }

  const cupom = await db.cupom.findUnique({
    where: { empresaId_codigo: { empresaId, codigo: codigo.trim().toUpperCase() } },
  });

  if (!cupom || !cupom.ativo) {
    return { ok: false, error: 'Cupom inválido ou inexistente' };
  }

  if (cupom.validoDe && new Date(cupom.validoDe) > new Date()) {
    return { ok: false, error: 'Este cupom ainda não está disponível' };
  }

  if (cupom.validoAte && new Date(cupom.validoAte) < new Date()) {
    return { ok: false, error: 'Este cupom expirou' };
  }

  if (cupom.diaSemanaRestrito != null && new Date().getDay() !== cupom.diaSemanaRestrito) {
    return { ok: false, error: `Este cupom só é válido às ${DIAS_SEMANA[cupom.diaSemanaRestrito]}` };
  }

  if (cupom.bairrosRestritos.length > 0 && (!bairro || !cupom.bairrosRestritos.includes(bairro))) {
    return { ok: false, error: 'Este cupom não é válido para o seu bairro' };
  }

  if (cupom.formaPagamentoRestrita && cupom.formaPagamentoRestrita !== formaPagamento) {
    return { ok: false, error: `Este cupom só é válido pagando com ${FORMA_PAGAMENTO_LABELS[cupom.formaPagamentoRestrita] || cupom.formaPagamentoRestrita}` };
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

  if (cupom.apenasClientesFieis) {
    if (!clienteId) {
      return { ok: false, error: 'Este cupom é exclusivo para clientes fiéis — entre na sua conta para usá-lo' };
    }
    const cliente = await db.cliente.findUnique({ where: { id: clienteId }, select: { totalUnidadesCompradas: true } });
    if (!cliente || cliente.totalUnidadesCompradas < MINIMO_UNIDADES_CLIENTE_FIEL) {
      return { ok: false, error: 'Este cupom é exclusivo para clientes fiéis' };
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
