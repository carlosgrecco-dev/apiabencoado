const dns = require('dns').promises;
const net = require('net');
const { Jimp } = require('jimp');

const TAMANHOS_VALIDOS = [192, 512];
const TIMEOUT_MS = 8000;
const TAMANHO_MAX_BYTES = 8 * 1024 * 1024;

/** true se o IP for de rede privada/loopback/link-local — usado pra impedir que a rota de ícone
 * (que busca a logoUrl cadastrada pelo lojista) seja usada pra sondar a rede interna (SSRF). */
function ipEhPrivada(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true;
    if (lower.startsWith('::ffff:')) {
      const v4 = lower.split(':').pop();
      return net.isIPv4(v4) ? ipEhPrivada(v4) : true;
    }
    return false;
  }
  return true;
}

/** Baixa uma imagem de URL externa com proteções básicas contra SSRF: só http(s), resolve o
 * host e rejeita IPs privados, sem seguir redirect (evita burlar a checagem de DNS), com timeout
 * e limite de tamanho. */
async function buscarImagemSegura(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('URL de imagem inválida');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Protocolo de imagem não permitido');
  }

  const { address } = await dns.lookup(parsed.hostname);
  if (ipEhPrivada(address)) {
    throw new Error('Endereço de imagem não permitido');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(parsed, { signal: controller.signal, redirect: 'error' });
    if (!resp.ok) throw new Error('Não foi possível baixar a imagem');
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) throw new Error('URL não aponta pra uma imagem');

    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length > TAMANHO_MAX_BYTES) throw new Error('Imagem muito grande');
    return buffer;
  } finally {
    clearTimeout(timeout);
  }
}

/** Gera um ícone quadrado (192 ou 512px) a partir de uma logo qualquer — redimensiona mantendo
 * proporção e centraliza sobre um fundo branco. Maskable ganha ~20% de padding extra (zona de
 * segurança), já que o Android pode recortar o ícone num círculo/squircle. */
async function gerarIconePwa(logoUrl, size, maskable) {
  const tamanho = TAMANHOS_VALIDOS.includes(size) ? size : 192;
  const buffer = await buscarImagemSegura(logoUrl);
  const logo = await Jimp.read(buffer);

  const canvas = new Jimp({ width: tamanho, height: tamanho, color: 0xffffffff });
  const areaUtil = maskable ? Math.round(tamanho * 0.8) : tamanho;

  logo.contain({ w: areaUtil, h: areaUtil });
  const x = Math.round((tamanho - logo.width) / 2);
  const y = Math.round((tamanho - logo.height) / 2);
  canvas.composite(logo, x, y);

  return canvas.getBuffer('image/png');
}

module.exports = { gerarIconePwa, TAMANHOS_VALIDOS };
