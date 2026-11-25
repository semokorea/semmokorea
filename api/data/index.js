// api/data/index.js
// GET  /api/data?type=shop|stock|sales|oem|qna  — 어드민 화면용 조회 API
// POST /api/data (action=collect_qna|answer_qna)  — Q&A 수집/답변 (Vercel 함수 개수 제한 때문에 여기에 묶음)
const { supabase } = require('../../utils/supabase');
const { verifyRequest } = require('../../utils/auth');

// 주문 상태 그룹
const PENDING = ['new', 'confirmed', 'preparing', 'ready'];

// KST 기준 날짜 문자열 (YYYY-MM-DD). DB의 order_dt는 timezone 없는 TIMESTAMP라 KST 날짜로 비교한다.
function kstDate(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

function check(error) {
  if (error) throw new Error(error.message);
}

// ── 쇼핑몰: 오늘 현황 + 기간 내 주문(스토어별 집계용) + 발송 대기 ──
// days: 주문일 기준 최근 며칠 (1=오늘, 기본 7, 최대 90)
async function getShop({ days } = {}) {
  const today = kstDate();
  const nDays = Math.max(1, Math.min(90, parseInt(days, 10) || 7));
  const since = kstDate(-(nDays - 1));

  const [recent, pending, todayOrders, shippedToday, shipping, deliveredToday] = await Promise.all([
    supabase
      .from('orders')
      .select(`
        id, channel_order_no, channel_item_no, status, buyer_name, receiver_name,
        address_full, delivery_message, total_amount, shipping_fee, order_dt,
        channels ( code, name ),
        order_items ( product_name, option_info, quantity ),
        shipments ( tracking_no, carrier, status )
      `)
      .gte('order_dt', since)
      .order('order_dt', { ascending: false, nullsFirst: false })
      .limit(5000),
    supabase
      .from('orders')
      .select(`
        id, channel_order_no, status, receiver_name, delivery_message,
        channels ( code, name ),
        order_items ( product_name, option_info, quantity )
      `)
      .in('status', PENDING)
      .order('order_dt', { ascending: true })
      .limit(200),
    supabase
      .from('orders')
      .select('total_amount, status')
      .gte('order_dt', today)
      .lt('order_dt', kstDate(1)),
    supabase
      .from('shipments')
      .select('id', { count: 'exact', head: true })
      .gte('shipped_dt', today),
    // 배송중: 현재 발송돼서 아직 도착 안 한 주문 (status='shipped')
    supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'shipped'),
    // 배송완료: 오늘 도착 완료된 배송 (shipments.delivered_dt = 오늘)
    supabase
      .from('shipments')
      .select('id', { count: 'exact', head: true })
      .gte('delivered_dt', today)
      .lt('delivered_dt', kstDate(1))
  ]);
  [recent, pending, todayOrders, shippedToday, shipping, deliveredToday].forEach(r => check(r.error));

  const todayRows = todayOrders.data || [];
  const live = todayRows.filter(o => o.status !== 'cancelled');
  return {
    metrics: {
      today_orders:    live.length,
      pending:         (pending.data || []).length,
      shipped_today:   shippedToday.count || 0,
      today_sales:     live.reduce((s, o) => s + (o.total_amount || 0), 0),
      shipping:        shipping.count || 0,          // 전체 배송중(아직 도착 전)
      delivered_today: deliveredToday.count || 0     // 오늘 도착 완료
    },
    period:  { days: nDays, from: since, to: today },
    orders:  recent.data || [],
    pending: pending.data || []
  };
}

// ── 재고 ──
async function getStock() {
  const { data, error } = await supabase
    .from('product_options')
    .select('id, option_code, option_info, stock_qty, alert_qty, products ( name, seller_code, is_active )')
    .order('stock_qty', { ascending: true });
  check(error);

  const rows = (data || []).filter(r => r.products?.is_active !== false);
  const { data: outLogs, error: logErr } = await supabase
    .from('stock_logs')
    .select('change_qty')
    .eq('reason', 'out')   // 실사 조정(adjust)은 출고로 세지 않음
    .lt('change_qty', 0)
    .gte('created_at', kstDate());
  check(logErr);

  return {
    metrics: {
      sku:     rows.length,
      danger:  rows.filter(r => r.stock_qty < r.alert_qty).length,
      warning: rows.filter(r => r.stock_qty >= r.alert_qty && r.stock_qty < r.alert_qty * 2).length,
      out_today: (outLogs || []).reduce((s, l) => s - l.change_qty, 0)
    },
    items: rows
  };
}

// ── 매출 ──
async function getSales() {
  const today = kstDate();
  const monthStart = today.slice(0, 8) + '01';
  const [y, m] = monthStart.split('-').map(Number);
  const prevMonthStart = (m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`) + '-01';
  const weekStart = kstDate(-6);
  const fromDate = prevMonthStart < weekStart ? prevMonthStart : weekStart;

  const { data, error } = await supabase
    .from('orders')
    .select('total_amount, status, order_dt, channels ( code, name )')
    .gte('order_dt', fromDate)
    .limit(10000);
  check(error);

  const rows = data || [];
  const sold = o => o.status !== 'cancelled' && o.status !== 'returned';
  const inRange = (o, a, b) => o.order_dt && o.order_dt.slice(0, 10) >= a && (!b || o.order_dt.slice(0, 10) < b);

  const thisMonth = rows.filter(o => inRange(o, monthStart));
  const prevMonth = rows.filter(o => inRange(o, prevMonthStart, monthStart));
  const thisSold = thisMonth.filter(sold);
  const sum = list => list.reduce((s, o) => s + (o.total_amount || 0), 0);

  // 지난달 같은 기간 대비 증감
  const day = Number(today.slice(8, 10));
  const prevSameRange = prevMonth.filter(sold).filter(o => Number(o.order_dt.slice(8, 10)) <= day);

  const channels = {};
  for (const o of thisSold) {
    const code = o.channels?.code || 'etc';
    channels[code] = channels[code] || { code, name: o.channels?.name || code, amount: 0, count: 0 };
    channels[code].amount += o.total_amount || 0;
    channels[code].count++;
  }

  const daily = [];
  for (let i = 6; i >= 0; i--) {
    const d = kstDate(-i);
    daily.push({ date: d, amount: sum(rows.filter(o => sold(o) && o.order_dt && o.order_dt.slice(0, 10) === d)) });
  }

  return {
    month_sales:      sum(thisSold),
    prev_same_period: sum(prevSameRange),
    month_orders:     thisSold.length,
    return_rate:      thisMonth.length ? thisMonth.filter(o => o.status === 'returned').length / thisMonth.length : 0,
    channels:         Object.values(channels).sort((a, b) => b.amount - a.amount),
    daily
  };
}

// ── OEM: 주문 + 견적서 + 거래처 ──
async function getOem() {
  const today     = kstDate();
  const monthStart = today.slice(0, 8) + '01';
  const yearStart  = today.slice(0, 4) + '-01-01';
  const [orders, quotes, clients] = await Promise.all([
    supabase
      .from('oem_orders')
      .select(`
        id, order_no, status, title, total_amount, vat_amount, shipping_fee,
        order_dt, expected_dt, delivered_dt, settled_dt, memo, client_id,
        oem_clients ( name ),
        oem_order_items ( product_name, spec, quantity, unit_price, total_price ),
        oem_shipments ( carrier, tracking_no, shipped_dt, delivered_dt, memo )
      `)
      .order('created_at', { ascending: false })
      .limit(200),
    supabase
      .from('oem_quotations')
      .select(`
        id, quote_no, status, valid_until, total_amount, vat_amount, shipping_fee,
        notes, created_at, client_id, oem_order_id,
        oem_clients ( name, address ),
        oem_quotation_items ( product_name, spec, quantity, unit_price, total_price, sort_order )
      `)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase
      .from('oem_clients')
      .select('id, name, biz_no, rep_name, phone, email, address, memo, monthly_goal')
      .eq('is_active', true)
      .order('name')
  ]);
  [orders, quotes, clients].forEach(r => check(r.error));

  const orderRows = orders.data || [];
  // 견적서발행(quoted)은 아직 확정 주문이 아니므로 수주·진행 집계에서 뺀다
  const NOT_ACTIVE = ['quoted', 'delivered', 'settled', 'cancelled'];
  const monthAmount = {};
  const yearAmount  = {};
  for (const o of orderRows) {
    if (o.status === 'quoted' || o.status === 'cancelled') continue;
    if (!o.order_dt) continue;
    if (o.order_dt >= yearStart) {
      yearAmount[o.client_id] = (yearAmount[o.client_id] || 0) + (o.total_amount || 0);
    }
    if (o.order_dt >= monthStart) {
      monthAmount[o.client_id] = (monthAmount[o.client_id] || 0) + (o.total_amount || 0);
    }
  }

  return {
    orders:  orderRows,
    quotes:  quotes.data || [],
    clients: (clients.data || []).map(c => ({ ...c, month_amount: monthAmount[c.id] || 0, year_amount: yearAmount[c.id] || 0 })),
    metrics: {
      year:         Number(yearStart.slice(0, 4)),
      year_amount:  Object.values(yearAmount).reduce((s, v) => s + v, 0),
      month_amount: Object.values(monthAmount).reduce((s, v) => s + v, 0),
      in_progress:  orderRows.filter(o => !NOT_ACTIVE.includes(o.status)).length,
      quoted:       orderRows.filter(o => o.status === 'quoted').length,
      due_this_month: orderRows.filter(o => o.expected_dt && o.expected_dt.slice(0, 7) === monthStart.slice(0, 7)
                                        && !NOT_ACTIVE.includes(o.status)).length,
      unsettled:    orderRows.filter(o => o.status === 'delivered').length
    }
  };
}

// ── 상품 Q&A (네이버 커머스 API) ──
// days: 최근 며칠간 (기본 14, 최대 90) · onlyUnanswered: 미답변만
async function getQna({ days, onlyUnanswered } = {}) {
  const nDays = Math.max(1, Math.min(90, parseInt(days, 10) || 14));
  const since = kstDate(-(nDays - 1)) + 'T00:00:00';

  let q = supabase
    .from('product_qnas')
    .select(`
      id, channel_question_id, product_no, product_name, product_order_id,
      question_type, question_title, question_content,
      questioner_nickname, is_secret, asked_at,
      answer_content, answered_at, answered_by, answer_source,
      channels ( code, name )
    `)
    .gte('asked_at', since)
    .order('asked_at', { ascending: false, nullsFirst: false })
    .limit(500);
  if (onlyUnanswered === '1' || onlyUnanswered === 'true') q = q.is('answered_at', null);
  const { data, error } = await q;
  check(error);

  const rows = data || [];
  const unansweredAll = await supabase
    .from('product_qnas')
    .select('id', { count: 'exact', head: true })
    .is('answered_at', null);
  check(unansweredAll.error);

  return {
    metrics: {
      total:        rows.length,
      unanswered:   rows.filter(r => !r.answered_at).length,
      unanswered_total: unansweredAll.count || 0
    },
    period: { days: nDays, from: since.slice(0, 10) },
    qnas:   rows
  };
}

const HANDLERS = { shop: getShop, stock: getStock, sales: getSales, oem: getOem, qna: getQna };

// ── POST 액션: Q&A 수집 / 답변 등록 ──
async function postAction(req, payload) {
  const naver = require('../../sync/naver');
  const action = req.query.action || payload.action;

  if (action === 'collect_qna') {
    return await naver.syncQnas({ days: payload.days });
  }

  if (action === 'answer_qna') {
    const { id, question_id, commentContent } = payload;
    if (!id && !question_id) throw new Error('id 또는 question_id가 필요합니다.');
    if (!commentContent || !commentContent.trim()) throw new Error('답변 내용을 입력하세요.');

    // DB row 조회 (channel_question_id 확인)
    let row;
    if (id) {
      const r = await supabase.from('product_qnas').select('id, channel_question_id').eq('id', id).maybeSingle();
      if (r.error) throw new Error(r.error.message);
      row = r.data;
    } else {
      row = { id: null, channel_question_id: String(question_id) };
    }
    if (!row || !row.channel_question_id) throw new Error('문의를 찾을 수 없습니다.');

    // 네이버에 답변 전송
    await naver.answerQna({ questionId: row.channel_question_id, commentContent });

    // DB 업데이트
    const update = {
      answer_content: commentContent.trim().slice(0, 1000),
      answered_at:    new Date().toISOString(),
      answered_by:    req.user?.username || 'admin',
      answer_source:  'api'
    };
    const { error } = await supabase
      .from('product_qnas')
      .update(update)
      .eq('channel_question_id', row.channel_question_id);
    if (error) throw new Error(error.message);
    return { ok: true, ...update };
  }

  throw new Error('지원하지 않는 action');
}

module.exports = async (req, res) => {
  const payload = verifyRequest(req);
  if (!payload) return res.status(401).json({ error: '인증 필요' });
  req.user = payload;

  try {
    if (req.method === 'GET') {
      const handler = HANDLERS[req.query.type];
      if (!handler) return res.status(400).json({ error: 'type은 shop|stock|sales|oem|qna 중 하나' });
      return res.status(200).json(await handler(req.query));
    }
    if (req.method === 'POST') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      return res.status(200).json(await postAction(req, body));
    }
    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (err) {
    console.error('[DATA]', req.method, req.query.type || req.query.action, err.message);
    return res.status(500).json({ error: err.message });
  }
};
