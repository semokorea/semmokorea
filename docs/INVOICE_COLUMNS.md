# 에이블리 57컬럼 송장 양식

## 컬럼 순서 (고정 — 절대 변경 금지)

| 번호 | 컬럼명 | DB 필드 | 비고 |
|------|--------|---------|------|
| 1 | 상품주문번호 | channel_item_no | 에이블리 상품 단위 주문번호 |
| 2 | 주문번호 | channel_order_no | 에이블리 주문번호 |
| 3 | 배송방법(구매자 요청) | — | 고정값: 택배 |
| 4 | 배송방법 | — | 고정값: 택배 |
| 5 | 택배사 | carrier | CJ대한통운 |
| 6 | 송장번호 | tracking_no | ⭐ 핵심 입력값 |
| 7 | 발송일 | shipped_dt | 오늘 날짜 자동 |
| 8 | 판매채널 | channel.name | 에이블리 |
| 9 | 구매자명 | buyer_name | |
| 10 | 구매자ID | buyer_id | |
| 11 | 수취인명 | receiver_name | |
| 12 | 주문상태 | status | 발송처리완료 |
| 13 | 주문세부상태 | — | 배송중 |
| 14 | 결제위치 | — | 앱 |
| 15 | 결제일 | payment_dt | |
| 16 | 상품번호 | product.seller_code | |
| 17 | 상품명 | product.name | |
| 18 | 상품종류 | — | 일반상품 |
| 19 | 옵션정보 | option_info | |
| 20 | 옵션관리코드 | option_code | |
| 21 | 수량 | quantity | |
| 22 | 옵션가격 | option_price | |
| 23 | 상품가격 | unit_price | |
| 24 | 최종 상품별 할인액 | discount_amount | |
| 25 | 최종 상품별 총 주문금액 | total_amount | |
| 26 | 최초 상품별 총 주문금액 | total_amount | |
| 27 | 사은품 | — | 빈값 |
| 28 | 발주확인일 | confirmed_dt | |
| 29 | 발송기한 | shipping_deadline_dt | |
| 30 | 발송처리일 | shipped_dt | |
| 31 | 송장출력일 | — | 오늘 날짜 |
| 32 | 배송비 형태 | — | 선불/무료 |
| 33 | 배송비 묶음번호 | — | |
| 34 | 배송비 유형 | — | 기본배송비 |
| 35 | 배송비 합계 | shipping_fee | |
| 36 | 제주/도서 추가배송비 | — | 0 |
| 37 | 배송비 할인액 | — | 0 |
| 38 | 판매자 상품코드 | product.seller_code | |
| 39 | 판매자 내부코드1 | — | 빈값 |
| 40 | 판매자 내부코드2 | — | 빈값 |
| 41 | 수취인연락처1 | receiver_phone1 | |
| 42 | 수취인연락처2 | receiver_phone2 | |
| 43 | 통합배송지 | address_full | |
| 44 | 기본배송지 | address_base | |
| 45 | 상세배송지 | address_detail | |
| 46 | 구매자연락처 | buyer_phone | |
| 47 | 우편번호 | zipcode | |
| 48 | 배송메세지 | delivery_message | |
| 49 | 출고지 | — | 세모코리아 주소 |
| 50 | 결제수단 | payment_method | |
| 51 | 네이버페이 주문관리 수수료 | — | 0 |
| 52 | 매출연동 수수료 | — | 0 |
| 53 | 정산예정금액 | settlement_amount | |
| 54 | 매출연동수수료 유입경로 | — | 빈값 |
| 55 | 개인통관고유부호 | — | 빈값 |
| 56 | 주문일시 | order_dt | |
| 57 | 배송완료일 | — | 빈값 (배송 후 업데이트) |

## 엑셀 스타일 규칙

```python
# 헤더 스타일
header_fill  = PatternFill("solid", fgColor="1A6B3C")  # 세모코리아 녹색
header_font  = Font(bold=True, color="FFFFFF", size=9)
header_align = Alignment(horizontal="center", vertical="center")

# 송장번호 컬럼 (6번) 강조
invoice_fill = PatternFill("solid", fgColor="E8F5E9")   # 연녹색
invoice_font = Font(bold=True, color="1A6B3C", size=9)

# 틀 고정: C2 (헤더 + 처음 2컬럼 고정)
ws.freeze_panes = "C2"

# 자동 필터
ws.auto_filter.ref = f"A1:BE1"  # 57컬럼 = BE열
```

## Node.js 생성 코드 예시

```javascript
// backend/api/invoice.js
const ExcelJS = require('exceljs');

const COLUMNS = [
  '상품주문번호', '주문번호', '배송방법(구매자 요청)', '배송방법', '택배사', '송장번호',
  // ... 57개 전체
];

async function generateInvoiceExcel(orders) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('발송처리');

  // 헤더
  ws.addRow(COLUMNS);
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A6B3C' } };
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };

  // 데이터
  for (const order of orders) {
    ws.addRow(mapOrderToColumns(order));
  }

  // 송장번호 컬럼 강조
  ws.getColumn(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };

  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];

  return wb.xlsx.writeBuffer();
}
```
