// api/sync/index.js
// POST /api/sync — 수동 주문 수집 (어드민 "주문 수집" 버튼)  body: { channels?: ['naver', ...] }
// GET  /api/sync — 최근 수집 기록(sync_logs) 조회
const naver   = require('../../sync/naver');
const coupang = require('../../sync/coupang');
const ably    = require('../../sync/ably');
const zigzag  = require('../../sync/zigzag');
const { enabledChannels } = require('../../sync/scheduler');
const { supabase } = require('../../utils/supabase');
const { verifyRequest } = require('../../utils/auth');

const syncMap = { naver, coupang, ably, zigzag };

module.exports = async (req, res) => {
  if (!verifyRequest(req)) return res.status(401).json({ error: '인증 필요' });

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('sync_logs')
      .select('channel_code, synced_count, error_count, message, synced_at')
      .order('synced_at', { ascending: false })
      .limit(20);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ logs: data || [], enabled: enabledChannels() });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const enabled = enabledChannels();
  const requested = Array.isArray(req.body?.channels) ? req.body.channels : enabled;
  const channels = requested.filter(c => enabled.includes(c));
  if (!channels.length) return res.status(400).json({ error: '연동된 쇼핑몰이 없습니다.', enabled });

  // days: 며칠 치를 가져올지 (1~30, 기본 1일)
  const days = Math.max(1, Math.min(30, parseInt(req.body?.days, 10) || 1));

  const results = {};
  await Promise.allSettled(channels.map(async c => {
    try {
      results[c] = await syncMap[c].syncOrders({ days });
    } catch (e) {
      results[c] = { synced: 0, errors: 1, message: e.message };
    }
  }));

  const totalSynced = Object.values(results).reduce((s, r) => s + (r.synced || 0), 0);
  const totalErrors = Object.values(results).reduce((s, r) => s + (r.errors || 0), 0);

  return res.status(200).json({ success: totalErrors === 0, results, totalSynced, totalErrors, syncedAt: new Date().toISOString() });
};
