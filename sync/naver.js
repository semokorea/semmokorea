// sync/naver.js — 네이버 커머스API: 주문 수집 + 발송 처리
// 공식 문서(apicenter.commerce.naver.com/llms) 기준:
//  - 토큰: POST /v1/oauth2/token (application/x-www-form-urlencoded)
//      client_secret_sign = base64( bcrypt.hashSync(`${client_id}_${timestamp}`, client_secret) ), timestamp=밀리초(5분 유효)
//  - 변경 주문: GET /v1/pay-order/seller/product-orders/last-changed-statuses (범위 최대 24시간, 300건씩, more로 이어받기)
//  - 상세 조회: POST /v1/pay-order/seller/product-orders/query { productOrderIds: [...최대 300] }
//  - 발송 처리: POST /v1/pay-order/seller/product-orders/dispatch { dispatchProductOrders: [...] }
// 호출 IP 제한이 있어 PROXY_URL(고정 IP 중계 서버)을 거쳐 나간다.
const axios = require('axios');
const bcrypt = require('bcrypt');
const { supabase, upsertOrder, getChannelId, logSync } = require('../utils/supabase');
const { proxyAgent } = require('../utils/proxy');

const BASE = 'https://api.commerce.naver.com/external';

function client() {
  return axios.create({
    baseURL: BASE,
    timeout: 20000,
    proxy: false,               // axios 자체 프록시 기능은 끄고
    httpsAgent: proxyAgent()    // CONNECT 터널 Agent 사용
  });
}

// ── 인증 토큰 ──
let _token = null;
let _tokenExpiry = 0;

async function getToken(force = false) {
  if (!force && _token && Date.now() < _tokenExpiry) return _token;

  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수가 없습니다.');

  const timestamp = Date.now();
  const hashed = bcrypt.hashSync(`${clientId}_${timestamp}`, clientSecret);
  const sign = Buffer.from(hashed, 'utf-8').toString('base64');

  const res = await client().post('/v1/oauth2/token', new URLSearchParams({
    client_id: clientId,
    timestamp: String(timestamp),
    client_secret_sign: sign,
    grant_type: 'client_credentials',
    type: 'SELF'
  }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  _token = res.data.access_token;
  _tokenExpiry = Date.now() + Math.max(60, (res.data.expires_in || 3600) - 300) * 1000;
  return _token;
}

// 401 GW.AUTHN 이면 토큰 재발급 후 1회 재시도
async function call(method, url, opts = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(attempt > 0);
    try {
      return await client().request({ method, url, ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
    } catch (e) {
      if (attempt === 0 && e.response?.status === 401) continue;
      throw e;
    }
  }
}

function errText(e) {
  const d = e.response?.data;
  if (d) return `${e.response.status} ${d.code || ''} ${d.message || JSON.stringify(d).slice(0, 300)}`.trim();
  return e.message;
}

// KST 오프셋을 붙인 ISO 문자열 (문서 예시 형식: 2025-04-07T12:00:00.000+09:00)
function kstIso(date) {
  const k = new Date(date.getTime() + 9 * 3600 * 1000).toISOString().replace('Z', '');
  return `${k}+09:00`;
}

// ── 변경된 상품주문번호 수집 (more로 이어받기) ──
async function fetchChangedIds(from, to) {
  const ids = new Set();
  let params = { lastChangedFrom: kstIso(from), lastChangedTo: kstIso(to) };
  for (let page = 0; page < 30; page++) {
    const res = await call('get', '/v1/pay-order/seller/product-orders/last-changed-statuses', { params });
    const data = res.data?.data || {};
    for (const s of data.lastChangeStatuses || []) if (s.productOrderId) ids.add(String(s.productOrderId));
    if (!data.more?.moreFrom) break;
    params = { lastChangedFrom: data.more.moreFrom, lastChangedTo: params.lastChangedTo, moreSequence: data.more.moreSequence };
  }
  return [...ids];
}

// ── 상세 조회 (300개씩) ──
async function fetchDetails(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 300) {
    const res = await call('post', '/v1/pay-order/seller/product-orders/query', {
      data: { productOrderIds: ids.slice(i, i + 300) },
      headers: { 'Content-Type': 'application/json' }
    });
    out.push(...(res.data?.data || []));
  }
  return out;
}

// ── 주문 수집 ──
// days: 며칠 전까지 거슬러 갈지 (1~30). API는 한 번에 24시간까지만 조회되므로
//       최근 24시간부터 하루씩 과거로 나눠 조회한다.
// 서버 함수 실행 시간(60초) 안에 끝나도록 시간 예산을 넘기면 멈추고 어디까지 했는지 알려준다.
const TIME_BUDGET_MS = 45000;

async function syncOrders({ days = 1 } = {}) {
  const started = Date.now();
  const channelId = await getChannelId('naver');
  const nDays = Math.max(1, Math.min(30, Math.floor(Number(days) || 1)));
  const DAY = 24 * 3600 * 1000;
  const end = Date.now() - 5000;                              // 문서 권장: 현재보다 5초 이전

  let synced = 0, errors = 0, changed = 0, doneDays = 0, stopped = false, errMsg = '';
  let refreshed = 0, statusChanged = 0;
  const seen = new Set();          // 이번에 이미 저장한 상품주문번호
  try {
    // ① 최근 N일 안에 바뀐 주문 수집
    for (let i = 0; i < nDays; i++) {
      if (Date.now() - started > TIME_BUDGET_MS) { stopped = true; break; }
      const to = new Date(end - i * DAY);
      const from = new Date(end - (i + 1) * DAY + 1);         // 구간끼리 겹치지 않게 1ms 띄움
      const ids = await fetchChangedIds(from, to);
      changed += ids.length;
      const details = ids.length ? await fetchDetails(ids) : [];
      for (const d of details) {
        if (Date.now() - started > TIME_BUDGET_MS + 10000) { stopped = true; break; }
        const r = await saveDetail(channelId, d);
        if (r === true) { synced++; seen.add(String(d.productOrder?.productOrderId)); }
        else { errors++; errMsg = errMsg || r; }
      }
      if (stopped) break;
      doneDays++;
    }

    // ② 진행 중인 주문 상태 새로고침
    //    ①은 "그 기간 안에 바뀐 주문"만 잡기 때문에, 예전에 발송된 주문이 나중에
    //    배송완료·구매확정으로 바뀐 것을 놓칠 수 있다. 그래서 아직 끝나지 않은 주문
    //    (신규·배송준비중·배송중)은 수집할 때마다 상세를 다시 조회해 상태를 맞춘다.
    if (!stopped && Date.now() - started < TIME_BUDGET_MS) {
      const open = await openOrders(channelId);
      const ids = [...open.keys()].filter(id => !seen.has(id));
      const details = ids.length ? await fetchDetails(ids) : [];
      for (const d of details) {
        if (Date.now() - started > TIME_BUDGET_MS + 10000) { stopped = true; break; }
        const id = String(d.productOrder?.productOrderId);
        const r = await saveDetail(channelId, d);
        if (r === true) {
          refreshed++;
          if (open.get(id) !== mapNaverStatus(d.productOrder?.productOrderStatus)) statusChanged++;
        } else { errors++; errMsg = errMsg || r; }
      }
    }
  } catch (e) {
    errMsg = `API 오류: ${errText(e)}`;
    console.error('[NAVER]', errMsg);
    errors++;
  }

  let message = `${doneDays}/${nDays}일 조회 · 변경 ${changed}건 · 저장 ${synced}건`;
  if (refreshed) message += ` · 진행중 주문 ${refreshed}건 상태 확인 (${statusChanged}건 바뀜)`;
  if (stopped) message += ` (시간 제한으로 ${doneDays}일까지만 처리 — 다시 누르면 이어서 확인)`;
  if (errMsg) message += ` · ${errMsg}`;

  await logSync('naver', { synced: synced + refreshed, errors, message });
  return { synced: synced + refreshed, errors, message };
}

// 진행 중(아직 구매확정·취소·반품이 아닌) 주문: 상품주문번호 → 현재 상태
const OPEN_STATUSES = ['new', 'confirmed', 'preparing', 'ready', 'shipped', 'delivered'];  // 배송완료도 구매확정·반품으로 바뀌므로 계속 확인
const OPEN_LOOKBACK_DAYS = 60;
async function openOrders(channelId) {
  const since = new Date(Date.now() + 9 * 3600 * 1000 - OPEN_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('orders')
    .select('channel_item_no, status')
    .eq('channel_id', channelId)
    .in('status', OPEN_STATUSES)
    .gte('order_dt', since)
    .limit(3000);
  if (error) throw new Error(error.message);
  const map = new Map();
  for (const o of data || []) if (o.channel_item_no) map.set(String(o.channel_item_no), o.status);
  return map;
}

// 상세 1건 저장: 주문 + 품목 + 배송(송장·발송일·도착일). 성공하면 true, 실패하면 오류 문구
async function saveDetail(channelId, d) {
  try {
    const row = await upsertOrder(mapNaverOrder(channelId, d));
    await replaceItems(row.id, d);
    await syncShipment(row.id, d);
    return true;
  } catch (e) {
    console.error('[NAVER] 저장 실패:', e.message);
    return `저장 실패: ${e.message}`;
  }
}

// 네이버 배송 정보(d.delivery) → shipments (주문당 1건, 있으면 갱신)
const CARRIER_NAMES = {
  CJGLS: 'CJ대한통운', HYUNDAI: '롯데택배', HANJIN: '한진택배', EPOST: '우체국택배', KGB: '로젠택배',
  KDEXP: '경동택배', DAESIN: '대신택배', CHUNIL: '천일택배', ILYANG: '일양로지스', HDEXP: '합동택배',
  CVSNET: 'GS편의점택배', CUPOST: 'CU편의점택배'
};
async function syncShipment(orderId, d) {
  const dl = d.delivery || {};
  if (!dl.sendDate && !dl.trackingNumber) return;          // 아직 발송 전
  const st = d.productOrder?.productOrderStatus;
  const delivered = Boolean(dl.deliveredDate) || ['DELIVERED', 'PURCHASE_DECIDED', 'EXCHANGED'].includes(st);
  const fields = { status: delivered ? 'delivered' : 'shipped' };
  if (dl.sendDate || dl.pickupDate) fields.shipped_dt = dl.sendDate || dl.pickupDate;
  if (dl.deliveredDate) fields.delivered_dt = dl.deliveredDate;
  if (dl.trackingNumber) fields.tracking_no = String(dl.trackingNumber);
  const carrier = dl.deliveryCompany
    ? (CARRIER_NAMES[dl.deliveryCompany] || dl.deliveryCompany)
    : (dl.deliveryMethod === 'VISIT_RECEIPT' ? '방문수령' : dl.deliveryMethod === 'DIRECT_DELIVERY' ? '직접전달' : null);
  if (carrier) fields.carrier = carrier;

  const { data: exist, error: selErr } = await supabase
    .from('shipments').select('id').eq('order_id', orderId)
    .order('created_at', { ascending: false }).limit(1);
  if (selErr) throw new Error(selErr.message);
  const { error } = exist?.length
    ? await supabase.from('shipments').update(fields).eq('id', exist[0].id)
    : await supabase.from('shipments').insert({ order_id: orderId, ...fields });
  if (error) throw new Error(error.message);
}

// 주문 1건(상품주문 1개)의 품목을 덮어쓴다
async function replaceItems(orderId, d) {
  const po = d.productOrder || {};
  await supabase.from('order_items').delete().eq('order_id', orderId);
  const { error } = await supabase.from('order_items').insert({
    order_id:     orderId,
    product_name: po.productName || '(상품명 없음)',
    option_info:  po.productOption || null,
    option_code:  po.optionManageCode || po.optionCode || null,
    seller_code:  po.sellerProductCode || null,
    quantity:     po.quantity ?? po.remainQuantity ?? 1,
    unit_price:   po.unitPrice || 0,
    option_price: po.optionPrice || 0,
    total_amount: po.totalPaymentAmount ?? po.remainPaymentAmount ?? 0
  });
  if (error) throw new Error(error.message);
}

// ── 발송 처리 ──
const CARRIER_CODES = {
  'CJ대한통운': 'CJGLS',
  '롯데택배':   'HYUNDAI',
  '한진택배':   'HANJIN',
  '우체국':     'EPOST',
  '우체국택배': 'EPOST',
  '로젠택배':   'KGB'
};

async function registerShipment({ channelItemNo, trackingNo, carrier }) {
  const res = await call('post', '/v1/pay-order/seller/product-orders/dispatch', {
    data: {
      dispatchProductOrders: [{
        productOrderId:      channelItemNo,
        deliveryMethod:      'DELIVERY',
        deliveryCompanyCode: CARRIER_CODES[carrier] || 'CJGLS',
        trackingNumber:      String(trackingNo).replace(/\s/g, ''),
        dispatchDate:        kstIso(new Date())
      }]
    },
    headers: { 'Content-Type': 'application/json' }
  });
  const fail = res.data?.data?.failProductOrderInfos || [];
  if (fail.length) throw new Error('네이버 발송 처리 실패: ' + JSON.stringify(fail).slice(0, 300));
  return res.data;
}

// ── 데이터 변환 ──
// 상세 응답(data[])의 order / productOrder 하위 필드. 필드가 없을 때를 대비해 기본값을 둔다.
function mapNaverOrder(channelId, d) {
  const o = d.order || {};
  const po = d.productOrder || {};
  const addr = po.shippingAddress || {};
  return {
    channel_id:        channelId,
    channel_order_no:  String(o.orderId || po.orderId || ''),
    channel_item_no:   String(po.productOrderId || ''),
    status:            mapNaverStatus(po.productOrderStatus),
    buyer_name:        o.ordererName || null,
    buyer_id:          o.ordererId || null,
    buyer_phone:       o.ordererTel || null,
    receiver_name:     addr.name || null,
    receiver_phone1:   addr.tel1 || null,
    receiver_phone2:   addr.tel2 || null,
    zipcode:           addr.zipCode || null,
    address_base:      addr.baseAddress || null,
    address_detail:    addr.detailedAddress || addr.detailAddress || null,
    address_full:      `${addr.baseAddress || ''} ${addr.detailedAddress || addr.detailAddress || ''}`.trim() || null,
    delivery_message:  po.shippingMemo || null,
    payment_method:    o.paymentMeans || null,
    payment_dt:        o.paymentDate || null,
    order_dt:          o.orderDate || o.paymentDate || null,
    shipping_deadline_dt: po.shippingDueDate || null,
    total_amount:      po.totalPaymentAmount ?? po.remainPaymentAmount ?? 0,
    shipping_fee:      po.deliveryFeeAmount || 0,
    discount_amount:   po.productDiscountAmount ?? po.remainProductDiscountAmount ?? 0,
    settlement_amount: po.expectedSettlementAmount || 0,
    raw_data:          d,
    synced_at:         new Date().toISOString()
  };
}

// productOrderStatus (문서: 주문 상태 변경 흐름도)
function mapNaverStatus(s) {
  const m = {
    PAYMENT_WAITING:       'new',
    PAYED:                 'confirmed',
    DELIVERING:            'shipped',
    DELIVERED:             'delivered',
    PURCHASE_DECIDED:      'completed',   // 구매확정 (배송완료와 따로 센다)
    EXCHANGED:             'delivered',
    CANCELED:              'cancelled',
    CANCELED_BY_NOPAYMENT: 'cancelled',
    RETURNED:              'returned'
  };
  return m[s] || 'new';
}

// ────────────────────────────────────────────────────────────
//  상품 문의 (Q&A)
//  문서: GET  /v1/contents/qnas               (fromDate, toDate 필수)
//        PUT  /v1/contents/qnas/:questionId   body: { commentContent } 1000자 이하
//  필요 권한: 네이버 앱 "[문의]" API 그룹 포함 (없으면 403 GW.AUTHN)
// ────────────────────────────────────────────────────────────

// Q&A 목록 조회 (페이지네이션)
async function fetchQnas(fromDate, toDate) {
  const all = [];
  // 문서: 첫 번째 페이지 번호는 1, 페이지당 최대 100건
  let page = 1, hasMore = true;
  while (hasMore && page <= 50) {
    const res = await call('get', '/v1/contents/qnas', {
      params: { fromDate: kstIso(fromDate), toDate: kstIso(toDate), page, size: 100 }
    });
    const body = res.data?.data ?? res.data ?? {};
    const rows = body.contents || body.items || body.list || [];
    all.push(...rows);
    hasMore = body.last === false || (body.totalPages != null && page < body.totalPages);
    page++;
    if (!rows.length) break;
  }
  return all;
}

// 네이버 Q&A 응답 → product_qnas row로 변환
function mapNaverQna(channelId, q) {
  return {
    channel_id:          channelId,
    channel_question_id: String(q.questionId ?? q.commentNo ?? q.id ?? ''),
    // 문서 응답 필드: questionId, productId, productName, question, answer, answered, createDate, maskedWriterId
    product_no:          (q.productId ?? q.productNo) ? String(q.productId ?? q.productNo) : null,
    product_name:        q.productName || null,
    product_order_id:    q.productOrderId ? String(q.productOrderId) : null,
    question_type:       q.inquiryCategory || q.inquiryType || q.category || null,
    question_title:      q.title || null,
    question_content:    q.question || q.content || q.questionContent || null,
    questioner_id:       q.maskedWriterId || q.writerId || q.customerId || null,
    questioner_nickname: q.writerName || q.customerName || q.nickName || q.maskedWriterId || null,
    is_secret:           Boolean(q.secretYn === 'Y' || q.isSecret),
    asked_at:            q.createDate || q.writeDate || q.registeredDate || q.createdDate || null,
    answer_content:      q.answer || q.commentContent || q.answerContent || null,
    answered_at:         q.answerDate || q.replyDate || null,
    answer_source:       (q.answer || q.commentContent || q.answerContent) ? 'smartstore' : null,
    raw_data:            q,
    synced_at:           new Date().toISOString()
  };
}

// 수집: days 일치 Q&A를 DB에 upsert
async function syncQnas({ days = 7 } = {}) {
  const channelId = await getChannelId('naver');
  const nDays = Math.max(1, Math.min(30, Math.floor(Number(days) || 7)));
  const now = new Date(Date.now() - 5000);
  const from = new Date(now.getTime() - nDays * 24 * 3600 * 1000);

  let synced = 0, errors = 0, errMsg = '';
  let qnas = [];
  try {
    qnas = await fetchQnas(from, now);
  } catch (e) {
    errMsg = `문의 조회 실패: ${errText(e)}`;
    console.error('[NAVER-QNA]', errMsg);
    errors++;
  }

  for (const q of qnas) {
    try {
      const row = mapNaverQna(channelId, q);
      if (!row.channel_question_id) continue;
      // 이미 API로 답한 건은 answer_source 'api' 유지 (스마트스토어 쓰기로 덮이지 않도록)
      const { data: exist } = await supabase
        .from('product_qnas')
        .select('id, answer_source')
        .eq('channel_id', channelId)
        .eq('channel_question_id', row.channel_question_id)
        .maybeSingle();
      if (exist?.answer_source === 'api' && row.answer_source === 'smartstore') {
        row.answer_source = 'api';
      }
      const { error } = await supabase
        .from('product_qnas')
        .upsert(row, { onConflict: 'channel_id,channel_question_id' });
      if (error) throw error;
      synced++;
    } catch (e) {
      console.error('[NAVER-QNA] 저장 실패:', e.message);
      errors++;
      errMsg = errMsg || `저장 실패: ${e.message}`;
    }
  }

  const message = `문의 ${qnas.length}건 조회 · 저장 ${synced}건` + (errMsg ? ` · ${errMsg}` : '');
  await logSync('naver-qna', { synced, errors, message });
  return { synced, errors, message };
}

// 답변 등록/수정 — PUT /v1/contents/qnas/:questionId
async function answerQna({ questionId, commentContent }) {
  if (!questionId) throw new Error('questionId가 필요합니다.');
  if (!commentContent || !commentContent.trim()) throw new Error('답변 내용이 비었습니다.');
  const trimmed = commentContent.trim().slice(0, 1000);
  await call('put', `/v1/contents/qnas/${encodeURIComponent(questionId)}`, {
    data: { commentContent: trimmed },
    headers: { 'Content-Type': 'application/json' }
  });
  return { ok: true, answer: trimmed };
}

module.exports = { syncOrders, registerShipment, getToken, mapNaverOrder, syncQnas, answerQna };
