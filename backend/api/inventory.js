const express  = require('express');
const supabase = require('./supabase');
const router   = express.Router();

// GET /api/inventory  — 재고 전체 조회
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('product_options')
    .select('*, products(name, seller_code, category)')
    .order('stock_qty', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /api/inventory/:option_id  — 재고 수정
router.patch('/:option_id', async (req, res) => {
  const { stock_qty, note } = req.body;
  const { data, error } = await supabase
    .from('product_options')
    .update({ stock_qty })
    .eq('id', req.params.option_id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // 재고 변동 로그
  if (note) {
    await supabase.from('stock_logs').insert({
      option_id: req.params.option_id,
      change_qty: stock_qty,
      memo: note
    });
  }
  res.json(data);
});

module.exports = router;
