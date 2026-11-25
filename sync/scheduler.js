// sync/scheduler.js
// 15분마다 전 플랫폼 주문 자동 수집
const cron = require('node-cron');
const naver   = require('./naver');
const coupang = require('./coupang');
const ably    = require('./ably');
const zigzag  = require('./zigzag');

// 전체 동기화 실행
async function runAllSync() {
  const start = Date.now();
  console.log(`[SYNC] 시작 ${new Date().toLocaleString('ko-KR')}`);

  const results = await Promise.allSettled([
    naver.syncOrders().then(r  => ({ channel: 'naver',   ...r })),
    coupang.syncOrders().then(r => ({ channel: 'coupang', ...r })),
    ably.syncOrders().then(r   => ({ channel: 'ably',    ...r })),
    zigzag.syncOrders().then(r => ({ channel: 'zigzag',  ...r })),
  ]);

  let totalSynced = 0, totalErrors = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      console.log(`[${r.value.channel.toUpperCase()}] 수집: ${r.value.synced}건, 오류: ${r.value.errors}건`);
      totalSynced += r.value.synced;
      totalErrors += r.value.errors;
    } else {
      console.error(`[SYNC] 실패:`, r.reason?.message);
      totalErrors++;
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[SYNC] 완료 — 총 ${totalSynced}건 수집, ${totalErrors}건 오류 (${elapsed}초)`);
  return { totalSynced, totalErrors };
}

// ── Vercel Cron (vercel.json에 설정) ──
// Vercel은 node-cron 미지원 → /api/cron/sync 엔드포인트로 호출
// 로컬 개발 시에는 node-cron 사용

if (process.env.NODE_ENV !== 'production') {
  // 로컬: 15분마다 실행
  cron.schedule('*/15 * * * *', runAllSync);
  console.log('[SCHEDULER] 로컬 스케줄러 시작 (15분 간격)');
}

module.exports = { runAllSync };
