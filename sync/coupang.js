// sync/coupang.js
// 쿠팡 Wing Open API — HMAC-SHA256 서명 인증
const axios  = require('axios');
const crypto = require('crypto');
const { upsertOrder, getChannelId, logSync } = require('../utils/supabase');

const BASE      = 'https://api-gateway.coupang.com';
const ACCESS_KEY = process.env.COUPANG_ACCESS_KEY;
const SECRET_KEY = process.env.COUPANG_SECRET_KEY;
const VENDOR_ID  = process.env.COUPANG_VENDOR_ID;

// ── HMAC 서명 생성 ──
function generateHmac(method, path, query = '') {
  const datetime  = new Date().toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const message   = `${datetime}${method}${path}${query}`;
  const signature = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(message)
    .digest('hex');

  return {
    Authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`,
    'Content-Type': 'application/json;charset=UTF-8'
  };
}

// ── 주문 수집 ──
async function syncOrders() {
  const channelId = await getChannelId('coupang');

  const to   = new Date();
  const from = new Date(to - 24 * 60 * 60 * 1000);
  const fmt  = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

  const path   = `/v2/providers/openapi/apis/api/v4/vendors/${VENDOR_ID}/ordersheets`;
  const query  = `createdAtFrom=${encodeURIComponent(fmt(from))}&createdAtTo=${encodeURIComponent(fmt(to))}&status=ACCEPT&pageSize=100&pageIndex=1`;
  const headers = generateHmac('GET', path, query);

  let synced = 0, errors = 0;

  try {
    const res = await axios.get(`${BASE}${path}?${query}`, { headers });
    const orders = res.data?.data || [];

    for (const o of orders) {
      for (const item of (o.orderItems || [])) {
        try {
          await upsertOrder(mapCoupangOrder(channelId, o, item));
          synced++;
        } catch (e) {
          console.error('[COUPANG] upsert 실패:', e.message);
          errors++;
        }
      }
    }
  } catch (e) {
    console.error('[COUPANG] API 실패:', e.response?.data || e.message);
    errors++;
  }

  await logSync('coupang', { synced, errors });
  return { synced, errors };
}

// ── 배송 반영 ──
async function registerShipment({ channelOrderNo, trackingNo, carrier }) {
  const carrierCodes = {
    'CJ대한통운': 'CJ대한통운',
    '한진택배':   '한진택배',
    '롯데택배':   '롯데택배',
    '우체국':     '우체국택배',
  };

  const path = `/v2/providers/openapi/apis/api/v4/vendors/${VENDOR_ID}/orders/${channelOrderNo}/invoices`;
  const headers = generateHmac('POST', path);

  const body = {
    vendorId:       VENDOR_ID,
    orderId:        channelOrderNo,
    deliveryCompanyCode: carrierCodes[carrier] || 'CJ대한통운',
    invoiceNumber:  trackingNo,
    splitShipping:  false,
    estimatedShippingDate: new Date().toISOString().split('T')[0]
  };

  const res = await axios.post(`${BASE}${path}`, body, { headers });
  return res.data;
}

// ── 주문 데이터 변환 ──
function mapCoupangOrder(channelId, order, item) {
  return {
    channel_id:       channelId,
    channel_order_no: String(order.orderId),
    channel_item_no:  String(item.orderItemId),
    status:           mapCoupangStatus(order.status),
    buyer_name:       order.orderer?.name,
    buyer_phone:      order.orderer?.safeNumber || order.orderer?.phone,
    receiver_name:    order.shippingAddress?.name,
    receiver_phone1:  order.shippingAddress?.safeNumber || order.shippingAddress?.phone,
    zipcode:          order.shippingAddress?.postCode,
    address_base:     order.shippingAddress?.addr,
    address_detail:   order.shippingAddress?.detailAddr,
    address_full:     `${order.shippingAddress?.addr || ''} ${order.shippingAddress?.detailAddr || ''}`.trim(),
    delivery_message: order.shippingAddress?.message,
    payment_method:   order.paymentMethod,
    order_dt:         order.orderDate,
    total_amount:     item.salesPrice * item.quantity,
    shipping_fee:     item.deliveryPrice || 0,
    discount_amount:  item.discountPrice || 0,
    settlement_amount: item.settledAmt || 0,
    raw_data:         item,
    synced_at:        new Date().toISOString()
  };
}

function mapCoupangStatus(s) {
  const m = {
    ACCEPT:    'confirmed',
    INSTRUCT:  'preparing',
    DEPARTURE: 'shipped',
    DELIVERING:'shipped',
    FINAL_DELIVERY: 'delivered',
    CANCEL_DONE:    'cancelled',
    RETURN_DONE:    'returned',
  };
  return m[s] || 'new';
}

module.exports = { syncOrders, registerShipment };
