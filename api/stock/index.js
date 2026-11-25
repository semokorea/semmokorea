// api/stock/index.js — 상품 등록 + 재고 입고/조정 (JWT 필요)
// POST /api/stock?action=product
//   body: { name, seller_code?, category?, base_price?, options?: ["S","M","L"], alert_qty? }
//   옵션이 없으면 옵션 1개(옵션 정보 없음)로 만든다. 판매자코드를 비우면 자동 생성.
// POST /api/stock?action=adjust
//   body: { option_id, change_qty (+입고 / -출고·조정), reason: 'receive'|'adjust'|'out', memo? }
//   재고가 0 미만이 되는 변경은 거부. stock_logs에 기록을 남긴다.
const { supabase } = require('../../utils/supabase');
const { verifyRequest } = require('../../utils/auth');

const MAX_INT = 2147483647;
const REASONS = ['receive', 'adjust', 'out'];
const toInt = v => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? Math.round(n) : NaN; };

function autoSellerCode() {
  const d = new Date(Date.now() + 9 * 3600 * 1000).toISOString();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `P${d.slice(2, 4)}${d.slice(5, 7)}${d.slice(8, 10)}-${rand}`;
}

async function createProduct(req, res) {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  let seller_code = String(b.seller_code || '').trim();
  const category = String(b.category || '').trim() || null;
  const base_price = toInt(b.base_price || 0);
  const alert_qty = b.alert_qty === undefined || b.alert_qty === '' ? 10 : toInt(b.alert_qty);
  const options = [...new Set((Array.isArray(b.options) ? b.options : [])
    .map(o => String(o || '').trim()).filter(Boolean))];

  if (!name) return res.status(400).json({ error: '상품명을 입력하세요.' });
  if (name.length > 200) return res.status(400).json({ error: '상품명은 200자 이하로 입력하세요.' });
  if (seller_code.length > 50) return res.status(400).json({ error: '판매자코드는 50자 이하로 입력하세요.' });
  if (!(base_price >= 0) || base_price > MAX_INT) return res.status(400).json({ error: '판매가가 올바르지 않습니다.' });
  if (!(alert_qty >= 0) || alert_qty > 100000) return res.status(400).json({ error: '알림 수량이 올바르지 않습니다.' });
  if (options.length > 50) return res.status(400).json({ error: '옵션은 50개까지 입력할 수 있습니다.' });
  if (options.some(o => o.length > 200)) return res.status(400).json({ error: '옵션은 200자 이하로 입력하세요.' });

  const userCode = !!seller_code;
  let product = null;
  for (let attempt = 0; attempt < 3 && !product; attempt++) {
    if (!userCode) seller_code = autoSellerCode();
    const { data, error } = await supabase.from('products')
      .insert({ name, seller_code, category, base_price }).select().single();
    if (!error) product = data;
    else if (error.code === '23505' && userCode) return res.status(400).json({ error: `판매자코드 "${seller_code}"는 이미 사용 중입니다.` });
    else if (error.code !== '23505') return res.status(500).json({ error: error.message });
  }
  if (!product) return res.status(409).json({ error: '판매자코드 생성에 실패했습니다. 다시 시도하세요.' });

  const rows = (options.length ? options : [null]).map((opt, i) => ({
    product_id:  product.id,
    option_info: opt,
    option_code: opt ? `${seller_code}-${i + 1}` : seller_code,
    stock_qty:   0,
    alert_qty
  }));
  const { data: opts, error: optErr } = await supabase.from('product_options').insert(rows).select();
  if (optErr) {
    await supabase.from('products').delete().eq('id', product.id);
    return res.status(500).json({ error: optErr.message });
  }
  return res.status(201).json({ ...product, options: opts });
}

async function adjustStock(req, res) {
  const b = req.body || {};
  const change_qty = toInt(b.change_qty);
  const reason = String(b.reason || 'receive');
  const memo = String(b.memo || '').trim() || null;

  if (!b.option_id) return res.status(400).json({ error: '상품을 선택하세요.' });
  if (!REASONS.includes(reason)) return res.status(400).json({ error: '구분이 올바르지 않습니다.' });
  if (!change_qty || Math.abs(change_qty) > 1000000) return res.status(400).json({ error: '수량을 입력하세요.' });
  if (reason === 'receive' && change_qty < 0) return res.status(400).json({ error: '입고 수량은 양수여야 합니다.' });
  if (reason === 'out' && change_qty > 0) return res.status(400).json({ error: '출고 수량은 음수로 보내야 합니다.' });
  if (memo && memo.length > 500) return res.status(400).json({ error: '메모는 500자 이하로 입력하세요.' });

  const { data: opt, error } = await supabase.from('product_options')
    .select('id, stock_qty').eq('id', b.option_id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!opt) return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });

  const next = opt.stock_qty + change_qty;
  if (next < 0) return res.status(400).json({ error: `재고가 부족합니다. (현재 ${opt.stock_qty}개)` });

  // 동시에 바뀌었으면 덮어쓰지 않도록, 읽은 값과 같을 때만 업데이트 (낙관적 잠금)
  const { data: upd, error: upErr } = await supabase.from('product_options')
    .update({ stock_qty: next }).eq('id', opt.id).eq('stock_qty', opt.stock_qty).select();
  if (upErr) return res.status(500).json({ error: upErr.message });
  if (!upd || !upd.length) return res.status(409).json({ error: '재고가 방금 바뀌었습니다. 새로고침 후 다시 시도하세요.' });

  const { error: logErr } = await supabase.from('stock_logs')
    .insert({ option_id: opt.id, change_qty, reason, memo });
  if (logErr) console.error('[STOCK] 로그 기록 실패:', logErr.message);

  return res.status(200).json({ option_id: opt.id, stock_qty: next });
}

module.exports = async (req, res) => {
  if (!verifyRequest(req)) return res.status(401).json({ error: '인증 필요' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  if (req.query.action === 'product') return createProduct(req, res);
  if (req.query.action === 'adjust') return adjustStock(req, res);
  return res.status(400).json({ error: 'action은 product|adjust 중 하나' });
};
