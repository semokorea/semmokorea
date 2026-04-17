# 세모코리아 통합 어드민 — Claude Code 가이드

## 프로젝트 개요

**세모코리아** (사업자: 131-72-00034, 대표: 김현석, 연락처: 010-9959-8982)
경기도 김포시 김포한강10로133번길 107

멀티채널 쇼핑몰(네이버·쿠팡·에이블리·지그재그) 운영 관리 +
중국 OEM B2B 납품 사업 통합 어드민 시스템

---

## 현재 개발 상태 (Claude Chat에서 완료된 것)

### ✅ 완료된 것

| 항목 | 파일 | 상태 |
|------|------|------|
| 반응형 어드민 UI (PC+모바일) | `frontend/index.html` | 완료 — 샘플 데이터 |
| DB 스키마 (PostgreSQL) | `db/schema.sql` | 완료 — Supabase 실행 대기 |
| 견적서 PDF 생성 로직 | `frontend/quote_template.html` | 완료 — wkhtmltopdf 기반 |
| 세모코리아 직인 이미지 | `assets/stamp_semockorea.png` | 완료 |
| 에이블리 57컬럼 송장 양식 | `docs/INVOICE_COLUMNS.md` | 완료 |

### ❌ 미완성 — Claude Code에서 작업 필요

| 항목 | 우선순위 | 설명 |
|------|----------|------|
| Supabase 연동 (인증·DB) | 🔴 높음 | 로그인·주문·재고 실제 데이터 |
| 플랫폼 API 수집 스케줄러 | 🔴 높음 | 네이버·쿠팡·에이블리·지그재그 |
| 견적서 PDF API | 🟡 중간 | `/api/quote/pdf` 엔드포인트 |
| 송장 엑셀 다운로드 API | 🟡 중간 | 에이블리 57컬럼 양식 유지 |
| CJ대한통운 배송처리 API | 🟡 중간 | 운송장 등록 + 플랫폼 반영 |
| 실시간 재고 동기화 | 🟠 낮음 | 채널별 재고 자동 조정 |

---

## 기술 스택

```
Frontend:  순수 HTML/CSS/JS (단일 파일, 프레임워크 없음)
Backend:   Node.js + Express (권장) 또는 Python FastAPI
Database:  PostgreSQL (Supabase 호스팅)
배포:      Vercel (프론트) + Supabase (DB)
PDF:       wkhtmltopdf (서버) 또는 puppeteer
Excel:     xlsx 라이브러리 (Node.js)
```

---

## 로그인 계정

| 아이디 | 비밀번호 | 권한 |
|--------|----------|------|
| admin | Admin1234! | 대표 관리자 (owner) |
| manager | Mgr5678! | 운영 매니저 (manager) |

> ⚠️ 실서버 배포 시 반드시 bcrypt 해시로 변경할 것

---

## 디렉토리 구조

```
semockorea-admin/
├── CLAUDE.md                  ← 이 파일 (Claude Code 가이드)
├── frontend/
│   ├── index.html             ← 메인 어드민 (PC+모바일 반응형)
│   ├── admin_v2.html          ← 이전 버전 (참고용)
│   └── quote_template.html    ← 견적서 HTML 템플릿
├── backend/
│   └── api/                   ← API 서버 코드 작성 위치
├── db/
│   └── schema.sql             ← PostgreSQL 스키마 (Supabase에 실행)
├── assets/
│   └── stamp_semockorea.png   ← 세모코리아 직인 이미지
└── docs/
    ├── FEATURES.md            ← 기능 명세
    ├── API_SPEC.md            ← API 설계 명세
    ├── INVOICE_COLUMNS.md     ← 에이블리 57컬럼 송장 양식
    └── DEPLOYMENT.md          ← Vercel+Supabase 배포 가이드
```

---

## Claude Code 작업 시작 방법

### 1단계: Supabase 연동부터 시작

```bash
# 패키지 초기화
npm init -y
npm install @supabase/supabase-js express cors dotenv xlsx
```

`.env` 파일 생성:
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_KEY=your-service-key
PORT=3000
```

### 2단계: 추천 작업 순서

1. `backend/api/auth.js` — 로그인 API (bcrypt + JWT)
2. `backend/api/orders.js` — 주문 CRUD API
3. `backend/api/invoice.js` — 에이블리 57컬럼 엑셀 생성
4. `backend/api/quote-pdf.js` — 견적서 PDF 생성
5. `backend/api/sync/` — 플랫폼별 API 수집 스케줄러

### 3단계: 프론트엔드 API 연동

`frontend/index.html` 상단에 환경변수 추가:
```javascript
const API_BASE = 'https://your-api.vercel.app/api';
const SUPABASE_URL = 'https://your-project.supabase.co';
const SUPABASE_KEY = 'your-anon-key';
```

---

## 주요 비즈니스 규칙

### 쇼핑몰 운영
- 플랫폼: 네이버 스마트스토어, 쿠팡, 에이블리, 지그재그
- 주문 수집: 각 플랫폼 API 자동 수집 (15분 간격 권장)
- 택배사: CJ대한통운 (기본)
- 송장 양식: 에이블리 57컬럼 (사용자 직접 제작 양식)
- 컬럼 매핑: DB `invoice_column_mappings` 테이블에 저장됨

### OEM 사업
- 거래 방식: 국내 B2B 도매 납품
- 배송 경로: 중국 공장 → 해운 → 한국 통관 → 거래처 납품
- 해운 진행 6단계:
  1. 공장 출고 준비중
  2. 중국 물류 대기중
  3. 한국 운송중 (해운)
  4. 통관중
  5. 통관 완료
  6. 고객 출고 완료
- 견적서: 최대 10개 품목, VAT 10% 자동 계산, PDF + 직인 포함

### 견적서 PDF 구성
- 공급자: 세모코리아
- 사업자: 131-72-00034
- 대표: 김현석
- 연락처: 010-9959-8982
- 주소: 경기도 김포시 김포한강10로133번길 107
- 직인: `assets/stamp_semockorea.png` (빨간색 원형 직인)
- 생성 방식: HTML 템플릿 → wkhtmltopdf 변환

---

## 참고: 에이블리 57컬럼 순서 (송장 양식)

`docs/INVOICE_COLUMNS.md` 참고
