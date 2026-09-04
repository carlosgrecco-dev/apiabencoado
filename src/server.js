require('dotenv/config');
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./swagger');
const { authenticate } = require('./lib/auth');
const prisma = require('./lib/prisma');
const superAdminRouter = require('./routes/superAdmin');
const empresasRouter = require('./routes/empresas');
const motoboysRouter = require('./routes/motoboys');
const movimentosCaixaRouter = require('./routes/movimentosCaixa');
const financeiroRouter = require('./routes/financeiro');
const produtosRouter = require('./routes/produtos');
const categoriasRouter = require('./routes/categorias');
const pedidosRouter = require('./routes/pedidos');
const clientesRouter = require('./routes/clientes');
const crmRouter = require('./routes/crm');
const dashboardRouter = require('./routes/dashboard');
const presenceRouter = require('./routes/presence');
const gatewaysPagamentoRouter = require('./routes/gatewaysPagamento');
const heroSlidesRouter = require('./routes/heroSlides');
const cuponsRouter = require('./routes/cupons');
const enderecosRouter = require('./routes/enderecos');
const horariosRouter = require('./routes/horarios');
const zonasEntregaRouter = require('./routes/zonasEntrega');
const freteRouter = require('./routes/frete');
const produtoVariacoesRouter = require('./routes/produtoVariacoes');
const produtoGruposOpcaoRouter = require('./routes/produtoGruposOpcao');
const planosRouter = require('./routes/planos');
const faturasRouter = require('./routes/faturas');
const logsRouter = require('./routes/logs');
const configuracoesPlataformaRouter = require('./routes/configuracoesPlataforma');
const leadsComerciaisRouter = require('./routes/leadsComerciais');
const siteBlocosRouter = require('./routes/siteBlocos');
const uploadRouter = require('./routes/upload');
const pushSubscriptionsRouter = require('./routes/pushSubscriptions');
const favoritosRouter = require('./routes/favoritos');
const notificacoesRouter = require('./routes/notificacoes');
const missoesRouter = require('./routes/missoes');
const ticketsRouter = require('./routes/tickets');
const operadoresPdvRouter = require('./routes/operadoresPdv');
const caixaSessoesRouter = require('./routes/caixaSessoes');
const contasPagarRouter = require('./routes/contasPagar');
const contasReceberRouter = require('./routes/contasReceber');
const fornecedoresRouter = require('./routes/fornecedores');
const logsAtividadeRouter = require('./routes/logsAtividade');
const webhookConfigRouter = require('./routes/webhookConfig');
const usuariosAdminRouter = require('./routes/usuariosAdmin');
const serializeDecimals = require('./lib/serializeDecimals');
const { registrarLog } = require('./lib/auditLog');

const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', true);
app.use(cors());
app.use(express.json());
app.use(authenticate);
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// Garante que campos Decimal (preco, valor, taxa...) saiam como number no JSON, não string.
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body) => originalJson(serializeDecimals(body));
  next();
});

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/docs.json', (req, res) => res.json(swaggerSpec));

/**
 * @openapi
 * /:
 *   get:
 *     summary: Status da API
 *     tags: [Status]
 *     responses:
 *       200:
 *         description: API está online
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: online
 *                 message:
 *                   type: string
 *                   example: API online
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 */
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'API online',
    timestamp: new Date().toISOString(),
  });
});

/**
 * @openapi
 * /ping:
 *   get:
 *     summary: Testa se a API está respondendo
 *     tags: [Status]
 *     responses:
 *       200:
 *         description: Pong
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: pong
 */
/**
 * @openapi
 * /app-version:
 *   get:
 *     summary: Versão atual e mínima suportada do app Flutter (Gestor de Pedidos), pra checagem de atualização
 *     tags: [Status]
 *     responses:
 *       200:
 *         description: Versões de referência
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ultimaVersao: { type: string, example: "1.0.3" }
 *                 versaoMinima: { type: string, example: "1.0.3" }
 */
// Bump junto com app/pubspec.yaml sempre que uma nova versão do APK for publicada.
// VERSAO_MINIMA_APP só sobe quando uma mudança no backend quebra versões antigas do app de
// verdade (ex: um campo que passou a ser obrigatório) — força update só quando é preciso.
const ULTIMA_VERSAO_APP = '1.2.0';
const VERSAO_MINIMA_APP = '1.0.3'; // v1.0.3 trouxe a confirmação de pagamento obrigatória

app.get('/app-version', (req, res) => {
  res.json({ ultimaVersao: ULTIMA_VERSAO_APP, versaoMinima: VERSAO_MINIMA_APP });
});

app.get('/ping', (req, res) => {
  res.json({ message: 'pong' });
});

/**
 * @openapi
 * /status-publico:
 *   get:
 *     summary: Status público da plataforma (operacional/instável) — sem autenticação, pra uma página de status pública
 *     tags: [Status]
 *     responses:
 *       200:
 *         description: Status real, calculado na hora (ping no banco de dados)
 */
app.get('/status-publico', async (req, res) => {
  let operacional = true;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    operacional = false;
  }
  res.json({ operacional, verificadoEm: new Date().toISOString() });
});

app.use('/super-admin', superAdminRouter);
app.use('/empresas', empresasRouter);
app.use('/empresas/:empresaId/motoboys', motoboysRouter);
app.use('/empresas/:empresaId/movimentos-caixa', movimentosCaixaRouter);
app.use('/empresas/:empresaId/financeiro', financeiroRouter);
app.use('/empresas/:empresaId/produtos', produtosRouter);
app.use('/empresas/:empresaId/categorias', categoriasRouter);
app.use('/empresas/:empresaId/pedidos', pedidosRouter);
app.use('/empresas/:empresaId/clientes', clientesRouter);
app.use('/empresas/:empresaId/crm', crmRouter);
app.use('/empresas/:empresaId/dashboard', dashboardRouter);
app.use('/empresas/:empresaId/presence', presenceRouter);
app.use('/empresas/:empresaId/gateways-pagamento', gatewaysPagamentoRouter);
app.use('/empresas/:empresaId/hero-slides', heroSlidesRouter);
app.use('/empresas/:empresaId/cupons', cuponsRouter);
app.use('/empresas/:empresaId/clientes/:clienteId/enderecos', enderecosRouter);
app.use('/empresas/:empresaId/clientes/:clienteId/favoritos', favoritosRouter);
app.use('/empresas/:empresaId/clientes/:clienteId/notificacoes', notificacoesRouter);
app.use('/empresas/:empresaId/missoes', missoesRouter);
app.use('/empresas/:empresaId/tickets', ticketsRouter);
app.use('/empresas/:empresaId/operadores-pdv', operadoresPdvRouter);
app.use('/empresas/:empresaId/caixa-sessoes', caixaSessoesRouter);
app.use('/empresas/:empresaId/contas-pagar', contasPagarRouter);
app.use('/empresas/:empresaId/contas-receber', contasReceberRouter);
app.use('/empresas/:empresaId/fornecedores', fornecedoresRouter);
app.use('/empresas/:empresaId/logs-atividade', logsAtividadeRouter);
app.use('/empresas/:empresaId/webhook', webhookConfigRouter);
app.use('/empresas/:empresaId/usuarios-admin', usuariosAdminRouter);
app.use('/empresas/:empresaId/horarios', horariosRouter);
app.use('/empresas/:empresaId/zonas-entrega', zonasEntregaRouter);
app.use('/empresas/:empresaId/frete', freteRouter);
app.use('/empresas/:empresaId/produtos/:produtoId/variacoes', produtoVariacoesRouter);
app.use('/empresas/:empresaId/produtos/:produtoId/grupos-opcao', produtoGruposOpcaoRouter);
app.use('/empresas/:empresaId/push', pushSubscriptionsRouter);
app.use('/planos', planosRouter);
app.use('/faturas', faturasRouter);
app.use('/logs', logsRouter);
app.use('/configuracoes-plataforma', configuracoesPlataformaRouter);
app.use('/leads-comerciais', leadsComerciaisRouter);
app.use('/site-blocos', siteBlocosRouter);
app.use('/uploads', uploadRouter);

app.use((err, req, res, next) => {
  console.error(err);
  registrarLog({
    tipo: 'ERRO',
    ator: 'servidor',
    acao: `Erro 500 em ${req.method} ${req.originalUrl}`,
    detalhes: { message: err.message },
  });
  res.status(500).json({ error: 'Erro interno do servidor' });
});

app.listen(PORT, () => {
  console.log(`Server rodando na porta ${PORT}`);
  console.log(`Documentação disponível em http://localhost:${PORT}/docs`);
});
