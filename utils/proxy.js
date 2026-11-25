// utils/proxy.js — 고정 IP 중계 서버(Squid)를 거쳐 HTTPS 요청을 보내는 Agent
// 네이버/쿠팡 API는 "등록된 IP에서만 호출"을 허용한다. Vercel은 IP가 매번 바뀌므로
// PROXY_URL(http://user:pass@IP:PORT) 로 HTTP CONNECT 터널을 연 뒤 그 위에서 TLS를 맺는다.
// 외부 라이브러리 없이 Node 기본 모듈만 사용한다.
const http = require('http');
const https = require('https');
const tls = require('tls');

class ConnectProxyAgent extends https.Agent {
  constructor(proxyUrl, opts = {}) {
    super({ keepAlive: false, ...opts });
    const u = new URL(proxyUrl);
    this.proxyHost = u.hostname;
    this.proxyPort = Number(u.port) || 80;
    this.proxyAuth = u.username
      ? 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')
      : null;
  }

  // Node Agent는 createConnection(options, callback) 비동기 형태를 지원한다
  createConnection(options, callback) {
    const target = `${options.host}:${options.port || 443}`;
    const headers = { Host: target };
    if (this.proxyAuth) headers['Proxy-Authorization'] = this.proxyAuth;

    const req = http.request({
      host: this.proxyHost,
      port: this.proxyPort,
      method: 'CONNECT',
      path: target,
      headers,
      timeout: 15000
    });

    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        callback(new Error(`프록시 연결 실패 (CONNECT ${res.statusCode})`));
        return;
      }
      const tlsSocket = tls.connect({
        socket,
        servername: options.servername || options.host,
        ALPNProtocols: ['http/1.1']
      });
      callback(null, tlsSocket);
    });
    req.once('timeout', () => req.destroy(new Error('프록시 연결 시간 초과')));
    req.once('error', err => callback(err));
    req.end();
  }
}

let _agent = null;

// PROXY_URL이 있으면 프록시 Agent, 없으면 undefined(직접 호출)
function proxyAgent() {
  const url = process.env.PROXY_URL;
  if (!url) return undefined;
  if (!_agent) _agent = new ConnectProxyAgent(url);
  return _agent;
}

module.exports = { proxyAgent, ConnectProxyAgent };
