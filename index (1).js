-- sync_logs 테이블 추가 (기존 schema.sql에 추가)
-- Supabase SQL Editor에서 실행하세요

CREATE TABLE IF NOT EXISTS sync_logs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_code VARCHAR(20) NOT NULL,
    synced_count INTEGER     NOT NULL DEFAULT 0,
    error_count  INTEGER     NOT NULL DEFAULT 0,
    message      TEXT,
    synced_at    TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sync_logs_channel ON sync_logs(channel_code);
CREATE INDEX idx_sync_logs_time    ON sync_logs(synced_at DESC);

-- channels 테이블에 에이블리/지그재그 코드 확인
-- (schema.sql에 이미 포함되어 있으나 혹시 누락 시 실행)
INSERT INTO channels (code, name) VALUES
    ('naver',   '네이버 스마트스토어'),
    ('coupang', '쿠팡'),
    ('ably',    '에이블리'),
    ('zigzag',  '지그재그')
ON CONFLICT (code) DO NOTHING;
