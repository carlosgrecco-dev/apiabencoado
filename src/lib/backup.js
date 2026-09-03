const fs = require('fs');
const path = require('path');
const { Prisma } = require('@prisma/client');
const prisma = require('./prisma');

const BACKUP_DIR = path.join(__dirname, '..', '..', 'backups');

const garantirPasta = () => {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
};

/**
 * Backup sob demanda — snapshot lógico de TODAS as tabelas via Prisma, num JSON só.
 * Não é um dump binário do Postgres: `pg_dump` não está disponível neste ambiente (nem no
 * dev local, nem confirmado em produção), então em vez de depender de um binário externo frágil,
 * a exportação usa o próprio Prisma (funciona em qualquer ambiente Node, sem dependência externa).
 * Pensado pra reconstrução manual/script em caso de perda de dados, não como restore automático.
 */
const gerarBackup = async () => {
  garantirPasta();
  const modelos = Prisma.dmmf.datamodel.models.map((m) => m.name);
  const dados = {};
  for (const modelo of modelos) {
    const chave = modelo.charAt(0).toLowerCase() + modelo.slice(1);
    dados[modelo] = await prisma[chave].findMany();
  }
  const nomeArquivo = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const caminho = path.join(BACKUP_DIR, nomeArquivo);
  fs.writeFileSync(caminho, JSON.stringify(dados));
  const stat = fs.statSync(caminho);
  return { nomeArquivo, tamanho: stat.size, criadoEm: stat.mtime, totalTabelas: modelos.length };
};

const listarBackups = () => {
  garantirPasta();
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { nomeArquivo: f, tamanho: stat.size, criadoEm: stat.mtime };
    })
    .sort((a, b) => new Date(b.criadoEm).getTime() - new Date(a.criadoEm).getTime());
};

/** Só aceita nomes de arquivo no formato que a gente mesmo gera — evita path traversal. */
const caminhoBackup = (nomeArquivo) => {
  if (!/^backup-[0-9T\-Z]+\.json$/.test(nomeArquivo)) return null;
  const caminho = path.join(BACKUP_DIR, nomeArquivo);
  return fs.existsSync(caminho) ? caminho : null;
};

module.exports = { gerarBackup, listarBackups, caminhoBackup };
