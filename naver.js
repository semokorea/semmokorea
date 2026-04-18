// api/orders/index.js
// GET /api/orders — 주문 목록 조회 (필터/페이지네이션)
const { supabase } = require('../../utils/supabase');
const jwt = require('jsonwebtoken');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();

  // JWT 검증
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: '인증 필요' });
  }

  const {
    channel   = 'all',
    status    = 'all',
    date_from,
    date_to,
    page      = 1,
    limit     = 50,
    search    = ''
  } = req.query;

  let query = supabase
    .from('orders')
    .select(`
      id, channel_id, channel_order_no, channel_item_no,
      status, buyer_name, receiver_name, receiver_phone1,
      address_full, delivery_message, payment_method,
      total_amount, shipping_fee, order_dt, synced_at,
      channels ( code, name ),
      order_items ( product_name, option_info, quantity, unit_price ),
      shipments ( tracking_no, carrier, status, shipped_dt )
    `, { count: 'exact' })
    .order('order_dt', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (channel !== 'all') {
    const { data: ch } = await supabase
      .from('channels').select('id').eq('code', channel).single();
    if (ch) query = query.eq('channel_id', ch.id);
  }
  if (status !== 'all')  query = query.eq('status', status);
  if (date_from)         query = query.gte('order_dt', date_from);
  if (date_to)           query = query.lte('order_dt', date_to + 'T23:59:59');
  if (search)            query = query.ilike('receiver_name', `%${search}%`);

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({
    orders: data,
    total:  count,
    page:   Number(page),
    pages:  Math.ceil(count / limit)
  });
};
