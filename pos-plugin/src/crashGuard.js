// 화면이 하얘지는 걸 막는다.
//
// POS 탭앱은 iframe 안에서 도는 웹 화면이라, 자바스크립트가 죽으면 아무것도 안 그려진 흰 화면만
// 남는다. 매장에서는 "화면이 하얘졌어요" 외에 알 수 있는 게 없고, 우리도 개발자도구를 붙일 수
// 없어서 원인을 못 찾는다. 실제로 그 상황이 났다.
//
// 그래서 잡히지 않은 오류를 여기서 받아 화면에 띄운다. 고치는 게 아니라 **보이게** 하는 것이
// 목적이다 — 무엇이 죽었는지 알면 그 다음이 있다.
//
// 주의: 이 파일은 다른 어떤 모듈보다 먼저 로드돼야 한다(app.js 최상단 import). 나중에 걸면
// 그 전에 난 오류를 놓친다.

const PANEL_ID = 'crash-panel'

function textOf(value) {
  if (!value) return '(내용 없음)'
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack || ''}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function show(title, detail) {
  // 이미 떠 있으면 첫 오류를 남긴다 — 뒤따르는 오류는 대개 첫 오류의 여파라 원인에서 멀다.
  if (document.getElementById(PANEL_ID)) return

  const panel = document.createElement('div')
  panel.id = PANEL_ID
  panel.setAttribute('role', 'alert')
  panel.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:9999',
    'display:flex', 'flex-direction:column', 'gap:12px',
    'padding:24px', 'overflow:auto',
    'background:#fff', 'color:#191f28',
    'font-family:-apple-system,BlinkMacSystemFont,"Malgun Gothic",sans-serif',
  ].join(';')

  const h = document.createElement('div')
  h.style.cssText = 'font-size:18px;font-weight:800;letter-spacing:-0.04em'
  h.textContent = '화면을 그리는 중 문제가 생겼습니다'

  const p = document.createElement('div')
  p.style.cssText = 'font-size:13px;color:#6b7684;line-height:1.6'
  p.textContent = '아래 내용을 그대로 담당자에게 전달해주세요. [다시 불러오기]를 누르면 복구됩니다.'

  const pre = document.createElement('pre')
  pre.style.cssText = [
    'margin:0', 'padding:12px', 'border-radius:12px',
    'background:#f7f8fa', 'color:#d93025',
    'font-size:12px', 'line-height:1.5',
    'white-space:pre-wrap', 'word-break:break-all',
  ].join(';')
  pre.textContent = `${title}\n\n${detail}`

  const reload = document.createElement('button')
  reload.type = 'button'
  reload.style.cssText = [
    'min-height:48px', 'border:0', 'border-radius:13px',
    'background:#3182f6', 'color:#fff',
    'font-size:14px', 'font-weight:700', 'cursor:pointer',
  ].join(';')
  reload.textContent = '다시 불러오기'
  reload.addEventListener('click', () => window.location.reload())

  panel.append(h, p, pre, reload)
  document.body.appendChild(panel)
}

export function installCrashGuard() {
  window.addEventListener('error', (e) => {
    // 이미지·스크립트 로드 실패는 화면을 죽이지 않으므로 무시한다(오탐이 잦다).
    if (e.target && e.target !== window) return
    show('오류', textOf(e.error || e.message))
  })

  // 처리되지 않은 Promise 거부. 지금 구조에서는 폴링·담기·발송이 전부 비동기라
  // 여기로 오는 게 더 흔하다.
  window.addEventListener('unhandledrejection', (e) => {
    show('처리되지 않은 오류', textOf(e.reason))
  })
}
