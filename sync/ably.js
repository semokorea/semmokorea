// sync/ably.js
// 에이블리 파트너 API — 주문 수집 + 배송 반영
const axios = require('axios');
const { upsertOrder, getChannelId, logSync } = require('../utils/supabase');

const BASE = 'https://api.a-bly.com';

function getHeaders() {
  return {
    'x-api-key':    process.env.ABLY_API_KEY,
    'Content-Type': 'application/json'
  };
}

// ── 주문 수집 ──
async function syncOrders() {
  const channelId = await getChannelId('ably');
  const headers   = getHeaders();

  const to   = new Date();
  const from = new Date(to - 24 * 60 * 60 * 1000);

  let synced = 0, errors = 0, page = 1;

  try {
    while (true) {
      const res = await axios.get(`${BASE}/api/v1/orders`, {
        headers,
        params: {
          start_date: from.toISOString().split('T')[0],
          end_date:   to.toISOString().split('T')[0],
          status:     'PAYMENT_COMPLETED',
          page,
          per_page:   100
        }
      });

      const orders = res.data?.orders || res.data?.data || [];
      if (orders.length === 0) break;

      for (const o of orders) {
        try {
          await upsertOrder(mapAblyOrder(channelId, o));
          synced++;
        } catch (e) {
          console.error('[ABLY] upsert 실패:', e.message);
          errors++;
        }
      }

      if (orders.length < 100) break;
      page++;
    }
  } catch (e) {
    console.error('[ABLY] API 실패:', e.response?.data || e.message);
    errors++;
  }

  await logSync('ably', { synced, errors });
  return { synced, errors };
}

// ── 배송 반영 ──
async function registerShipment({ channelItemNo, trackingNo, carrier }) {
  const headers = getHeaders();

  const carrierCodes = {
    'CJ대한통운': 'cj',
    '한진택배':   'hanjin',
    '롯데택배':   'lotte',
    '우체국':     'epost',
  };

  const res = await axios.post(
    `${BASE}/api/v1/orders/${channelItemNo}/shipping`,
    {
      carrier_id:      carrierCodes[carrier] || 'cj',
      tracking_number: trackingNo,
      shipped_at:      new Date().toISOString()
    },
    { headers }
  );

  return res.data;
}

// ── 주문 데이터 변환 ──
function mapAblyOrder(channelId, o) {
  return {
    channel_id:       channelId,
    channel_order_no: String(o.order_number || o.id),
    channel_item_no:  String(o.order_item_number || o.item_id || o.id),
    status:           mapAblyStatus(o.status),
    buyer_name:       o.buyer?.name || o.buyer_name,
    buyer_id:         o.buyer?.id   || o.buyer_id,
    buyer_phone:      o.buyer?.phone,
    receiver_name:    o.shipping_address?.receiver_name || o.receiver_name,
    receiver_phone1:  o.shipping_address?.phone || o.receiver_phone,
    zipcode:          o.shipping_address?.zipcode,
    address_base:     o.shipping_address?.address1,
    address_detail:   o.shipping_address?.address2,
    address_full:     `${o.shipping_address?.address1 || ''} ${o.shipping_address?.address2 || ''}`.trim(),
    delivery_message: o.shipping_address?.message || o.delivery_memo,
    payment_method:   o.payment_method,
    order_dt:         o.ordered_at || o.created_at,
    total_amount:     o.total_price || o.amount,
    shipping_fee:     o.shipping_fee || 0,
    discount_amount:  o.discount_price || 0,
    settlement_amount: o.settlement_amount || 0,
    raw_data:         o,
    synced_at:        new Date().toISOString()
  };
}

function mapAblyStatus(s) {
  const m = {
    'PAYMENT_COMPLETED':   'confirmed',
    'PREPARING':           'preparing',
    'SHIPPING':            'shipped',
    'DELIVERED':           'delivered',
    'PURCHASE_CONFIRMED':  'completed',
    'CANCELLED':           'cancelled',
    'RETURNED':            'returned',
  };
  return m[s] || 'new';
}

module.exports = { syncOrders, registerShipment };
