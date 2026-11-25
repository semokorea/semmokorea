// api/oem/orders.js
// POST /api/oem/orders — OEM 주문 등록
// body: { client_id, title, expected_dt, quantity, unit_price, memo }
// 주문번호는 OEM-YYMM-NNN (KST 기준 월별 일련번호), 상태는 'received'(주문 접수)로 시작.
// total_amount = 공급가액(수량×단가), vat_amount = 10%
const { supabase } = require('../../utils/supabase');
const { verifyRequest } = require('../../utils/auth');

const MAX_INT = 2147483647;

function kstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function toInt(v) {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n) : NaN;
}

async function nextOrderNo(prefix) {
  const { data, error } = await supabase
    .from('oem_orders')
    .select('order_no')
    .like('order_no', prefix + '%')
    .order('order_no', { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const last = data && data[0] ? parseInt(data[0].order_no.slice(prefix.length), 10) || 0 : 0;
  return prefix + String(last + 1).padStart(3, '0');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!verifyRequest(req)) return res.status(401).json({ error: '인증 필요' });

  const b = req.body || {};
  const title = String(b.title || '').trim();
  const quantity = toInt(b.quantity);
  const unit_price = toInt(b.unit_price);
  const expected_dt = b.expected_dt ? String(b.expected_dt).slice(0, 10) : null;

  if (!b.client_id) return res.status(400).json({ error: '거래처를 선택하세요.' });
  if (!title) return res.status(400).json({ error: '주문 내용을 입력하세요.' });
  if (title.length > 200) return res.status(400).json({ error: '주문 내용은 200자 이하로 입력하세요.' });
  if (!(quantity > 0)) return res.status(400).json({ error: '수량을 1 이상 입력하세요.' });
  if (!(unit_price >= 0)) return res.status(400).json({ error: '단가가 올바르지 않습니다.' });
  if (expected_dt && !/^\d{4}-\d{2}-\d{2}$/.test(expected_dt)) return res.status(400).json({ error: '납품예정일이 올바르지 않습니다.' });

  const total_amount = quantity * unit_price;
  if (total_amount > MAX_INT) return res.status(400).json({ error: '주문 금액이 너무 큽니다.' });

  const { data: client, error: clErr } = await supabase
    .from('oem_clients').select('id').eq('id', b.client_id).maybeSingle();
  if (clErr) return res.status(500).json({ error: clErr.message });
  if (!client) return res.status(400).json({ error: '거래처를 찾을 수 없습니다.' });

  const today = kstToday();
  const prefix = `OEM-${today.slice(2, 4)}${today.slice(5, 7)}-`;
  const row = {
    client_id:    b.client_id,
    status:       'received',
    title,
    total_amount,
    vat_amount:   Math.round(total_amount * 0.1),
    order_dt:     today,
    expected_dt,
    memo:         String(b.memo || '').trim() || null
  };

  // 동시에 등록하면 같은 번호가 나올 수 있어 UNIQUE 충돌(23505) 시 번호를 다시 뽑는다
  let order = null;
  for (let attempt = 0; attempt < 3 && !order; attempt++) {
    let order_no;
    try {
      order_no = await nextOrderNo(prefix);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    const { data, error } = await supabase.from('oem_orders').insert({ ...row, order_no }).select().single();
    if (!error) order = data;
    else if (error.code !== '23505') return res.status(500).json({ error: error.message });
  }
  if (!order) return res.status(409).json({ error: '주문번호 생성에 실패했습니다. 다시 시도하세요.' });

  const { error: itemErr } = await supabase.from('oem_order_items').insert({
    oem_order_id: order.id,
    product_name: title,
    quantity,
    unit_price,
    total_price:  total_amount
  });
  if (itemErr) {
    // 품목 저장 실패 시 주문도 되돌려 반쪽 데이터가 남지 않게 한다
    await supabase.from('oem_orders').delete().eq('id', order.id);
    return res.status(500).json({ error: itemErr.message });
  }

  return res.status(201).json(order);
};
