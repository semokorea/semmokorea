// sync/zigzag.js
// 지그재그(카카오스타일) 파트너 API — 주문 수집 + 배송 반영
const axios = require('axios');
const { upsertOrder, getChannelId, logSync } = require('../utils/supabase');

const BASE = 'https://api.zigzag.kr';

function getHeaders() {
  return {
    'Authorization': `Bearer ${process.env.ZIGZAG_API_KEY}`,
    'Content-Type':  'application/json'
  };
}

// ── 주문 수집 ──
async function syncOrders() {
  const channelId = await getChannelId('zigzag');
  const headers   = getHeaders();

  const to   = new Date();
  const from = new Date(to - 24 * 60 * 60 * 1000);

  let synced = 0, errors = 0, cursor = null;

  try {
    while (true) {
      const params = {
        start_date: from.toISOString(),
        end_date:   to.toISOString(),
        status:     'payment_done',
        limit:      100,
        ...(cursor && { cursor })
      };

      const res = await axios.get(`${BASE}/api/v1/orders`, { headers, params });
      const orders = res.data?.list || res.data?.orders || res.data?.data || [];

      if (orders.length === 0) break;

      for (const o of orders) {
        try {
          await upsertOrder(mapZigzagOrder(channelId, o));
          synced++;
        } catch (e) {
          console.error('[ZIGZAG] upsert 실패:', e.message);
          errors++;
        }
      }

      cursor = res.data?.next_cursor || res.data?.cursor;
      if (!cursor || orders.length < 100) break;
    }
  } catch (e) {
    console.error('[ZIGZAG] API 실패:', e.response?.data || e.message);
    errors++;
  }

  await logSync('zigzag', { synced, errors });
  return { synced, errors };
}

// ── 배송 반영 ──
async function registerShipment({ channelItemNo, trackingNo, carrier }) {
  const headers = getHeaders();

  const carrierCodes = {
    'CJ대한통운': 'cj_logistics',
    '한진택배':   'hanjin',
    '롯데택배':   'lotte',
    '우체국':     'koreapost',
  };

  const res = await axios.post(
    `${BASE}/api/v1/orders/${channelItemNo}/delivery`,
    {
      courier_name:    carrierCodes[carrier] || 'cj_logistics',
      invoice_number:  trackingNo,
      shipped_at:      new Date().toISOString()
    },
    { headers }
  );

  return res.data;
}

// ── 주문 데이터 변환 ──
function mapZigzagOrder(channelId, o) {
  const addr = o.shipping_address || o.delivery_address || {};
  return {
    channel_id:       channelId,
    channel_order_no: String(o.order_number || o.id),
    channel_item_no:  String(o.order_item_number || o.item_id || o.id),
    status:           mapZigzagStatus(o.status),
    buyer_name:       o.buyer_name || o.orderer?.name,
    buyer_id:         o.buyer_id,
    buyer_phone:      o.buyer_phone || o.orderer?.phone,
    receiver_name:    addr.name || addr.receiver_name,
    receiver_phone1:  addr.phone || addr.mobile,
    zipcode:          addr.zipcode || addr.zip_code,
    address_base:     addr.address1 || addr.road_address,
    address_detail:   addr.address2 || addr.detail_address,
    address_full:     `${addr.address1 || addr.road_address || ''} ${addr.address2 || addr.detail_address || ''}`.trim(),
    delivery_message: addr.message || o.delivery_memo,
    payment_method:   o.payment_method,
    order_dt:         o.ordered_at || o.created_at,
    total_amount:     o.total_price || o.order_amount,
    shipping_fee:     o.shipping_fee || 0,
    discount_amount:  o.discount_amount || 0,
    settlement_amount: o.settlement_amount || 0,
    raw_data:         o,
    synced_at:        new Date().toISOString()
  };
}

function mapZigzagStatus(s) {
  const m = {
    'payment_done':      'confirmed',
    'preparing':         'preparing',
    'shipping':          'shipped',
    'delivered':         'delivered',
    'purchase_confirm':  'delivered',
    'cancelled':         'cancelled',
    'returned':          'returned',
  };
  return m[s] || 'new';
}

module.exports = { syncOrders, registerShipment };
