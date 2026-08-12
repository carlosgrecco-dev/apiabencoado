const prisma = require('./prisma');

/**
 * Registra um evento de auditoria (acesso, erro do servidor ou alteração crítica). Nunca lança —
 * uma falha ao gravar o log não pode derrubar a requisição original que a disparou.
 * @param {{ tipo: 'ACESSO'|'ERRO'|'ALTERACAO_CRITICA', empresaId?: string|null, empresaNome?: string|null, ator?: string|null, acao: string, detalhes?: object|null }} evento
 */
const registrarLog = async (evento) => {
  try {
    await prisma.logAuditoria.create({
      data: {
        tipo: evento.tipo,
        empresaId: evento.empresaId || null,
        empresaNome: evento.empresaNome || null,
        ator: evento.ator || null,
        acao: evento.acao,
        detalhes: evento.detalhes || undefined,
      },
    });
  } catch (err) {
    console.error('Falha ao gravar log de auditoria:', err.message);
  }
};

module.exports = { registrarLog };
