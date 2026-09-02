const crypto = require('crypto');
const prisma = require('./prisma');

/**
 * Dispara o webhook configurado da loja pra um evento, se ela tiver um configurado, ativo, e
 * inscrito nesse evento. Nunca lança — é sempre fire-and-forget, chamado fora de qualquer
 * transação, e uma falha de rede/DNS/timeout do destino não pode derrubar a requisição original.
 * Assina o corpo com HMAC-SHA256 (header X-Webhook-Signature) usando o secret da própria loja,
 * pro destino poder validar que o disparo veio mesmo da SaltFood.
 * @param {string} empresaId
 * @param {string} evento - um de EVENTOS_WEBHOOK (webhookEventos.js)
 * @param {object} dados
 */
const dispararWebhook = async (empresaId, evento, dados) => {
  try {
    const config = await prisma.webhookConfig.findUnique({ where: { empresaId } });
    if (!config || !config.ativo || !config.eventos.includes(evento)) return;

    const corpo = JSON.stringify({ evento, dados, disparadoEm: new Date().toISOString() });
    const assinatura = crypto.createHmac('sha256', config.secret).update(corpo).digest('hex');

    let statusCode = null;
    let sucesso = false;
    let erro = null;
    try {
      const resposta = await fetch(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': assinatura },
        body: corpo,
        signal: AbortSignal.timeout(8000),
      });
      statusCode = resposta.status;
      sucesso = resposta.ok;
    } catch (err) {
      erro = err.message;
    }

    await prisma.webhookLog.create({
      data: { webhookConfigId: config.id, evento, statusCode, sucesso, erro },
    });
  } catch (err) {
    console.error('Falha ao processar disparo de webhook:', err.message);
  }
};

module.exports = { dispararWebhook };
