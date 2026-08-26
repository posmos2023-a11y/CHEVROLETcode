#!/usr/bin/env node
// diningOption의 허용 enum을 실호출로 알아낸다.
//
// 배경: 토스 공개 문서에 OrderDiningOption의 전체 enum 목록이 없다. 요청 예시에 'HERE'만
// 나와 있어 그 값으로 주문 생성은 성공했지만, 생성된 OPENED 주문이 POS [현황] 탭에 뜨지 않아
// "정비 매장인데 '매장 식사(HERE)'로 넣은 게 화면 노출 조건과 안 맞는 것 아닌가"를 확인해야 한다.
//
// 후보 값을 하나씩 보내보고 4000(유효하지 않은 값) 여부로 허용/불허를 가른다.
// ⚠️ 허용되는 값은 실제로 주문이 만들어진다 — 테스트 주문이 여러 건 생기므로 확인 후 POS에서
// 정리하거나, DRY_RUN=1로 먼저 목록만 뽑아볼 것.
//
// 사용법 (PowerShell):
//   $env:TOSS_OPENAPI_ACCESS_KEY='...'; $env:TOSS_OPENAPI_SECRET_KEY='...'; $env:TOSS_MERCHANT_ID='129169'
//   node backend/scripts/probe-dining-option.js

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

// 외식업 POS에서 흔히 쓰는 명명 규칙들을 폭넓게 넣어본다.
const CANDIDATES = [
  'HERE', 'TO_GO', 'TOGO', 'TAKE_OUT', 'TAKEOUT', 'TAKE_AWAY', 'TAKEAWAY',
  'DELIVERY', 'PACKAGING', 'PACKAGE', 'PICKUP', 'PICK_UP',
  'EAT_IN', 'DINE_IN', 'IN_STORE', 'STORE', 'NONE', 'ETC', 'DEFAULT', 'UNKNOWN',
]

function buildBody(diningOption) {
  const total = 1000
  const tax = Math.round(total / 11)
  return {
    order: {
      orderKey: `probe-${diningOption.toLowerCase()}-${crypto.randomUUID()}`,
      orderNumber: `PROBE-${diningOption}`,
      memo: `diningOption 탐색용 (${diningOption}) — 결제하지 마세요`,
      lineItems: [{
        diningOption,
        targetType: 'AD_HOC',
        item: { title: `탐색 ${diningOption}`, category: { title: '정비' } },
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
}

;(async () => {
  const dryRun = process.env.DRY_RUN === '1'
  if (dryRun) {
    console.log('DRY_RUN=1 — 실제 호출 없이 후보만 출력합니다.')
    console.log(CANDIDATES.join(', '))
    return
  }

  console.log(`후보 ${CANDIDATES.length}개를 실제로 호출해 허용 여부를 확인합니다.`)
  console.log('⚠️ 허용되는 값은 실제 주문이 생성됩니다(각 1,000원). 확인 후 POS에서 정리하세요.\n')

  const allowed = []
  const rejected = []

  for (const option of CANDIDATES) {
    let res, body
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-access-key': accessKey,
          'x-secret-key': secretKey,
        },
        body: JSON.stringify(buildBody(option)),
      })
      body = await res.json().catch(() => null)
    } catch (e) {
      console.log(`  ?  ${option.padEnd(12)} 요청 실패: ${e.message}`)
      continue
    }

    const reason = body?.error?.reason || ''
    const isDiningOptionError = reason.includes('diningOption')

    if (res.status === 200 || res.status === 201) {
      allowed.push(option)
      console.log(`  ✅ ${option.padEnd(12)} 허용 — 주문 생성됨`)
    } else if (isDiningOptionError) {
      rejected.push(option)
      console.log(`  ❌ ${option.padEnd(12)} 유효하지 않은 값`)
    } else {
      // diningOption 외의 다른 이유로 실패 — 값 자체는 통과했을 가능성이 있다.
      console.log(`  ⚠️ ${option.padEnd(12)} 다른 사유로 400: ${reason || res.status}`)
    }
  }

  console.log('\n──────── 결과 ────────')
  console.log(`허용되는 값 (${allowed.length}개): ${allowed.join(', ') || '없음'}`)
  console.log(`거부된 값 (${rejected.length}개): ${rejected.join(', ') || '없음'}`)
  if (allowed.length > 1) {
    console.log('\n허용값이 여러 개면, POS [현황] 탭을 열어 어떤 값으로 만든 주문이 화면에 뜨는지')
    console.log('확인하세요. 주문번호가 PROBE-<값> 이라 어느 것인지 바로 구분됩니다.')
  }
})().catch((e) => {
  console.error('실패:', e.message)
  process.exitCode = 1
})
