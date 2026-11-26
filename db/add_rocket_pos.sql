-- 쿠팡 서플라이어허브(로켓배송) 발주서 — 서플라이어허브 "발주서" 엑셀(발주서 1장 = 파일 1개)을 어드민에서 올려 저장
-- 공개 API가 없어 엑셀 업로드 방식. 같은 발주번호를 다시 올리면 덮어쓴다(입고수량·상태 갱신).

CREATE TABLE IF NOT EXISTS rocket_pos (
    id               BIGSERIAL PRIMARY KEY,
    po_no            TEXT      NOT NULL UNIQUE,     -- 발주번호
    po_type          TEXT,                          -- 발주구분 (리오더 등)
    manager          TEXT,                          -- 쿠팡 발주담당자
    center           TEXT,                          -- 물류센터 (평택5 등)
    center_address   TEXT,
    expected_dt      TIMESTAMP,                     -- 입고예정일시
    unloaded_dt      TIMESTAMP,                     -- 하차일시 (입고 처리된 시각)
    sku_count        INTEGER   NOT NULL DEFAULT 0,
    order_qty        INTEGER   NOT NULL DEFAULT 0,  -- 발주수량 합계
    deliverable_qty  INTEGER   NOT NULL DEFAULT 0,  -- 업체납품가능수량 합계
    received_qty     INTEGER   NOT NULL DEFAULT 0,  -- 입고수량 합계
    order_amount     BIGINT    NOT NULL DEFAULT 0,  -- 발주금액(매입가, VAT 포함)
    received_amount  BIGINT    NOT NULL DEFAULT 0,  -- 입고금액(매입가, VAT 포함)
    status           TEXT      NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','partial','received')),   -- 입고대기 / 부분입고 / 입고완료
    file_name        TEXT,
    uploaded_by      TEXT,
    created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rocket_po_items (
    id               BIGSERIAL PRIMARY KEY,
    po_id            BIGINT    NOT NULL REFERENCES rocket_pos(id) ON DELETE CASCADE,
    line_no          INTEGER,
    sku_id           TEXT,                          -- 상품코드(쿠팡 SKU ID)
    product_name     TEXT,
    barcode          TEXT,
    buy_type         TEXT,                          -- 매입유형 (직매입)
    tax_type         TEXT,                          -- 면세여부 (과세)
    order_qty        INTEGER   NOT NULL DEFAULT 0,
    deliverable_qty  INTEGER   NOT NULL DEFAULT 0,
    received_qty     INTEGER   NOT NULL DEFAULT 0,
    unit_price       INTEGER   NOT NULL DEFAULT 0,  -- 매입가(VAT 포함)
    supply_price     INTEGER   NOT NULL DEFAULT 0,  -- 공급가액
    order_amount     BIGINT    NOT NULL DEFAULT 0,
    received_amount  BIGINT    NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_rocket_pos_expected ON rocket_pos (expected_dt DESC);
CREATE INDEX IF NOT EXISTS idx_rocket_po_items_po  ON rocket_po_items (po_id);

-- 다른 테이블과 같이 RLS 끔 (서버가 service key로만 접근)
ALTER TABLE rocket_pos      DISABLE ROW LEVEL SECURITY;
ALTER TABLE rocket_po_items DISABLE ROW LEVEL SECURITY;
