// api/shipments/bulk.js
// POST /api/shipments/bulk — 운송장 일괄 등록 + 각 플랫폼 배송중 반영
const { supabase } = require('../../utils/supabase');
const naver   = require('../../sync/naver');
const coupang = require('../../sync/coupang');
const ably    = require('../../sync/ably');
const zigzag  = require('../../sync/zigzag');
const { verifyRequest } = require('../../utils/auth');

const platformMap = { naver, coupang, ably, zigzag };

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!verifyRequest(req)) return res.status(401).json({ error: '인증 필요' });

  /*
    body: {
      shipments: [
        {
          order_id:       "uuid",          // Supabase orders.id
          tracking_no:    "5012-3456-7890",
          carrier:        "CJ대한통운"
        },
        ...
      ]
    }
  */
  const { shipments = [] } = req.body;
  if (!shipments.length) {
    return res.status(400).json({ error: '배송 처리할 주문이 없습니다.' });
  }

  const results = { success: [], failed: [], platform_failed: [] };

  for (const item of shipments) {
    const { order_id, tracking_no, carrier = 'CJ대한통운' } = item;

    // 1. Supabase에서 주문 정보 조회
    const { data: order, error: fetchErr } = await supabase
      .from('orders')
      .select('id, channel_id, channel_order_no, channel_item_no, channels(code)')
      .eq('id', order_id)
      .single();

    if (fetchErr || !order) {
      results.failed.push({ order_id, reason: '주문을 찾을 수 없음' });
      continue;
    }

    const channelCode = order.channels?.code;

    try {
      // 2. 각 플랫폼에 운송장 번호 전송
      const platform = platformMap[channelCode];
      if (platform) {
        try {
          await platform.registerShipment({
            channelOrderNo: order.channel_order_no,
            channelItemNo:  order.channel_item_no,
            trackingNo:     tracking_no,
            carrier
          });
        } catch (platformErr) {
          console.error(`[${channelCode.toUpperCase()}] 플랫폼 배송 반영 실패:`, platformErr.message);
          results.platform_failed.push({
            order_id,
            channel: channelCode,
            reason: platformErr.message
          });
        }
      }

      // 3. Supabase shipments 테이블에 저장
      //    shipments.order_id에는 UNIQUE 제약이 없어 upsert(onConflict) 대신 조회 후 update/insert
      const shipRow = {
        carrier,
        tracking_no,
        status:     'shipped',
        shipped_dt: new Date().toISOString()
      };
      const { data: existing, error: exErr } = await supabase
        .from('shipments').select('id').eq('order_id', order_id).limit(1);
      if (exErr) throw new Error(exErr.message);
      const { error: shipErr } = existing && existing.length
        ? await supabase.from('shipments').update(shipRow).eq('id', existing[0].id)
        : await supabase.from('shipments').insert({ order_id, ...shipRow });
      if (shipErr) throw new Error(shipErr.message);

      // 4. orders 테이블 상태 업데이트
      await supabase
        .from('orders')
        .update({
          status:    'shipped',
          synced_at: new Date().toISOString()
        })
        .eq('id', order_id);

      results.success.push({ order_id, tracking_no, channel: channelCode });

    } catch (err) {
      console.error('[SHIPMENT] 처리 실패:', err.message);
      results.failed.push({ order_id, reason: err.message });
    }
  }

  return res.status(200).json({
    success:          results.success.length,
    failed:           results.failed.length,
    platform_failed:  results.platform_failed.length,
    details:          results,
    processed_at:     new Date().toISOString()
  });
};
