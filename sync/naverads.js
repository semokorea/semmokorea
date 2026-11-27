// sync/naverads.js — 네이버 검색광고 API(파워링크·쇼핑검색): 캠페인/광고단위/일별 성과/비즈머니 수집
// 공식 문서: https://naver.github.io/searchad-apidoc  (예제: github.com/naver/searchad-apidoc python-sample)
//  - 서버: https://api.searchad.naver.com
//  - 헤더: X-Timestamp(ms), X-API-KEY(액세스라이선스), X-Customer(고객 ID),
//          X-Signature = base64( HMAC-SHA256( 비밀키, `${timestamp}.${METHOD}.${uri}` ) )  ← uri는 쿼리 없는 경로
//  - 캠페인 GET /ncc/campaigns · 광고그룹 GET /ncc/adgroups?nccCampaignId= · 키워드 GET /ncc/keywords?nccAdgroupId=
//    소재 GET /ncc/ads?nccAdgroupId= · 성과 GET /stats?ids=..&fields=[..]&timeRange={since,until} · 비즈머니 GET /billing/bizmoney
// 이 모듈은 "읽기"만 한다. 입찰가 변경·광고 중지 같은 쓰기는 하지 않는다.
const axios  = require('axios');
const crypto = require('crypto');
const { supabase, logSync } = require('../utils/supabase');

const BASE = 'https://api.searchad.naver.com';
const TIME_BUDGET_MS = 40000;
const FIELDS = ['impCnt', 'clkCnt', 'salesAmt', 'ccnt', 'convAmt', 'avgRnk'];

function keys() {
  const clean = v => String(v || '').trim().replace(/^["']|["']$/g, '').trim();
  const customerId = clean(process.env.NAVER_AD_CUSTOMER_ID);
  const accessKey  = clean(process.env.NAVER_AD_ACCESS_KEY);
  const secretKey  = clean(process.env.NAVER_AD_SECRET_KEY);
  if (!customerId || !accessKey || !secretKey) {
    throw new Error('NAVER_AD_CUSTOMER_ID / NAVER_AD_ACCESS_KEY / NAVER_AD_SECRET_KEY 환경변수가 없습니다.');
  }
  return { customerId, accessKey, secretKey };
}
const configured = () => { try { keys(); return true; } catch (_) { return false; } };

// params: { key: value | [values] } → 같은 이름 반복(ids=a&ids=b) 형태로 만든다
function qs(params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach(x => sp.append(k, x)); else sp.append(k, typeof v === 'object' ? JSON.stringify(v) : v);
  }
  const s = sp.toString();
  return s ? '?' + s : '';
}

async function call(method, uri, params) {
  const k = keys();
  const ts = String(Date.now());
  const sig = crypto.createHmac('sha256', k.secretKey).update(`${ts}.${method.toUpperCase()}.${uri}`).digest('base64');
  const res = await axios.request({
    method,
    url: BASE + uri + qs(params),
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Timestamp': ts,
      'X-API-KEY': k.accessKey,
      'X-Customer': k.customerId,
      'X-Signature': sig
    },
    timeout: 20000
  });
  return res.data;
}

function errText(e) {
  const d = e.response?.data;
  if (d) return `${e.response.status} ${d.title || d.code || ''} ${d.detail || d.message || JSON.stringify(d).slice(0, 200)}`.trim();
  return e.message;
}

const kstDay = (offset = 0) => new Date(Date.now() + 9 * 3600e3 + offset * 86400e3).toISOString().slice(0, 10);
const num = v => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);

// ── 구조 수집: 캠페인 → 광고그룹 → (파워링크) 키워드 / (쇼핑검색 등) 소재 ──
async function syncStructure() {
  const campaigns = await call('get', '/ncc/campaigns');
  const now = new Date().toISOString();
  if (campaigns.length) {
    const { error } = await supabase.from('ad_campaigns').upsert(campaigns.map(c => ({
      id: c.nccCampaignId, name: c.name, campaign_tp: c.campaignTp, status: c.status,
      daily_budget: c.useDailyBudget === false ? null : num(c.dailyBudget) || null, raw_data: c, updated_at: now
    })), { onConflict: 'id' });
    if (error) throw new Error(error.message);
  }
  const units = [];
  for (const c of campaigns) {
    const groups = await call('get', '/ncc/adgroups', { nccCampaignId: c.nccCampaignId });
    for (const g of groups) {
      units.push({ id: g.nccAdgroupId, unit_type: 'adgroup', name: g.name, campaign_id: c.nccCampaignId, adgroup_id: g.nccAdgroupId,
        bid_amt: num(g.bidAmt) || null, status: g.status, raw_data: g, updated_at: now });
      if (c.campaignTp === 'WEB_SITE') {
        const kws = await call('get', '/ncc/keywords', { nccAdgroupId: g.nccAdgroupId });
        for (const k of kws) units.push({ id: k.nccKeywordId, unit_type: 'keyword', name: k.keyword, campaign_id: c.nccCampaignId,
          adgroup_id: g.nccAdgroupId, bid_amt: k.useGroupBidAmt ? num(g.bidAmt) : num(k.bidAmt), status: k.status, raw_data: k, updated_at: now });
      } else {
        const ads = await call('get', '/ncc/ads', { nccAdgroupId: g.nccAdgroupId });
        for (const a of ads) {
          const name = a.referenceData?.productName || a.ad?.productName || a.ad?.headline || a.referenceData?.mallProductName || a.nccAdId;
          units.push({ id: a.nccAdId, unit_type: 'ad', name, campaign_id: c.nccCampaignId, adgroup_id: g.nccAdgroupId,
            bid_amt: num(a.adAttr?.bidAmt) || null, status: a.status, raw_data: a, updated_at: now });
        }
      }
    }
  }
  for (let i = 0; i < units.length; i += 500) {
    const { error } = await supabase.from('ad_units').upsert(units.slice(i, i + 500), { onConflict: 'id' });
    if (error) throw new Error(error.message);
  }
  return { campaigns, units };
}

// ── 하루치 성과: ids를 50개씩 /stats 조회 ──
let convAmtSupported = true;
async function statsForDay(ids, day) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    let data;
    try {
      data = await call('get', '/stats', { ids: batch, fields: convAmtSupported ? FIELDS : FIELDS.filter(f => f !== 'convAmt'), timeRange: { since: day, until: day } });
    } catch (e) {
      // 전환매출(convAmt) 필드를 받지 않는 계정이면 빼고 다시
      if (convAmtSupported && e.response?.status === 400) { convAmtSupported = false; i -= 50; continue; }
      throw e;
    }
    out.push(...(data?.data || []));
  }
  return out;
}

// ── 수집: from(KST 날짜)부터 오늘까지 하루씩, 시간 예산 안에서. 다 못 하면 next(다음 시작일)를 돌려준다 ──
async function syncAds({ days = 3, from } = {}) {
  const started = Date.now();
  if (!configured()) return { synced: 0, errors: 0, skipped: true, message: '네이버 광고 키가 없어 건너뜀' };
  const today = kstDay(0);
  let cur = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : kstDay(-(Math.max(1, Math.min(90, Number(days) || 3)) - 1));
  let synced = 0, errors = 0, errMsg = '', daysDone = 0;
  try {
    const { campaigns, units } = await syncStructure();
    const entity = [
      ...campaigns.map(c => ({ id: c.nccCampaignId, type: 'campaign', campaign_id: c.nccCampaignId })),
      ...units.filter(u => u.unit_type !== 'adgroup').map(u => ({ id: u.id, type: u.unit_type, campaign_id: u.campaign_id }))
    ];
    const byId = Object.fromEntries(entity.map(e => [e.id, e]));
    while (cur <= today && Date.now() - started < TIME_BUDGET_MS) {
      const rows = (await statsForDay(entity.map(e => e.id), cur))
        .map(s => {
          const e = byId[s.id]; if (!e) return null;
          const r = { stat_date: cur, entity_type: e.type, entity_id: e.id, campaign_id: e.campaign_id,
            imp_cnt: num(s.impCnt), clk_cnt: num(s.clkCnt), cost: Math.round(num(s.salesAmt)), conv_cnt: num(s.ccnt),
            conv_amt: Math.round(num(s.convAmt)), avg_rnk: s.avgRnk == null ? null : num(s.avgRnk), updated_at: new Date().toISOString() };
          return (r.imp_cnt || r.clk_cnt || r.cost || r.conv_cnt || e.type === 'campaign') ? r : null;   // 활동 없는 키워드는 저장 안 함
        }).filter(Boolean);
      if (rows.length) {
        const { error } = await supabase.from('ad_stats_daily').upsert(rows, { onConflict: 'stat_date,entity_type,entity_id' });
        if (error) throw new Error(error.message);
        synced += rows.length;
      }
      cur = new Date(Date.parse(cur + 'T00:00:00Z') + 86400e3).toISOString().slice(0, 10);
      daysDone++;
    }
    // 비즈머니 잔액
    try {
      const bm = await call('get', '/billing/bizmoney');
      await supabase.from('ad_meta').upsert({ key: 'bizmoney', value: bm, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    } catch (e) { console.error('[NAVER-ADS] 비즈머니 조회 실패:', errText(e)); }
  } catch (e) {
    errMsg = `API 오류: ${errText(e)}`;
    console.error('[NAVER-ADS]', errMsg);
    errors++;
  }
  const next = cur <= today ? cur : null;          // 오류가 나면 그 날짜부터 다시
  const message = `네이버 광고 ${daysDone}일 성과 · 저장 ${synced}행` + (next ? ` · 다음 시작 ${next}` : ' · 완료') + (errMsg ? ` · ${errMsg}` : '');
  await logSync('naver-ads', { synced, errors, message });
  return { synced, errors, next, done: !next, error: errMsg || null, message };
}

module.exports = { syncAds, configured, call, qs };
