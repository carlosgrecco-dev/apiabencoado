const { creditarUnidadesFidelidade } = require('./fidelidade');
const { RECOMPENSA_INDICACAO_UNIDADES, bonusPorMarco } = require('./indicacao');
const { creditarCashback } = require('./cashback');
const { creditarCoins } = require('./coins');

/**
 * Tudo que precisa acontecer quando um Pedido vira ENTREGUE (delivery, balcão, retirada ou
 * fechamento de mesa) — extraído de PATCH /pedidos/:id/status pra ser um único caminho de
 * código pra todo tipo de pedido, com ou sem pagamento dividido. Roda dentro da mesma
 * transação que atualiza o status.
 *
 * `pagamentos`, quando vier (venda dividida em mais de uma forma — PDV), gera um MovimentoCaixa
 * ENTRADA por linha, cada um com sua própria formaPagamento — necessário pra separar quanto do
 * "esperado em dinheiro" veio de qual venda na conferência de caixa. Sem isso, gera uma única
 * ENTRADA com o total, exatamente como sempre funcionou.
 */
async function finalizarComoEntregue(tx, { pedido, empresaId, empresa, pagamentos }) {
  let salvo = pedido;

  const caixaAberto = await tx.caixaSessao.findFirst({
    where: { empresaId, status: 'ABERTO' },
    select: { id: true },
  });

  const descricao = `Pedido #${salvo.numero} — ${salvo.clienteNome ?? 'Venda PDV'}`;
  const linhas = Array.isArray(pagamentos) && pagamentos.length > 0
    ? pagamentos.map((p) => ({ valor: p.valor, formaPagamento: p.formaPagamento }))
    : [{ valor: Number(salvo.total), formaPagamento: salvo.formaPagamento }];

  for (const linha of linhas) {
    await tx.movimentoCaixa.create({
      data: {
        empresaId,
        tipo: 'ENTRADA',
        descricao,
        valor: linha.valor,
        dataMovimento: new Date(),
        caixaSessaoId: caixaAberto?.id ?? null,
        pedidoId: salvo.id,
        formaPagamento: linha.formaPagamento,
      },
    });
  }

  // Credita fidelidade (1x por pedido, guardado por unidadesFidelidadeCreditadas). O nível
  // (Bronze/Prata/Ouro) sempre segue totalUnidadesCompradas, nos dois métodos — só a recompensa
  // resgatável muda: método CARIMBO usa o contador de itens grátis já calculado acima; método
  // PONTOS credita, além disso, pontos sobre o subtotal (Empresa.pontosPorReal) em Cliente.saldoPontos.
  if (salvo.clienteId && salvo.unidadesFidelidadeCreditadas == null) {
    const unidades = salvo.itens.reduce((sum, item) => sum + item.quantidade, 0);
    await creditarUnidadesFidelidade(tx, salvo.clienteId, unidades);
    const dadosFidelidade = { unidadesFidelidadeCreditadas: unidades };

    if (empresa.fidelidadeMetodo === 'PONTOS') {
      const pontosPorReal = empresa.pontosPorReal != null ? Number(empresa.pontosPorReal) : 1;
      const pontos = Math.floor(Number(salvo.subtotal) * pontosPorReal);
      if (pontos > 0) {
        await tx.cliente.update({ where: { id: salvo.clienteId }, data: { saldoPontos: { increment: pontos } } });
      }
      dadosFidelidade.pontosCreditados = pontos;
    }

    await tx.pedido.update({ where: { id: salvo.id }, data: dadosFidelidade });
    // Reflete no objeto que a rota devolve — sem isso, o response deste PATCH ficava com o
    // valor antigo mesmo já tendo sido atualizado no banco acima.
    salvo = { ...salvo, ...dadosFidelidade };
  }

  // Credita cashback sobre o subtotal (1x por pedido, guardado por cashbackCreditado).
  const cashbackPercent = empresa.cashbackPercent ? Number(empresa.cashbackPercent) : 0;
  if (salvo.clienteId && cashbackPercent > 0 && salvo.cashbackCreditado == null) {
    const valorCashback = Number(salvo.subtotal) * (cashbackPercent / 100);
    await creditarCashback(tx, salvo.clienteId, valorCashback);
    await tx.pedido.update({
      where: { id: salvo.id },
      data: { cashbackCreditado: valorCashback },
    });
    salvo = { ...salvo, cashbackCreditado: valorCashback };
  }

  // Credita SaltFood Coins sobre o subtotal (1x por pedido, guardado por coinsCreditado) —
  // só se a loja participar (opt-in) e o cliente já tiver uma conta de plataforma vinculada.
  // Em paralelo ao cashback local acima, sem interferir nele.
  const coinsPercent = empresa.participaSaltfoodCoins && empresa.saltfoodCoinsPercent
    ? Number(empresa.saltfoodCoinsPercent) : 0;
  if (salvo.clienteId && coinsPercent > 0 && salvo.coinsCreditado == null) {
    const clienteConta = await tx.cliente.findUnique({
      where: { id: salvo.clienteId },
      select: { contaPlataformaId: true },
    });
    if (clienteConta?.contaPlataformaId) {
      const valorCoins = Number(salvo.subtotal) * (coinsPercent / 100);
      await creditarCoins(tx, {
        contaPlataformaId: clienteConta.contaPlataformaId,
        empresaId,
        clienteId: salvo.clienteId,
        pedidoId: salvo.id,
        valor: valorCoins,
      });
      await tx.pedido.update({
        where: { id: salvo.id },
        data: { coinsCreditado: valorCoins },
      });
      salvo = { ...salvo, coinsCreditado: valorCoins };
    }
  }

  // Indicação: se esse pedido é a primeira compra concluída de um cliente indicado por
  // outro, credita fidelidade pros dois lados — uma única vez (indicacaoRecompensada trava).
  if (salvo.clienteId) {
    const cliente = await tx.cliente.findUnique({ where: { id: salvo.clienteId } });
    if (cliente?.indicadoPorId && !cliente.indicacaoRecompensada) {
      const pedidosAnterioresEntregues = await tx.pedido.count({
        where: { clienteId: cliente.id, status: 'ENTREGUE', id: { not: salvo.id } },
      });
      if (pedidosAnterioresEntregues === 0) {
        const recompensaIndicacao = empresa.habilitarIndicacaoAvancada
          ? empresa.indicacaoRecompensaUnidades
          : RECOMPENSA_INDICACAO_UNIDADES;
        await creditarUnidadesFidelidade(tx, cliente.id, recompensaIndicacao);
        await creditarUnidadesFidelidade(tx, cliente.indicadoPorId, recompensaIndicacao);
        await tx.cliente.update({ where: { id: cliente.id }, data: { indicacaoRecompensada: true } });

        // Modo avançado: acumula o total de indicações concluídas do indicador e libera
        // bônus de marco (3/10/25) quando bate exatamente numa dessas metas.
        if (empresa.habilitarIndicacaoAvancada) {
          const indicador = await tx.cliente.update({
            where: { id: cliente.indicadoPorId },
            data: { indicacoesConcluidas: { increment: 1 } },
          });
          const bonus = bonusPorMarco(indicador.indicacoesConcluidas);
          if (bonus) {
            await creditarUnidadesFidelidade(tx, indicador.id, bonus);
          }
        }
      }
    }
  }

  // Missões de fidelidade: avalia as participações ativas do cliente e credita quem bateu a meta.
  if (salvo.clienteId && empresa.habilitarMissoes) {
    const participacoesAtivas = await tx.missaoCliente.findMany({
      where: { clienteId: salvo.clienteId, concluidaEm: null },
      include: { missao: true },
    });
    for (const participacao of participacoesAtivas) {
      const expiraEm = new Date(participacao.iniciadaEm).getTime() + participacao.missao.periodoDias * 86400000;
      if (Date.now() > expiraEm) continue;
      const pedidosCount = await tx.pedido.count({
        where: { clienteId: salvo.clienteId, status: 'ENTREGUE', createdAt: { gte: participacao.iniciadaEm } },
      });
      if (pedidosCount >= participacao.missao.metaPedidos) {
        await creditarUnidadesFidelidade(tx, salvo.clienteId, participacao.missao.recompensaUnidades);
        await tx.missaoCliente.update({
          where: { id: participacao.id },
          data: { concluidaEm: new Date(), recompensada: true },
        });
      }
    }
  }

  return salvo;
}

module.exports = { finalizarComoEntregue };
