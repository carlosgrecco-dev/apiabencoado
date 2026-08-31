/**
 * Semeia os blocos de conteúdo do CMS do site público (SiteBloco) com o texto atualmente
 * hardcoded nas páginas — pra ativar o CMS sem regredir nenhuma copy existente, mais os 2 CTAs
 * novos de cadastro (Recursos e Política de Privacidade) que essas páginas não tinham antes.
 *
 * Idempotente: roda com upsert por (pagina, chave), então pode ser rodado de novo com segurança
 * se um novo slot for adicionado ao código no futuro.
 *
 * Uso: node prisma/seedSiteBlocos.js  (a partir de api/)
 */
require('dotenv').config();
const prisma = require('../src/lib/prisma');

const BLOCOS = [
  // LANDING
  {
    pagina: 'LANDING', chave: 'hero', tipo: 'HERO',
    titulo: 'Peça online na sua loja favorita, com entrega rápida.',
    subtitulo: 'Cada loja parceira do SaltFood tem seu próprio endereço. Digite o nome do restaurante pra ir direto pro cardápio dele.',
  },
  {
    pagina: 'LANDING', chave: 'features', tipo: 'LISTA_ICONES',
    itens: [
      { icone: 'Store', titulo: 'Loja própria', texto: 'Cada restaurante parceiro tem seu cardápio, marca e link exclusivos.' },
      { icone: 'Zap', titulo: 'Pedido rápido', texto: 'Sem cadastro obrigatório — monta o carrinho e finaliza em poucos toques.' },
      { icone: 'MapPin', titulo: 'Acompanhamento', texto: 'Veja o status do seu pedido do preparo até a entrega, em tempo real.' },
      { icone: 'Wallet', titulo: 'Pagamento flexível', texto: 'Pix, dinheiro ou cartão na entrega — você escolhe o que for mais fácil.' },
    ],
  },
  {
    pagina: 'LANDING', chave: 'cta-rodape', tipo: 'CTA_BANNER',
    icone: 'Store',
    titulo: 'Tem um restaurante e quer vender por aqui?',
    texto: 'Leve o SaltFood pro seu negócio — cardápio digital, pedidos e entrega, tudo em um só lugar, com a sua própria marca.',
    textoBotao: 'Conhecer o programa de parceiros',
    linkBotao: '/parceiro',
  },

  // PARCEIRO
  {
    pagina: 'PARCEIRO', chave: 'hero', tipo: 'HERO',
    eyebrow: 'Seja nosso parceiro',
    titulo: 'Quando você vende, todo mundo faz um bom negócio.',
    subtitulo: 'Leve seu restaurante pro SaltFood — cardápio digital, pedidos, entrega e gestão dos seus motoboys, tudo em um só lugar, com a sua própria marca.',
  },
  {
    pagina: 'PARCEIRO', chave: 'vantagens', tipo: 'LISTA_ICONES',
    itens: [
      { icone: 'Link2', titulo: 'Link exclusivo', texto: 'Sua loja ganha um endereço só seu (saltfood.com.br/sua-loja) pra divulgar nas redes sociais.' },
      { icone: 'Wallet', titulo: 'Pagamento flexível', texto: 'Pix, dinheiro ou cartão na entrega — o cliente escolhe, sem taxa de gateway no meio.' },
      { icone: 'HandCoins', titulo: 'Dinheiro direto com você', texto: 'Sem intermediário retendo o pagamento — o valor da venda vai direto pra loja.' },
      { icone: 'ClipboardList', titulo: 'Painel de pedidos', texto: 'Receba, prepare e imprima a comanda direto do painel ou do app do gestor.' },
      { icone: 'Bike', titulo: 'Gestão de entregadores', texto: 'Cadastre seus próprios motoboys, acompanhe corridas e feche o pagamento de cada um.' },
    ],
  },

  // RECURSOS
  {
    pagina: 'RECURSOS', chave: 'hero', tipo: 'HERO',
    eyebrow: 'Recursos',
    titulo: 'Tudo que o SaltFood oferece',
    subtitulo: 'Uma plataforma de verdade pra rodar seu delivery — do cardápio ao caixa. Alguns itens marcados como "em breve" ainda estão no nosso roadmap; tudo o resto já está no ar hoje.',
  },
  {
    pagina: 'RECURSOS', chave: 'cta-cadastro', tipo: 'CTA_BANNER',
    icone: 'Store',
    titulo: 'Quer ver esses recursos rodando no seu restaurante?',
    texto: 'Cadastre sua empresa no SaltFood e comece a vender com cardápio digital, pedidos, entrega e muito mais — tudo em um só lugar, com a sua própria marca.',
    textoBotao: 'Cadastrar minha empresa',
    linkBotao: '/parceiro',
  },
  {
    pagina: 'RECURSOS', chave: 'cta-rodape', tipo: 'CTA_BANNER',
    icone: 'ShieldCheck',
    titulo: 'Ficou com alguma dúvida sobre algum recurso?',
    texto: 'Conta pra gente o que sua loja precisa e te mostramos como o SaltFood se encaixa.',
    textoBotao: 'Falar com a gente',
    linkBotao: 'abrir-contato',
  },

  // POLITICA_PRIVACIDADE
  {
    pagina: 'POLITICA_PRIVACIDADE', chave: 'cta-rodape', tipo: 'CTA_BANNER',
    icone: 'Store',
    titulo: 'Ainda não vende pelo SaltFood?',
    texto: 'Cadastre seu restaurante na plataforma e leve cardápio digital, pedidos e entrega pro seu negócio — sem complicação, com a sua própria marca.',
    textoBotao: 'Quero cadastrar meu restaurante',
    linkBotao: '/parceiro',
  },
];

(async () => {
  for (const bloco of BLOCOS) {
    const { pagina, chave, ...resto } = bloco;
    await prisma.siteBloco.upsert({
      where: { pagina_chave: { pagina, chave } },
      update: resto,
      create: { pagina, chave, ...resto },
    });
    console.log(`OK  ${pagina}/${chave}`);
  }
  console.log(`\nSeed concluído: ${BLOCOS.length} blocos.`);
  process.exit(0);
})().catch((err) => {
  console.error('Falha ao semear site_blocos:', err);
  process.exit(1);
});
