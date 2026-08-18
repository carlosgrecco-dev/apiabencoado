const { Router } = require('express');
const multer = require('multer');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');

const router = Router();

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const EXTENSOES_PERMITIDAS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!EXTENSOES_PERMITIDAS.has(ext) || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Apenas imagens são permitidas (jpg, jpeg, png, webp, gif)'));
    }
    cb(null, true);
  },
});

/**
 * @openapi
 * /uploads:
 *   post:
 *     summary: Envia uma imagem (produto, empresa, etc.) e retorna a URL pública
 *     tags: [Upload]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               arquivo: { type: string, format: binary }
 *     responses:
 *       201:
 *         description: Upload concluído
 *       400:
 *         description: Arquivo inválido
 */
/** Não tem :empresaId na URL (o upload é usado antes de se saber o destino final da imagem) —
 * aceita qualquer um dos dois papéis autenticados que fazem upload hoje: admin de alguma loja
 * ou Super Admin. A leitura estática de /uploads/* continua pública (imagem precisa carregar
 * na loja sem login). */
router.post('/', (req, res, next) => {
  if (!req.auth || !['EMPRESA_ADMIN', 'SUPER_ADMIN'].includes(req.auth.role)) {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  next();
}, (req, res) => {
  upload.single('arquivo')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Erro ao enviar arquivo' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }
    const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    res.status(201).json({ url });
  });
});

module.exports = router;
