// api/oem/clients.js
// POST  /api/oem/clients        — 거래처 등록
// PATCH /api/oem/clients?id=... — 거래처 수정
// body: { name, biz_no, rep_name, phone, email, address, memo, monthly_goal }
const { supabase } = require('../../utils/supabase');
const { verifyRequest } = require('../../utils/auth');

const LIMITS = { name: 100, biz_no: 20, rep_name: 50, phone: 20, email: 100 };

function clean(body) {
  const row = {};
  for (const k of ['name', 'biz_no', 'rep_name', 'phone', 'email', 'address', 'memo']) {
    if (body[k] === undefined) continue;
    const v = body[k] === null ? '' : String(body[k]).trim();
    if (LIMITS[k] && v.length > LIMITS[k]) throw new Error(`${k}는 ${LIMITS[k]}자 이하로 입력하세요.`);
    row[k] = v || null;
  }
  if (body.monthly_goal !== undefined) {
    const n = Number(String(body.monthly_goal || 0).replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 0 || n > 2147483647) throw new Error('월 목표 수주액이 올바르지 않습니다.');
    row.monthly_goal = Math.round(n);
  }
  if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) throw new Error('이메일 형식이 올바르지 않습니다.');
  return row;
}

module.exports = async (req, res) => {
  if (!verifyRequest(req)) return res.status(401).json({ error: '인증 필요' });

  let row;
  try {
    row = clean(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  if (req.method === 'POST') {
    if (!row.name) return res.status(400).json({ error: '거래처명을 입력하세요.' });
    const { data, error } = await supabase.from('oem_clients').insert(row).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  if (req.method === 'PATCH') {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id가 필요합니다.' });
    if ('name' in row && !row.name) return res.status(400).json({ error: '거래처명을 입력하세요.' });
    const { data, error } = await supabase.from('oem_clients').update(row).eq('id', id).select().maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: '거래처를 찾을 수 없습니다.' });
    return res.status(200).json(data);
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
};
