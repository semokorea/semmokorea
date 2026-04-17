require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const jwt     = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

// ── 인증 미들웨어 ──
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '인증 필요' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: '토큰 만료 또는 유효하지 않음' });
  }
}

// ── 라우터 ──
app.use('/api/auth',      require('./auth'));
app.use('/api/orders',    authMiddleware, require('./orders'));
app.use('/api/shipments', authMiddleware, require('./shipments'));
app.use('/api/invoice',   authMiddleware, require('./invoice'));
app.use('/api/inventory', authMiddleware, require('./inventory'));
app.use('/api/oem',       authMiddleware, require('./oem'));

// 로컬 개발 전용 서버 실행
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`세모코리아 API 서버: http://localhost:${PORT}`));
}

module.exports = app;
