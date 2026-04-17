# 배포 가이드 — Vercel + Supabase

## 전체 아키텍처

```
[브라우저] → [Vercel] → [index.html + API Routes]
                              ↓
                        [Supabase PostgreSQL]
```

---

## 1. Supabase 설정

### 1-1. 프로젝트 생성
1. supabase.com → New project
2. Name: `semockorea-admin`
3. Region: Northeast Asia (Seoul)
4. DB 비밀번호 저장

### 1-2. DB 스키마 실행
SQL Editor → `db/schema.sql` 전체 붙여넣기 → RUN

### 1-3. API 키 복사 (Project Settings → API)
```
SUPABASE_URL      = https://xxxxxx.supabase.co
SUPABASE_ANON_KEY = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_KEY = eyJhbGciOi... (서버 전용, 절대 노출 금지)
```

---

## 2. GitHub 저장소 설정

```bash
git init
git add .
git commit -m "초기 세모코리아 어드민 배포"
git remote add origin https://github.com/YOUR_ID/semockorea-admin.git
git push -u origin main
```

---

## 3. Vercel 배포

### 3-1. 프론트엔드 배포 (index.html)
1. vercel.com → New Project → GitHub 저장소 연결
2. Framework: Other
3. Root Directory: `frontend`
4. Environment Variables 입력:
   ```
   SUPABASE_URL       = (Supabase에서 복사)
   SUPABASE_ANON_KEY  = (Supabase에서 복사)
   JWT_SECRET         = (랜덤 32자 문자열)
   ```
5. Deploy

### 3-2. API 서버 배포 (Vercel Serverless Functions)
`backend/api/` 폴더의 파일들이 자동으로 `/api/*` 경로로 배포됨

`vercel.json` 루트에 추가:
```json
{
  "version": 2,
  "builds": [
    { "src": "frontend/index.html", "use": "@vercel/static" },
    { "src": "backend/api/**/*.js", "use": "@vercel/node" }
  ],
  "routes": [
    { "src": "/api/(.*)", "dest": "backend/api/$1" },
    { "src": "/(.*)", "dest": "frontend/index.html" }
  ]
}
```

---

## 4. 환경 변수 목록

| 변수명 | 설명 | 필수 |
|--------|------|------|
| SUPABASE_URL | Supabase 프로젝트 URL | ✅ |
| SUPABASE_ANON_KEY | Supabase 익명 키 (프론트용) | ✅ |
| SUPABASE_SERVICE_KEY | Supabase 서비스 키 (서버 전용) | ✅ |
| JWT_SECRET | JWT 토큰 서명 비밀키 | ✅ |
| NAVER_CLIENT_ID | 네이버 커머스 API 클라이언트 ID | 🔜 |
| NAVER_CLIENT_SECRET | 네이버 커머스 API 시크릿 | 🔜 |
| COUPANG_ACCESS_KEY | 쿠팡 API 액세스 키 | 🔜 |
| COUPANG_SECRET_KEY | 쿠팡 API 시크릿 키 | 🔜 |
| ABLY_API_KEY | 에이블리 API 키 | 🔜 |
| ZIGZAG_API_KEY | 지그재그 API 키 | 🔜 |

---

## 5. 커스텀 도메인 연결 (선택)

1. 가비아·후이즈 등에서 도메인 구매
2. Vercel → Settings → Domains → 도메인 입력
3. DNS 설정: CNAME → cname.vercel-dns.com

예시: `admin.semockorea.com`

---

## 6. 현재 배포 후 동작 상태

### 바로 동작하는 것
- 로그인/로그아웃 (admin/Admin1234!, manager/Mgr5678!)
- 모든 화면 탐색 (샘플 데이터)
- 견적서 작성 UI (품목 최대 10개, 합계 자동계산)
- 해운 진행 타임라인
- PC+모바일 반응형

### API 연동 후 동작하는 것
- 실제 주문 데이터 조회/처리
- 운송장 등록 및 플랫폼 반영
- 에이블리 57컬럼 엑셀 다운로드
- 견적서 PDF 생성 + 직인 삽입
- 재고 실시간 동기화
