#!/usr/bin/env node
// 토스플레이스 결제 웹훅 서명 검증이 실제로 동작하는지 확인하는 일회성 점검 도구.
//
// 서버에 넣은 TOSS_WEBHOOK_SECRET과 개발자센터에 등록한 서명 secret이 같은 값인지,
// 그리고 서명 검증 로직이 실제 요청을 제대로 통과/차단하는지를 실제 HTTP 요청으로 확인한다.
// 토스 쪽에 실제 결제를 발생시키지 않고도 웹훅 경로만 따로 점검할 수 있다.
//
// 사용법 (secret은 인자로 넘기지 말고 환경변수로 — 셸 히스토리에 남지 않게):
//   PowerShell:
//     $env:TOSS_WEBHOOK_SECRET='붙여넣기'
//     $env:WEBHOOK_TARGET='https://<운영도메인>/api/webhooks/toss/payment'
//     node backend/scripts/verify-webhook.js
//   Git Bash:
//     TOSS_WEBHOOK_SECRET='붙여넣기' WEBHOOK_TARGET='https://.../api/webhooks/toss/payment' \
//       node backend/scripts/verify-webhook.js
//
// 이 스크립트는 존재하지 않는 merchantId로 테스트 이벤트를 보내므로, 서명이 통과해도
// 실제 결제 레코드는 만들어지지 않는다(서버가 "등록되지 않은 merchantId"로 건너뛴다).

const crypto = require('node:crypto')

const secret = process.env.TOSS_WEBHOOK_SECRET
const target = process.env.WEBHOOK_TARGET

if (!secret || !target) {
  console.error('TOSS_WEBHOOK_SECRET 과 WEBHOOK_TARGET 환경변수가 모두 필요합니다. 파일 상단 사용법 참고.')
  process.exit(1)
}

// 실제 토스 페이로드 구조(https://docs.tossplace.com/reference/open-api/webhook.html):
// merchantId는 최상위, 결제 객체는 data.payment 안에 온다.
function buildPayload(webhookId) {
  return JSON.stringify({
    id: webhookId,
    type: 'payment.payment.approved.v1',
    createdAt: new Date().toISOString(),
    merchantId: 'verify-webhook-does-not-exist',
    app: { id: 'verify-script' },
    data: { payment: { id: 'p_test', orderId: `verify-${webhookId}`, amount: 1000 } },
  })
}

function sign(timestamp, body) {
  return 'v1=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

async function send({ label, mutateSignature = false, mutateTimestamp = false }) {
  const webhookId = `verify-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const body = buildPayload(webhookId)
  const timestamp = mutateTimestamp ? String(Date.now() - 10 * 60 * 1000) : String(Date.now())
  let signature = sign(timestamp, body)
  if (mutateSignature) signature = signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0')

  const res = await fetch(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-toss-webhook-id': webhookId,
      'x-toss-timestamp': timestamp,
      'x-toss-signature': signature,
    },
    body,
  })
  const text = await res.text()
  return { label, status: res.status, text: text.slice(0, 200) }
}

;(async () => {
  console.log(`대상: ${target}\n`)
  const cases = [
    { label: '① 올바른 서명',            opts: {},                          expect: 200, why: '서버와 secret이 일치하면 200' },
    { label: '② 서명 한 글자 변조',      opts: { mutateSignature: true },   expect: 401, why: '위조 요청은 반드시 거부돼야 함' },
    { label: '③ 10분 지난 timestamp',    opts: { mutateTimestamp: true },   expect: 400, why: '재전송 공격 방지(5분 허용창)' },
  ]

  let allOk = true
  for (const c of cases) {
    try {
      const r = await send({ ...c.opts, label: c.label })
      const ok = r.status === c.expect
      if (!ok) allOk = false
      console.log(`${ok ? '✅' : '❌'} ${c.label}: ${r.status} (기대 ${c.expect}) — ${c.why}`)
      if (!ok) console.log(`     응답: ${r.text}`)
    } catch (e) {
      allOk = false
      console.log(`❌ ${c.label}: 요청 실패 — ${e.message}`)
    }
  }

  console.log()
  if (allOk) {
    console.log('>>> 통과. 서버의 TOSS_WEBHOOK_SECRET과 지금 넣은 값이 같고, 서명 검증이 정상 동작합니다.')
    console.log('    이제 개발자센터에 등록한 secret도 같은 값인지만 확인하면 됩니다.')
  } else {
    console.log('>>> 실패 항목이 있습니다.')
    console.log('    ①이 401이면 → 서버 환경변수와 지금 넣은 secret이 다릅니다.')
    console.log('    ①이 404/타임아웃이면 → WEBHOOK_TARGET 주소가 틀렸거나 아직 배포 전입니다.')
    console.log('    ②가 200이면 → 서명 검증이 꺼져 있습니다(서버에 secret이 아예 비어 있음).')
    process.exit(1)
  }
})()
