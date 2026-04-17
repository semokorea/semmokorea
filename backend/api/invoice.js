const express  = require('express');
const supabase = require('./supabase');
const router   = express.Router();

// GET /api/invoice/mappings  — 에이블리 컬럼 매핑 조회
router.get('/mappings', async (req, res) => {
  const { data, error } = await supabase
    .from('invoice_column_mappings').select('*').order('col_index');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/invoice/mappings  — 컬럼 매핑 저장
router.post('/mappings', async (req, res) => {
  const { mappings } = req.body;
  const { data, error } = await supabase
    .from('invoice_column_mappings').upsert(mappings).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/invoice/generate  — 에이블리 57컬럼 엑셀 생성 (추후 구현)
router.post('/generate', (req, res) => {
  res.status(501).json({ message: '엑셀 송장 생성 기능 준비 중' });
});

module.exports = router;
