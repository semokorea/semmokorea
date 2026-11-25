# 세모코리아 통합 어드민 — Claude Code 가이드

## 프로젝트 개요

**세모코리아** (사업자: 131-72-00034, 대표: 김현석, 연락처: 010-9959-8982)
경기도 김포시 김포한강10로133번길 107

멀티채널 쇼핑몰(네이버·쿠팡·에이블리·지그재그) 운영 관리 +
중국 OEM B2B 납품 사업 통합 어드민 시스템

---

## 현재 개발 상태 (2026-11-25 기준)

### 배포 정보
- 운영 주소: **https://semokorea.vercel.app** (`semo` — **m이 하나**. `semmokorea`는 틀린 주소 → 404 DEPLOYMENT_NOT_FOUND)
- GitHub: `semokorea/semmokorea` (main 푸시 → Vercel 자동 배포)
- Vercel 플랜: **Hobby** → 크론은 **하루 1회까지** (15분 크론을 vercel.json에 넣으면 배포가 Error)
- Supabase: 프로젝트 `semockorea-admin` (ID `qhuitkweccncoyevuqba`, Free 플랜 → 7일 미접속 시 일시정지, 재개에 1~3분)
- 환경변수는 전부 Vercel에만 둔다 (코드/문서/채팅에 키·시크릿 금지). 필요한 이름:
  `SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, JWT_SECRET, CRON_SECRET,
  NAVER_CLIENT_ID, NAVER_CLIENT_SECRET, COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY, COUPANG_VENDOR_ID,
  ABLY_API_KEY, ZIGZAG_API_KEY`
  (주의: 과거 `SUPABASE_ANON_KE` 오타 이름이 있었음 → `SUPABASE_ANON_KEY`로 고칠 것)

### ✅ 완료
| 항목 | 위치 | 비고 |
|------|------|------|
| 반응형 어드민 UI | `frontend/index.html` | 로그인 + **조회 화면 실데이터 연동**(주문·배송처리·재고·매출·OEM주문·해운진행·견적서·거래처). 등록/수정 모달(OEM주문·거래처·견적서 저장·해운 업데이트)과 송장 엑셀은 아직 동작 안 함 |
| 화면 조회 API | `api/data/index.js` | `GET /api/data?type=shop\|stock\|sales\|oem` (JWT 필요). Hobby 함수 개수 제한 때문에 하나로 묶음. 브라우저 목업 테스트만 함, 실DB 미검증 |
| DB 스키마 + 시드 | `db/schema.sql`, `db/add_sync_logs.sql`, `db/seed_admin_users.sql` | Supabase에 테이블 16개 생성됨, admin/manager 계정(bcrypt) 입력됨 |
| 로그인 API | `api/auth/login.js`, `utils/auth.js` | bcrypt + JWT 7일. 운영에서 200 확인 |
| 비밀번호 변경 | `api/auth/password.js`, 상단바/더보기 메뉴 | 본인만, 현재 비번 확인, 8자 이상+영문+숫자. 변경 후 재로그인. 기존 JWT는 만료(7일)까지 유효 |
| 주문/수집/배송 API (서버리스) | `api/orders`, `api/sync`, `api/shipments/bulk`, `api/cron/sync` | 문법·모듈 로드만 검증. **실제 플랫폼 호출은 미검증** |
| 플랫폼 연동 모듈 | `sync/{naver,coupang,ably,zigzag,scheduler}.js`, `utils/supabase.js` | `syncOrders()`, `registerShipment()` |
| 견적서 HTML + 직인 | `frontend/quote_template.html`, `assets/stamp_semockorea.png` | 서버 PDF API는 아직 없음 |

### ❌ 남은 작업 (우선순위 순)
1. 초기 비밀번호 변경 — 화면(상단바 "비밀번호 변경")에서 admin·manager 둘 다 바꿀 것 (기본 비번이 과거 문서에 평문으로 남아 있었음)
2. 플랫폼 API 키 4종 재발급(과거 채팅에 노출) → Vercel 환경변수 교체 → Redeploy
3. `POST /api/sync`로 주문 수집 테스트 → Supabase `orders` 확인
4. 15분 자동 수집: Vercel Hobby 크론 한계 때문에 **외부 스케줄러**(cron-job.org 등)가 `/api/cron/sync`를 `Authorization: Bearer <CRON_SECRET>`로 호출
5. 등록/수정 API + 모달 연결 (OEM 주문 등록, 거래처 등록·수정, 견적서 저장, 해운 단계 업데이트, 재고 입고)
6. 견적서 PDF API(`/api/quote/pdf`), 에이블리 57컬럼 송장 엑셀 API
7. 기존 `backend/api/`(Express)와 `api/`(서버리스) 중복 정리 — Vercel은 `api/`만 배포함. 하나로 통일할 것

### 알려진 함정
- `vercel.json`은 **zero-config**(`outputDirectory: frontend`, `api/`는 자동 함수). 예전 `builds/routes` 방식은 `/api/*`가 404였음
- 다른 도메인에서 API를 호출하면 CORS로 막힘 (같은 도메인 `/api/...`로 호출할 것)
- 로컬 테스트: `npm install` 후 `node -e "require('./sync/scheduler')"`는 NODE_ENV≠production이면 15분 타이머를 켜서 종료되지 않음(정상)
- 과거 GitHub 웹 업로드로 파일명/내용이 뒤바뀐 사고가 있었음 → 웹 업로드 대신 git 사용
- `shipments.order_id`에는 UNIQUE가 없어 `upsert(onConflict:'order_id')`가 실패함 → `api/shipments/bulk.js`는 조회 후 update/insert
- `oem_orders.status` 값 규칙(프론트 `OEM_STATUS`): `received`(접수) → `factory, china, sea, customs, cleared, delivered`(해운 6단계) → `settled`(정산완료), `cancelled`. 단계별 날짜 이력 테이블은 아직 없음
- 견적서 상태: `draft | sent | confirmed`

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

| 아이디 | 권한 |
|--------|------|
| admin | 대표 관리자 (owner) |
| manager | 운영 매니저 (manager) |

> 비밀번호는 `admin_users` 테이블에 bcrypt 해시로만 저장된다 (`db/seed_admin_users.sql` 참고).
> 로그인은 `POST /api/auth/login` → JWT. 문서/코드에 평문 비밀번호를 적지 말 것.
> 초기 비밀번호는 로그인 후 반드시 변경한다.

---

## 디렉토리 구조

```
semmokorea/
├── CLAUDE.md                  ← 이 파일
├── vercel.json                ← zero-config + 일 1회 크론
├── package.json
├── api/                       ← Vercel 서버리스 함수 (배포됨)
│   ├── auth/login.js
│   ├── orders/index.js
│   ├── sync/index.js
│   ├── shipments/bulk.js
│   └── cron/sync.js
├── sync/                      ← 플랫폼별 수집/배송처리 모듈
│   ├── naver.js  coupang.js  ably.js  zigzag.js  scheduler.js
├── utils/                     ← supabase.js, auth.js
├── frontend/                  ← index.html(메인), admin_v2.html(참고), quote_template.html
├── backend/api/               ← 이전 Express 구현 (배포 안 됨, 정리 대상)
├── db/                        ← schema.sql, add_sync_logs.sql, seed_admin_users.sql
├── assets/                    ← stamp_semockorea.png
└── docs/                      ← FEATURES / API_SPEC / INVOICE_COLUMNS / DEPLOYMENT
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
