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
  try {
    for (let i = 0; i < nDays; i++) {
      if (Date.now() - started > TIME_BUDGET_MS) { stopped = true; break; }
      const to = new Date(end - i * DAY);
      const from = new Date(end - (i + 1) * DAY + 1);         // 구간끼리 겹치지 않게 1ms 띄움
      const ids = await fetchChangedIds(from, to);
      changed += ids.length;
      const details = ids.length ? await fetchDetails(ids) : [];
      for (const d of details) {
        if (Date.now() - started > TIME_BUDGET_MS + 10000) { stopped = true; break; }
        try {
          const row = await upsertOrder(mapNaverOrder(channelId, d));
          await replaceItems(row.id, d);
          synced++;
        } catch (e) {
          console.error('[NAVER] 저장 실패:', e.message);
          errors++;
          errMsg = errMsg || `저장 실패: ${e.message}`;
        }
      }
      if (stopped) break;
      doneDays++;
    }
  } catch (e) {
    errMsg = `API 오류: ${errText(e)}`;
    console.error('[NAVER]', errMsg);
    errors++;
  }

  let message = `${doneDays}/${nDays}일 조회 · 변경 ${changed}건 · 저장 ${synced}건`;
  if (stopped) message += ` (시간 제한으로 ${doneDays}일까지만 처리 — 다시 누르면 이어서 확인)`;
  if (errMsg) message += ` · ${errMsg}`;

  await logSync('naver', { synced, errors, message });
  return { synced, errors, message };
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
    PURCHASE_DECIDED:      'delivered',
    EXCHANGED:             'delivered',
    CANCELED:              'cancelled',
    CANCELED_BY_NOPAYMENT: 'cancelled',
    RETURNED:              'returned'
  };
  return m[s] || 'new';
}

module.exports = { syncOrders, registerShipment, getToken, mapNaverOrder };
