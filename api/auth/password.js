// api/auth/password.js
// POST /api/auth/password — { current_password, new_password } (JWT 필요)
// 로그인한 본인의 비밀번호만 바꾼다. 현재 비밀번호를 다시 확인한다.
const bcrypt = require('bcrypt');
const { supabase } = require('../../utils/supabase');
const { verifyRequest } = require('../../utils/auth');

const MIN_LEN = 8;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const payload = verifyRequest(req);
  if (!payload?.id) return res.status(401).json({ error: '인증 필요' });

  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password)
    return res.status(400).json({ error: '현재 비밀번호와 새 비밀번호를 입력하세요.' });
  if (typeof new_password !== 'string' || new_password.length < MIN_LEN)
    return res.status(400).json({ error: `새 비밀번호는 ${MIN_LEN}자 이상이어야 합니다.` });
  if (!/[A-Za-z]/.test(new_password) || !/[0-9]/.test(new_password))
    return res.status(400).json({ error: '새 비밀번호에 영문과 숫자를 모두 넣으세요.' });
  if (new_password === current_password)
    return res.status(400).json({ error: '새 비밀번호가 현재 비밀번호와 같습니다.' });

  const { data: user, error } = await supabase
    .from('admin_users')
    .select('id, password_hash')
    .eq('id', payload.id)
    .eq('is_active', true)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!user) return res.status(401).json({ error: '계정을 찾을 수 없습니다.' });

  if (!(await bcrypt.compare(current_password, user.password_hash)))
    return res.status(400).json({ error: '현재 비밀번호가 올바르지 않습니다.' });

  const password_hash = await bcrypt.hash(new_password, 10);
  const { error: upErr } = await supabase
    .from('admin_users')
    .update({ password_hash })
    .eq('id', user.id);
  if (upErr) return res.status(500).json({ error: upErr.message });

  return res.status(200).json({ ok: true });
};
