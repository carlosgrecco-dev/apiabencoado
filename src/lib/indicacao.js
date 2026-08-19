const crypto = require('node:crypto');
const prisma = require('./prisma');

// Sem O/0/I/1 — evita confusão visual quando o cliente compartilha o código de viva voz ou por print.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TAMANHO_CODIGO = 6;

const gerarCodigo = () => {
  let codigo = '';
  for (let i = 0; i < TAMANHO_CODIGO; i++) {
    codigo += ALFABETO[crypto.randomInt(ALFABETO.length)];
  }
  return codigo;
};

/** Gera um código de indicação único dentro da empresa (o espaço de códigos é grande, mas confere pra garantir). */
const gerarCodigoIndicacaoUnico = async (empresaId) => {
  for (let tentativa = 0; tentativa < 10; tentativa++) {
    const codigo = gerarCodigo();
    const existente = await prisma.cliente.findFirst({ where: { empresaId, codigoIndicacao: codigo } });
    if (!existente) return codigo;
  }
  throw new Error('Não foi possível gerar um código de indicação único');
};

/** Unidades de fidelidade creditadas pra cada lado (quem indicou e quem foi indicado) na primeira compra concluída do indicado — usado quando a loja não habilitou o modo avançado (valor fixo, não configurável). */
const RECOMPENSA_INDICACAO_UNIDADES = 3;

/** Marcos de indicações concluídas (só quem indica) que liberam um bônus extra — só vale com Empresa.habilitarIndicacaoAvancada=true. */
const MARCOS_INDICACAO = [
  { meta: 3, bonus: 5 },
  { meta: 10, bonus: 15 },
  { meta: 25, bonus: 40 },
];

/** Se `total` bater exatamente num marco, devolve o bônus daquele marco; senão null. */
const bonusPorMarco = (total) => MARCOS_INDICACAO.find((m) => m.meta === total)?.bonus ?? null;

module.exports = { gerarCodigoIndicacaoUnico, RECOMPENSA_INDICACAO_UNIDADES, MARCOS_INDICACAO, bonusPorMarco };
