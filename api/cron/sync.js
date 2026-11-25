// api/cron/sync.js
// 자동 수집 엔드포인트 (Authorization: Bearer CRON_SECRET 필요)
// - Vercel Cron(Hobby 플랜은 하루 1회까지) → vercel.json 참고
// - 15분 간격은 외부 스케줄러(cron-job.org 등)가 이 URL을 호출

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
