// api/cron/sync.js
// 자동 수집 엔드포인트 (Authorization: Bearer CRON_SECRET 필요)
// - Vercel Cron: 매일 08:00 / 12:00 / 18:00 (한국시간) — vercel.json의 crons 3개(UTC 23시·3시·9시)
//   Hobby 플랜은 예약 하나당 하루 1번만 가능해서 같은 주소로 예약을 3개 둔다. 실행 시각은 그 시간대 안(최대 59분 늦게)에서 돈다
// - 15분 간격은 외부 스케줄러(cron-job.org 등)가 이 URL을 호출

const { runAllSync } = require('../../sync/scheduler');

module.exports = async (req, res) => {
  // Vercel Cron 요청 검증
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // 주문 수집과 네이버 광고 성과(최근 3일 — 늦게 잡히는 전환 반영)를 동시에. 광고 키가 없으면 광고는 건너뜀
    const naverads = require('../../sync/naverads');
    const [result, ads] = await Promise.all([
      runAllSync(),
      naverads.syncAds({ days: 3 }).catch(e => ({ errors: 1, message: e.message }))
    ]);
    return res.status(200).json({
      success: true,
      synced:  result.totalSynced,
      errors:  result.totalErrors,
      ads:     ads.message,
      time:    new Date().toISOString()
    });
  } catch (err) {
    console.error('[CRON] 동기화 실패:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
