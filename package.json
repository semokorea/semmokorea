// api/sync/index.js
// POST /api/sync — 수동 동기화 트리거 (어드민 버튼용)
const naver   = require('../../sync/naver');
const coupang = require('../../sync/coupang');
const ably    = require('../../sync/ably');
const zigzag  = require('../../sync/zigzag');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // JWT 인증 확인
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '인증 필요' });

  const { channels = ['naver', 'coupang', 'ably', 'zigzag'] } = req.body || {};

  const syncMap = { naver, coupang, ably, zigzag };
  const results = {};

  await Promise.allSettled(
    channels
      .filter(c => syncMap[c])
      .map(async (c) => {
        try {
          results[c] = await syncMap[c].syncOrders();
        } catch (e) {
          results[c] = { synced: 0, errors: 1, message: e.message };
        }
      })
  );

  const totalSynced = Object.values(results).reduce((s, r) => s + (r.synced || 0), 0);
  const totalErrors = Object.values(results).reduce((s, r) => s + (r.errors || 0), 0);

  return res.status(200).json({
    success: true,
    results,
    totalSynced,
    totalErrors,
    syncedAt: new Date().toISOString()
  });
};
