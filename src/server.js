const express = require('express');

const app = express();
const PORT = process.env.PORT || 3001;

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'API online',
    timestamp: new Date().toISOString(),
  });
});

app.get('/ping', (req, res) => {
  res.json({ message: 'pong' });
});

app.listen(PORT, () => {
  console.log(`Server rodando na porta ${PORT}`);
});
