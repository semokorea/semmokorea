const express  = require('express');
const supabase = require('./supabase');
const router   = express.Router();

// POST /api/shipments/bulk  — 운송장 일괄 등록
router.post('/bulk', async (req, res) => {
  const { shipments } = req.body;
  if (!Array.isArray(shipments) || shipments.length === 0)
    return res.status(400).json({ error: '운송장 데이터가 없습니다.' });

  const { data, error } = await supabase.from('shipments').insert(shipments).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: `${data.length}건 등록 완료`, data });
});

// GET /api/shipments/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('shipments').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: '배송 정보를 찾을 수 없습니다.' });
  res.json(data);
});

module.exports = router;
