// api/oem/quotes.js
// POST  /api/oem/quotes        — 견적서 저장
//   body: { client_id, valid_until, shipping_fee, notes, status('draft'|'sent'), items: [{ product_name, quantity, unit_price }] }
// PATCH  /api/oem/quotes?id=... — 상태 변경 { status: 'draft'|'sent'|'confirmed' } (확정 시 주문관리 주문접수로 반영)
// PUT    /api/oem/quotes?id=... — 내용 수정 (등록과 같은 body)
// DELETE /api/oem/quotes?id=... — 삭제
// 견적번호는 QT-YYMM-NNN. 금액은 서버에서 다시 계산한다 (공급가액 = Σ수량×단가, 부가세 10%).
// 저장 시 주문관리에 '견적서발행'(quoted) 상태의 OEM 주문도 만들어 연결한다 (oem_quotations.oem_order_id).
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

// 등록·수정 공통 입력 검증. 오류면 { error }, 정상이면 계산된 값
function parseQuoteBody(b) {
  const valid_until = b.valid_until ? String(b.valid_until).slice(0, 10) : null;
  const shipping_fee = toInt(b.shipping_fee || 0);
  const notes = String(b.notes || '').trim() || null;
  if (!b.client_id) return { error: '거래처를 선택하세요.' };
  if (valid_until && !/^\d{4}-\d{2}-\d{2}$/.test(valid_until)) return { error: '유효기간이 올바르지 않습니다.' };
  if (!(shipping_fee >= 0)) return { error: '배송비가 올바르지 않습니다.' };

  const items = [];
  for (const it of Array.isArray(b.items) ? b.items : []) {
    const name = String(it.product_name || '').trim();
    if (!name) continue; // 빈 줄은 건너뜀
    const quantity = toInt(it.quantity), unit_price = toInt(it.unit_price || 0);
    if (name.length > 200) return { error: '품목명은 200자 이하로 입력하세요.' };
    if (!(quantity > 0)) return { error: `"${name}" 수량을 1 이상 입력하세요.` };
    if (!(unit_price >= 0)) return { error: `"${name}" 단가가 올바르지 않습니다.` };
    items.push({ product_name: name, quantity, unit_price, total_price: quantity * unit_price });
  }
  if (!items.length) return { error: '품목을 1개 이상 입력하세요.' };
  if (items.length > MAX_ITEMS) return { error: `품목은 최대 ${MAX_ITEMS}개까지입니다.` };

  const total_amount = items.reduce((s, i) => s + i.total_price, 0);
  const vat_amount = Math.round(total_amount * 0.1);
  if (total_amount + vat_amount + shipping_fee > MAX_INT) return { error: '견적 금액이 너무 큽니다.' };
  return { client_id: b.client_id, valid_until, shipping_fee, notes, items, total_amount, vat_amount };
}

async function clientExists(id) {
  const { data, error } = await supabase.from('oem_clients').select('id').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return !!data;
}

async function createQuote(req, res) {
  const b = req.body || {};
  const status = b.status || 'draft';
  if (!['draft', 'sent'].includes(status)) return res.status(400).json({ error: '상태가 올바르지 않습니다.' });
  const p = parseQuoteBody(b);
  if (p.error) return res.status(400).json({ error: p.error });
  const { valid_until, shipping_fee, notes, items, total_amount, vat_amount } = p;

  let client;
  try { client = await clientExists(b.client_id); } catch (e) { return res.status(500).json({ error: e.message }); }
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

  // 주문관리에 '견적서발행' 상태의 OEM 주문을 함께 만들고 견적서와 연결한다.
  // 실패해도 견적서는 저장된 상태로 두고 경고만 돌려준다.
  let order = null, warning = null;
  try {
    order = await createQuotedOrder(quote, items, today);
  } catch (e) {
    warning = '견적서는 저장됐지만 주문관리 연결에 실패했습니다: ' + e.message;
    console.error('[QUOTE→ORDER]', e.message);
  }
  return res.status(201).json({ ...quote, oem_order_id: order?.id || null, warning });
}

async function nextOrderNo(prefix) {
  const { data, error } = await supabase
    .from('oem_orders').select('order_no')
    .like('order_no', prefix + '%')
    .order('order_no', { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  const last = data && data[0] ? parseInt(data[0].order_no.slice(prefix.length), 10) || 0 : 0;
  return prefix + String(last + 1).padStart(3, '0');
}

async function createQuotedOrder(quote, items, today, status = 'quoted') {
  const prefix = `OEM-${today.slice(2, 4)}${today.slice(5, 7)}-`;
  const title = items[0].product_name + (items.length > 1 ? ` 외 ${items.length - 1}종` : '');
  let order = null;
  for (let attempt = 0; attempt < 3 && !order; attempt++) {
    const order_no = await nextOrderNo(prefix);
    const { data, error } = await supabase.from('oem_orders').insert({
      order_no,
      client_id:    quote.client_id,
      status,
      title:        title.slice(0, 200),
      total_amount: quote.total_amount,
      vat_amount:   quote.vat_amount,
      shipping_fee: quote.shipping_fee,
      order_dt:     today,
      memo:         `견적서 ${quote.quote_no}`
    }).select().single();
    if (!error) order = data;
    else if (error.code !== '23505') throw new Error(error.message);
  }
  if (!order) throw new Error('주문번호 생성 실패');

  const { error: itemErr } = await supabase.from('oem_order_items').insert(items.map(it => ({
    oem_order_id: order.id,
    product_name: it.product_name,
    quantity:     it.quantity,
    unit_price:   it.unit_price,
    total_price:  it.total_price
  })));
  if (itemErr) {
    await supabase.from('oem_orders').delete().eq('id', order.id);
    throw new Error(itemErr.message);
  }

  const { error: linkErr } = await supabase.from('oem_quotations').update({ oem_order_id: order.id }).eq('id', quote.id);
  if (linkErr) throw new Error(linkErr.message);
  return order;
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

  // 주문관리와 맞추기
  //  - 확정: 연결 주문이 견적서발행이면 → 주문접수(주문일=오늘). 연결 주문이 없으면(예전 견적서) 주문접수로 새로 만든다.
  //  - 확정 취소(작성중/발행완료로 되돌림): 연결 주문이 아직 주문접수면 → 견적서발행
  let order = null, orderAction = null, warning = null;
  try {
    const today = kstToday();
    if (data.oem_order_id) {
      const { data: o, error: oErr } = await supabase.from('oem_orders')
        .select('id, order_no, status').eq('id', data.oem_order_id).maybeSingle();
      if (oErr) throw new Error(oErr.message);
      if (o) {
        let next = null;
        if (status === 'confirmed' && o.status === 'quoted') next = { status: 'received', order_dt: today };
        if (status !== 'confirmed' && o.status === 'received') next = { status: 'quoted' };
        if (next) {
          const { error: uErr } = await supabase.from('oem_orders').update(next).eq('id', o.id);
          if (uErr) throw new Error(uErr.message);
          orderAction = next.status === 'received' ? 'confirmed' : 'reverted';
        }
        order = { id: o.id, order_no: o.order_no, status: next?.status || o.status };
      }
    }
    if (!order && status === 'confirmed') {
      const { data: qItems, error: iErr } = await supabase.from('oem_quotation_items')
        .select('product_name, quantity, unit_price, total_price, sort_order').eq('quotation_id', id);
      if (iErr) throw new Error(iErr.message);
      const items = (qItems || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
      if (items.length) {
        const created = await createQuotedOrder(data, items, today, 'received');
        order = { id: created.id, order_no: created.order_no, status: 'received' };
        orderAction = 'created';
      }
    }
  } catch (e) {
    warning = '견적서 상태는 바뀌었지만 주문관리 반영에 실패했습니다: ' + e.message;
    console.error('[QUOTE→ORDER]', e.message);
  }
  return res.status(200).json({ ...data, order, orderAction, warning });
}

// ── 견적서 수정 저장: PUT /api/oem/quotes?id=...  (등록과 같은 body) ──
// 연결된 주문이 아직 견적서발행이면 주문의 거래처·금액·품목도 같이 고친다.
async function editQuote(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id가 필요합니다.' });
  const p = parseQuoteBody(req.body || {});
  if (p.error) return res.status(400).json({ error: p.error });

  try {
    if (!(await clientExists(p.client_id))) return res.status(400).json({ error: '거래처를 찾을 수 없습니다.' });
    const { data: q, error } = await supabase.from('oem_quotations')
      .update({ client_id: p.client_id, valid_until: p.valid_until, shipping_fee: p.shipping_fee, notes: p.notes,
                total_amount: p.total_amount, vat_amount: p.vat_amount })
      .eq('id', id).select().maybeSingle();
    if (error) throw new Error(error.message);
    if (!q) return res.status(404).json({ error: '견적서를 찾을 수 없습니다.' });

    const { error: dErr } = await supabase.from('oem_quotation_items').delete().eq('quotation_id', id);
    if (dErr) throw new Error(dErr.message);
    const { error: iErr } = await supabase.from('oem_quotation_items')
      .insert(p.items.map((it, i) => ({ ...it, quotation_id: id, sort_order: i + 1 })));
    if (iErr) throw new Error(iErr.message);

    let orderNote = null;
    if (q.oem_order_id) {
      const { data: o } = await supabase.from('oem_orders').select('id, order_no, status').eq('id', q.oem_order_id).maybeSingle();
      if (o && o.status === 'quoted') {
        const title = p.items[0].product_name + (p.items.length > 1 ? ` 외 ${p.items.length - 1}종` : '');
        await supabase.from('oem_orders').update({
          client_id: p.client_id, title: title.slice(0, 200),
          total_amount: p.total_amount, vat_amount: p.vat_amount, shipping_fee: p.shipping_fee
        }).eq('id', o.id);
        await supabase.from('oem_order_items').delete().eq('oem_order_id', o.id);
        await supabase.from('oem_order_items').insert(p.items.map(it => ({
          oem_order_id: o.id, product_name: it.product_name, quantity: it.quantity, unit_price: it.unit_price, total_price: it.total_price
        })));
        orderNote = `주문관리 ${o.order_no}(견적서발행)도 같이 수정했습니다.`;
      } else if (o) {
        orderNote = `주문관리 ${o.order_no}는 이미 진행 중이라 바꾸지 않았습니다. 필요하면 주문을 직접 확인하세요.`;
      }
    }
    return res.status(200).json({ ...q, orderNote });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── 견적서 삭제: DELETE /api/oem/quotes?id=... ──
// 연결된 주문이 아직 견적서발행이면 같이 지우고, 진행 중이면 주문은 남긴다.
async function deleteQuote(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id가 필요합니다.' });
  try {
    const { data: q, error } = await supabase.from('oem_quotations').select('id, quote_no, oem_order_id').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!q) return res.status(404).json({ error: '견적서를 찾을 수 없습니다.' });

    let orderNote = null, deleteOrderId = null;
    if (q.oem_order_id) {
      const { data: o } = await supabase.from('oem_orders').select('id, order_no, status').eq('id', q.oem_order_id).maybeSingle();
      if (o && o.status === 'quoted') { deleteOrderId = o.id; orderNote = `주문관리 ${o.order_no}(견적서발행)도 같이 삭제했습니다.`; }
      else if (o) orderNote = `주문관리 ${o.order_no}는 진행 중이라 남겨 두었습니다.`;
    }

    await supabase.from('oem_quotation_items').delete().eq('quotation_id', id);
    const { error: qErr } = await supabase.from('oem_quotations').delete().eq('id', id);
    if (qErr) throw new Error(qErr.message);
    if (deleteOrderId) {
      await supabase.from('oem_order_items').delete().eq('oem_order_id', deleteOrderId);
      const { error: oErr } = await supabase.from('oem_orders').delete().eq('id', deleteOrderId);
      if (oErr) orderNote = '견적서는 삭제됐지만 주문관리 주문 삭제에 실패했습니다: ' + oErr.message;
    }
    return res.status(200).json({ ok: true, quote_no: q.quote_no, orderNote });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

module.exports = async (req, res) => {
  if (!verifyRequest(req)) return res.status(401).json({ error: '인증 필요' });
  if (req.method === 'POST') return createQuote(req, res);
  if (req.method === 'PATCH') return updateStatus(req, res);
  if (req.method === 'PUT') return editQuote(req, res);
  if (req.method === 'DELETE') return deleteQuote(req, res);
  return res.status(405).json({ error: 'Method Not Allowed' });
};
