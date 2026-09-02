const prisma = require('./prisma');

/**
 * Registra uma atividade importante da loja (visível pro próprio lojista em Sistema → Logs) —
 * diferente de registrarLog (auditLog.js), que é da plataforma e só o Super Admin vê. Nunca
 * lança — uma falha ao gravar o log não pode derrubar a requisição original que a disparou.
 * @param {{ empresaId: string, tipo: string, ator?: string|null, descricao: string }} evento
 */
const registrarAtividadeLoja = async (evento) => {
  try {
    await prisma.logAtividadeLoja.create({
      data: {
        empresaId: evento.empresaId,
        tipo: evento.tipo,
        ator: evento.ator || null,
        descricao: evento.descricao,
      },
    });
  } catch (err) {
    console.error('Falha ao gravar log de atividade da loja:', err.message);
  }
};

module.exports = { registrarAtividadeLoja };
