const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'API Abençoado',
      version: '1.0.0',
      description: 'Documentação da API',
    },
    servers: [
      { url: '/', description: 'Servidor atual' },
    ],
  },
  apis: ['./src/server.js', './src/routes/*.js'],
};

module.exports = swaggerJsdoc(options);
