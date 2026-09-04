const fs = require('fs');
const path = require('path');
const { Prisma } = require('@prisma/client');
const prisma = require('./prisma');

const BACKUP_DIR = path.join(__dirname, '..', '..', 'backups');

const PADRAO_TENANT = /^backup-tenant-([0-9a-fA-F-]{36})-([0-9T\-Z]+)\.json$/;

const garantirPasta = () => {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
};

/** Modelos do schema que têm um campo escalar com esse nome (ex: "empresaId" — usado pra achar todo modelo escopado por tenant). */
const listarModelosComCampoEscalar = (nomeCampo) =>
  Prisma.dmmf.datamodel.models.filter((m) => m.fields.some((f) => f.name === nomeCampo && f.kind === 'scalar'));

/** Roda findMany em cada modelo (com where opcional, calculado por modelo) e monta um objeto { NomeDoModelo: [...linhas] }. */
const montarSnapshot = async (modelos, whereFn) => {
  const dados = {};
  for (const modelo of modelos) {
    const chave = modelo.name.charAt(0).toLowerCase() + modelo.name.slice(1);
    dados[modelo.name] = await prisma[chave].findMany(whereFn ? { where: whereFn(modelo) } : undefined);
  }
  return dados;
};

const escreverArquivo = (dados, nomeArquivo, totalTabelas) => {
  garantirPasta();
  const caminho = path.join(BACKUP_DIR, nomeArquivo);
  fs.writeFileSync(caminho, JSON.stringify(dados));
  const stat = fs.statSync(caminho);
  return { nomeArquivo, tamanho: stat.size, criadoEm: stat.mtime, totalTabelas };
};

/**
 * Backup sob demanda — snapshot lógico de TODAS as tabelas via Prisma, num JSON só.
 * Não é um dump binário do Postgres: `pg_dump` não está disponível neste ambiente (nem no
 * dev local, nem confirmado em produção), então em vez de depender de um binário externo frágil,
 * a exportação usa o próprio Prisma (funciona em qualquer ambiente Node, sem dependência externa).
 * Pensado pra reconstrução manual/script em caso de perda de dados, não como restore automático.
 */
const gerarBackup = async () => {
  const modelos = Prisma.dmmf.datamodel.models;
  const dados = await montarSnapshot(modelos);
  const nomeArquivo = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  return escreverArquivo(dados, nomeArquivo, modelos.length);
};

/**
 * Backup de UM tenant. `Empresa` é tratada à parte (tem campo `id`, não `empresaId`) — sem esse
 * caso especial, o mecanismo genérico pularia silenciosamente a própria linha da empresa. Depois,
 * todo modelo com um campo escalar `empresaId` no schema entra, filtrado por essa empresa. Modelos
 * sem `empresaId` direto (Plano, CampanhaMarketing, WebhookLog — escopado por webhookConfigId, não
 * empresaId — etc.) ficam de fora de propósito: são platform-level ou escopados indiretamente,
 * fora do alcance deste mecanismo genérico.
 */
const gerarBackupTenant = async (empresaId) => {
  const empresa = await prisma.empresa.findUnique({ where: { id: empresaId } });
  if (!empresa) return null;

  const modelosEscopados = listarModelosComCampoEscalar('empresaId');
  const dadosEscopados = await montarSnapshot(modelosEscopados, () => ({ empresaId }));
  const dados = { Empresa: [empresa], ...dadosEscopados };

  const nomeArquivo = `backup-tenant-${empresaId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const resultado = escreverArquivo(dados, nomeArquivo, modelosEscopados.length + 1);
  return { ...resultado, empresaId, empresaNome: empresa.nome };
};

/** Escopo é lido do próprio nome do arquivo — sem tabela nova no banco pra rastrear backups. */
const listarBackups = () => {
  garantirPasta();
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      const tenantMatch = f.match(PADRAO_TENANT);
      return {
        nomeArquivo: f,
        tamanho: stat.size,
        criadoEm: stat.mtime,
        escopo: tenantMatch ? 'TENANT' : 'PLATAFORMA',
        empresaId: tenantMatch ? tenantMatch[1] : null,
      };
    })
    .sort((a, b) => new Date(b.criadoEm).getTime() - new Date(a.criadoEm).getTime());
};

/** Só aceita nomes de arquivo que já existem de verdade na pasta de backups — evita path traversal sem precisar manter um regex por formato de nome. */
const caminhoBackup = (nomeArquivo) => {
  const base = path.basename(nomeArquivo);
  garantirPasta();
  return fs.readdirSync(BACKUP_DIR).includes(base) ? path.join(BACKUP_DIR, base) : null;
};

/** Apaga um arquivo de backup do disco. Não há política de retenção automática hoje — essa é a única forma de limpar espaço. */
const removerBackup = (nomeArquivo) => {
  const caminho = caminhoBackup(nomeArquivo);
  if (!caminho) return false;
  fs.unlinkSync(caminho);
  return true;
};

module.exports = { gerarBackup, gerarBackupTenant, listarBackups, caminhoBackup, removerBackup };
