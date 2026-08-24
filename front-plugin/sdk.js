// 로컬 브라우저 개발용 오버라이드.
//
// 2026-08-03 재검토(실제 브라우저 통합 테스트로 발견): "함수가 없을 때만 채운다"는 예전 가정이 틀렸다.
// CDN의 실제 toss-front-sdk(`https://cdn.tossplace.com/toss-front-sdk/v0/index.js`)는 실제 단말기가
// 아닌 일반 브라우저에서 열어도 `sdk.app.getMerchant()`를 이미 자체적으로 정의해두고 있고,
// 그 상태에서는 `{ id: -1, name: '토스 프론트 플러그인 매장', businessNumber: '0000000000' }` 같은
// 더미 값을 반환한다(실제 단말기 온보딩 전 플레이스홀더로 보인다). 그 결과 `if (!sdk.app.getMerchant)`
// 가드가 항상 false가 되어 아래 오버라이드가 전혀 적용되지 않았고, 로컬 미리보기에서 예약/결제 요청이
// merchantId=-1로 나가 서버가 매번 404("등록되지 않은 가맹점입니다")를 반환했다 — 즉 로컬 미리보기가
// 실제로는 한 번도 끝까지 성공한 적이 없었다(이전에 "확인했다"고 한 테스트는 이 SDK를 거치지 않고
// 서버 API를 직접 호출한 것이었다).
//
// 그래서 함수 존재 여부가 아니라 "로컬/미리보기 환경인지"로 판단한다
// (pos-plugin/src/app.js의 isPreview와 같은 패턴). 실제 단말기에서는 아래 조건에 해당하지 않으므로
// 이 오버라이드가 적용되지 않고 토스프론트가 제공하는 진짜 함수가 그대로 쓰인다.
//
// 2026-08-24 재검토(프로덕션 하드닝 감사로 발견): 예전에는 이 판단을 호스트명 목록으로 했는데, 그
// 목록에 `chevroletcode.onrender.com`이 들어 있었다 — 이 호스트는 README에 적힌 **실제 운영 API
// 도메인**이다. 즉 운영 도메인에서 서빙되는 화면은 전부 이 오버라이드에 걸려 실제 가맹점 정보 대신
// 테스트 매장(`id: '0'`)으로 강제 고정되고 있었다: 실제 손님이 예약/결제를 해도 항상 테스트 매장
// 앞으로 접수되는, 운영 트래픽을 통째로 삼켜버리는 버그였다. 배포 도메인은 배포할 때마다(Render,
// Cloud Run 등) 달라질 수 있어 애초에 특정 도메인을 하드코딩하는 접근 자체가 근본적으로 틀렸다.
// 그래서 도메인 이름을 아예 쓰지 않는 규칙으로 바꾼다: 로컬 개발 호스트이거나(localhost/127.0.0.1),
// 백엔드가 이 플러그인을 자체적으로 정적 서빙하는 미리보기 경로(`/toss-plugin/`, api-config.js와
// 동일한 규칙)인 경우에만 미리보기로 간주한다. 이 규칙은 어떤 배포처(Render/Cloud Run/기타)에서
// 서빙되든 동일하게 동작하고, 실제 단말기 배포본은 애초에 이 경로로 서빙되지 않으므로 안전하다.
var sdk = window.TossFrontSDK

if (!sdk.app) sdk.app = {}

var isLocalPreview = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
var isBackendPreview = location.pathname.startsWith('/toss-plugin/')
var isPreview = isLocalPreview || isBackendPreview

if (isPreview) {
  sdk.app.getMerchant = async () => ({
    id: '0',
    name: '쉐보레 대리점 (테스트)',
    businessNumber: '0000000000',
  })
  sdk.app.getSerialNumber = async () => ({ serialNumber: '000000000000000' })
}
