# 세모코리아 통합 어드민 — Claude Code 가이드

## 프로젝트 개요

**세모코리아** (사업자: 131-72-00034, 대표: 김현석, 연락처: 010-9959-8982)
경기도 김포시 김포한강10로133번길 107

멀티채널 쇼핑몰(네이버·쿠팡·에이블리·지그재그) 운영 관리 +
중국 OEM B2B 납품 사업 통합 어드민 시스템

---

## 현재 개발 상태 (2026-11-25 저녁 기준)

### 배포 정보
- 운영 주소: **https://semokorea.vercel.app** (`semo` — **m이 하나**. `semmokorea`는 틀린 주소 → 404 DEPLOYMENT_NOT_FOUND)
- GitHub: `semokorea/semmokorea` (main 푸시 → Vercel 자동 배포)
- Vercel 플랜: **Hobby** → 크론은 **하루 1회까지** (15분 크론을 vercel.json에 넣으면 배포가 Error)
- Supabase: 프로젝트 `semockorea-admin` (ID `qhuitkweccncoyevuqba`, Free 플랜 → 7일 미접속 시 일시정지, 재개에 1~3분)
- 환경변수는 전부 Vercel에만 둔다 (코드/문서/채팅에 키·시크릿 금지). 필요한 이름:
  `SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, JWT_SECRET, CRON_SECRET,
  NAVER_CLIENT_ID, NAVER_CLIENT_SECRET, COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY, COUPANG_VENDOR_ID,
  ABLY_API_KEY, ZIGZAG_API_KEY, PROXY_URL` (+ 선택 `SYNC_CHANNELS`, 기본 `naver`)
  (`SUPABASE_ANON_KE` 오타 변수는 2026-11-25 삭제함. 코드는 ANON 키를 쓰지 않음)
  환경변수를 바꾸면 **Redeploy**해야 적용됨

### ✅ 운영 중 (2026-11-25 저녁, main `16ed787` 기준 — 모두 운영 사이트 반영됨)
| 영역 | 기능 | 위치 |
|------|------|------|
| 계정 | 로그인(bcrypt+JWT 7일), 비밀번호 변경 | `api/auth/login.js`, `api/auth/password.js` |
| 조회 | 화면 데이터 전부 실DB (`GET /api/data?type=shop\|stock\|sales\|oem`, shop은 `&days=`) | `api/data/index.js` |
| 쇼핑몰 | **네이버 주문 수집 운영 중**(버튼 + 기간 1~30일), 스토어별 집계표(주문·취소·반품·발송대기·순매출, 숫자 클릭 → 목록), 배송처리(→ 네이버 발송처리 API), 상품 등록·입고/출고/실사조정 | `sync/naver.js`, `api/sync`, `api/shipments/bulk.js`, `api/stock` |
| OEM | 거래처 등록·수정 / 주문 등록·상태 드롭다운(견적서발행→주문접수→샘플→메인→출고중→납품완료) / 해운진행 10단계 타임라인(자동 연동) / 주문번호 클릭 → 품목·단가 상세 | `api/oem/clients.js`, `api/oem/orders.js` |
| 견적서 | 작성·수정·삭제·PDF(직인, 브라우저 인쇄) / 저장 시 주문관리에 '견적서발행' 자동 생성 / **확정 ↔ 주문접수 양방향 연동** | `api/oem/quotes.js`, `frontend/quote_template.html` |
| DB | 테이블 17개(+`sync_logs`). 네이버 주문 29건 수집됨(11/17~11/24) | Supabase |
- 서버리스 함수 개수: **Hobby 12개 제한 중 11개 사용** → 새 기능은 기존 파일에 메서드/action으로 붙일 것
- 테스트 방식: 이 PC엔 Node가 없음 → 로컬 정적 서버(`scratchpad/serve.ps1`, 포트 8765) + 브라우저에서 API 파일을 가짜 supabase로 실행해 검증. 실서버 확인은 Supabase MCP(SQL) + 중계 서버 Squid 로그 + Vercel Logs 화면

### ❌ 남은 작업
1. **쿠팡 Wing 연결 확인 + 서플라이어허브 발주 엑셀 업로드** — 아래 "쇼핑몰 연동 현황" 참고 (에이블리·지그재그는 연동 안 하기로 함)
2. 15분 자동 수집: Vercel Hobby 크론은 하루 1회 → **cron-job.org** 등이 `/api/cron/sync`를 `Authorization: Bearer <CRON_SECRET>`로 호출 (CRON_SECRET은 Vercel에 있음)
3. 수집 속도 개선: 주문 1건당 DB 3회 호출이라 7일치에서 45초 제한에 걸림 → upsert/insert 일괄 처리로 바꿀 것
4. 초기 비밀번호 변경(admin·manager) 확인, 바탕화면 `클로드코드/PROXY_URL_for_vercel.txt` 삭제 확인
5. 주문 발송 시 재고 자동 차감(주문 상품 ↔ 등록 상품 매칭 필요), 상품 수정·삭제
6. 에이블리 57컬럼 송장 엑셀 (송장출력 탭은 아직 샘플 화면)
7. 보안: 모든 테이블 RLS 꺼져 있음(서버가 service key로만 접근, 프론트는 Supabase 직접 호출 안 함). Vercel의 `SUPABASE_SERVICE_KEY`가 실제 service_role 키인지 확인 권장
8. 기존 `backend/api/`(Express, 배포 안 됨) 정리

### ▶ 쇼핑몰 연동 현황 (2026-11-26)
**공통 방식**: ① 공식 문서 확보 ② `sync/<채널>.js`를 공식 규격으로 작성 ③ 요청은 `utils/proxy.js`(PROXY_URL)로 ④ Squid `ALLOWED_DOMAINS`에 API 도메인 추가 ⑤ 수집 채널 켜기 ⑥ 1일 수집 → DB 필드 확인. 스토어별 집계표·배송처리는 채널만 들어오면 자동으로 채워짐

**쿠팡 Wing (OPEN API) — 코드 완료, 연결 확인 대기**
- `sync/coupang.js`: 공식 문서(developers.coupang.com) 기준. 서명 날짜 yyMMdd'T'HHmmss'Z', v5 ordersheets(상태별·일단위·nextToken), 30일 전체 상태 스캔, 상품준비중 처리 후 송장 업로드, shipmentBoxId는 문자열 유지(2^53 초과)
- 키 3개(COUPANG_ACCESS_KEY/SECRET_KEY/VENDOR_ID)가 있으면 수집에 자동 포함(SYNC_CHANNELS 불필요). 키 앞뒤 공백 자동 제거, Access/Secret이 바뀌어 저장돼도 자동으로 맞바꿈(Access=36자 UUID)
- Wing 계정: 업체코드 A01300533, **OPEN API 키 유효기간 2027-05-25** → 그 전에 Wing에서 재발급 후 Vercel 교체 필요
- Wing 연동정보 허용 IP: 58.127.206.110 + **101.79.26.42**(2026-11-26 추가, 반영 최대 30분). 오류 이력: 401 not registered(옛 키) → 401 Hmac key is expired(만료 키) → 403 IP not allowed(IP 미등록)
- 쿠팡 서플라이어허브(로켓배송 납품): 공개 API 확인 안 됨 → 필요하면 발주 엑셀 업로드 방식으로

**에이블리 — 연동 안 함 (2026-11-26 결정)**
- 공개 API 없음. 셀러센터 API Token은 승인된 제휴 솔루션 전용, 셀러스 계정만 가능. 쇼핑몰 탭 스토어 목록에서 제외함(`sync/ably.js`는 남아 있으나 수집에 안 켜짐)

**지그재그(카카오스타일) — 연동 안 함 (2026-11-26 결정)**
- 공개 API 문서 없음(파트너센터 인증키는 제휴 솔루션용으로 보임). 쇼핑몰 탭 스토어 목록에서 제외함(`sync/zigzag.js`는 남아 있으나 수집에 안 켜짐)

**쿠팡 서플라이어허브(로켓배송 납품) — 진행 중**
- 공개 API 없음 → 서플라이어허브 발주 엑셀을 어드민에 올리는 방식으로 구현 예정

### 쇼핑몰 API 연동 구조 (2026-11-25)
- 네이버·쿠팡은 **API 호출 IP 등록 필수** → Vercel(유동 IP) 대신 **고정 IP 중계 서버**를 거쳐 호출
  - 네이버 클라우드 `semo-proxy` (Micro, Ubuntu 24.04, 2027-11까지 무료) / **공인 IP 101.79.26.42** (월 4,032원)
  - Squid 포워드 프록시 **포트 8080** (3128은 사무실 네트워크에서 막혀 있음), Basic 인증 + 허용 도메인(api.commerce.naver.com, api-gateway.coupang.com)만 통과. 설치: `infra/proxy/setup-squid.sh`
  - ACG: 22 = 사무실 IP(58.127.206.131)만, 8080 = 전체. SSH는 키 로그인(`~/.ssh/semo_proxy_ed25519`, 이 PC)
  - Vercel 환경변수 `PROXY_URL`(http://semo:비번@101.79.26.42:8080) → `utils/proxy.js`가 CONNECT 터널로 사용
  - 새 쇼핑몰 도메인을 쓰려면 setup-squid.sh의 ALLOWED_DOMAINS에 추가 후 재실행
- 네이버 커머스API 공식 문서는 `https://apicenter.commerce.naver.com/llms/llms.txt` (md 문서, curl로 받기 가능)
- 수집 채널은 환경변수 `SYNC_CHANNELS`(기본 `naver`)로 켠다. 연동 안 된 채널은 넣지 말 것
- 네이버: 커머스API센터 애플리케이션의 API호출 IP에 101.79.26.42 등록됨

### 대시보드 · 데이터 메모 (2026-11-26)
- 대시보드(`GET /api/data?type=dashboard`) 금액은 모두 VAT 포함: 쇼핑몰 결제금액(취소·반품 제외) / 쿠팡 로켓 입고금액 / OEM 공급가+VAT(견적서발행·취소 제외). 연도·월은 주문일(로켓은 입고예정일) 기준
- OEM 과거 데이터 32건은 일괄 입력 때 주문일이 11월로 들어가 있어 **1~11월에 균등 분산**함(대표님 요청, 총액 동일). 원래 날짜는 DB 표 `oem_orders_dt_backup_20261126`. 이후 주문은 실제 주문일 그대로
- 네이버 과거 주문: 쇼핑몰 탭 "네이버 과거 주문 가져오기" → `POST /api/sync {backfill_from}` 가 하루씩 약 35초 처리 후 `next`를 돌려주고 화면이 이어서 호출

### 알려진 함정
- `vercel.json`은 **zero-config**(`outputDirectory: frontend`, `api/`는 자동 함수). 예전 `builds/routes` 방식은 `/api/*`가 404였음
- 다른 도메인에서 API를 호출하면 CORS로 막힘 (같은 도메인 `/api/...`로 호출할 것)
- 로컬 테스트: `npm install` 후 `node -e "require('./sync/scheduler')"`는 NODE_ENV≠production이면 15분 타이머를 켜서 종료되지 않음(정상)
- 과거 GitHub 웹 업로드로 파일명/내용이 뒤바뀐 사고가 있었음 → 웹 업로드 대신 git 사용
- `shipments.order_id`에는 UNIQUE가 없어 `upsert(onConflict:'order_id')`가 실패함 → `api/shipments/bulk.js`는 조회 후 update/insert
- `oem_orders.status` 값 규칙(프론트 `OEM_STATUS`/`OEM_FLOW`): `quoted`(견적서발행, 견적서 저장 시 자동 생성) → `received`(주문접수) → `sample`(샘플진행중) → `production`(메인진행중) → `factory, china, sea, customs, cleared`(= 주문관리의 '출고중', 해운 세부 단계) → `delivered`(납품완료) → `settled`(정산완료), `cancelled`. 주문관리 드롭다운과 해운진행 타임라인이 같은 값을 써서 자동 연동. quoted→진행으로 바뀌면 연결된 견적서가 confirmed. 단계별 날짜 이력 테이블은 아직 없음
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
