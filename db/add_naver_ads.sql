-- 네이버 검색광고(파워링크·쇼핑검색) — searchad API로 가져온 캠페인 / 광고단위 / 일별 성과
-- 금액은 VAT 포함 여부가 API 기준 그대로(광고비 salesAmt는 VAT 제외 금액). 화면에서 그대로 표시.

CREATE TABLE IF NOT EXISTS ad_campaigns (
    id            TEXT PRIMARY KEY,             -- nccCampaignId
    name          TEXT,
    campaign_tp   TEXT,                         -- WEB_SITE(파워링크) / SHOPPING(쇼핑검색) / ...
    status        TEXT,
    daily_budget  BIGINT,
    raw_data      JSONB,
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 성과를 보는 최소 단위: 파워링크는 키워드, 쇼핑검색은 소재(상품). 광고그룹도 함께 저장
CREATE TABLE IF NOT EXISTS ad_units (
    id            TEXT PRIMARY KEY,             -- nccKeywordId / nccAdId / nccAdgroupId
    unit_type     TEXT NOT NULL,                -- keyword / ad / adgroup
    name          TEXT,                         -- 키워드 또는 상품명 또는 광고그룹명
    campaign_id   TEXT,
    adgroup_id    TEXT,
    bid_amt       BIGINT,
    status        TEXT,
    raw_data      JSONB,
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ad_units_campaign ON ad_units (campaign_id);

CREATE TABLE IF NOT EXISTS ad_stats_daily (
    stat_date     DATE   NOT NULL,
    entity_type   TEXT   NOT NULL,              -- campaign / keyword / ad / adgroup
    entity_id     TEXT   NOT NULL,
    campaign_id   TEXT,
    imp_cnt       BIGINT NOT NULL DEFAULT 0,    -- 노출
    clk_cnt       BIGINT NOT NULL DEFAULT 0,    -- 클릭
    cost          BIGINT NOT NULL DEFAULT 0,    -- 광고비 (salesAmt)
    conv_cnt      NUMERIC NOT NULL DEFAULT 0,   -- 전환수 (ccnt)
    conv_amt      BIGINT NOT NULL DEFAULT 0,    -- 전환매출 (convAmt)
    avg_rnk       NUMERIC,                      -- 평균 노출 순위
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (stat_date, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_ad_stats_entity ON ad_stats_daily (entity_type, stat_date);

-- 비즈머니 잔액 등 한 줄짜리 상태값
CREATE TABLE IF NOT EXISTS ad_meta (
    key           TEXT PRIMARY KEY,
    value         JSONB,
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE ad_campaigns   DISABLE ROW LEVEL SECURITY;
ALTER TABLE ad_units       DISABLE ROW LEVEL SECURITY;
ALTER TABLE ad_stats_daily DISABLE ROW LEVEL SECURITY;
ALTER TABLE ad_meta        DISABLE ROW LEVEL SECURITY;
