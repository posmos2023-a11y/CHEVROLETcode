#!/usr/bin/env node
// 가설 검증: "POS에 메뉴(상품)가 등록돼 있어야 주문이 [현황] 탭에 뜨는 것 아닌가?"
//
// 배경: AD_HOC(카탈로그 미등록) 임시 상품으로 만든 OPENED 주문이 토스 서버에는 정상 저장되는데
// POS [현황] 탭에 전혀 뜨지 않는다. diningOption 4개 값은 이미 원인에서 배제했다.
// 그래서 "카탈로그에 실제로 등록된 상품(targetType: ITEM + targetId)으로 만든 주문은 뜨는가"를
// 확인해 AD_HOC 여부가 원인인지 가른다.
//
// 동작:
//   1) 매장 카탈로그 상품 목록을 조회한다.
//   2) 등록 상품이 없으면 → 비교 자체가 불가능하므로 그 사실만 알리고 종료
//      (그 경우 "메뉴를 먼저 등록해야 한다"는 가설을 POS에서 직접 상품 하나 만들고 재실행해 확인).
//   3) 있으면 첫 상품으로 targetType: 'ITEM' 주문을 만들어 본다.
//      → 이게 POS에 뜨면: 원인은 AD_HOC. 전산 연동 설계를 바꿔야 한다(중대).
//      → 이것도 안 뜨면: AD_HOC과 무관한 문제. 토스 문의로 확정.
//
// 사용법 (PowerShell):
//   $env:TOSS_OPENAPI_ACCESS_KEY='...'; $env:TOSS_OPENAPI_SECRET_KEY='...'; $env:TOSS_MERCHANT_ID='129169'
//   node backend/scripts/verify-toss-catalog-order.js

const crypto = require('node:crypto')

const accessKey = process.env.TOSS_OPENAPI_ACCESS_KEY
const secretKey = process.env.TOSS_OPENAPI_SECRET_KEY
const merchantId = process.env.TOSS_MERCHANT_ID

if (!accessKey || !secretKey || !merchantId) {
  console.error('TOSS_OPENAPI_ACCESS_KEY / TOSS_OPENAPI_SECRET_KEY / TOSS_MERCHANT_ID 환경변수가 필요합니다.')
  process.exit(1)
}

const BASE = (process.env.TOSS_OPENAPI_BASE_URL || 'https://open-api.tossplace.com').replace(/\/$/, '')
const M = encodeURIComponent(merchantId)
const headers = {
  'content-type': 'application/json',
  'x-access-key': accessKey,
  'x-secret-key': secretKey,
}

// 응답 스키마가 문서에 상세히 없어 배열 위치를 방어적으로 찾는다.
function pickArray(body) {
  return (
    (Array.isArray(body?.success?.items) && body.success.items) ||
    (Array.isArray(body?.success?.content) && body.success.content) ||
    (Array.isArray(body?.success) && body.success) ||
    (Array.isArray(body?.items) && body.items) ||
    (Array.isArray(body?.content) && body.content) ||
    null
  )
}

;(async () => {
  // ── 1) 카탈로그 상품 목록 조회 ─────────────────────────────
  const catalogUrl = `${BASE}/api-public/openapi/v1/merchants/${M}/catalog/items?page=1&size=100`
  console.log(`카탈로그 조회: ${catalogUrl}\n`)

  const catRes = await fetch(catalogUrl, { headers })
  const catText = await catRes.text()
  let catBody = null
  try { catBody = JSON.parse(catText) } catch { /* 원문 */ }

  console.log(`HTTP ${catRes.status}`)
  if (catRes.status !== 200) {
    console.log(catBody ? JSON.stringify(catBody, null, 2) : catText.slice(0, 2000))
    console.log('\n❌ 카탈로그 조회 실패. 이 앱에 카탈로그 조회 권한이 없을 수 있습니다.')
    process.exitCode = 1
    return
  }

  const items = pickArray(catBody)
  if (!items) {
    console.log('(상품 배열 위치를 자동으로 못 찾아 원본을 출력합니다)')
    console.log(JSON.stringify(catBody, null, 2).slice(0, 3000))
    return
  }

  console.log(`등록된 상품 ${items.length}개\n`)
  for (const it of items.slice(0, 20)) {
    console.log(`  id=${it.id}  ${it.title ?? it.name ?? '(이름 없음)'}`)
  }

  if (items.length === 0) {
    console.log('\n📌 이 매장에는 등록된 상품이 하나도 없습니다.')
    console.log('   → "메뉴가 있어야 뜨는 것 아닌가" 가설을 확인하려면, POS에서 상품을 하나 만든 뒤')
    console.log('     이 스크립트를 다시 실행하세요. 그러면 그 상품으로 주문을 만들어 비교합니다.')
    console.log('   → 참고: 카탈로그가 비어 있다는 사실 자체도 단서입니다. POS가 주문을 화면에')
    console.log('     그리려면 상품/카테고리 구성이 필요할 수 있습니다.')
    return
  }

  // ── 2) 등록 상품으로 ITEM 주문 생성 ─────────────────────────
  const target = items[0]
  const total = 1000
  const tax = Math.round(total / 11)
  const orderKey = `posmos-catalog-${crypto.randomUUID()}`

  const body = {
    order: {
      orderKey,
      orderNumber: 'CATALOG-0001',
      memo: '카탈로그 등록 상품 주문 검증용 (결제하지 마세요)',
      lineItems: [{
        diningOption: process.env.TOSS_DINING_OPTION || 'HERE',
        // AD_HOC이 아니라 카탈로그에 실제 등록된 상품을 가리킨다.
        targetType: 'ITEM',
        targetId: String(target.id),
        item: {
          title: target.title ?? target.name ?? '등록 상품',
          category: { title: target.category?.title ?? '정비' },
        },
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
    },
    payments: [],
  }

  const orderUrl = `${BASE}/api-public/openapi/v1/merchants/${M}/order/orders`
  console.log(`\n등록 상품(id=${target.id})으로 주문 생성: POST ${orderUrl}`)
  console.log(`orderKey: ${orderKey}\n`)

  const res = await fetch(orderUrl, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* 원문 */ }

  console.log(`HTTP ${res.status}`)
  console.log(parsed ? JSON.stringify(parsed, null, 2) : text.slice(0, 2000))
  console.log()

  if (res.ok) {
    console.log(`✅ 생성 성공 — orderState: ${parsed?.success?.orderState ?? '(응답에 없음)'}`)
    console.log('\n   지금 POS [현황] 탭을 새로고침해서 "CATALOG-0001" 주문이 뜨는지 확인하세요.')
    console.log('   → 뜬다면: 원인은 AD_HOC(카탈로그 미등록 상품)입니다. 전산 연동 설계를 다시 봐야 합니다.')
    console.log('   → 안 뜬다면: 상품 등록 여부와 무관한 문제입니다. 토스 문의로 확정하면 됩니다.')
  } else {
    console.log('❌ 생성 실패 — 위 reason을 알려주시면 필드를 맞추겠습니다.')
  }
  process.exitCode = res.ok ? 0 : 1
})().catch((e) => {
  console.error('실패:', e.message)
  process.exitCode = 1
})
