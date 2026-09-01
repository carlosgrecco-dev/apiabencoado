/**
 * Segmentação RFM (Recência/Frequência/Monetário) padrão, pontuada em tercis relativos à própria
 * base de clientes da loja (não valores fixos) — assim o cálculo funciona igual pra loja pequena
 * ou grande. Usado pelo dashboard, por Clientes → Grupos e por Desempenho → Análises RFM.
 */

const RFM_SEGMENT_LABELS = {
  CAMPEOES: 'Campeões',
  FIEIS: 'Fiéis',
  POTENCIAIS: 'Potenciais',
  EM_RISCO: 'Em risco',
  PERDIDOS: 'Perdidos',
};

const percentil = (valores, p) => {
  const ordenado = [...valores].sort((a, b) => a - b);
  return ordenado[Math.min(ordenado.length - 1, Math.floor(ordenado.length * p))];
};

/**
 * @param {{ clienteId: string, nome: string, recenciaDias: number, frequencia: number, monetario: number }[]} clientes
 */
function calcularRfm(clientes) {
  if (clientes.length === 0) return [];

  const rP33 = percentil(clientes.map((c) => c.recenciaDias), 0.33);
  const rP66 = percentil(clientes.map((c) => c.recenciaDias), 0.66);
  const fP33 = percentil(clientes.map((c) => c.frequencia), 0.33);
  const fP66 = percentil(clientes.map((c) => c.frequencia), 0.66);
  const mP33 = percentil(clientes.map((c) => c.monetario), 0.33);
  const mP66 = percentil(clientes.map((c) => c.monetario), 0.66);

  // Recência: menos dias desde a última compra = melhor, por isso a nota é invertida (dias baixos → nota 3).
  const scoreR = (dias) => (dias <= rP33 ? 3 : dias <= rP66 ? 2 : 1);
  const scoreF = (freq) => (freq <= fP33 ? 1 : freq <= fP66 ? 2 : 3);
  const scoreM = (valor) => (valor <= mP33 ? 1 : valor <= mP66 ? 2 : 3);

  const segmentar = (r, f, m) => {
    if (r === 3 && f >= 2 && m >= 2) return 'CAMPEOES';
    if (f >= 2 && m >= 2) return 'FIEIS';
    if (r === 3) return 'POTENCIAIS';
    if (r === 1 && (f >= 2 || m >= 2)) return 'EM_RISCO';
    return 'PERDIDOS';
  };

  return clientes.map((c) => {
    const r = scoreR(c.recenciaDias);
    const f = scoreF(c.frequencia);
    const m = scoreM(c.monetario);
    return { ...c, scoreR: r, scoreF: f, scoreM: m, segmento: segmentar(r, f, m) };
  });
}

module.exports = { calcularRfm, RFM_SEGMENT_LABELS };
