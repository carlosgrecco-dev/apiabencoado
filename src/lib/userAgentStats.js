/**
 * Classificação leve de dispositivo/navegador a partir do header User-Agent — sem biblioteca
 * externa, só o suficiente pra dar uma leitura agregada da plataforma pro Super Admin (nunca
 * usado por pedido/cliente individual). Não tenta ser exaustivo, só cobrir os casos comuns.
 * @param {string|null} userAgent
 */
const classificarDispositivo = (userAgent) => {
  if (!userAgent) return 'Desconhecido';
  const ua = userAgent.toLowerCase();
  if (ua.includes('iphone')) return 'iPhone';
  if (ua.includes('ipad')) return 'iPad';
  if (ua.includes('android')) return ua.includes('mobile') ? 'Android' : 'Android (tablet)';
  if (ua.includes('windows')) return 'Windows';
  if (ua.includes('macintosh') || ua.includes('mac os')) return 'Mac';
  if (ua.includes('linux')) return 'Linux';
  return 'Outro';
};

const classificarNavegador = (userAgent) => {
  if (!userAgent) return 'Desconhecido';
  const ua = userAgent.toLowerCase();
  if (ua.includes('edg/')) return 'Edge';
  if (ua.includes('opr/') || ua.includes('opera')) return 'Opera';
  if (ua.includes('chrome/') && !ua.includes('chromium')) return 'Chrome';
  if (ua.includes('crios/')) return 'Chrome (iOS)';
  if (ua.includes('fxios/')) return 'Firefox (iOS)';
  if (ua.includes('firefox/')) return 'Firefox';
  if (ua.includes('safari/') && !ua.includes('chrome')) return 'Safari';
  return 'Outro';
};

/** Agrega uma lista de User-Agents brutos em contagens por dispositivo e por navegador. */
const agregarDispositivos = (userAgents) => {
  const porDispositivo = new Map();
  const porNavegador = new Map();
  for (const ua of userAgents) {
    const dispositivo = classificarDispositivo(ua);
    const navegador = classificarNavegador(ua);
    porDispositivo.set(dispositivo, (porDispositivo.get(dispositivo) || 0) + 1);
    porNavegador.set(navegador, (porNavegador.get(navegador) || 0) + 1);
  }
  const paraLista = (mapa) => Array.from(mapa.entries())
    .map(([nome, quantidade]) => ({ nome, quantidade }))
    .sort((a, b) => b.quantidade - a.quantidade);
  return { dispositivos: paraLista(porDispositivo), navegadores: paraLista(porNavegador) };
};

module.exports = { classificarDispositivo, classificarNavegador, agregarDispositivos };
