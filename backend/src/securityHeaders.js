// 응답 보안 헤더 (계약 §7). helmet 같은 별도 패키지 없이 필요한 헤더만 직접 붙인다 — 새 npm
// 의존성 추가가 금지돼 있고(계약 §0, node_modules 미설치라 lockfile을 갱신할 수 없음), 이 정도
// 헤더 셋은 미들웨어 하나로 충분히 구현 가능하다.

// /toss-plugin/, /pos-plugin/ 정적 파일은 토스 SDK가 외부 CDN에서 스크립트를 불러오고 토스
// 앱(iframe/웹뷰) 안에 얹혀 렌더링되는 구조라, 엄격한 CSP(특히 default-src 'self')를 걸면 그
// 페이지들이 깨진다. 이 두 경로만 CSP 적용에서 제외한다(계약 §7).
function isPluginPreviewPath(path) {
  return path.startsWith('/toss-plugin/') || path.startsWith('/pos-plugin/')
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function securityHeaders(req, res, next) {
  // MIME 스니핑으로 응답을 실제 Content-Type과 다르게(예: 스크립트로) 해석하지 못하게 막는다.
  res.setHeader('X-Content-Type-Options', 'nosniff')
  // Referer 헤더에 예약번호/전화번호 등이 쿼리스트링으로 들어가는 경로는 없지만, 관리자 화면
  // URL 자체가 새어나가는 것도 막기 위해 아예 보내지 않는다.
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()')

  // 관리자 화면이 다른 사이트의 iframe에 얹혀 클릭재킹 당하는 걸 막는다.
  // 단, POS 탭앱(/pos-plugin/)은 애초에 "탭 화면(iframe) 패키지" 규격이라 토스 POS 앱이
  // iframe으로 띄우는 게 정상 동작이고, 토스프론트 플러그인(/toss-plugin/)도 토스 앱 웹뷰
  // 안에서 렌더링된다. 이 두 경로에 X-Frame-Options를 걸면 미리보기가 통째로 깨지므로
  // CSP와 동일하게 예외 처리한다(둘 다 미리보기 전용 경로이고 자체 인증도 별도로 있다).
  if (!isPluginPreviewPath(req.path)) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  }

  // HSTS는 로컬 개발(HTTP)에서 켜면 브라우저가 다음부터 강제로 HTTPS만 시도해 개발 서버 접속이
  // 막힐 수 있으므로 production에서만 붙인다.
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }

  if (!isPluginPreviewPath(req.path)) {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  }

  next()
}

module.exports = { securityHeaders }
