// api/data/index.js
// GET  /api/data?type=shop|stock|sales|oem|qna|rocket|dashboard|ads — 어드민 화면용 조회 API
// POST /api/data (action=collect_qna|answer_qna|rocket_po_save|ads_sync) — Q&A 수집/답변, 로켓 발주서 저장, 네이버 광고 수집 (Vercel 함수 개수 제한 때문에 여기에 묶음)
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

// Supabase(PostgREST)는 한 번에 최대 1,000행만 돌려준다 → 1,000행씩 끝까지 읽는다.
// build는 매번 새 쿼리를 만드는 함수여야 하고, 순서가 고정되도록 .order()를 붙여서 넘길 것
async function fetchAll(build, pageSize = 1000) {
  const out = [];
  for (let from = 0; from < 500000; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) return { data: null, error };
    out.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return { data: out, error: null };
}

// ── 쇼핑몰: 오늘 현황 + 기간 내 주문(스토어별 집계용) + 발송 대기 ──
// days: 주문일 기준 최근 며칠 (1=오늘, 기본 7, 최대 90)
async function getShop({ days } = {}) {
  const today = kstDate();
  const nDays = Math.max(1, Math.min(90, parseInt(days, 10) || 7));
  const since = kstDate(-(nDays - 1));

  const monthStart = today.slice(0, 8) + '01';
  const [recent, pending, todayOrders, shippedToday, shipping, delivered, monthOrders] = await Promise.all([
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
    // 배송완료: 도착했지만 아직 구매확정 전인 주문 전체 (네이버 판매자센터와 같은 기준)
    supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'delivered'),
    // 이번 달 주문 (주문일 기준, 취소·반품 제외는 아래에서)
    supabase
      .from('orders')
      .select('total_amount, status')
      .gte('order_dt', monthStart)
      .lt('order_dt', kstDate(1))
      .limit(20000)
  ]);
  [recent, pending, todayOrders, shippedToday, shipping, delivered, monthOrders].forEach(r => check(r.error));

  const todayRows = todayOrders.data || [];
  const live = todayRows.filter(o => o.status !== 'cancelled');
  const monthLive = (monthOrders.data || []).filter(o => o.status !== 'cancelled' && o.status !== 'returned');
  return {
    metrics: {
      today_orders:    live.length,
      new_orders:      (pending.data || []).filter(o => o.status === 'new').length,   // 신규주문(발주확인 전)
      pending:         (pending.data || []).filter(o => o.status !== 'new').length,   // 배송준비중(발주확인 후)
      month_orders:    monthLive.length,
      month_amount:    monthLive.reduce((s, o) => s + (o.total_amount || 0), 0),
      shipped_today:   shippedToday.count || 0,
      today_sales:     live.reduce((s, o) => s + (o.total_amount || 0), 0),
      shipping:        shipping.count || 0,          // 전체 배송중(아직 도착 전)
      delivered:       delivered.count || 0          // 배송완료(구매확정 전)
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

// ── 쿠팡 로켓(서플라이어허브) 발주 ──
async function getRocket() {
  const monthStart = kstDate().slice(0, 8) + '01';
  const yearStart  = kstDate().slice(0, 5) + '01-01';
  const { data, error } = await supabase
    .from('rocket_pos')
    .select(`id, po_no, po_type, manager, center, expected_dt, unloaded_dt, sku_count, order_qty, deliverable_qty,
             received_qty, order_amount, received_amount, status, file_name, updated_at,
             rocket_po_items ( line_no, sku_id, product_name, barcode, order_qty, received_qty, unit_price, order_amount, received_amount )`)
    .order('expected_dt', { ascending: false, nullsFirst: false })
    .limit(500);
  check(error);
  const pos = data || [];
  const day = r => String(r.expected_dt || '').slice(0, 10);
  const inMonth = pos.filter(p => day(p) >= monthStart);
  const inYear  = pos.filter(p => day(p) >= yearStart);
  const sum = (list, k) => list.reduce((s, p) => s + Number(p[k] || 0), 0);
  return {
    metrics: {
      month_count:    inMonth.length,
      month_amount:   sum(inMonth, 'order_amount'),
      month_received: sum(inMonth, 'received_amount'),
      pending:        pos.filter(p => p.status !== 'received').length,
      year_amount:    sum(inYear, 'received_amount') || sum(inYear, 'order_amount')
    },
    pos
  };
}

// 발주서 저장: 브라우저가 엑셀을 읽어 보낸 발주서(들)를 발주번호 기준으로 덮어쓴다
async function saveRocketPos(list, user) {
  if (!Array.isArray(list) || !list.length) throw new Error('저장할 발주서가 없습니다.');
  const toInt = v => Math.round(Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0);
  const saved = [];
  for (const p of list.slice(0, 50)) {
    const poNo = String(p.po_no || '').trim();
    if (!/^\d+$/.test(poNo)) throw new Error(`발주번호를 읽지 못했습니다 (${p.file_name || '파일'})`);
    const items = (p.items || []).map((it, i) => ({
      line_no:         toInt(it.line_no) || i + 1,
      sku_id:          String(it.sku_id || '').trim() || null,
      product_name:    String(it.product_name || '').trim() || null,
      barcode:         String(it.barcode || '').trim() || null,
      buy_type:        it.buy_type || null,
      tax_type:        it.tax_type || null,
      order_qty:       toInt(it.order_qty),
      deliverable_qty: toInt(it.deliverable_qty),
      received_qty:    toInt(it.received_qty),
      unit_price:      toInt(it.unit_price),
      supply_price:    toInt(it.supply_price),
      order_amount:    toInt(it.order_amount),
      received_amount: toInt(it.received_amount)
    }));
    const tot = k => items.reduce((s, it) => s + it[k], 0);
    const orderQty = tot('order_qty'), receivedQty = tot('received_qty');
    const status = receivedQty <= 0 ? 'pending' : receivedQty < orderQty ? 'partial' : 'received';
    const row = {
      po_no:           poNo,
      po_type:         p.po_type || null,
      manager:         p.manager || null,
      center:          p.center || null,
      center_address:  p.center_address || null,
      expected_dt:     p.expected_dt || null,
      unloaded_dt:     p.unloaded_dt || null,
      sku_count:       items.length,
      order_qty:       orderQty,
      deliverable_qty: tot('deliverable_qty'),
      received_qty:    receivedQty,
      order_amount:    tot('order_amount'),
      received_amount: tot('received_amount'),
      status,
      file_name:       p.file_name || null,
      uploaded_by:     user?.username || 'admin',
      updated_at:      new Date().toISOString()
    };
    const { data: po, error } = await supabase.from('rocket_pos').upsert(row, { onConflict: 'po_no' }).select('id').single();
    check(error);
    const del = await supabase.from('rocket_po_items').delete().eq('po_id', po.id);
    check(del.error);
    if (items.length) {
      const ins = await supabase.from('rocket_po_items').insert(items.map(it => ({ po_id: po.id, ...it })));
      check(ins.error);
    }
    saved.push({ po_no: poNo, status, sku_count: items.length, order_amount: row.order_amount });
  }
  return { ok: true, saved };
}

// ── 메인 대시보드: 매출원별(네이버·쿠팡·쿠팡 로켓·OEM) 연도/월 매출 + 처리할 일 ──
// 금액 기준은 모두 "VAT 포함 실제 거래 금액"으로 맞춘다
//  - 쇼핑몰: orders.total_amount (결제금액), 취소·반품 제외, 주문일 기준
//  - 쿠팡 로켓: rocket_pos.received_amount (입고금액, 없으면 발주금액), 입고예정일 기준
//  - OEM: oem_orders.total_amount + vat_amount, 견적서발행·취소 제외, 주문일 기준
const DASH_SOURCES = ['naver', 'coupang', 'rocket', 'oem'];
const DASH_FROM_YEAR = 2026;   // 대시보드는 2026년부터 (그 전 데이터는 DB에 있어도 표시 안 함)
async function getDashboard({ year } = {}) {
  const thisYear = Number(kstDate().slice(0, 4));
  const selYear = Number(year) || thisYear;
  const [shop, oem, rocket, qna] = await Promise.all([
    fetchAll(() => supabase.from('orders').select('order_dt, total_amount, status, channels ( code )').order('id')),
    fetchAll(() => supabase.from('oem_orders').select('order_dt, total_amount, vat_amount, status').order('id')),
    fetchAll(() => supabase.from('rocket_pos').select('expected_dt, order_amount, received_amount, status').order('id')),
    supabase.from('product_qnas').select('id', { count: 'exact', head: true }).is('answer_content', null)
  ]);
  [shop, oem, rocket].forEach(r => check(r.error));

  const months = {};                                        // 'YYYY-MM' → { naver, coupang, rocket, oem }
  const add = (dt, src, amt) => {
    const ym = String(dt || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym) || !amt || Number(ym.slice(0, 4)) < DASH_FROM_YEAR) return;
    (months[ym] ||= { naver: 0, coupang: 0, rocket: 0, oem: 0 })[src] += amt;
  };
  const sold = o => !['cancelled', 'returned'].includes(o.status);
  for (const o of shop.data || []) {
    const code = o.channels?.code;
    if (!sold(o) || !DASH_SOURCES.includes(code)) continue;
    add(o.order_dt, code, Number(o.total_amount || 0));
  }
  for (const r of rocket.data || []) add(r.expected_dt, 'rocket', Number(r.received_amount || 0) || Number(r.order_amount || 0));
  for (const o of oem.data || []) {
    if (['quoted', 'cancelled'].includes(o.status)) continue;
    add(o.order_dt, 'oem', Number(o.total_amount || 0) + Number(o.vat_amount || 0));
  }

  // 연도별 합계 (올해는 데이터가 없어도 항상 포함)
  const years = {};
  for (const [ym, v] of Object.entries(months)) {
    const y = ym.slice(0, 4);
    const t = (years[y] ||= { naver: 0, coupang: 0, rocket: 0, oem: 0 });
    DASH_SOURCES.forEach(s => { t[s] += v[s]; });
  }
  // 2026년부터 내년까지는 데이터가 없어도 탭(연도)을 보여준다
  for (let y = DASH_FROM_YEAR; y <= thisYear + 1; y++) years[y] ||= { naver: 0, coupang: 0, rocket: 0, oem: 0 };

  // 올해 같은 기간(1월 1일~오늘의 월·일) 대비 작년
  const md = kstDate().slice(5);
  const ytdPrev = { naver: 0, coupang: 0, rocket: 0, oem: 0 };
  const prevY = thisYear - 1 >= DASH_FROM_YEAR ? String(thisYear - 1) : 'none';   // 2026년 이전은 비교하지 않음
  for (const o of shop.data || []) if (sold(o) && String(o.order_dt || '').startsWith(prevY) && String(o.order_dt).slice(5, 10) <= md && DASH_SOURCES.includes(o.channels?.code)) ytdPrev[o.channels.code] += Number(o.total_amount || 0);
  for (const r of rocket.data || []) if (String(r.expected_dt || '').startsWith(prevY) && String(r.expected_dt).slice(5, 10) <= md) ytdPrev.rocket += Number(r.received_amount || 0) || Number(r.order_amount || 0);
  for (const o of oem.data || []) if (!['quoted', 'cancelled'].includes(o.status) && String(o.order_dt || '').startsWith(prevY) && String(o.order_dt).slice(5, 10) <= md) ytdPrev.oem += Number(o.total_amount || 0) + Number(o.vat_amount || 0);

  const shopRows = shop.data || [], oemRows = oem.data || [];
  const unsettled = oemRows.filter(o => o.status === 'delivered');
  return {
    this_year: thisYear,
    year: selYear,
    years: Object.keys(years).sort().map(y => ({ year: Number(y), ...years[y] })),
    months: Object.keys(months).filter(ym => ym.startsWith(String(selYear))).sort().map(ym => ({ month: ym, ...months[ym] })),
    ytd_prev: ytdPrev,
    todo: {
      new_orders:    shopRows.filter(o => o.status === 'new').length,
      to_ship:       shopRows.filter(o => ['confirmed', 'preparing', 'ready'].includes(o.status)).length,
      shipping:      shopRows.filter(o => o.status === 'shipped').length,
      qna:           qna.error ? null : (qna.count || 0),
      oem_quoted:    oemRows.filter(o => o.status === 'quoted').length,
      oem_progress:  oemRows.filter(o => !['quoted', 'delivered', 'settled', 'cancelled'].includes(o.status)).length,
      oem_unsettled: unsettled.length,
      oem_unsettled_amount: unsettled.reduce((s, o) => s + Number(o.total_amount || 0) + Number(o.vat_amount || 0), 0),
      rocket_pending: (rocket.data || []).filter(r => r.status !== 'received').length
    },
  };
}

// ── 네이버 광고(파워링크·쇼핑검색): 기간 성과 + 진단 ──
// days: 최근 며칠 (7/30/90, 기본 30). 광고비(cost)는 네이버 광고 기준 금액
const AD_TYPE = { WEB_SITE: '파워링크', SHOPPING: '쇼핑검색' };
async function getAds({ days } = {}) {
  const nDays = Math.max(1, Math.min(90, parseInt(days, 10) || 30));
  const since = kstDate(-(nDays - 1)), today = kstDate();
  const [camps, units, stats, meta, orders] = await Promise.all([
    supabase.from('ad_campaigns').select('id, name, campaign_tp, status, daily_budget'),
    fetchAll(() => supabase.from('ad_units').select('id, unit_type, name, campaign_id, adgroup_id, bid_amt, status').order('id')),
    fetchAll(() => supabase.from('ad_stats_daily').select('stat_date, entity_type, entity_id, campaign_id, imp_cnt, clk_cnt, cost, conv_cnt, conv_amt, avg_rnk')
      .gte('stat_date', since).lte('stat_date', today).order('stat_date').order('entity_type').order('entity_id')),
    supabase.from('ad_meta').select('key, value, updated_at'),
    fetchAll(() => supabase.from('orders').select('total_amount, status, order_dt, channels!inner ( code )').eq('channels.code', 'naver').gte('order_dt', since).order('id'))
  ]);
  [camps, units, stats, meta, orders].forEach(r => check(r.error));

  const zero = () => ({ imp: 0, clk: 0, cost: 0, conv: 0, conv_amt: 0 });
  const addTo = (t, s) => { t.imp += +s.imp_cnt; t.clk += +s.clk_cnt; t.cost += +s.cost; t.conv += +s.conv_cnt; t.conv_amt += +s.conv_amt; return t; };
  const campRows = (stats.data || []).filter(s => s.entity_type === 'campaign');
  const unitRows = (stats.data || []).filter(s => s.entity_type !== 'campaign');
  const campInfo = Object.fromEntries((camps.data || []).map(c => [c.id, c]));
  const unitInfo = Object.fromEntries((units.data || []).map(u => [u.id, u]));

  // 전체 / 유형별 / 캠페인별 / 일별
  const total = zero(), byType = {}, byCamp = {}, daily = {};
  for (const s of campRows) {
    const tp = AD_TYPE[campInfo[s.campaign_id]?.campaign_tp] || campInfo[s.campaign_id]?.campaign_tp || '기타';
    addTo(total, s); addTo(byType[tp] ||= zero(), s); addTo(byCamp[s.campaign_id] ||= zero(), s); addTo(daily[s.stat_date] ||= zero(), s);
  }
  const rate = t => ({ ...t, ctr: t.imp ? t.clk / t.imp : 0, cpc: t.clk ? t.cost / t.clk : 0, roas: t.cost ? t.conv_amt / t.cost : 0 });

  // 광고단위(키워드·소재)별 합계 → 진단
  const byUnit = {};
  for (const s of unitRows) addTo(byUnit[s.entity_id] ||= zero(), s);
  const unitList = Object.entries(byUnit).map(([id, t]) => {
    const u = unitInfo[id] || {}, c = campInfo[u.campaign_id] || {};
    const g = unitInfo[u.adgroup_id];   // 같은 상품이 차종별 광고그룹 여러 곳에 있어서 그룹명을 같이 보여준다
    return { id, name: u.name || id, group: g?.name || null, unit_type: u.unit_type, campaign: c.name || '-', type: AD_TYPE[c.campaign_tp] || c.campaign_tp || '-', bid_amt: u.bid_amt, ...rate(t) };
  });
  const spent = unitList.filter(u => u.cost > 0);
  const waste = spent.filter(u => u.conv === 0 && u.cost >= 5000).sort((a, b) => b.cost - a.cost).slice(0, 15);
  const lowCtr = unitList.filter(u => u.imp >= 1000 && u.ctr < 0.003).sort((a, b) => b.imp - a.imp).slice(0, 10);
  const best = spent.filter(u => u.conv > 0 && u.cost >= 3000).sort((a, b) => b.roas - a.roas).slice(0, 10);

  // 실제 스마트스토어 매출(취소·반품 제외)과 광고비 비교
  const storeSales = (orders.data || []).filter(o => !['cancelled', 'returned'].includes(o.status)).reduce((s, o) => s + Number(o.total_amount || 0), 0);

  // 비즈머니 잔액 → 최근 7일 평균 광고비로 며칠 버티는지
  const bm = (meta.data || []).find(m => m.key === 'bizmoney');
  const last7 = Object.entries(daily).filter(([d]) => d >= kstDate(-6)).reduce((s, [, t]) => s + t.cost, 0) / 7;
  const balance = bm ? Number(bm.value?.bizmoney ?? bm.value?.bizMoney ?? 0) : null;

  return {
    period: { days: nDays, from: since, to: today },
    total: rate(total),
    by_type: Object.entries(byType).map(([type, t]) => ({ type, ...rate(t) })),
    campaigns: Object.entries(byCamp).map(([id, t]) => ({ id, name: campInfo[id]?.name || id, type: AD_TYPE[campInfo[id]?.campaign_tp] || campInfo[id]?.campaign_tp || '-',
      status: campInfo[id]?.status, daily_budget: campInfo[id]?.daily_budget, ...rate(t) })).sort((a, b) => b.cost - a.cost),
    daily: Object.keys(daily).sort().map(d => ({ date: d, ...rate(daily[d]) })),
    store_sales: storeSales,
    store_roas: total.cost ? storeSales / total.cost : 0,
    bizmoney: bm ? { balance, updated_at: bm.updated_at, days_left: last7 > 0 ? balance / last7 : null } : null,
    diagnosis: { waste, low_ctr: lowCtr, best },
    has_data: (camps.data || []).length > 0
  };
}

const HANDLERS = { shop: getShop, stock: getStock, sales: getSales, oem: getOem, qna: getQna, rocket: getRocket, dashboard: getDashboard, ads: getAds };

// ── POST 액션: Q&A 수집 / 답변 등록 ──
async function postAction(req, payload) {
  const naver = require('../../sync/naver');
  const action = req.query.action || payload.action;

  if (action === 'ads_sync') {
    // 네이버 광고 성과 가져오기: { from: 'YYYY-MM-DD' } 또는 { days }. 시간 안에 다 못 하면 next를 돌려줌
    return await require('../../sync/naverads').syncAds({ from: payload.from, days: payload.days });
  }

  if (action === 'rocket_po_save') {
    return await saveRocketPos(payload.pos, req.user);
  }

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
      if (!handler) return res.status(400).json({ error: 'type은 shop|stock|sales|oem|qna|rocket|dashboard|ads 중 하나' });
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
