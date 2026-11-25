#!/usr/bin/env bash
# infra/proxy/setup-squid.sh
# 고정 IP 중계 서버(네이버 클라우드, Ubuntu 24.04)에 Squid 포워드 프록시를 설치한다.
# - 쇼핑몰 API(네이버/쿠팡)가 "등록된 IP에서만 호출"을 요구해서, Vercel → 이 서버 → 쇼핑몰 API 로 나간다.
# - 비밀번호(Basic 인증)가 있어야만 사용 가능, HTTPS(443) CONNECT만, 허용 도메인으로만 통과.
# - 비밀번호는 서버에서 무작위 생성해 /root/proxy-url.txt (권한 600)에만 저장한다. 화면에 출력하지 않는다.
# 사용법: sudo bash setup-squid.sh   (다시 실행하면 설정을 덮어쓰고 비밀번호는 유지)
set -euo pipefail

PORT=8080   # 3128은 일부 사무실 네트워크에서 막혀 있어 8080 사용 (네이버 클라우드 ACG에도 8080 허용 필요)
USER_NAME=semo
ALLOWED_DOMAINS="api.commerce.naver.com api-gateway.coupang.com"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq squid apache2-utils >/dev/null

# 비밀번호: 이미 있으면 유지, 없으면 새로 생성
if [ ! -s /etc/squid/passwd ]; then
  PASS="$(openssl rand -hex 24)"
  htpasswd -bcB /etc/squid/passwd "$USER_NAME" "$PASS" >/dev/null 2>&1 || htpasswd -bc /etc/squid/passwd "$USER_NAME" "$PASS" >/dev/null
  PUBLIC_IP="$(curl -s --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')"
  umask 077
  echo "http://${USER_NAME}:${PASS}@${PUBLIC_IP}:${PORT}" > /root/proxy-url.txt
  chmod 600 /root/proxy-url.txt
fi
# 포트를 바꿔 다시 실행한 경우 저장된 URL의 포트도 맞춘다
sed -i -E "s/:[0-9]+$/:${PORT}/" /root/proxy-url.txt
chown proxy:proxy /etc/squid/passwd
chmod 640 /etc/squid/passwd

cat > /etc/squid/squid.conf <<EOF
http_port ${PORT}

auth_param basic program /usr/lib/squid/basic_ncsa_auth /etc/squid/passwd
auth_param basic realm semo-proxy
auth_param basic credentialsttl 2 hours
acl authenticated proxy_auth REQUIRED

acl SSL_ports port 443
acl CONNECT method CONNECT
acl allowed_sites dstdomain ${ALLOWED_DOMAINS}

http_access deny !authenticated
http_access deny CONNECT !SSL_ports
http_access deny !allowed_sites
http_access allow authenticated allowed_sites
http_access deny all

# 캐시/추적 정보 끄기
cache deny all
forwarded_for delete
via off
request_header_access X-Forwarded-For deny all

access_log daemon:/var/log/squid/access.log squid
EOF

squid -k parse >/dev/null 2>&1
systemctl enable squid >/dev/null 2>&1
systemctl restart squid
sleep 1
systemctl is-active squid
echo "OK: squid on port ${PORT}. Proxy URL saved to /root/proxy-url.txt (not printed)."
