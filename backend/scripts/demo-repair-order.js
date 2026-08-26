#!/usr/bin/env node
// 정비소 실제 상황처럼 생긴 데모 주문을 토스 POS에 넣는다.
//
// 용도: MOU 시연·내부 확인용. 쉐보레 전산에서 "물건 담기"를 눌렀을 때 POS에 어떻게 보이는지를
// 실제와 가깝게 재현한다(부품 + 공임이 섞인 여러 품목, 차량번호가 담긴 메모 등).
// 실제 연동에서는 이 body를 우리 서버(POST /api/erp/draft-orders)가 대신 만들어 보낸다 —
// 이 스크립트는 토스 API를 직접 때려 화면만 확인하는 도구다.
//
// 사용법 (PowerShell):
//   $env:TOSS_OPENAPI_ACCESS_KEY='...'; $env:TOSS_OPENAPI_SECRET_KEY='...'; $env:TOSS_MERCHANT_ID='129169'
//   node backend/scripts/demo-repair-order.js            # 기본 시나리오(엔진오일 교환)
//   node backend/scripts/demo-repair-order.js 2          # 2번 시나리오
//   node backend/scripts/demo-repair-order.js --list     # 시나리오 목록만 보기

const crypto = require('node:crypto')

const accessKey = process.env.TOSS_OPENAPI_ACCESS_KEY
const secretKey = process.env.TOSS_OPENAPI_SECRET_KEY
const merchantId = process.env.TOSS_MERCHANT_ID

// 정비소에서 실제로 나올 법한 주문 구성. 부품과 공임을 분리해서 담는 게 정비업 관행이라
// 카테고리를 '부품'/'공임'/'소모품'으로 나눠 POS 주문서에서도 구분되게 했다.
const SCENARIOS = [
  {
    name: '엔진오일 교환 + 필터',
    carNumber: '12가3456',
    customer: '김민준',
    items: [
      { name: '엔진오일 5W30 (4L)', category: '부품', unitPrice: 45000, quantity: 1 },
      { name: '오일필터', category: '부품', unitPrice: 12000, quantity: 1 },
      { name: '드레인 와셔', category: '소모품', unitPrice: 1000, quantity: 1 },
      { name: '엔진오일 교환 공임', category: '공임', unitPrice: 15000, quantity: 1 },
    ],
  },
  {
    name: '타이어 2본 교체 + 위치교환',
    carNumber: '34나5678',
    customer: '이서연',
    items: [
      { name: '금호 크루젠 225/60R17', category: '부품', unitPrice: 138000, quantity: 2 },
      { name: '타이어 장착 공임', category: '공임', unitPrice: 15000, quantity: 2 },
      { name: '휠 밸런스', category: '공임', unitPrice: 10000, quantity: 2 },
      { name: '타이어 위치교환', category: '공임', unitPrice: 20000, quantity: 1 },
    ],
  },
  {
    name: '정기점검 + 배터리 교체',
    carNumber: '56다7890',
    customer: '박도윤',
    items: [
      { name: 'AGM 배터리 70Ah', category: '부품', unitPrice: 210000, quantity: 1 },
      { name: '에어컨 필터', category: '소모품', unitPrice: 18000, quantity: 1 },
      { name: '와이퍼 블레이드 (운전석)', category: '소모품', unitPrice: 12000, quantity: 1 },
      { name: '정기점검 공임', category: '공임', unitPrice: 30000, quantity: 1 },
      { name: '배터리 교체 공임', category: '공임', unitPrice: 10000, quantity: 1 },
    ],
  },
  {
    name: '브레이크 패드 교체 (앞)',
    carNumber: '78라1234',
    customer: '최지우',
    items: [
      { name: '브레이크 패드 (프론트)', category: '부품', unitPrice: 88000, quantity: 1 },
      { name: '브레이크 오일 DOT4', category: '소모품', unitPrice: 15000, quantity: 1 },
      { name: '브레이크 패드 교체 공임', category: '공임', unitPrice: 40000, quantity: 1 },
    ],
  },
]

if (process.argv.includes('--list')) {
  console.log('사용 가능한 시나리오:\n')
  SCENARIOS.forEach((s, i) => {
    const total = s.items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0)
    console.log(`  ${i + 1}. ${s.name}  (${s.carNumber} ${s.customer}님, ${s.items.length}개 품목, ${total.toLocaleString('ko-KR')}원)`)
  })
  console.log('\n실행: node backend/scripts/demo-repair-order.js <번호>')
  process.exit(0)
}

if (!accessKey || !secretKey || !merchantId) {
  console.error('TOSS_OPENAPI_ACCESS_KEY / TOSS_OPENAPI_SECRET_KEY / TOSS_MERCHANT_ID 환경변수가 필요합니다.')
  process.exit(1)
}

const pickedIndex = Number(process.argv[2])
const scenario = SCENARIOS[(Number.isInteger(pickedIndex) ? pickedIndex : 1) - 1] || SCENARIOS[0]

const totalAmount = scenario.items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0)
// 부가세 포함가 기준 역산 (tossOrderClient.js의 buildChargePrice와 동일 규칙).
const taxAmount = Math.round(totalAmount / 11)

// 전산 주문번호처럼 보이게: ERP-YYYYMMDD-일련번호
const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
const serial = String(Math.floor(Math.random() * 900) + 100)
const referenceId = `ERP-${today}-${serial}`

const body = {
  order: {
    orderKey: `demo-${referenceId}-${crypto.randomUUID().slice(0, 8)}`,
    orderNumber: referenceId,
    // 정비소에서는 차량번호가 주문을 식별하는 핵심 정보라 메모 맨 앞에 둔다.
    memo: `${scenario.carNumber} ${scenario.customer}님 · ${scenario.name}`,
    lineItems: scenario.items.map((it) => ({
      diningOption: process.env.TOSS_DINING_OPTION || 'HERE',
      targetType: 'AD_HOC',
      item: {
        title: it.name,
        category: { title: it.category },
      },
      itemPrice: {
        title: '기본',
        priceType: 'FIXED',
        priceUnit: 1,
        priceValue: it.unitPrice,
        isTaxFree: false,
        taxInclusive: true,
      },
      quantity: it.quantity,
    })),
    chargePrice: {
      listPrice: totalAmount,
      discountAmount: 0,
      tipAmount: 0,
      serviceChargeAmount: 0,
      taxAmount,
      supplyAmount: totalAmount - taxAmount,
      taxExemptAmount: 0,
      totalAmount,
    },
  },
  payments: [],
}

;(async () => {
  const BASE = (process.env.TOSS_OPENAPI_BASE_URL || 'https://open-api.tossplace.com').replace(/\/$/, '')
  const url = `${BASE}/api-public/openapi/v1/merchants/${encodeURIComponent(merchantId)}/order/orders`

  console.log(`시나리오: ${scenario.name}`)
  console.log(`차량/고객: ${scenario.carNumber} ${scenario.customer}님`)
  console.log(`주문번호: ${referenceId}\n`)
  for (const it of scenario.items) {
    const line = (it.unitPrice * it.quantity).toLocaleString('ko-KR')
    console.log(`  [${it.category}] ${it.name}  ×${it.quantity}  ${line}원`)
  }
  console.log(`  ${'─'.repeat(50)}`)
  console.log(`  합계 ${totalAmount.toLocaleString('ko-KR')}원 (공급가 ${(totalAmount - taxAmount).toLocaleString('ko-KR')} + 부가세 ${taxAmount.toLocaleString('ko-KR')})\n`)

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-access-key': accessKey,
      'x-secret-key': secretKey,
    },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* 원문 */ }

  console.log(`HTTP ${res.status}`)
  if (res.ok) {
    console.log(`✅ 주문 생성 완료 — orderState: ${parsed?.success?.orderState ?? '(응답에 없음)'}`)
    console.log(`   POS [현황] > 진행 탭에서 "${referenceId}" 주문을 확인하세요.`)
  } else {
    console.log(parsed ? JSON.stringify(parsed, null, 2) : text.slice(0, 2000))
    console.log('❌ 생성 실패 — 위 reason을 확인하세요.')
  }
  process.exitCode = res.ok ? 0 : 1
})().catch((e) => {
  console.error('요청 실패:', e.message)
  process.exitCode = 1
})
