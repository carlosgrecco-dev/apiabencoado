/**
 * Converte recursivamente instâncias de Prisma.Decimal em number puro, para que o
 * JSON devolvido pela API tenha campos numéricos de verdade (preco, valor, taxa...)
 * em vez de strings — evita bugs de concatenação de string no front (ex: "7" + 7).
 */
function isDecimalLike(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.toNumber === 'function' &&
    typeof value.toFixed === 'function'
  );
}

function serializeDecimals(value) {
  if (value === null || value === undefined) return value;
  if (isDecimalLike(value)) return value.toNumber();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(serializeDecimals);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = serializeDecimals(val);
    }
    return out;
  }
  return value;
}

module.exports = serializeDecimals;
