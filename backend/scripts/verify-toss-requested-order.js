#!/usr/bin/env node
// 가설 검증: `requestedInfo`를 넣어 REQUESTED(요청됨) 상태로 만들면 POS [현황] 탭에 뜨는가?
//
// 배경: verify-toss-order.js로 만든 OPENED(시작됨) 주문 6건이 토스 서버에는 정상 저장되는데
// POS [현황] 탭에는 전혀 뜨지 않았다. diningOption 허용값 4개(HERE/TOGO/DELIVERY/PICKUP)를
// 전부 시도해도 동일했으므로 그건 원인이 아니다.
//
// [현황] 탭에 "진행 / 완료 / 취소" 세 구획이 있는 점에 주목하면, 매장이 수락/거절해야 하는
// REQUESTED 주문이 "진행"에 뜰 가능성이 있다. 공식 문서도 requestedInfo가 있으면
// "매장이 주문을 수락하면 자동으로 주문서가 출력된다"고 설명하는데, 이는 REQUESTED 주문이
// POS 화면에서 실제로 다뤄지는 대상임을 시사한다.
//
// 문서(OrderRequestedInfo.Create) 기준 하위 필드:
//   requestedAt, expiredAt, expectedReadyAt, estimatedReadyAt, allowedEstimatedReadyDurations
// 전체 필수 여부가 명시돼 있지 않아, 우선 시각 필드들만 채워 보내고 400이 나면 메시지를 보고 조정한다.
//
// 사용법 (PowerShell):
//   $env:TOSS_OPENAPI_ACCESS_KEY='...'; $env:TOSS_OPENAPI_SECRET_KEY='...'; $env:TOSS_MERCHANT_ID='129169'
//   node backend/scripts/verify-toss-requested-order.js

const crypto = require('node:crypto')

const accessKey = process.env.TOSS_OPENAPI_ACCESS_KEY
const secretKey = process.env.TOSS_OPENAPI_SECRET_KEY
const merchantId = process.env.TOSS_MERCHANT_ID

if (!accessKey || !secretKey || !merchantId) {
  console.error('TOSS_OPENAPI_ACCESS_KEY / TOSS_OPENAPI_SECRET_KEY / TOSS_MERCHANT_ID 환경변수가 필요합니다.')
  process.exit(1)
}

const BASE = (process.env.TOSS_OPENAPI_BASE_URL || 'https://open-api.tossplace.com').replace(/\/$/, '')
const url = `${BASE}/api-public/openapi/v1/merchants/${encodeURIComponent(merchantId)}/order/orders`

const now = new Date()
const iso = (d) => d.toISOString()
const plusMin = (m) => new Date(now.getTime() + m * 60 * 1000)

const total = 1000
const tax = Math.round(total / 11)
const orderKey = `posmos-requested-${crypto.randomUUID()}`

const body = {
  order: {
    orderKey,
    orderNumber: 'REQ-0001',
    memo: 'REQUESTED 상태 검증용 (결제하지 마세요)',
    lineItems: [{
      diningOption: process.env.TOSS_DINING_OPTION || 'HERE',
      targetType: 'AD_HOC',
      item: { title: 'REQUESTED 테스트 상품', category: { title: '정비' } },
      itemPrice: {
        title: '기본', priceType: 'FIXED', priceUnit: 1,
        priceValue: total, isTaxFree: false, taxInclusive: true,
      },
      quantity: 1,
    }],
    chargePrice: {
      listPrice: total, discountAmount: 0, tipAmount: 0, serviceChargeAmount: 0,
      taxAmount: tax, supplyAmount: total - tax, taxExemptAmount: 0, totalAmount: total,
    },
    // 이 블록이 있으면 OPENED가 아니라 REQUESTED(요청됨)로 생성된다 — 매장이 수락/거절해야 하는 주문.
    requestedInfo: {
      requestedAt: iso(now),
      expiredAt: iso(plusMin(60)),        // 1시간 뒤 만료
      expectedReadyAt: iso(plusMin(30)),  // 손님 기준 예상 완료
      estimatedReadyAt: iso(plusMin(30)), // 매장 기준 예상 완료
    },
  },
  payments: [],
}

;(async () => {
  console.log(`대상: POST ${url}`)
  console.log(`orderKey: ${orderKey}`)
  console.log('요청 본문(requestedInfo 포함):')
  console.log(JSON.stringify(body, null, 2))
  console.log()

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-access-key': accessKey,
        'x-secret-key': secretKey,
      },
      body: JSON.stringify(body),
    })
  } catch (e) {
    console.error(`❌ 요청 실패(네트워크): ${e.message}`)
    process.exitCode = 1
    return
  }

  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* 텍스트 그대로 */ }

  console.log(`HTTP ${res.status}`)
  console.log(parsed ? JSON.stringify(parsed, null, 2) : text.slice(0, 2000))
  console.log()

  const state = parsed?.success?.orderState
  if (res.status === 200 || res.status === 201) {
    console.log(`✅ 주문 생성 성공 — orderState: ${state || '(응답에 없음)'}`)
    if (state === 'REQUESTED') {
      console.log('   → 의도대로 REQUESTED(요청됨)로 생성됐습니다.')
    } else {
      console.log(`   → ⚠️ REQUESTED가 아니라 ${state}로 생성됐습니다. requestedInfo가 무시된 것일 수 있습니다.`)
    }
    console.log('\n   지금 바로 POS [현황] 탭을 새로고침해서 "REQ-0001" 주문이 뜨는지 확인하세요.')
    console.log('   → 뜬다면: OPENED는 화면에 안 나오고 REQUESTED만 나온다는 뜻입니다(중요한 발견).')
    console.log('   → 안 뜬다면: 상태와 무관한 문제이므로 토스 문의로 넘어갑니다.')
  } else {
    console.log('❌ 생성 실패.')
    console.log('   → requestedInfo의 필수 하위 필드가 더 있거나 형식이 다를 수 있습니다.')
    console.log('   → 위 reason 메시지를 그대로 알려주시면 필드를 맞추겠습니다.')
  }
  process.exitCode = res.ok ? 0 : 1
})()
