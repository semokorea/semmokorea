// sync/naver.js
// 네이버 Commerce API — 주문 수집 + 배송 반영
const axios = require('axios');
const { upsertOrder, getChannelId, logSync } = require('../utils/supabase');

const BASE = 'https://api.commerce.naver.com/external';

// ── OAuth 토큰 발급 ──
let _token = null;
let _tokenExpiry = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  const clientId     = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  const timestamp = Date.now().toString();
  const crypto    = require('crypto');
  const signature = crypto
    .createHmac('sha256', clientSecret)
    .update(`${clientId}_${timestamp}`)
    .digest('base64');

  const res = await axios.post(
    `${BASE}/v1/oauth2/token`,
    new URLSearchParams({
      client_id:     clientId,
      timestamp,
      client_secret_sign: signature,
      grant_type:    'client_credentials',
      type:          'SELF'
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  _token       = res.data.access_token;
  _tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return _token;
}

// ── 주문 수집 ──
async function syncOrders() {
  const channelId = await getChannelId('naver');
  const token     = await getToken();
  const headers   = { Authorization: `Bearer ${token}` };

  // 최근 24시간 주문 조회
  const to   = new Date();
  const from = new Date(to - 24 * 60 * 60 * 1000);

  const params = {
    lastChangedFrom: from.toISOString(),
    lastChangedTo:   to.toISOString(),
    pageNum:  1,
    pageSize: 300,
    sellerType: 'GENERAL'
  };

  let synced = 0, errors = 0;

  try {
    const res = await axios.get(`${BASE}/v1/pay-order/seller/orders`, { headers, params });
    const orders = res.data.data || [];

    for (const o of orders) {
      for (const item of (o.productOrderList || [])) {
        try {
          await upsertOrder(mapNaverOrder(channelId, o, item));
          synced++;
        } catch (e) {
          console.error('[NAVER] upsert 실패:', e.message);
          errors++;
        }
      }
    }
  } catch (e) {
    console.error('[NAVER] API 호출 실패:', e.response?.data || e.message);
    errors++;
  }

  await logSync('naver', { synced, errors });
  return { synced, errors };
}

// ── 배송 반영 ──
async function registerShipment({ channelItemNo, trackingNo, carrier }) {
  const token   = await getToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // 택배사 코드 매핑
  const carrierCodes = {
    'CJ대한통운': 'CJGLS',
    '한진택배':   'HANJIN',
    '롯데택배':   'LOTTE',
    '우체국':     'EPOST',
  };
  const deliveryCompany = carrierCodes[carrier] || 'CJGLS';

  const body = {
    dispatchProductOrders: [{
      productOrderId:  channelItemNo,
      deliveryMethod:  'PARCEL',
      deliveryCompany,
      trackingNumber:  trackingNo,
      dispatchDate:    new Date().toISOString().split('T')[0]
    }]
  };

  const res = await axios.post(
    `${BASE}/v1/pay-order/seller/product-orders/dispatch`,
    body,
    { headers }
  );

  return res.data;
}

// ── 주문 데이터 변환 ──
function mapNaverOrder(channelId, order, item) {
  return {
    channel_id:           channelId,
    channel_order_no:     order.orderId,
    channel_item_no:      item.productOrderId,
    status:               mapNaverStatus(item.productOrderStatus),
    buyer_name:           order.ordererName,
    buyer_phone:          order.ordererTel,
    receiver_name:        item.shippingAddress?.name,
    receiver_phone1:      item.shippingAddress?.tel1,
    receiver_phone2:      item.shippingAddress?.tel2,
    zipcode:              item.shippingAddress?.zipCode,
    address_base:         item.shippingAddress?.baseAddress,
    address_detail:       item.shippingAddress?.detailAddress,
    address_full:         `${item.shippingAddress?.baseAddress || ''} ${item.shippingAddress?.detailAddress || ''}`.trim(),
    delivery_message:     item.shippingAddress?.requestedMessage,
    payment_method:       order.paymentMeans,
    order_dt:             order.orderDate,
    total_amount:         item.unitPrice * item.quantity,
    shipping_fee:         item.shippingFee || 0,
    discount_amount:      item.discountAmt || 0,
    settlement_amount:    item.settleExpectAmt || 0,
    raw_data:             item,
    synced_at:            new Date().toISOString()
  };
}

function mapNaverStatus(s) {
  const m = {
    PAYMENT_WAITING:          'new',
    PAYED:                    'confirmed',
    DELIVERING:               'shipped',
    DELIVERED:                'delivered',
    PURCHASE_DECIDED:         'delivered',
    EXCHANGED:                'returned',
    CANCEL_DONE:              'cancelled',
    RETURN_DONE:              'returned',
  };
  return m[s] || 'new';
}

module.exports = { syncOrders, registerShipment };
