// api/oem/quotes.js
// POST  /api/oem/quotes        — 견적서 저장
//   body: { client_id, valid_until, shipping_fee, notes, status('draft'|'sent'), items: [{ product_name, quantity, unit_price }] }
// PATCH /api/oem/quotes?id=... — 상태 변경 { status: 'draft'|'sent'|'confirmed' }
// 견적번호는 QT-YYMM-NNN. 금액은 서버에서 다시 계산한다 (공급가액 = Σ수량×단가, 부가세 10%).
const { supabase } = require('../../utils/supabase');
const { verifyRequest } = require('../../utils/auth');

const MAX_INT = 2147483647;
const MAX_ITEMS = 10;
const STATUSES = ['draft', 'sent', 'confirmed'];

const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const toInt = v => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? Math.round(n) : NaN; };

async function nextQuoteNo(prefix) {
  const { data, error } = await supabase
    .from('oem_quotations').select('quote_no')
    .like('quote_no', prefix + '%')
    .order('quote_no', { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  const last = data && data[0] ? parseInt(data[0].quote_no.slice(prefix.length), 10) || 0 : 0;
  return prefix + String(last + 1).padStart(3, '0');
}

async function createQuote(req, res) {
  const b = req.body || {};
  const status = b.status || 'draft';
  const valid_until = b.valid_until ? String(b.valid_until).slice(0, 10) : null;
  const shipping_fee = toInt(b.shipping_fee || 0);
  const notes = String(b.notes || '').trim() || null;

  if (!b.client_id) return res.status(400).json({ error: '거래처를 선택하세요.' });
  if (!['draft', 'sent'].includes(status)) return res.status(400).json({ error: '상태가 올바르지 않습니다.' });
  if (valid_until && !/^\d{4}-\d{2}-\d{2}$/.test(valid_until)) return res.status(400).json({ error: '유효기간이 올바르지 않습니다.' });
  if (!(shipping_fee >= 0)) return res.status(400).json({ error: '배송비가 올바르지 않습니다.' });

  const items = [];
  for (const it of Array.isArray(b.items) ? b.items : []) {
    const name = String(it.product_name || '').trim();
    if (!name) continue; // 빈 줄은 건너뜀
    const quantity = toInt(it.quantity), unit_price = toInt(it.unit_price || 0);
    if (name.length > 200) return res.status(400).json({ error: '품목명은 200자 이하로 입력하세요.' });
    if (!(quantity > 0)) return res.status(400).json({ error: `"${name}" 수량을 1 이상 입력하세요.` });
    if (!(unit_price >= 0)) return res.status(400).json({ error: `"${name}" 단가가 올바르지 않습니다.` });
    items.push({ product_name: name, quantity, unit_price, total_price: quantity * unit_price });
  }
  if (!items.length) return res.status(400).json({ error: '품목을 1개 이상 입력하세요.' });
  if (items.length > MAX_ITEMS) return res.status(400).json({ error: `품목은 최대 ${MAX_ITEMS}개까지입니다.` });

  const total_amount = items.reduce((s, i) => s + i.total_price, 0);
  const vat_amount = Math.round(total_amount * 0.1);
  if (total_amount + vat_amount + shipping_fee > MAX_INT) return res.status(400).json({ error: '견적 금액이 너무 큽니다.' });

  const { data: client, error: clErr } = await supabase
    .from('oem_clients').select('id').eq('id', b.client_id).maybeSingle();
  if (clErr) return res.status(500).json({ error: clErr.message });
  if (!client) return res.status(400).json({ error: '거래처를 찾을 수 없습니다.' });

  const today = kstToday();
  const prefix = `QT-${today.slice(2, 4)}${today.slice(5, 7)}-`;
  const row = {
    client_id: b.client_id, status, valid_until, total_amount, vat_amount, shipping_fee, notes,
    sent_at: status === 'sent' ? new Date().toISOString() : null
  };

  let quote = null;
  for (let attempt = 0; attempt < 3 && !quote; attempt++) {
    let quote_no;
    try { quote_no = await nextQuoteNo(prefix); } catch (e) { return res.status(500).json({ error: e.message }); }
    const { data, error } = await supabase.from('oem_quotations').insert({ ...row, quote_no }).select().single();
    if (!error) quote = data;
    else if (error.code !== '23505') return res.status(500).json({ error: error.message });
  }
  if (!quote) return res.status(409).json({ error: '견적번호 생성에 실패했습니다. 다시 시도하세요.' });

  const { error: itemErr } = await supabase.from('oem_quotation_items')
    .insert(items.map((it, i) => ({ ...it, quotation_id: quote.id, sort_order: i + 1 })));
  if (itemErr) {
    await supabase.from('oem_quotations').delete().eq('id', quote.id);
    return res.status(500).json({ error: itemErr.message });
  }
  return res.status(201).json(quote);
}

async function updateStatus(req, res) {
  const id = req.query.id;
  const status = (req.body || {}).status;
  if (!id) return res.status(400).json({ error: 'id가 필요합니다.' });
  if (!STATUSES.includes(status)) return res.status(400).json({ error: '상태가 올바르지 않습니다.' });
  const upd = { status };
  if (status === 'sent') upd.sent_at = new Date().toISOString();
  if (status === 'confirmed') upd.confirmed_at = new Date().toISOString();
  const { data, error } = await supabase.from('oem_quotations').update(upd).eq('id', id).select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: '견적서를 찾을 수 없습니다.' });
  return res.status(200).json(data);
}

module.exports = async (req, res) => {
  if (!verifyRequest(req)) return res.status(401).json({ error: '인증 필요' });
  if (req.method === 'POST') return createQuote(req, res);
  if (req.method === 'PATCH') return updateStatus(req, res);
  return res.status(405).json({ error: 'Method Not Allowed' });
};
