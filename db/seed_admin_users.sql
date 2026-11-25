-- 초기 관리자 계정 (bcrypt 해시). Supabase SQL Editor에서 실행.
-- 로그인 후 반드시 비밀번호를 바꾸세요.
INSERT INTO admin_users (username, password_hash, name, role) VALUES
  ('admin',   '$2b$10$wyQkq03OjNXj2epVj3t.8OWXay7Z12z2fiD5BRatd3c2ykC/x5AA.', '대표 관리자', 'owner'),
  ('manager', '$2b$10$4tkALO6Mm94b3I8X0PRP6OqH.dbNExep2Z/E9WcaBwFviJXoOgsTe', '운영 매니저', 'manager')
ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = TRUE;
