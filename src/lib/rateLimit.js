const rateLimit = require('express-rate-limit');

/**
 * Limita tentativas de login por IP — nenhum endpoint de autenticação tinha proteção contra
 * força bruta antes disso. 10 tentativas por 15 minutos é generoso o bastante pra alguém errar a
 * senha algumas vezes, mas inviabiliza um script tentando muitas combinações seguidas.
 *
 * É uma função (não uma instância pronta) porque express-rate-limit guarda o contador na própria
 * instância do middleware — se os 6 endpoints de login (super admin, admin secundário, master da
 * loja x2, cliente, motoboy) compartilhassem uma só instância, esgotar a tentativa em um login
 * bloquearia os outros pro mesmo IP (ex: um Wi-Fi compartilhado de restaurante, com clientes e
 * equipe tentando logar em portais diferentes ao mesmo tempo). Cada rota chama loginRateLimit()
 * e recebe seu próprio contador independente.
 */
const loginRateLimit = () => rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Aguarde alguns minutos e tente novamente.' },
});

module.exports = { loginRateLimit };
