// Express 라우트 표를 그대로 찍는다. 리팩터링 전후를 대조하는 안전망이다.
//
// 왜 필요한가: server.js를 쪼개다 보면 라우트 자체는 멀쩡한데 **미들웨어 하나가 빠지거나
// 순서가 바뀌는** 사고가 난다. 인증 가드(requireAuth)가 빠져도, 레이트리밋이 사라져도,
// CORS가 다른 라우트에 붙어도 테스트는 전부 통과할 수 있다 — 그 테스트가 그 경로를
// 안 건드리면 그만이기 때문이다. 실제로 이 저장소의 관리자 라우트에는 테스트가 거의 없다.
//
// 그래서 "무엇이 어떤 순서로 붙어 있는지"를 통째로 덤프해 두고, 리팩터링 뒤 같은 걸 찍어
// diff로 비교한다. 한 글자라도 다르면 즉시 드러난다.
//
// 쓰는 법:
//   node scripts/dump-routes.js > /tmp/routes-before.txt
//   ...리팩터링...
//   node scripts/dump-routes.js > /tmp/routes-after.txt
//   diff /tmp/routes-before.txt /tmp/routes-after.txt   # 아무것도 안 나와야 한다
//
// 무엇을 잡고 무엇을 못 잡는지(중요):
//   잡는다  — 라우트가 사라지거나 경로가 바뀐 것, 미들웨어가 빠진 것, 순서가 바뀐 것,
//            app.use 프리픽스(CORS 등)가 다른 경로에 붙은 것
//   못 잡는다 — 같은 자리에 "다른" 레이트리밋을 끼운 것. express-rate-limit이 돌려주는
//            미들웨어는 설정만 다르고 함수 본문이 같아서 해시가 겹친다. asyncHandler로
//            감싼 핸들러들도 같은 이유로 전부 같은 해시로 찍힌다 — 즉 이 도구는 "뼈대"를
//            지키는 것이지 핸들러 안의 로직까지 보증하지 않는다. 그쪽은 테스트의 몫이다.

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dump'
process.env.ERP_API_TOKEN = process.env.ERP_API_TOKEN || 'dump'
process.env.TOSS_WEBHOOK_SECRET = process.env.TOSS_WEBHOOK_SECRET || 'dump'
process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://postgres:devpass@localhost:5432/devdb?schema=public'

const { app } = require('../server')

// 익명 함수는 이름이 '' 라 그대로 찍으면 구분이 안 된다. 그럴 때는 함수 본문의 앞부분을
// 해시해서 안정적인 식별자를 만든다 — 내용이 같으면 같은 이름이 나오므로, 옮겨졌을 뿐인
// 핸들러는 diff에 안 잡히고 실제로 바뀐 것만 잡힌다.
const crypto = require('node:crypto')
function nameOf(fn) {
  if (fn.name) return fn.name
  const body = fn.toString().replace(/\s+/g, ' ').trim()
  return `anon:${crypto.createHash('sha1').update(body).digest('hex').slice(0, 10)}`
}

function pathOf(layer) {
  if (layer.route) return layer.route.path
  if (layer.regexp && layer.regexp.fast_slash) return '/'
  // app.use('/prefix', ...) 로 붙은 미들웨어의 경로를 정규식에서 되살린다.
  const m = layer.regexp && layer.regexp.source
    .replace('^\\/', '/')
    .replace('\\/?(?=\\/|$)', '')
    .replace(/\\\//g, '/')
    .replace(/\$$/, '')
  return m || '(?)'
}

const lines = []
let i = 0

for (const layer of app._router.stack) {
  i += 1
  if (layer.route) {
    const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]).map((m) => m.toUpperCase()).sort()
    // 라우트에 붙은 핸들러 체인(미들웨어 포함)을 순서 그대로 남긴다 — 이게 핵심이다.
    const chain = layer.route.stack.map((s) => nameOf(s.handle)).join(' > ')
    lines.push(`${String(i).padStart(3, '0')} ROUTE ${methods.join(',')} ${layer.route.path}`)
    lines.push(`    chain: ${chain}`)
  } else {
    lines.push(`${String(i).padStart(3, '0')} USE   ${pathOf(layer)}  [${nameOf(layer.handle)}]`)
  }
}

console.log(`# Express 라우트 표 스냅샷 — 총 ${app._router.stack.length}개 레이어`)
console.log('# 리팩터링 전후로 이 출력이 완전히 같아야 한다.')
console.log(lines.join('\n'))
