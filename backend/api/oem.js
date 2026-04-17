const express  = require('express');
const supabase = require('./supabase');
const router   = express.Router();

// ── OEM 주문 ──

// GET /api/oem/orders
router.get('/orders', async (req, res) => {
  const { status } = req.query;
  let query = supabase.from('oem_orders').select('*, oem_clients(name), oem_order_items(*)').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/oem/orders
router.post('/orders', async (req, res) => {
  const { data, error } = await supabase.from('oem_orders').insert(req.body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/oem/orders/:id/progress  — 배송 진행단계 업데이트
router.patch('/orders/:id/progress', async (req, res) => {
  const { status } = req.body;
  const { data, error } = await supabase
    .from('oem_orders').update({ status }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── OEM 견적서 ──

// GET /api/oem/quotations
router.get('/quotations', async (req, res) => {
  const { data, error } = await supabase
    .from('oem_quotations')
    .select('*, oem_clients(name), oem_quotation_items(*)')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/oem/quotations
router.post('/quotations', async (req, res) => {
  const { data, error } = await supabase.from('oem_quotations').insert(req.body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// POST /api/oem/quotations/:id/pdf  — 견적서 PDF 생성 (추후 구현)
router.post('/quotations/:id/pdf', (req, res) => {
  res.status(501).json({ message: '견적서 PDF 생성 기능 준비 중' });
});

// ── OEM 거래처 ──

// GET /api/oem/clients
router.get('/clients', async (req, res) => {
  const { data, error } = await supabase
    .from('oem_clients').select('*').eq('is_active', true).order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
