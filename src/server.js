require('dotenv/config');
const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./swagger');
const gruposRouter = require('./routes/grupos');
const empresasRouter = require('./routes/empresas');
const motoboysRouter = require('./routes/motoboys');
const movimentosCaixaRouter = require('./routes/movimentosCaixa');
const produtosRouter = require('./routes/produtos');
const pedidosRouter = require('./routes/pedidos');
const clientesRouter = require('./routes/clientes');
const crmRouter = require('./routes/crm');
const gatewaysPagamentoRouter = require('./routes/gatewaysPagamento');
const heroSlidesRouter = require('./routes/heroSlides');
const cuponsRouter = require('./routes/cupons');
const enderecosRouter = require('./routes/enderecos');
const horariosRouter = require('./routes/horarios');
const zonasEntregaRouter = require('./routes/zonasEntrega');
const freteRouter = require('./routes/frete');
const produtoVariacoesRouter = require('./routes/produtoVariacoes');
const planosRouter = require('./routes/planos');
const faturasRouter = require('./routes/faturas');
const logsRouter = require('./routes/logs');
const configuracoesPlataformaRouter = require('./routes/configuracoesPlataforma');
const serializeDecimals = require('./lib/serializeDecimals');
const { registrarLog } = require('./lib/auditLog');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

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
app.get('/ping', (req, res) => {
  res.json({ message: 'pong' });
});

app.use('/grupos', gruposRouter);
app.use('/empresas', empresasRouter);
app.use('/empresas/:empresaId/motoboys', motoboysRouter);
app.use('/empresas/:empresaId/movimentos-caixa', movimentosCaixaRouter);
app.use('/empresas/:empresaId/produtos', produtosRouter);
app.use('/empresas/:empresaId/pedidos', pedidosRouter);
app.use('/empresas/:empresaId/clientes', clientesRouter);
app.use('/empresas/:empresaId/crm', crmRouter);
app.use('/empresas/:empresaId/gateways-pagamento', gatewaysPagamentoRouter);
app.use('/empresas/:empresaId/hero-slides', heroSlidesRouter);
app.use('/empresas/:empresaId/cupons', cuponsRouter);
app.use('/empresas/:empresaId/clientes/:clienteId/enderecos', enderecosRouter);
app.use('/empresas/:empresaId/horarios', horariosRouter);
app.use('/empresas/:empresaId/zonas-entrega', zonasEntregaRouter);
app.use('/empresas/:empresaId/frete', freteRouter);
app.use('/empresas/:empresaId/produtos/:produtoId/variacoes', produtoVariacoesRouter);
app.use('/planos', planosRouter);
app.use('/faturas', faturasRouter);
app.use('/logs', logsRouter);
app.use('/configuracoes-plataforma', configuracoesPlataformaRouter);

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
