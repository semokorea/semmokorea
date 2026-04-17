# API 설계 명세서 — 세모코리아 통합 어드민

## 기본 설정

```
Base URL:  https://your-api.vercel.app/api
인증:      Authorization: Bearer {JWT_TOKEN}
Content-Type: application/json
```

---

## 인증 API

### POST /api/auth/login
```json
Request:
{ "username": "admin", "password": "Admin1234!" }

Response 200:
{
  "token": "eyJhbGc...",
  "user": { "id": "uuid", "name": "대표 관리자", "role": "owner" },
  "expires_at": "2025-04-21T00:00:00Z"
}

Response 401:
{ "error": "아이디 또는 비밀번호가 올바르지 않습니다." }
```

### POST /api/auth/logout
```json
Response 200: { "message": "로그아웃 완료" }
```

---

## 주문 API (쇼핑몰)

### GET /api/orders
```
Query Params:
  channel   = naver | coupang | ably | zigzag | all
  status    = new | confirmed | preparing | ready | shipped | delivered | cancelled
  date_from = 2025-04-01
  date_to   = 2025-04-14
  page      = 1
  limit     = 50

Response 200:
{
  "orders": [...],
  "total": 127,
  "page": 1
}
```

### GET /api/orders/:id
주문 상세 + 품목 + 배송 정보

### POST /api/orders/sync
```json
Request: { "channels": ["naver", "coupang", "ably", "zigzag"] }
Response: { "synced": 12, "errors": 0 }
```

---

## 배송 API

### POST /api/shipments/bulk
```json
Request:
{
  "shipments": [
    { "order_id": "uuid", "tracking_no": "5012-3456-7890", "carrier": "CJ대한통운" },
    { "order_id": "uuid", "tracking_no": "5012-3456-7891", "carrier": "CJ대한통운" }
  ]
}
Response:
{
  "success": 3,
  "failed": 1,
  "platform_synced": true
}
```

---

## 송장 출력 API

### POST /api/invoice/generate
```json
Request:
{
  "order_ids": ["uuid1", "uuid2", "uuid3"],
  "mapping_id": "uuid",     // 저장된 컬럼 매핑
  "channel": "ably"
}
Response: xlsx 파일 (Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet)
```

### GET /api/invoice/mappings
저장된 컬럼 매핑 목록 조회

### POST /api/invoice/mappings
새 컬럼 매핑 저장

---

## 재고 API

### GET /api/inventory
```json
Response:
{
  "products": [
    {
      "id": "uuid",
      "name": "린넨 블라우스",
      "options": [
        { "option_code": "BL-W-M", "option_info": "화이트/M", "stock_qty": 78, "alert_qty": 10 }
      ]
    }
  ]
}
```

### PATCH /api/inventory/:option_id
```json
Request: { "change_qty": 50, "reason": "receive", "memo": "입고 처리" }
```

---

## OEM 주문 API

### GET /api/oem/orders
```
Query: client_id, status, date_from, date_to
```

### POST /api/oem/orders
```json
Request:
{
  "client_id": "uuid",
  "title": "린넨 블라우스 500pcs",
  "expected_dt": "2025-04-25",
  "items": [
    { "product_name": "린넨 블라우스", "spec": "화이트/M", "quantity": 500, "unit_price": 17000 }
  ]
}
```

### PATCH /api/oem/orders/:id/progress
```json
Request:
{
  "stage": 2,
  "date": "2025-04-12",
  "memo": "부산항 도착",
  "eta": "2025-04-22"
}
```

---

## 견적서 API

### POST /api/oem/quotations
견적서 생성

### POST /api/oem/quotations/:id/pdf
```
Response: PDF 파일
Content-Type: application/pdf
Content-Disposition: attachment; filename="QT-2404-009_한강어패럴.pdf"
```
wkhtmltopdf로 `frontend/quote_template.html` 렌더링
직인 이미지: `assets/stamp_semockorea.png` (base64 삽입)

---

## 플랫폼 API 연동 명세

### 네이버 스마트스토어
```
API: commerce.naver.com
인증: Client ID + Client Secret → OAuth 토큰
주문 수집: GET /external/v1/pay-order/seller/orders
배송 등록: PUT /external/v1/pay-order/seller/product-orders/{productOrderId}/dispatch
```

### 쿠팡
```
API: api-gateway.coupang.com
인증: HMAC-SHA256 서명
주문 수집: GET /v2/providers/openapi/apis/api/v4/orders
배송 등록: PUT /v2/providers/openapi/apis/api/v4/orders/{orderId}/shipment
```

### 에이블리
```
API: api.a-bly.com
인증: API Key 헤더
주문 수집: GET /api/v1/orders
배송 등록: POST /api/v1/orders/{orderId}/shipping
```

### 지그재그
```
API: shop.zigzag.kr/api
인증: API Key
주문 수집: GET /api/v1/orders
배송 등록: POST /api/v1/orders/{orderId}/delivery
```

---

## 스케줄러 설계

```javascript
// backend/api/sync/scheduler.js
// 15분마다 모든 채널 주문 수집

const schedule = require('node-cron');

schedule.schedule('*/15 * * * *', async () => {
  await syncNaverOrders();
  await syncCoupangOrders();
  await syncAblyOrders();
  await syncZigzagOrders();
  await updateInventory();
});
```
