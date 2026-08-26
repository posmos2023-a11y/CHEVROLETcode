#!/usr/bin/env node
// 토스플레이스 Open API "주문 생성"이 실제로 동작하는지 확인하는 일회성 점검 도구.
// (쉐보레 전산 연동 1단계 사전 검증 — docs/배포-패키징-가이드.md, MOU 연동 설계 참고)
//
// 하는 일: 테스트 가맹점에 카탈로그 등록 없는 AD_HOC 상품 1건짜리 미결제 주문(OPENED)을 생성한다.
// 성공하면 토스 POS [현황] 탭에 "연동 테스트 상품 1,000원" 주문이 떠야 하고, 매장에서 결제만
// 진행할 수 있는 상태가 된다 — 이것이 확인되면 전산 연동의 핵심 전제가 전부 검증된 것이다.
//
// 사용법 (키는 인자가 아니라 환경변수로 — 셸 히스토리/채팅에 남기지 않기 위함):
//   PowerShell:
//     $env:TOSS_OPENAPI_ACCESS_KEY='발급받은 Access Key'
//     $env:TOSS_OPENAPI_SECRET_KEY='발급받은 Secret Key'
//     $env:TOSS_MERCHANT_ID='테스트 가맹점의 merchantId'
//     node backend/scripts/verify-toss-order.js
//
// 응답 해석(스크립트가 자동으로 판정해준다):
//   201/200  성공 — POS [현황] 탭 확인
//   401/403  인증 실패 또는 아직 미승인 ("승인을 받은 앱에서만 사용할 수 있어요")
//   404      merchantId가 틀렸거나, 이 앱이 그 가맹점에 아직 연결(설치)되지 않음
//   400      ⚠️ 인증은 통과했다는 뜻! body 스키마만 조정하면 됨 — 응답의 에러 메시지를 그대로
//            보고 필드를 고치면 된다(공개 문서에 diningOption 등 일부 enum 값이 명시돼 있지 않아
//            첫 호출은 400이 나올 수 있음. 그 자체로 "승인 완료" 확인은 된 것이다).

const crypto = require('node:crypto')

const accessKey = process.env.TOSS_OPENAPI_ACCESS_KEY
const secretKey = process.env.TOSS_OPENAPI_SECRET_KEY
const merchantId = process.env.TOSS_MERCHANT_ID

if (!accessKey || !secretKey || !merchantId) {
  console.error('TOSS_OPENAPI_ACCESS_KEY / TOSS_OPENAPI_SECRET_KEY / TOSS_MERCHANT_ID 환경변수가 모두 필요합니다.')
  console.error('파일 상단의 사용법을 참고하세요.')
  process.exit(1)
}

const BASE = 'https://open-api.tossplace.com/api-public/openapi/v1'
const orderKey = `posmos-verify-${crypto.randomUUID()}`

// 구성 근거 — 토스 개발자센터 공식 답변(2026-08 승인 메일)으로 확정된 내용:
// - payments는 **필수 필드**라 생략하면 안 되고, 미결제 주문은 빈 배열("payments": [])로 보낸다.
//   (공개 문서만 보고 "생략하면 OPENED"로 오해하기 쉬운 지점 — 답변으로 정정됨)
// - requestedInfo를 전달하지 않으면 OPENED(미결제) 상태로 생성된다.
// - 카탈로그 미등록 상품은 targetType: "AD_HOC" + 상품 정보(item)를 함께 전달한다.
// - 생성된 OPENED 주문은 토스 POS [현황] 탭에 표시되고, 매장에서 선택해 결제할 수 있다.
// - diningOption은 필수인데 공개 문서에 enum 값이 없어 추정값을 넣는다. 400이 나오면 응답
//   메시지에 허용값이 나올 것이므로 TOSS_DINING_OPTION 환경변수로 바꿔 재시도하면 된다.
const body = {
  order: {
    orderKey,
    orderNumber: 'TEST-0001',
    memo: '포스모스 연동 검증용 테스트 주문 (결제하지 마세요)',
    lineItems: [
      {
        diningOption: process.env.TOSS_DINING_OPTION || 'FOR_HERE',
        targetType: 'AD_HOC',
        item: { title: '연동 테스트 상품' },
        itemPrice: {
          priceType: 'FIXED',
          priceUnit: 1,
          priceValue: 1000,
          isTaxFree: false,
          taxInclusive: true,
        },
        quantity: 1,
      },
    ],
    chargePrice: 1000,
  },
  // 미결제 주문이라도 payments 자체는 필수 — 빈 배열로 보낸다(토스 답변).
  payments: [],
}

;(async () => {
  const url = `${BASE}/merchants/${encodeURIComponent(merchantId)}/order/orders`
  console.log(`대상: POST ${url}`)
  console.log(`orderKey: ${orderKey}\n`)

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
    console.error(`❌ 요청 자체가 실패했습니다(네트워크/DNS): ${e.message}`)
    process.exit(1)
  }

  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* 텍스트 그대로 출력 */ }

  console.log(`HTTP ${res.status}`)
  console.log('응답 본문:')
  console.log(parsed ? JSON.stringify(parsed, null, 2) : text.slice(0, 2000))
  console.log()

  if (res.status === 200 || res.status === 201) {
    console.log('✅ 주문 생성 성공!')
    console.log('   → 토스 POS [현황] 탭에서 "연동 테스트 상품 1,000원" 미결제 주문을 확인하세요.')
    console.log('   → 이게 보이면 전산 연동의 핵심 전제(AD_HOC + 미결제 생성)가 전부 검증된 것입니다.')
    console.log('   → 테스트 주문은 POS에서 취소 처리하면 됩니다.')
  } else if (res.status === 401 || res.status === 403) {
    console.log('❌ 인증 실패 또는 미승인.')
    console.log('   → 키 오타 확인. 키가 맞다면 아직 주문 생성 API 승인 전입니다(토스 답장 대기).')
  } else if (res.status === 404) {
    console.log('❌ 가맹점을 찾을 수 없습니다.')
    console.log('   → TOSS_MERCHANT_ID 값 확인, 그리고 개발자센터 [테스트 가맹점 관리]에서')
    console.log('     이 앱(posmos-chevrolet-order)이 해당 가맹점에 연결(설치)돼 있는지 확인하세요.')
  } else if (res.status === 400) {
    console.log('⚠️ 400 = 인증은 통과! body 스키마만 조정하면 됩니다.')
    console.log('   → 위 응답 메시지가 가리키는 필드를 고치세요. diningOption 허용값 문제라면')
    console.log('     TOSS_DINING_OPTION 환경변수로 다른 값을 넣어 재시도하세요 (예: TAKE_OUT, DELIVERY 등')
    console.log('     — 정확한 허용값은 응답 메시지에 나옵니다).')
  } else {
    console.log(`❓ 예상 밖 응답(${res.status}). 위 본문을 확인하세요.`)
  }
  process.exit(res.ok ? 0 : 1)
})()
