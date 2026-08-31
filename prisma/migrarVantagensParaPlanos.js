/**
 * Migração pontual: a seção de Planos+Vantagens saiu de /parceiro pra virar a nova página /planos.
 * O bloco "vantagens" (PARCEIRO) é MOVIDO pra PLANOS (preserva id e conteúdo — inclusive edições
 * já feitas pelo Super Admin, se houver), e os 2 blocos novos da página (hero, cta-rodape) são
 * criados só se ainda não existirem (nunca sobrescreve um que já esteja lá).
 *
 * Seguro pra rodar mais de uma vez: se já migrado, cada passo vira um no-op.
 *
 * Uso: node prisma/migrarVantagensParaPlanos.js  (a partir de api/)
 */
require('dotenv').config();
const prisma = require('../src/lib/prisma');

(async () => {
  const jaExisteEmPlanos = await prisma.siteBloco.findUnique({
    where: { pagina_chave: { pagina: 'PLANOS', chave: 'vantagens' } },
  });

  if (jaExisteEmPlanos) {
    console.log('PLANOS/vantagens já existe — nada a mover.');
  } else {
    const emParceiro = await prisma.siteBloco.findUnique({
      where: { pagina_chave: { pagina: 'PARCEIRO', chave: 'vantagens' } },
    });
    if (emParceiro) {
      await prisma.siteBloco.update({ where: { id: emParceiro.id }, data: { pagina: 'PLANOS' } });
      console.log('Movido: PARCEIRO/vantagens -> PLANOS/vantagens (id preservado).');
    } else {
      await prisma.siteBloco.create({
        data: {
          pagina: 'PLANOS', chave: 'vantagens', tipo: 'LISTA_ICONES',
          itens: [
            { icone: 'Link2', titulo: 'Link exclusivo', texto: 'Sua loja ganha um endereço só seu (saltfood.com.br/sua-loja) pra divulgar nas redes sociais.' },
            { icone: 'Wallet', titulo: 'Pagamento flexível', texto: 'Pix, dinheiro ou cartão na entrega — o cliente escolhe, sem taxa de gateway no meio.' },
            { icone: 'HandCoins', titulo: 'Dinheiro direto com você', texto: 'Sem intermediário retendo o pagamento — o valor da venda vai direto pra loja.' },
            { icone: 'ClipboardList', titulo: 'Painel de pedidos', texto: 'Receba, prepare e imprima a comanda direto do painel ou do app do gestor.' },
            { icone: 'Bike', titulo: 'Gestão de entregadores', texto: 'Cadastre seus próprios motoboys, acompanhe corridas e feche o pagamento de cada um.' },
          ],
        },
      });
      console.log('Criado do zero: PLANOS/vantagens (não havia bloco em PARCEIRO pra mover).');
    }
  }

  await prisma.siteBloco.upsert({
    where: { pagina_chave: { pagina: 'PLANOS', chave: 'hero' } },
    update: {},
    create: {
      pagina: 'PLANOS', chave: 'hero', tipo: 'HERO',
      eyebrow: 'sem letra miúda',
      titulo: 'Escolha o plano do tamanho do seu negócio',
      subtitulo: 'Sem taxa de adesão, sem contrato de fidelidade — escolha o plano ideal pro tamanho do seu negócio e comece a vender hoje.',
    },
  });
  console.log('OK  PLANOS/hero (criado se não existia)');

  await prisma.siteBloco.upsert({
    where: { pagina_chave: { pagina: 'PLANOS', chave: 'cta-rodape' } },
    update: {},
    create: {
      pagina: 'PLANOS', chave: 'cta-rodape', tipo: 'CTA_BANNER',
      icone: 'MessageSquarePlus',
      titulo: 'Ainda com dúvida sobre qual plano escolher?',
      texto: 'Conta pra gente o tamanho da sua operação e te ajudamos a escolher o plano certo.',
      textoBotao: 'Falar com a gente',
      linkBotao: 'abrir-contato',
    },
  });
  console.log('OK  PLANOS/cta-rodape (criado se não existia)');

  console.log('\nMigração concluída.');
  process.exit(0);
})().catch((err) => {
  console.error('Falha na migração:', err);
  process.exit(1);
});
