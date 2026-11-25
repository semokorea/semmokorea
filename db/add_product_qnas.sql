-- product_qnas — 네이버 스마트스토어 상품 Q&A 저장
-- API: GET  /v1/contents/qnas               (목록 조회)
--      PUT  /v1/contents/qnas/:questionId   (판매자 답변 등록/수정, commentContent 1000자)
-- 권한: 네이버 앱 "[문의]" API 그룹 포함 필요 (없으면 403 GW.AUTHN)

CREATE TABLE IF NOT EXISTS product_qnas (
    id                  BIGSERIAL PRIMARY KEY,
    channel_id          SMALLINT NOT NULL REFERENCES channels(id),
    channel_question_id TEXT     NOT NULL,          -- 네이버 questionId
    product_no          TEXT,
    product_name        TEXT,
    product_order_id    TEXT,                       -- 주문 연결된 문의일 경우
    question_type       TEXT,                       -- 문의 유형 (배송/교환/기타…)
    question_title      TEXT,
    question_content    TEXT,
    questioner_id       TEXT,
    questioner_nickname TEXT,
    is_secret           BOOLEAN DEFAULT FALSE,
    asked_at            TIMESTAMP,

    answer_content      TEXT,
    answered_at         TIMESTAMP,
    answered_by         TEXT,                        -- 어드민 admin_users.username
    answer_source       TEXT CHECK (answer_source IN ('api','smartstore')),

    raw_data            JSONB,                       -- 네이버 원본 응답 보존
    synced_at           TIMESTAMP DEFAULT NOW(),
    created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP NOT NULL DEFAULT NOW(),

    UNIQUE (channel_id, channel_question_id)
);

CREATE INDEX IF NOT EXISTS idx_product_qnas_channel_asked
    ON product_qnas (channel_id, asked_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_qnas_unanswered
    ON product_qnas (channel_id, asked_at DESC)
    WHERE answered_at IS NULL;

CREATE OR REPLACE FUNCTION trg_product_qnas_touch()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_product_qnas_touch ON product_qnas;
CREATE TRIGGER tr_product_qnas_touch
BEFORE UPDATE ON product_qnas
FOR EACH ROW EXECUTE FUNCTION trg_product_qnas_touch();
