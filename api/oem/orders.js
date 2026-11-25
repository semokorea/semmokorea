// api/oem/orders.js
// POST  /api/oem/orders        — OEM 주문 등록
// PATCH /api/oem/orders?id=... — 진행 단계 업데이트 (아래 updateStage 참고)
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
  if (!verifyRequest(req)) return res.status(401).json({ error: '인증 필요' });
  if (req.method === 'POST') return createOrder(req, res);
  if (req.method === 'PATCH') return updateStage(req, res);
  return res.status(405).json({ error: 'Method Not Allowed' });
};

// ── PATCH /api/oem/orders?id=... — 진행 단계 업데이트 ──
// body: { status, date, eta, memo }
// 단계별 이력 테이블이 없어서, 기존 컬럼에 담을 수 있는 것만 저장한다:
//   eta → oem_orders.expected_dt, memo → oem_shipments.memo,
//   중국 물류 이후 첫 진입 날짜 → oem_shipments.shipped_dt,
//   납품완료 → delivered_dt, 정산완료 → settled_dt
// 주문관리 상태: 견적서발행(quoted, 견적서 저장 시 자동 생성) → 주문접수(received) → 샘플진행중(sample)
//               → 메인진행중(production) → 출고중(factory~cleared, 해운 5단계) → 납품완료(delivered/settled)
const STAGE_ORDER = ['quoted', 'received', 'sample', 'production', 'factory', 'china', 'sea', 'customs', 'cleared', 'delivered', 'settled'];
const VALID_STATUS = [...STAGE_ORDER, 'cancelled'];
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);

async function updateStage(req, res) {
  const id = req.query.id;
  const b = req.body || {};
  const status = String(b.status || '');
  const date = b.date ? String(b.date).slice(0, 10) : kstToday();
  const eta = b.eta ? String(b.eta).slice(0, 10) : null;
  const memo = b.memo === undefined ? undefined : (String(b.memo || '').trim() || null);

  if (!id) return res.status(400).json({ error: 'id가 필요합니다.' });
  if (!VALID_STATUS.includes(status)) return res.status(400).json({ error: '단계가 올바르지 않습니다.' });
  if (!isDate(date)) return res.status(400).json({ error: '날짜가 올바르지 않습니다.' });
  if (eta && !isDate(eta)) return res.status(400).json({ error: '예상 도착일이 올바르지 않습니다.' });
  if (memo && memo.length > 500) return res.status(400).json({ error: '메모는 500자 이하로 입력하세요.' });

  const { data: order, error } = await supabase
    .from('oem_orders').select('id, status, delivered_dt').eq('id', id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!order) return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });

  const idx = STAGE_ORDER.indexOf(status);
  const upd = { status };
  if (eta) upd.expected_dt = eta;
  if (status === 'delivered') upd.delivered_dt = date;
  if (status === 'settled') { upd.settled_dt = date; if (!order.delivered_dt) upd.delivered_dt = date; }
  // 이전 단계로 되돌리면 완료 날짜를 지운다
  if (idx >= 0 && idx < STAGE_ORDER.indexOf('delivered')) { upd.delivered_dt = null; upd.settled_dt = null; }
  if (status === 'delivered') upd.settled_dt = null;
  // 견적서발행 → 실제 진행으로 바뀌는 순간: 주문일을 그날로, 연결된 견적서는 '확정'
  const becameOrder = order.status === 'quoted' && status !== 'quoted' && status !== 'cancelled';
  if (becameOrder) upd.order_dt = date;

  const { data: updated, error: upErr } = await supabase
    .from('oem_orders').update(upd).eq('id', id).select().single();
  if (upErr) return res.status(500).json({ error: upErr.message });

  if (becameOrder) {
    const { error: qErr } = await supabase.from('oem_quotations')
      .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
      .eq('oem_order_id', id);
    if (qErr) console.error('[OEM] 견적서 확정 반영 실패:', qErr.message);
  }

  // 배송 정보(oem_shipments)는 주문당 한 줄로 유지
  const { data: ships, error: shErr } = await supabase
    .from('oem_shipments').select('id, shipped_dt').eq('oem_order_id', id).limit(1);
  if (shErr) return res.status(500).json({ error: shErr.message });
  const ship = ships && ships[0];
  const shipUpd = {};
  if (memo !== undefined) shipUpd.memo = memo;
  if (idx >= STAGE_ORDER.indexOf('china') && !(ship && ship.shipped_dt)) shipUpd.shipped_dt = date;
  if (status === 'delivered' || status === 'settled') shipUpd.delivered_dt = upd.delivered_dt || order.delivered_dt;
  else if (upd.delivered_dt === null && ship && ship.delivered_dt) shipUpd.delivered_dt = null;

  if (Object.keys(shipUpd).length) {
    const { error: e2 } = ship
      ? await supabase.from('oem_shipments').update(shipUpd).eq('id', ship.id)
      : await supabase.from('oem_shipments').insert({ oem_order_id: id, ...shipUpd });
    if (e2) return res.status(500).json({ error: e2.message });
  }

  return res.status(200).json(updated);
}

// ── POST: 주문 등록 ──
async function createOrder(req, res) {
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
}
