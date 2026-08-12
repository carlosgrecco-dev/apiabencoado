const normalizar = (texto = '') => texto.trim().toLowerCase();

/**
 * Calcula a taxa de entrega para um pedido: casa o bairro informado com uma zona ativa do tipo
 * BAIRRO; se não houver zona correspondente, usa a taxa fixa padrão da empresa. Em seguida aplica
 * frete grátis quando o subtotal atinge o limite configurado (freteGratisAcimaDe).
 * Zonas RAIO_KM/FAIXA_DISTANCIA exigem coordenadas geocodificadas (fora do escopo atual) e são
 * ignoradas neste cálculo automático.
 * @param {{ zonas: any[], bairro: string|null|undefined, subtotal: number, taxaPadrao: number, freteGratisAcimaDe: number|null }} params
 */
const calcularFrete = ({ zonas, bairro, subtotal, taxaPadrao, freteGratisAcimaDe }) => {
  let taxa = Number(taxaPadrao) || 0;
  let zonaAplicada = null;

  if (bairro) {
    const zona = zonas.find((z) => z.tipo === 'BAIRRO' && z.ativo && normalizar(z.bairro) === normalizar(bairro));
    if (zona) {
      taxa = Number(zona.taxa);
      zonaAplicada = zona;
    }
  }

  let freteGratis = false;
  if (freteGratisAcimaDe != null && subtotal >= Number(freteGratisAcimaDe)) {
    taxa = 0;
    freteGratis = true;
  }

  return { taxa, freteGratis, zona: zonaAplicada };
};

module.exports = { calcularFrete };
