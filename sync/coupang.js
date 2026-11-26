// sync/coupang.js — 쿠팡 Wing OPEN API: 주문 수집 + 상품준비중 처리 + 송장 업로드
// 공식 문서(developers.coupang.com) 기준:
//  - 인증: Authorization: CEA algorithm=HmacSHA256, access-key=..., signed-date=yyMMdd'T'HHmmss'Z'(UTC), signature=hex
//          서명 메시지 = signed-date + METHOD + path + query(물음표 없이)
//  - 발주서 목록(일단위 페이징): GET /v2/providers/openapi/apis/api/v5/vendors/{vendorId}/ordersheets
//          createdAtFrom/To = "yyyy-mm-dd+09:00"(최대 31일), status 필수(한 번에 한 상태), maxPerPage≤50, nextToken
//  - 발주서 단건(orderId): GET /v2/providers/openapi/apis/api/v5/vendors/{vendorId}/{orderId}/ordersheets
//  - 상품준비중 처리: PATCH /v2/providers/openapi/apis/api/v4/vendors/{vendorId}/ordersheets/acknowledgement
//  - 송장 업로드: POST /v2/providers/openapi/apis/api/v4/vendors/{vendorId}/orders/invoices (상품준비중 상태에서만)
// 호출 IP 제한이 있어 PROXY_URL(고정 IP 중계 서버)을 거쳐 나간다.
// 주의: shipmentBoxId 는 JavaScript 숫자 범위(2^53)를 넘을 수 있어 응답을 문자열로 받아 큰 정수를 따옴표로 감싼 뒤 파싱한다.
const axios  = require('axios');
const crypto = require('crypto');
const { supabase, upsertOrder, getChannelId, logSync } = require('../utils/supabase');
const { proxyAgent } = require('../utils/proxy');

const HOST = 'https://api-gateway.coupang.com';
const V4 = '/v2/providers/openapi/apis/api/v4/vendors';
const V5 = '/v2/providers/openapi/apis/api/v5/vendors';
const STATUSES = ['ACCEPT', 'INSTRUCT', 'DEPARTURE', 'DELIVERING', 'FINAL_DELIVERY', 'NONE_TRACKING'];
const TIME_BUDGET_MS = 45000;

function keys() {
  // 복사할 때 붙은 앞뒤 공백·줄바꿈·따옴표를 잘라낸다 ("key is not registered" 방지)
  const clean = v => String(v || '').trim().replace(/^["']|["']$/g, '').trim();
  let accessKey = clean(process.env.COUPANG_ACCESS_KEY);
  let secretKey = clean(process.env.COUPANG_SECRET_KEY);
  const vendorId  = clean(process.env.COUPANG_VENDOR_ID);
  if (!accessKey || !secretKey || !vendorId) {
    throw new Error('COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY / COUPANG_VENDOR_ID 환경변수가 없습니다.');
  }
  // Access Key는 36자 UUID 형식. Access 자리에 UUID가 아니고 Secret 자리에 UUID가 있으면
  // 두 값이 바뀌어 저장된 것이 확실하므로 맞바꿔 쓴다.
  let swapped = false;
  if (!UUID.test(accessKey) && UUID.test(secretKey)) {
    [accessKey, secretKey] = [secretKey, accessKey];
    swapped = true;
  }
  return { accessKey, secretKey, vendorId, swapped };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 401일 때 원인 짐작용 힌트 — 키 값은 절대 넣지 않고 길이·형식만 알려준다.
// 쿠팡 Access Key는 보통 36자(하이픈 포함 UUID), Secret Key는 40자 내외 영숫자.
function keyHint() {
  try {
    const { accessKey, secretKey, vendorId, swapped } = keys();
    const uuid = UUID.test(accessKey);
    return `Access Key ${accessKey.length}자${uuid ? '·형식 정상' : '·형식 다름'}, Secret Key ${secretKey.length}자, 업체코드 ${/^A\d+$/.test(vendorId) ? '형식 정상' : '형식 확인 필요'}` +
      (swapped ? ', Access/Secret 바뀜 → 자동으로 맞바꿔 사용함' : '') +
      (uuid ? ' — 형식은 맞으니 키 활성화(최대 24시간) 대기 또는 업체코드·키 계정 불일치일 수 있어요' : '');
  } catch (_) { return '키 확인 불가'; }
}

// ── HMAC 서명 ── signed-date: yyMMdd'T'HHmmss'Z' (UTC, 연도 2자리)
function signedDate(now = new Date()) {
  return now.toISOString().slice(2, 19).replace(/[-:]/g, '') + 'Z';   // "251126T013000Z"
}
function authorization(method, path, query, k) {
  const dt = signedDate();
  const signature = crypto.createHmac('sha256', k.secretKey).update(`${dt}${method}${path}${query}`).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${k.accessKey}, signed-date=${dt}, signature=${signature}`;
}

// 16자리 이상 정수는 문자열로 바꿔서 파싱 (정밀도 손실 방지)
function parseBig(text) {
  if (typeof text !== 'string') return text;
  return JSON.parse(text.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"'));
}
// 요청 본문: 큰 숫자 필드(shipmentBoxId 등)는 문자열로 넣었다가 JSON에서 따옴표를 벗겨 숫자로 보낸다
function bigBody(obj) {
  return JSON.stringify(obj).replace(/"(shipmentBoxId|orderId|vendorItemId)":"(\d+)"/g, '"$1":$2')
    .replace(/"shipmentBoxIds":\[([^\]]*)\]/g, (m, inner) => `"shipmentBoxIds":[${inner.replace(/"(\d+)"/g, '$1')}]`);
}

async function call(method, path, { params, body } = {}) {
  const k = keys();
  // 문서 예시와 같은 형태(…%2B09:00)로 보낸다 — 서명도 이 문자열 그대로 계산
  const query = params ? new URLSearchParams(params).toString().replace(/%3A/gi, ':') : '';
  const res = await axios.request({
    method,
    url: HOST + path + (query ? `?${query}` : ''),
    data: body === undefined ? undefined : bigBody(body),
    headers: {
      Authorization: authorization(method.toUpperCase(), path, query, k),
      'Content-Type': 'application/json;charset=UTF-8',
      'X-EXTENDED-TIMEOUT': '90000'
    },
    timeout: 25000,
    proxy: false,
    httpsAgent: proxyAgent(),
    responseType: 'text',
    transformResponse: [t => t]
  });
  return parseBig(res.data);
}

function errText(e) {
  const raw = e.response?.data;
  if (raw) {
    let d = raw;
    try { d = parseBig(raw); } catch (_) { /* 텍스트 그대로 */ }
    const msg = typeof d === 'string' ? d.slice(0, 300) : (d.message || JSON.stringify(d).slice(0, 300));
    return `${e.response.status} ${msg}`.trim();
  }
  return e.message;
}

// KST 날짜 "yyyy-mm-dd"
function kstDay(offsetDays = 0) {
  return new Date(Date.now() + 9 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
}
const money = m => (m && typeof m === 'object') ? Number(m.units || 0) + Number(m.nanos || 0) / 1e9 : Number(m || 0);

// ── 발주서 목록 (상태 하나, 기간 최대 31일, nextToken 페이징) ──
async function listOrdersheets(status, fromDay, toDay, deadline) {
  const { vendorId } = keys();
  const out = [];
  let nextToken = '';
  for (let page = 0; page < 40; page++) {
    if (Date.now() > deadline) break;
    const params = { createdAtFrom: `${fromDay}+09:00`, createdAtTo: `${toDay}+09:00`, status, maxPerPage: '50' };
    if (nextToken) params.nextToken = nextToken;
    const r = await call('get', `${V5}/${vendorId}/ordersheets`, { params });
    out.push(...(r?.data || []));
    nextToken = r?.nextToken || '';
    if (!nextToken) break;
  }
  return out;
}

async function getOrdersheetByOrderId(orderId) {
  const { vendorId } = keys();
  const r = await call('get', `${V5}/${vendorId}/${orderId}/ordersheets`);
  return Array.isArray(r?.data) ? r.data : (r?.data ? [r.data] : []);
}

// ── 주문 수집 ──
// 쿠팡은 "상태별 목록"을 주기 때문에, 최근 기간(기본 30일)의 모든 상태를 한 번씩 훑으면
// 신규 주문 수집과 진행 중 주문의 상태 갱신이 함께 된다.
async function syncOrders({ days = 1 } = {}) {
  const started = Date.now();
  const deadline = started + TIME_BUDGET_MS;
  const channelId = await getChannelId('coupang');
  const span = Math.max(30, Math.min(31, Number(days) || 1)) - 1;    // 상태 갱신을 위해 최소 30일
  const fromDay = kstDay(-span), toDay = kstDay(0);

  let synced = 0, errors = 0, stopped = false, errMsg = '';
  const seen = new Set();          // 이번에 저장한 쿠팡 주문번호
  const perStatus = {};

  const save = async (sheet) => {
    for (const row of mapCoupangSheet(channelId, sheet)) {
      try {
        const saved = await upsertOrder(row.order);
        await replaceItems(saved.id, row.item);
        await syncShipment(saved.id, sheet, row.order.status);
        synced++;
      } catch (e) {
        console.error('[COUPANG] 저장 실패:', e.message);
        errors++;
        errMsg = errMsg || `저장 실패: ${e.message}`;
      }
    }
    seen.add(String(sheet.orderId));
  };

  try {
    for (const st of STATUSES) {
      if (Date.now() > deadline) { stopped = true; break; }
      const sheets = await listOrdersheets(st, fromDay, toDay, deadline);
      perStatus[st] = sheets.length;
      for (const s of sheets) {
        if (Date.now() > deadline + 10000) { stopped = true; break; }
        await save(s);
      }
      if (stopped) break;
    }

    // 목록에서 사라진 진행 중 주문(취소·반품 등)은 단건 조회로 확인
    if (!stopped) {
      const { data: open, error } = await supabase
        .from('orders').select('channel_order_no')
        .eq('channel_id', channelId)
        .in('status', ['new', 'confirmed', 'preparing', 'ready', 'shipped', 'delivered'])
        .limit(500);
      if (error) throw new Error(error.message);
      const missing = [...new Set((open || []).map(o => o.channel_order_no))].filter(n => n && !seen.has(n));
      for (const orderId of missing) {
        if (Date.now() > deadline) { stopped = true; break; }
        try {
          const sheets = await getOrdersheetByOrderId(orderId);
          if (sheets.length) { for (const s of sheets) await save(s); }
          else await markOrder(channelId, orderId, 'cancelled');
        } catch (e) {
          if (e.response?.status === 404 || e.response?.status === 400) await markOrder(channelId, orderId, 'cancelled');
          else throw e;
        }
      }
    }
  } catch (e) {
    errMsg = `API 오류: ${errText(e)}`;
    if (e.response?.status === 401) errMsg += ` (${keyHint()})`;
    console.error('[COUPANG]', errMsg);
    errors++;
  }

  const counts = Object.entries(perStatus).filter(([, n]) => n).map(([s, n]) => `${STATUS_LABEL[s]} ${n}`).join(', ');
  let message = `${fromDay}~${toDay} 조회 · 저장 ${synced}건` + (counts ? ` (${counts})` : '');
  if (stopped) message += ' · 시간 제한으로 일부만 처리 — 다시 누르면 이어서 확인';
  if (errMsg) message += ` · ${errMsg}`;
  await logSync('coupang', { synced, errors, message });
  return { synced, errors, message };
}

const STATUS_LABEL = {
  ACCEPT: '결제완료', INSTRUCT: '상품준비중', DEPARTURE: '배송지시', DELIVERING: '배송중',
  FINAL_DELIVERY: '배송완료', NONE_TRACKING: '업체직송'
};

async function markOrder(channelId, orderNo, status) {
  const { error } = await supabase.from('orders')
    .update({ status, synced_at: new Date().toISOString() })
    .eq('channel_id', channelId).eq('channel_order_no', String(orderNo));
  if (error) throw new Error(error.message);
}

// 주문 1행(옵션 1개)의 품목을 덮어쓴다
async function replaceItems(orderId, it) {
  await supabase.from('order_items').delete().eq('order_id', orderId);
  const qty = Number(it.shippingCount || 1);
  const { error } = await supabase.from('order_items').insert({
    order_id:     orderId,
    product_name: it.sellerProductName || it.vendorItemName || '(상품명 없음)',
    option_info:  it.sellerProductItemName || null,
    option_code:  it.vendorItemId ? String(it.vendorItemId) : null,
    seller_code:  it.externalVendorSkuCode || null,
    quantity:     qty,
    unit_price:   money(it.salesPrice),
    option_price: 0,
    total_amount: money(it.orderPrice) || money(it.salesPrice) * qty
  });
  if (error) throw new Error(error.message);
}

// 배송 정보(택배사·송장·발송일·도착일) → shipments (주문당 1건, 있으면 갱신)
async function syncShipment(orderId, s, status) {
  if (!s.invoiceNumber && !s.inTrasitDateTime) return;
  const fields = { status: ['delivered', 'completed'].includes(status) ? 'delivered' : 'shipped' };
  if (s.invoiceNumber) fields.tracking_no = String(s.invoiceNumber);
  if (s.deliveryCompanyName) fields.carrier = s.deliveryCompanyName.replace(/\s+/g, '');
  if (s.inTrasitDateTime) fields.shipped_dt = s.inTrasitDateTime;
  if (s.deliveredDate) fields.delivered_dt = s.deliveredDate;
  const { data: exist, error: selErr } = await supabase
    .from('shipments').select('id').eq('order_id', orderId).order('created_at', { ascending: false }).limit(1);
  if (selErr) throw new Error(selErr.message);
  const { error } = exist?.length
    ? await supabase.from('shipments').update(fields).eq('id', exist[0].id)
    : await supabase.from('shipments').insert({ order_id: orderId, ...fields });
  if (error) throw new Error(error.message);
}

// ── 데이터 변환: 발주서 1건 → 옵션(orderItems)마다 orders 1행 ──
// channel_item_no = "shipmentBoxId_vendorItemId" (송장 업로드에 둘 다 필요)
function mapCoupangSheet(channelId, s) {
  const r = s.receiver || {};
  const items = s.orderItems || [];
  return items.map((it, i) => {
    const qty = Number(it.shippingCount || 0);
    const canceledAll = it.canceled === true || (qty > 0 && Number(it.cancelCount || 0) >= qty);
    const status = canceledAll ? 'cancelled' : mapCoupangStatus(s.status, it);
    const { orderItems, ...sheetWithoutItems } = s;
    return {
      item: it,
      order: {
        channel_id:        channelId,
        channel_order_no:  String(s.orderId),
        channel_item_no:   `${s.shipmentBoxId}_${it.vendorItemId}`,
        status,
        buyer_name:        s.orderer?.name || null,
        buyer_phone:       s.orderer?.ordererNumber || s.orderer?.safeNumber || null,
        receiver_name:     r.name || null,
        receiver_phone1:   r.safeNumber || null,
        receiver_phone2:   r.receiverNumber || null,
        zipcode:           r.postCode || null,
        address_base:      r.addr1 || null,
        address_detail:    r.addr2 || null,
        address_full:      `${r.addr1 || ''} ${r.addr2 || ''}`.trim() || null,
        delivery_message:  s.parcelPrintMessage || null,
        payment_dt:        s.paidAt || null,
        order_dt:          s.orderedAt || s.paidAt || null,
        shipping_deadline_dt: it.estimatedShippingDate || null,
        total_amount:      money(it.orderPrice) || money(it.salesPrice) * qty,
        shipping_fee:      i === 0 ? money(s.shippingPrice) + money(s.remotePrice) : 0,   // 배송비는 묶음당 1번
        discount_amount:   money(it.discountPrice),
        raw_data:          { ...sheetWithoutItems, orderItem: it },
        synced_at:         new Date().toISOString()
      }
    };
  });
}

// 쿠팡 상태 → 어드민 상태 (네이버와 같은 구분)
//  결제완료=신규주문(new), 상품준비중=배송준비중(confirmed), 배송지시·배송중·업체직송=배송중(shipped),
//  배송완료=배송완료(delivered), 구매확정일이 있으면 구매확정(completed)
function mapCoupangStatus(s, item = {}) {
  if (s === 'FINAL_DELIVERY') return item.confirmDate ? 'completed' : 'delivered';
  const m = {
    ACCEPT:        'new',
    INSTRUCT:      'confirmed',
    DEPARTURE:     'shipped',
    DELIVERING:    'shipped',
    NONE_TRACKING: 'shipped'
  };
  return m[s] || 'new';
}

// ── 상품준비중 처리 (결제완료 → 상품준비중). shipmentBoxIds 최대 50개씩 ──
async function acknowledge(shipmentBoxIds) {
  const { vendorId } = keys();
  const results = [];
  for (let i = 0; i < shipmentBoxIds.length; i += 50) {
    const r = await call('patch', `${V4}/${vendorId}/ordersheets/acknowledgement`, {
      body: { vendorId, shipmentBoxIds: shipmentBoxIds.slice(i, i + 50).map(String) }
    });
    results.push(...(r?.data?.responseList || []));
  }
  return results;
}

// ── 송장 업로드 ── (bulk.js에서 호출: channelOrderNo=orderId, channelItemNo="shipmentBoxId_vendorItemId")
const CARRIER_CODES = {
  'CJ대한통운': 'CJGLS', '한진택배': 'HANJIN', '롯데택배': 'HYUNDAI', '우체국': 'EPOST', '우체국택배': 'EPOST',
  '로젠택배': 'KGB', '경동택배': 'KDEXP', '대신택배': 'DAESIN', '일양로지스': 'ILYANG', '천일택배': 'CHUNIL'
};
async function registerShipment({ channelOrderNo, channelItemNo, trackingNo, carrier }) {
  const { vendorId } = keys();
  const [shipmentBoxId, vendorItemId] = String(channelItemNo || '').split('_');
  if (!shipmentBoxId || !vendorItemId) throw new Error('쿠팡 배송번호(shipmentBoxId)를 찾을 수 없습니다. 주문을 다시 수집해 주세요.');

  // 송장은 상품준비중 상태에서만 올릴 수 있어서, 결제완료 상태면 먼저 상품준비중 처리
  const ack = await acknowledge([shipmentBoxId]).catch(() => []);
  void ack;   // 이미 상품준비중이면 실패 응답이 오지만 무시하고 진행

  const r = await call('post', `${V4}/${vendorId}/orders/invoices`, {
    body: {
      vendorId,
      orderSheetInvoiceApplyDtos: [{
        shipmentBoxId,
        orderId:             String(channelOrderNo),
        vendorItemId,
        deliveryCompanyCode: CARRIER_CODES[carrier] || 'CJGLS',
        invoiceNumber:       String(trackingNo).replace(/[\s-]/g, ''),
        splitShipping:       false,
        preSplitShipped:     false,
        estimatedShippingDate: ''
      }]
    }
  });
  const fail = (r?.data?.responseList || []).filter(x => !x.succeed);
  if (fail.length || (r?.data?.responseCode != null && Number(r.data.responseCode) !== 0)) {
    throw new Error('쿠팡 송장 업로드 실패: ' + (fail.map(f => `${f.resultCode} ${f.resultMessage || ''}`).join(', ') || r?.data?.responseMessage || ''));
  }
  return r;
}

module.exports = { syncOrders, registerShipment, acknowledge, mapCoupangSheet, mapCoupangStatus, signedDate, parseBig, bigBody };
