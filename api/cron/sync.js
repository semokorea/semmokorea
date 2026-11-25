// api/cron/sync.js
// Vercel Cron Job 엔드포인트 — 15분마다 자동 호출
// vercel.json 에 cron 설정 필요

const { runAllSync } = require('../../sync/scheduler');

module.exports = async (req, res) => {
  // Vercel Cron 요청 검증
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await runAllSync();
    return res.status(200).json({
      success: true,
      synced:  result.totalSynced,
      errors:  result.totalErrors,
      time:    new Date().toISOString()
    });
  } catch (err) {
    console.error('[CRON] 동기화 실패:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
