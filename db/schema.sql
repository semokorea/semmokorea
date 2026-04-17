-- ============================================================
--  통합 어드민 DB 스키마 v1.0
--  쇼핑몰 멀티채널 + OEM 사업 통합 관리
-- ============================================================

-- 1. 인증/권한
-- ──────────────────────────────────────────
CREATE TABLE admin_users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      VARCHAR(50)  UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name          VARCHAR(50)  NOT NULL,
    role          VARCHAR(20)  NOT NULL DEFAULT 'staff',
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    last_login_at TIMESTAMP,
    created_at    TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE TABLE admin_sessions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    token      VARCHAR(512) UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 2. 판매 채널
-- ──────────────────────────────────────────
CREATE TABLE channels (
    id         SMALLSERIAL PRIMARY KEY,
    code       VARCHAR(20) UNIQUE NOT NULL,
    name       VARCHAR(50) NOT NULL,
    api_key    TEXT,
    api_secret TEXT,
    is_active  BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO channels (code, name) VALUES
    ('naver',   '네이버 스마트스토어'),
    ('coupang', '쿠팡'),
    ('ably',    '에이블리'),
    ('zigzag',  '지그재그');

-- 3. 상품 / 재고
-- ──────────────────────────────────────────
CREATE TABLE products (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_code  VARCHAR(50) UNIQUE NOT NULL,
    name         VARCHAR(200) NOT NULL,
    category     VARCHAR(100),
    base_price   INTEGER NOT NULL DEFAULT 0,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE product_options (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    option_code VARCHAR(50),
    option_info VARCHAR(200),
    stock_qty   INTEGER NOT NULL DEFAULT 0,
    alert_qty   INTEGER NOT NULL DEFAULT 10,
    UNIQUE (product_id, option_code)
);

CREATE TABLE stock_logs (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    option_id  UUID NOT NULL REFERENCES product_options(id),
    change_qty INTEGER NOT NULL,
    reason     VARCHAR(50),
    ref_id     UUID,
    memo       TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 4. 주문 (멀티채널 통합)
-- ──────────────────────────────────────────
CREATE TABLE orders (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id           SMALLINT NOT NULL REFERENCES channels(id),
    channel_order_no     VARCHAR(100) NOT NULL,
    channel_item_no      VARCHAR(100),
    status               VARCHAR(30) NOT NULL DEFAULT 'new',
    buyer_name           VARCHAR(50),
    buyer_id             VARCHAR(100),
    buyer_phone          VARCHAR(20),
    receiver_name        VARCHAR(50),
    receiver_phone1      VARCHAR(20),
    receiver_phone2      VARCHAR(20),
    zipcode              VARCHAR(10),
    address_base         VARCHAR(200),
    address_detail       VARCHAR(200),
    address_full         VARCHAR(400),
    delivery_message     TEXT,
    payment_method       VARCHAR(50),
    payment_dt           TIMESTAMP,
    order_dt             TIMESTAMP,
    confirmed_dt         TIMESTAMP,
    shipping_deadline_dt TIMESTAMP,
    total_amount         INTEGER NOT NULL DEFAULT 0,
    shipping_fee         INTEGER NOT NULL DEFAULT 0,
    discount_amount      INTEGER NOT NULL DEFAULT 0,
    settlement_amount    INTEGER NOT NULL DEFAULT 0,
    raw_data             JSONB,
    synced_at            TIMESTAMP,
    created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (channel_id, channel_order_no, channel_item_no)
);

CREATE TABLE order_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id      UUID REFERENCES products(id),
    option_id       UUID REFERENCES product_options(id),
    product_name    VARCHAR(200) NOT NULL,
    option_info     VARCHAR(200),
    option_code     VARCHAR(50),
    seller_code     VARCHAR(50),
    quantity        INTEGER NOT NULL DEFAULT 1,
    unit_price      INTEGER NOT NULL DEFAULT 0,
    option_price    INTEGER NOT NULL DEFAULT 0,
    discount_amount INTEGER NOT NULL DEFAULT 0,
    total_amount    INTEGER NOT NULL DEFAULT 0
);

-- 5. 배송 / 송장
-- ──────────────────────────────────────────
CREATE TABLE shipments (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id           UUID NOT NULL REFERENCES orders(id),
    carrier            VARCHAR(50) NOT NULL DEFAULT 'CJ대한통운',
    tracking_no        VARCHAR(100),
    status             VARCHAR(30) NOT NULL DEFAULT 'preparing',
    shipped_dt         TIMESTAMP,
    delivered_dt       TIMESTAMP,
    invoice_printed_at TIMESTAMP,
    created_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE invoice_column_mappings (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id       SMALLINT REFERENCES channels(id),
    name             VARCHAR(100) NOT NULL,
    mapping          JSONB NOT NULL,
    template_columns JSONB NOT NULL,
    is_default       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 6. OEM 사업
-- ──────────────────────────────────────────
CREATE TABLE oem_clients (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         VARCHAR(100) NOT NULL,
    biz_no       VARCHAR(20),
    rep_name     VARCHAR(50),
    phone        VARCHAR(20),
    email        VARCHAR(100),
    address      TEXT,
    memo         TEXT,
    monthly_goal INTEGER NOT NULL DEFAULT 0,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE oem_orders (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_no     VARCHAR(30) UNIQUE NOT NULL,
    client_id    UUID NOT NULL REFERENCES oem_clients(id),
    status       VARCHAR(30) NOT NULL DEFAULT 'received',
    title        TEXT,
    total_amount INTEGER NOT NULL DEFAULT 0,
    vat_amount   INTEGER NOT NULL DEFAULT 0,
    shipping_fee INTEGER NOT NULL DEFAULT 0,
    order_dt     DATE,
    expected_dt  DATE,
    delivered_dt DATE,
    settled_dt   DATE,
    memo         TEXT,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE oem_order_items (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    oem_order_id UUID NOT NULL REFERENCES oem_orders(id) ON DELETE CASCADE,
    product_name VARCHAR(200) NOT NULL,
    spec         VARCHAR(200),
    quantity     INTEGER NOT NULL DEFAULT 0,
    unit_price   INTEGER NOT NULL DEFAULT 0,
    total_price  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE oem_quotations (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_no     VARCHAR(30) UNIQUE NOT NULL,
    client_id    UUID NOT NULL REFERENCES oem_clients(id),
    oem_order_id UUID REFERENCES oem_orders(id),
    status       VARCHAR(20) NOT NULL DEFAULT 'draft',
    valid_until  DATE,
    total_amount INTEGER NOT NULL DEFAULT 0,
    vat_amount   INTEGER NOT NULL DEFAULT 0,
    shipping_fee INTEGER NOT NULL DEFAULT 0,
    notes        TEXT,
    sent_at      TIMESTAMP,
    confirmed_at TIMESTAMP,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE oem_quotation_items (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quotation_id UUID NOT NULL REFERENCES oem_quotations(id) ON DELETE CASCADE,
    product_name VARCHAR(200) NOT NULL,
    spec         VARCHAR(200),
    quantity     INTEGER NOT NULL DEFAULT 0,
    unit_price   INTEGER NOT NULL DEFAULT 0,
    total_price  INTEGER NOT NULL DEFAULT 0,
    sort_order   SMALLINT NOT NULL DEFAULT 0
);

CREATE TABLE oem_shipments (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    oem_order_id UUID NOT NULL REFERENCES oem_orders(id),
    carrier      VARCHAR(50),
    tracking_no  VARCHAR(100),
    shipped_dt   DATE,
    delivered_dt DATE,
    memo         TEXT,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 7. 인덱스
-- ──────────────────────────────────────────
CREATE INDEX idx_orders_channel    ON orders(channel_id);
CREATE INDEX idx_orders_status     ON orders(status);
CREATE INDEX idx_orders_order_dt   ON orders(order_dt DESC);
CREATE INDEX idx_orders_channel_no ON orders(channel_id, channel_order_no);
CREATE INDEX idx_shipments_order   ON shipments(order_id);
CREATE INDEX idx_stock_option      ON stock_logs(option_id);
CREATE INDEX idx_oem_orders_client ON oem_orders(client_id);
CREATE INDEX idx_oem_orders_status ON oem_orders(status);
CREATE INDEX idx_oem_quotes_client ON oem_quotations(client_id);
CREATE INDEX idx_sessions_token    ON admin_sessions(token);
CREATE INDEX idx_sessions_user     ON admin_sessions(user_id);
