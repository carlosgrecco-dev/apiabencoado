const crypto = require('node:crypto');
const prisma = require('./prisma');

// Mesmo alfabeto do código de indicação de cliente (lib/indicacao.js) — sem O/0/I/1.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TAMANHO_CODIGO = 6;

const gerarCodigo = () => {
  let codigo = '';
  for (let i = 0; i < TAMANHO_CODIGO; i++) {
    codigo += ALFABETO[crypto.randomInt(ALFABETO.length)];
  }
  return codigo;
};

/** Gera um código de indicação de EMPRESA único na plataforma inteira (sem escopo — a empresa é o próprio tenant). */
const gerarCodigoIndicacaoEmpresaUnico = async () => {
  for (let tentativa = 0; tentativa < 10; tentativa++) {
    const codigo = gerarCodigo();
    const existente = await prisma.empresa.findUnique({ where: { codigoIndicacao: codigo } });
    if (!existente) return codigo;
  }
  throw new Error('Não foi possível gerar um código de indicação de empresa único');
};

module.exports = { gerarCodigoIndicacaoEmpresaUnico };
