const express  = require('express');
const supabase = require('./supabase');
const router   = express.Router();

// GET /api/orders
router.get('/', async (req, res) => {
  const { channel, status, page = 1, limit = 50 } = req.query;
  let query = supabase.from('orders').select('*, order_items(*)', { count: 'exact' });
  if (channel) query = query.eq('channel_id', channel);
  if (status)  query = query.eq('status', status);
  query = query.range((page - 1) * limit, page * limit - 1).order('ordered_at', { ascending: false });
  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count, page: Number(page), limit: Number(limit) });
});

// GET /api/orders/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('orders').select('*, order_items(*)').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });
  res.json(data);
});

// POST /api/orders/sync  (플랫폼 수동 동기화 — 추후 구현)
router.post('/sync', (req, res) => {
  res.status(501).json({ message: '플랫폼 동기화 기능 준비 중' });
});

module.exports = router;
