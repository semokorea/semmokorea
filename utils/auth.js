// utils/auth.js — JWT 검증 공통 모듈
const jwt = require('jsonwebtoken');

// 유효하면 payload 반환, 아니면 null
function verifyRequest(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

module.exports = { verifyRequest };
