#!/usr/bin/env node
// 토스에 만든 주문이 실제로 어떤 상태로 저장됐는지 조회한다.
// verify-toss-order.js가 200을 받았는데도 POS [현황] 탭에 안 보일 때, "정말 안 만들어진 건지"
// 아니면 "만들어졌는데 화면 필터에 안 걸리는 건지"를 가르기 위한 도구다.
//
// 사용법 (PowerShell):
//   $env:TOSS_OPENAPI_ACCESS_KEY='...'
//   $env:TOSS_OPENAPI_SECRET_KEY='...'
//   $env:TOSS_MERCHANT_ID='129169'
//   node backend/scripts/check-toss-order.js                 # 최근 주문 목록(모든 상태)
//   node backend/scripts/check-toss-order.js <orderKey>      # 특정 주문 단건 조회

const accessKey = process.env.TOSS_OPENAPI_ACCESS_KEY
const secretKey = process.env.TOSS_OPENAPI_SECRET_KEY
const merchantId = process.env.TOSS_MERCHANT_ID

if (!accessKey || !secretKey || !merchantId) {
  console.error('TOSS_OPENAPI_ACCESS_KEY / TOSS_OPENAPI_SECRET_KEY / TOSS_MERCHANT_ID 환경변수가 필요합니다.')
  process.exit(1)
}

const BASE = (process.env.TOSS_OPENAPI_BASE_URL || 'https://open-api.tossplace.com').replace(/\/$/, '')
const headers = { 'x-access-key': accessKey, 'x-secret-key': secretKey }
const orderKey = process.argv[2]

async function get(url) {
  const res = await fetch(url, { headers })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* 원문 그대로 */ }
  return { status: res.status, body: parsed, text }
}

;(async () => {
  if (orderKey) {
    // 단건 조회 — orderKey로 찾는다.
    const url = `${BASE}/api-public/openapi/v1/merchants/${encodeURIComponent(merchantId)}/order/orders/by-order-key/${encodeURIComponent(orderKey)}`
    console.log(`단건 조회: ${url}\n`)
    const r = await get(url)
    console.log(`HTTP ${r.status}`)
    console.log(r.body ? JSON.stringify(r.body, null, 2) : r.text.slice(0, 3000))
    return
  }

  // 목록 조회. 기본 orderStates가 ["COMPLETED","CANCELLED"]라서 그냥 조회하면 미결제(OPENED)
  // 주문이 안 나온다 — 우리가 만든 건 OPENED이므로 상태를 명시해서 넣어야 보인다.
  // (POS [현황] 탭에 안 보이는 것도 같은 종류의 "기본 필터" 문제일 수 있다.)
  const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const to = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const states = ['REQUESTED', 'OPENED', 'COMPLETED', 'CANCELLED']
  const qs = new URLSearchParams({ from, to, page: '1', size: '50', sortOrder: 'DESC' })
  for (const s of states) qs.append('orderStates', s)

  const url = `${BASE}/api-public/openapi/v1/merchants/${encodeURIComponent(merchantId)}/order/orders?${qs}`
  console.log(`목록 조회(최근 24시간, 전체 상태): ${url}\n`)
  const r = await get(url)
  console.log(`HTTP ${r.status}`)

  if (r.status !== 200 || !r.body) {
    console.log(r.body ? JSON.stringify(r.body, null, 2) : r.text.slice(0, 3000))
    return
  }

  // 응답 스키마가 문서에 없어 방어적으로 배열을 찾는다.
  const list =
    (Array.isArray(r.body?.success?.orders) && r.body.success.orders) ||
    (Array.isArray(r.body?.success?.content) && r.body.success.content) ||
    (Array.isArray(r.body?.success) && r.body.success) ||
    (Array.isArray(r.body?.orders) && r.body.orders) ||
    (Array.isArray(r.body?.content) && r.body.content) ||
    null

  if (!list) {
    console.log('(주문 배열 위치를 자동으로 못 찾아 원본을 그대로 출력합니다)')
    console.log(JSON.stringify(r.body, null, 2).slice(0, 4000))
    return
  }

  console.log(`주문 ${list.length}건\n`)
  for (const o of list) {
    const key = o.orderKey ?? o.key ?? '(orderKey 없음)'
    const state = o.state ?? o.status ?? '(상태 없음)'
    const amount = o.chargePrice?.totalAmount ?? o.totalAmount ?? '?'
    const created = o.createdAt ?? o.openedAt ?? ''
    console.log(`  [${state}] ${amount}원  ${key}  ${created}`)
  }
  console.log('\n우리가 만든 주문(orderKey가 posmos-verify-... 또는 erp-...)이 위 목록에 있고 상태가')
  console.log('OPENED라면, 주문 생성 자체는 정상이고 POS 화면 쪽 노출 조건 문제입니다.')
})().catch((e) => {
  console.error('요청 실패:', e.message)
  process.exitCode = 1
})
