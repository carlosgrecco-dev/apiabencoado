require('dotenv/config');
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./swagger');
const gruposRouter = require('./routes/grupos');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

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

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

app.listen(PORT, () => {
  console.log(`Server rodando na porta ${PORT}`);
  console.log(`Documentação disponível em http://localhost:${PORT}/docs`);
});
