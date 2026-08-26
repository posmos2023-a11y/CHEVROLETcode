// 쉐보레 전산(ERP) -> 토스 POS 주문 생성 Open API 클라이언트 (ERP_CONTRACT_V1 §3).
// 참고 구현: backend/scripts/verify-toss-order.js (실제 토스 서버로 호출해가며 400을 하나씩
// 잡아 확정한 "정답지" -- 아래 body 구성은 그 파일을 그대로 따른다).
//
// ⚠️ 공개 문서만 보고 만든 최초 초안은 여러 군데 틀렸었다. 아래는 실호출로 확정된 내용이다:
//   - payments는 필수 필드다. 미결제 주문이라도 "payments": []를 반드시 보내야 한다
//     (생략하면 400 -- 공개 문서는 "생략하면 OPENED"처럼 읽히지만 틀렸다).
//   - requestedInfo를 전달하지 않으면 주문이 OPENED(미결제) 상태로 생성된다.
//   - 카탈로그 미등록 상품은 targetType: "AD_HOC" + item(상품 정보)을 함께 전달한다.
//   - diningOption은 "FOR_HERE"가 아니라 "HERE"다(FOR_HERE는 4000 에러).
//   - item.category가 필수다. enum이 아니라 { title, code? } 객체 -- 카탈로그 미등록(AD_HOC)이라
//     토스에 미리 만들어 둔 카테고리가 없어도 된다.
//   - itemPrice.title이 필수다(가격 항목 이름). 단일 가격이면 '기본'을 쓴다.
//   - chargePrice는 숫자가 아니라 객체다("order.chargePrice는 형식이 올바르지 않습니다" 4000 에러로 확인).

const REQUEST_TIMEOUT_MS = 10000
const DEFAULT_CATEGORY_TITLE = '정비'
const DEFAULT_ITEM_PRICE_TITLE = '기본'

// 응답 스키마가 아직 미확정이라(202608 기준 토스가 문서화하지 않음) 여러 후보 경로에서
// 방어적으로 주문 id를 추출한다. 어디서도 못 찾아도 실패로 취급하지 않는다 -- raw를 통째로
// 저장해두면 나중에 실제 응답을 보고 파싱 경로를 고칠 수 있다.
function extractTossOrderId(raw) {
  if (!raw || typeof raw !== 'object') return null
  return raw.order?.id ?? raw.id ?? raw.orderId ?? null
}

// chargePrice는 숫자가 아니라 부가세 포함가 기준의 세부 내역 객체를 요구한다(verify-toss-order.js
// 실호출로 확인). 전산은 부가세 포함 총액(totalAmount) 하나만 넘겨주므로, 나머지 필드는 여기서
// 역산해서 채운다.
//   - taxAmount(세액) = round(총액 / 11) : 부가세 10% 포함가에서 세액을 역산하는 표준 공식
//     (공급가 + 공급가*0.1 = 총액 => 세액 = 총액/11, 소수점은 반올림)
//   - supplyAmount(공급가) = 총액 - 세액
//   - 할인/팁/봉사료/면세액은 이 연동에서 다루지 않는 개념이라 전부 0으로 고정한다.
//   - listPrice(정가)도 할인이 없으므로 totalAmount와 동일하게 둔다.
function buildChargePrice(totalAmount) {
  const taxAmount = Math.round(totalAmount / 11)
  const supplyAmount = totalAmount - taxAmount
  return {
    listPrice: totalAmount,
    discountAmount: 0,
    tipAmount: 0,
    serviceChargeAmount: 0,
    taxAmount,
    supplyAmount,
    taxExemptAmount: 0,
    totalAmount,
  }
}

// createTossDraftOrder({ merchantId, orderKey, orderNumber, memo, items, totalAmount })
//   items: [{ name, unitPrice, quantity, category? }]  -- category 없으면 '정비'를 기본값으로 쓴다.
//   반환(성공): { ok: true, status, tossOrderId, raw }
//   반환(실패): { ok: false, status, error, raw }   // throw하지 않는다 -- 호출부(server.js)가 분기한다.
//
// 절대 x-access-key/x-secret-key를 로그에 남기지 않는다.
async function createTossDraftOrder({ merchantId, orderKey, orderNumber, memo, items, totalAmount }) {
  const accessKey = process.env.TOSS_OPENAPI_ACCESS_KEY
  const secretKey = process.env.TOSS_OPENAPI_SECRET_KEY
  if (!accessKey || !secretKey) {
    return { ok: false, status: 0, error: '토스 Open API 키가 설정되지 않았습니다.' }
  }

  // 기본값은 실제 운영 Open API지만, TESTS 에이전트가 로컬 목 서버를 이 값으로 가리켜야 하므로
  // 반드시 환경변수로 오버라이드 가능해야 한다(하드코딩 금지 -- ERP_CONTRACT_V1 §3 필수 요구사항).
  const baseUrl = process.env.TOSS_OPENAPI_BASE_URL || 'https://open-api.tossplace.com'
  // 공식 문서 예시 값은 'HERE'다 -- 'FOR_HERE'는 4000 에러로 확인됨(verify-toss-order.js).
  const diningOption = process.env.TOSS_DINING_OPTION || 'HERE'

  const body = {
    order: {
      orderKey,
      orderNumber,
      memo: memo || undefined,
      lineItems: items.map((item) => ({
        diningOption,
        targetType: 'AD_HOC',
        item: {
          title: item.name,
          // 카탈로그 미등록(AD_HOC) 상품이라 토스에 미리 만들어 둔 카테고리가 없어도 되며,
          // enum이 아니라 자유 텍스트 객체라 전산이 카테고리를 안 보내면 '정비'를 기본값으로 쓴다.
          category: { title: item.category || DEFAULT_CATEGORY_TITLE },
        },
        itemPrice: {
          // 사이즈/옵션별 가격이 있는 업종을 위한 필드다. 정비 매장처럼 단일 가격이면 '기본'.
          title: DEFAULT_ITEM_PRICE_TITLE,
          priceType: 'FIXED',
          priceUnit: 1,
          priceValue: item.unitPrice,
          isTaxFree: false,
          taxInclusive: true,
        },
        quantity: item.quantity,
      })),
      chargePrice: buildChargePrice(totalAmount),
    },
    // 미결제 주문이라도 payments 자체는 필수 -- 빈 배열로 보낸다(§0, 토스 공식 확인 사항).
    payments: [],
  }

  const url = `${baseUrl}/api-public/openapi/v1/merchants/${encodeURIComponent(merchantId)}/order/orders`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

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
      signal: controller.signal,
    })
  } catch (e) {
    // AbortError(타임아웃)든 네트워크 에러든, 클라이언트에는 원인을 노출하지 않고 호출부가
    // 502로 변환한다. 에러 상세는 여기서도 로그에 남기지 않는다(호출부 store.js가 errorMessage로
    // 감사 기록용으로만 남긴다 -- 키는 이 함수 안에서도 절대 로그로 내보내지 않는다).
    return { ok: false, status: 0, error: e.name === 'AbortError' ? '토스 API 호출이 시간 초과되었습니다.' : '토스 API 호출에 실패했습니다.' }
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text()
  let raw = null
  try { raw = JSON.parse(text) } catch { raw = { rawText: text.slice(0, 2000) } }

  if (!res.ok) {
    return { ok: false, status: res.status, error: raw?.message || raw?.error || `토스 API가 ${res.status}를 반환했습니다.`, raw }
  }

  return { ok: true, status: res.status, tossOrderId: extractTossOrderId(raw), raw }
}

module.exports = { createTossDraftOrder }
