/**
 * Contador de "usuários online" em memória do processo — sem tabela no banco. O storefront chama
 * POST /presence/ping a cada 30s enquanto a aba está aberta; uma sessão sem ping há mais de TTL_MS
 * é considerada offline e removida na próxima leitura. Reinicia (zera) a cada restart da API, o
 * que é aceitável pra uma métrica de "agora", não histórica.
 */

const TTL_MS = 90 * 1000;

/** @type {Map<string, Map<string, number>>} empresaId -> sessionId -> timestamp do último ping */
const porEmpresa = new Map();

function ping(empresaId, sessionId) {
  if (!porEmpresa.has(empresaId)) porEmpresa.set(empresaId, new Map());
  porEmpresa.get(empresaId).set(sessionId, Date.now());
}

function contar(empresaId) {
  const sessoes = porEmpresa.get(empresaId);
  if (!sessoes) return 0;
  const agora = Date.now();
  let ativos = 0;
  for (const [sessionId, ts] of sessoes) {
    if (agora - ts > TTL_MS) sessoes.delete(sessionId);
    else ativos += 1;
  }
  return ativos;
}

module.exports = { ping, contar };
