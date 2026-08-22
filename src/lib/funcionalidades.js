/**
 * As 10 funcionalidades opt-in da loja — mesmos campos em Empresa e Plano. Fonte única pra
 * evitar a lista duplicada entre a rota de config da empresa e a de pacote do plano.
 */
const CAMPOS_FUNCIONALIDADES = [
  'habilitarFavoritos', 'habilitarPedirDeNovo', 'habilitarRankingFidelidade',
  'habilitarAgendamento', 'habilitarAvaliacaoComFotos', 'habilitarNotificacoesInApp',
  'habilitarMissoes', 'habilitarIndicacaoAvancada', 'habilitarAvaliacaoDetalhada', 'habilitarCentralSuporte',
];

module.exports = { CAMPOS_FUNCIONALIDADES };
