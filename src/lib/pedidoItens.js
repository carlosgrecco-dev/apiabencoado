/**
 * Erro de validação de item de pedido — carrega o texto pronto pra devolver como 400. Extraído
 * de POST /pedidos pra ser reaproveitado também em POST /pedidos/:id/itens (adicionar itens a
 * uma mesa já aberta), sem duplicar a lógica de preço/opções em dois lugares.
 */
class ErroPedidoItens extends Error {}

/**
 * Valida e precifica uma lista de itens crus (`{produtoId, quantidade, observacoes, opcoes}`)
 * contra o catálogo real da empresa, devolvendo o formato pronto pra `pedido.itens.create`/
 * `pedidoItem.createMany`. Lança ErroPedidoItens (mensagem pronta pra 400) em qualquer
 * inconsistência. `client` pode ser o `prisma` direto ou um `tx` de transação.
 */
async function montarItensPedido(client, empresaId, itens) {
  const produtoIds = [...new Set(itens.map((i) => i.produtoId))];
  const produtos = await client.produto.findMany({
    where: { id: { in: produtoIds }, empresaId, ativo: true },
    include: { gruposOpcao: { include: { opcoes: true } } },
  });
  const produtoPorId = new Map(produtos.map((p) => [p.id, p]));

  const itensParaCriar = [];
  for (const item of itens) {
    const produto = produtoPorId.get(item.produtoId);
    if (!produto) {
      throw new ErroPedidoItens(`Produto ${item.produtoId} não encontrado ou indisponível`);
    }
    if (produto.esgotadoHoje) {
      throw new ErroPedidoItens(`Produto "${produto.nome}" está esgotado hoje`);
    }
    const quantidade = Number(item.quantidade);
    if (!Number.isInteger(quantidade) || quantidade < 1) {
      throw new ErroPedidoItens(`Quantidade inválida para o produto "${produto.nome}"`);
    }
    if (produto.controlarEstoque && (produto.estoqueQtd ?? 0) < quantidade) {
      throw new ErroPedidoItens(`Estoque insuficiente para o produto "${produto.nome}"`);
    }

    const opcaoIdsSelecionados = Array.isArray(item.opcoes) ? [...new Set(item.opcoes)] : [];
    const opcoesSelecionadas = [];

    for (const grupo of produto.gruposOpcao) {
      const opcoesDoGrupo = new Map(grupo.opcoes.map((o) => [o.id, o]));
      const selecionadasDoGrupo = opcaoIdsSelecionados
        .map((id) => opcoesDoGrupo.get(id))
        .filter((o) => o && o.ativo);

      const minEfetivo = grupo.obrigatorio ? Math.max(1, grupo.minSelecoes) : grupo.minSelecoes;
      if (selecionadasDoGrupo.length < minEfetivo) {
        throw new ErroPedidoItens(`Selecione ao menos ${minEfetivo} opção(ões) em "${grupo.nome}" para o produto "${produto.nome}"`);
      }
      const maxEfetivo = !grupo.selecaoMultipla ? 1 : (grupo.maxSelecoes ?? Infinity);
      if (selecionadasDoGrupo.length > maxEfetivo) {
        throw new ErroPedidoItens(`Selecione no máximo ${maxEfetivo} opção(ões) em "${grupo.nome}" para o produto "${produto.nome}"`);
      }

      for (const opcao of selecionadasDoGrupo) {
        opcoesSelecionadas.push({
          opcaoId: opcao.id,
          nomeGrupo: grupo.nome,
          nomeOpcao: opcao.nome,
          precoAdicional: opcao.precoAdicional,
        });
      }
    }

    const precoBase = Number(produto.precoPromocional ?? produto.preco);
    const precoAdicionais = opcoesSelecionadas.reduce((sum, o) => sum + Number(o.precoAdicional), 0);
    const precoUnitario = precoBase + precoAdicionais;

    itensParaCriar.push({
      produtoId: produto.id,
      nomeProduto: produto.nome,
      ehCombo: produto.ehCombo,
      precoUnitario,
      quantidade,
      observacoes: item.observacoes || null,
      ...(opcoesSelecionadas.length > 0 ? { opcoesSelecionadas: { create: opcoesSelecionadas } } : {}),
    });
  }

  return { itensParaCriar, produtoPorId };
}

/** Debita o estoque simples por produto (Produto.estoqueQtd) — mesma regra de sempre. */
async function decrementarEstoque(tx, itensParaCriar, produtoPorId) {
  for (const item of itensParaCriar) {
    const produto = produtoPorId.get(item.produtoId);
    if (produto.controlarEstoque) {
      await tx.produto.update({
        where: { id: produto.id },
        data: { estoqueQtd: Math.max(0, (produto.estoqueQtd ?? 0) - item.quantidade) },
      });
    }
  }
}

module.exports = { montarItensPedido, decrementarEstoque, ErroPedidoItens };
