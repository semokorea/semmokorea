// api/auth/login.js
// POST /api/auth/login — { username, password } → { token, user }
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { supabase } = require('../../utils/supabase');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요.' });

  const { data: user } = await supabase
    .from('admin_users')
    .select('id, username, name, role, password_hash')
    .eq('username', username)
    .eq('is_active', true)
    .maybeSingle();

  // 사용자 없음/비번 불일치 모두 같은 메시지 (계정 존재 여부 노출 방지)
  const ok = user && await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  await supabase.from('admin_users').update({ last_login_at: new Date().toISOString() }).eq('id', user.id);

  res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
};
