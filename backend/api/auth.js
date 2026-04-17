// backend/api/auth.js
const express  = require('express');
const bcrypt   = require('bcrypt');
const jwt      = require('jsonwebtoken');
const supabase = require('./supabase');

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요.' });

  const { data: user, error } = await supabase
    .from('admin_users')
    .select('*')
    .eq('username', username)
    .eq('is_active', true)
    .single();

  if (error || !user)
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok)
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });

  // JWT 발급 (7일)
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  // 마지막 로그인 업데이트
  await supabase.from('admin_users').update({ last_login_at: new Date() }).eq('id', user.id);

  res.json({
    token,
    user: { id: user.id, name: user.name, role: user.role, username: user.username }
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.json({ message: '로그아웃 완료' });
});

module.exports = router;

// ── 초기 관리자 계정 생성 SQL (Supabase SQL Editor에서 실행) ──
/*
INSERT INTO admin_users (username, password_hash, name, role) VALUES
  ('admin',   '$2b$10$[bcrypt_hash_of_Admin1234!]', '대표 관리자', 'owner'),
  ('manager', '$2b$10$[bcrypt_hash_of_Mgr5678!]',   '운영 매니저', 'manager');

-- bcrypt 해시 생성 (Node.js):
-- const bcrypt = require('bcrypt');
-- console.log(await bcrypt.hash('Admin1234!', 10));
-- console.log(await bcrypt.hash('Mgr5678!', 10));
*/
