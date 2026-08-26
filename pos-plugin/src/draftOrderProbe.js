// ⚠️ 임시 검증 도구 — 확인이 끝나면 이 파일과 app.js의 import 한 줄, index.html의 패널 마크업을
// 함께 지운다. 운영 기능이 아니다.
//
// 목적: posPluginSdk.draftOrder(POS 장바구니)로 쉐보레 전산 품목을 담고 결제까지 띄울 수 있는지
//       실단말기에서 확인.
//
// ── SDK가 실제로 요구하는 스펙 (추정 아님) ───────────────────────────────────────
// SDK 런타임(dist/index.esm.js)의 addLineItem은 전송 전에 zod 스키마로 검증한다:
//     addLineItem(e) { PluginDraftOrderItemDtoSchema.parse(e); webview.send({... lineItem: e}) }
// 그 PluginDraftOrderItemDtoSchema 원문은 다음과 같다:
//   {
//     key?: string,
//     item: { id: number, title: string, category: {id, title, titleI18n?}, type: OrderItemType },
//     itemPrice: { isTaxFree, priceType, priceUnit, priceValue, sku?, title },
//     discount: [{ amountMoney: {value}, title, titleI18n? }],
//     memo?: string,
//     optionChoices: [{ id, title, titleI18n?, priceValue, imageUrl?, state, quantity }],
//     quantity: number,
//     diningOption: 'HERE' | 'TOGO' | 'DELIVERY' | 'PICKUP',
//     metadata?: { memoFixed?, optionFixed?, quantityFixed? }
//   }
//   OrderItemType = 'ITEM' | 'DELIVERY_FEE' | 'PREPAID_CARD' | 'MULTI_USE_TICKET' | 'COMBO' | 'GIFT_CARD'
//   (AD_HOC 없음 — Open API의 targetType과는 다른 체계다)
//
// ⚠️ zod 스키마도 타입 선언도 전부가 아니다 — 실호출과 ③ 덤프로 확정된 것:
//
// (1) SDK는 parse() 결과를 버리고 **원본 객체를 그대로** 포스 본체로 보낸다(위 코드 참고).
//     그래서 스키마에 없는 키도 포스까지 전달되고, 반대로 포스 본체는 스키마에 없는 필드를 읽는다.
//
// (2) item.options를 빼고 보냈더니 포스가 "Cannot read properties of undefined (reading 'map')"을
//     errorMessage로 돌려줬다 — 포스는 item.options를 배열로 가정하고 .map() 한다.
//
// (3) 결정적: [주문] 탭에서 **포스가 스스로 담은** 항목을 ③으로 덤프해 보니, item은
//     Pick으로 깎인 5개짜리가 아니라 **카탈로그 원본 객체 통째**였다:
//       item: id, title, code, description, state, type, options,
//             merchantId, category(원본 통째), defaultPriceId, prices[], priceVariations,
//             optionSets, color, imageUrl, labels, durationSeconds, provenance,
//             provenanceInfo, metadata{ diningOptions, minQuantity, maxQuantity, kioskDetails,
//                                       titleI18n, descriptionI18n, categoryId, schedule, ... }
//       category: id, title, code, merchantId, order, default, position, enabled,
//                 kioskEnabled, kioskOrder, titleI18n, stampDisabled, metadata, createdAt, updatedAt
//       itemPrice: id, title, isDefault, state, sku, barcode, priceType, priceUnit,
//                  priceValue, isTaxFree, isStockable, stockQuantity
//       memo는 undefined가 아니라 빈 문자열("")이었다.
//
// 결론: **문서(zod/타입 선언)는 둘 다 실제보다 좁다. 깎지 말고 카탈로그 원본을 통째로 펼친 뒤
// 화면에 보이는 값(title, priceValue)만 갈아끼운다.** 필드를 지우면 포스가 렌더링에서 깨진다.
//
// 결제: DraftOrder 인터페이스에 startPayment()가 있다(types/index.d.ts:280).
// 장바구니에 담은 뒤 이걸 호출하면 포스 결제가 시작된다 — MOU 목표 흐름의 마지막 조각.

import { posPluginSdk } from '@tossplace/pos-plugin-sdk'

const draftOrder = posPluginSdk.draftOrder

const logEl = () => document.getElementById('probe-log')

function log(message, kind = 'info') {
  const el = logEl()
  if (!el) return
  const line = document.createElement('div')
  line.className = `probe-line ${kind}`
  const time = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date())
  line.textContent = `[${time}] ${message}`
  el.prepend(line)
}

function show(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// ③ 덤프로 확정된 모양(파일 상단 주석 참고): 카탈로그 원본을 통째로 펼치고 보이는 값만 교체.
function buildLineItem({ baseItem, title, priceValue, quantity, memo }) {
  const basePrice = baseItem.price || (Array.isArray(baseItem.prices) ? baseItem.prices[0] : null) || {}
  return {
    item: { ...baseItem, type: 'ITEM', title, options: baseItem.options ?? [] },
    itemPrice: { ...basePrice, priceValue, title: basePrice.title ?? '기본' },
    discount: [],
    memo: memo || '',
    optionChoices: [],
    quantity,
    diningOption: 'HERE',
  }
}

async function getBaseCatalogItem() {
  const catalogs = await posPluginSdk.catalog.getCatalogs()
  if (!catalogs || catalogs.length === 0) return null
  return catalogs.find((c) => c.state === 'ON_SALE') || catalogs[0]
}

// ── 1) 전산 품목 담기 ─────────────────────────────────────────────
// 확인하려는 것: 카탈로그에 등록되지 않은 이름·가격을, 기존 상품 id를 빌려 담을 수 있는가?
// 이게 되면 쉐보레 품목을 토스 POS에 미리 등록하지 않아도 되고 MOU 원안대로 갈 수 있다.
async function probeAdHoc() {
  log('① 전산 품목 담기 (카탈로그 원본 통째 + 이름/가격만 교체)...')
  try {
    const base = await getBaseCatalogItem()
    if (!base) {
      log('⚠️ 카탈로그에 상품이 없습니다. POS에서 아무 상품이나 하나 만든 뒤 다시 시도하세요.', 'fail')
      return
    }
    log(`   기준 상품: id=${base.id} "${base.title}" / 카테고리 id=${base.category?.id} "${base.category?.title}"`)

    const lineItem = buildLineItem({
      baseItem: base,
      title: '엔진오일 5W30 (4L)',
      priceValue: 45000,
      quantity: 1,
      memo: '12가3456 · 전산 연동 테스트',
    })
    // 원본을 통째로 펼치므로 로그가 길다 — 핵심 필드만 찍고 전체는 ③으로 본다.
    log(`   item 필드 ${Object.keys(lineItem.item).length}개 / itemPrice 필드 ${Object.keys(lineItem.itemPrice).length}개`)

    const result = await draftOrder.addLineItem(lineItem)
    log(`✅ 담기 성공 — 항목 ${result?.lineItems?.length ?? '?'}개`, 'ok')
    log('   → [주문] 탭이 정상인지, 이름이 "엔진오일 5W30 (4L)" 45,000원으로 보이는지 확인하세요.', 'ok')
  } catch (e) {
    log(`❌ 실패: ${e?.message || show(e)}`, 'fail')
  }
}

// ── 2) 카탈로그 상품 그대로 담기 (대조군) ─────────────────────────
// ①이 깨지고 ②가 정상이면 "이름·가격 교체"가 원인 → 전산 품목을 POS 카탈로그에 미리 등록해야 한다.
// 둘 다 정상이면 등록 없이 임의 품목을 담을 수 있다는 뜻이다.
async function probeCatalog() {
  log('② 카탈로그 상품 원본 값으로 담기 (대조군)...')
  try {
    const base = await getBaseCatalogItem()
    if (!base) {
      log('⚠️ 카탈로그에 상품이 없습니다.', 'fail')
      return
    }
    log(`   대상: id=${base.id} "${base.title}" ${Number(base.price?.priceValue ?? 0).toLocaleString('ko-KR')}원`)

    // 대조군: 이름/가격도 카탈로그 원본 그대로 둔다.
    const lineItem = buildLineItem({
      baseItem: base,
      title: base.title,
      priceValue: (base.price || (Array.isArray(base.prices) ? base.prices[0] : null) || {}).priceValue ?? 1000,
      quantity: 1,
    })
    log(`   item 필드 ${Object.keys(lineItem.item).length}개 / itemPrice 필드 ${Object.keys(lineItem.itemPrice).length}개`)

    const result = await draftOrder.addLineItem(lineItem)
    log(`✅ 담기 성공 — 항목 ${result?.lineItems?.length ?? '?'}개`, 'ok')
  } catch (e) {
    log(`❌ 실패: ${e?.message || show(e)}`, 'fail')
  }
}

// ── 3) 현재 장바구니 덤프 ─────────────────────────────────────────
// 여기가 핵심 진단이다. [주문] 탭에서 POS로 직접 담은 항목을 이걸로 덤프하면,
// **포스가 스스로 만든 정상 lineItem의 정확한 모양**을 볼 수 있다. 우리가 만든 것과 비교하면
// 어느 필드가 다른지 추측 없이 확정된다.
// 로그가 길어지므로 한 줄에 다 넣지 않고 키 단위로 잘라서 찍는다(작은 화면에서 읽으려고).
// ③에서 덤프한 항목 하나를 보관해 두고 ⑥에서 그대로 되담는 데 쓴다.
let lastDumpedLineItem = null

function dumpObject(label, value, depth = 0) {
  const pad = '  '.repeat(depth)
  if (value === null || typeof value !== 'object') {
    log(`${pad}${label}: ${show(value)}`)
    return
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      log(`${pad}${label}: []`)
      return
    }
    log(`${pad}${label}: [${value.length}]`)
    value.forEach((v, i) => dumpObject(String(i), v, depth + 1))
    return
  }
  log(`${pad}${label}:`)
  for (const [k, v] of Object.entries(value)) dumpObject(k, v, depth + 1)
}

async function probeGet() {
  log('③ 장바구니 덤프...')
  try {
    const current = await draftOrder.get()
    const items = current?.lineItems ?? []
    log(`   항목 ${items.length}개, 주문금액 ${Number(current?.price?.orderPriceValue ?? 0).toLocaleString('ko-KR')}원`, items.length ? 'ok' : 'info')
    if (items.length === 0) {
      log('   → [주문] 탭에서 POS로 직접 상품을 담은 뒤 다시 눌러보세요.', 'info')
      return
    }
    items.forEach((li, i) => {
      log(`── lineItem[${i}] ─────────────────`, 'ok')
      dumpObject('lineItem', li)
    })
    // 항목 하나를 통째로 저장해 두면 ⑥에서 그대로 다시 담아볼 수 있다.
    lastDumpedLineItem = items[items.length - 1]
    log('   → ⑥으로 이 항목을 그대로 복제해 담아볼 수 있습니다.', 'info')
  } catch (e) {
    log(`❌ 실패: ${e?.message || show(e)}`, 'fail')
  }
}

// ── 6) 포스가 만든 항목을 그대로 되담기 ───────────────────────────
// ③으로 덤프한(=포스가 스스로 만든) 항목을 아무것도 바꾸지 않고 addLineItem에 그대로 넣는다.
// 이것마저 [주문] 탭을 깨뜨리면 addLineItem 자체가 이 용도로 못 쓰는 것이고,
// 정상이면 우리가 만든 객체의 어느 필드가 문제인지로 범위가 좁혀진다.
async function probeReadd() {
  log('⑥ ③에서 덤프한 항목 그대로 되담기...')
  if (!lastDumpedLineItem) {
    log('⚠️ 먼저 ③으로 덤프하세요.', 'fail')
    return
  }
  try {
    // key는 포스가 항목마다 새로 발급하므로 빼고 보낸다(스키마상 optional).
    const { key, lineItemId, ...rest } = lastDumpedLineItem
    log(`   보낼 값: ${show(rest)}`)
    const result = await draftOrder.addLineItem(rest)
    log(`✅ 담기 성공 — 항목 ${result?.lineItems?.length ?? '?'}개`, 'ok')
    log('   → [주문] 탭이 정상인지 확인하세요.', 'ok')
  } catch (e) {
    log(`❌ 실패: ${e?.message || show(e)}`, 'fail')
  }
}

// ── 4) 장바구니 비우기 ────────────────────────────────────────────
// DraftOrder.clear()가 인터페이스에 있다(types/index.d.ts:270). 항목을 하나씩 지울 필요가 없다.
async function probeClear() {
  log('④ 장바구니 비우기...')
  try {
    await draftOrder.clear()
    log('✅ 비웠습니다.', 'ok')
  } catch (e) {
    log(`❌ 실패: ${e?.message || show(e)}`, 'fail')
  }
}

// ── 5) 결제 시작 ──────────────────────────────────────────────────
// DraftOrder.startPayment()가 인터페이스에 있다(types/index.d.ts:280).
// 이게 되면 "전산에서 담기 → 직원은 결제만" 이라는 MOU 목표가 그대로 성립한다.
async function probeStartPayment() {
  log('⑤ 결제 시작(startPayment)...')
  try {
    const current = await draftOrder.get()
    const count = current?.lineItems?.length ?? 0
    if (count === 0) {
      log('⚠️ 장바구니가 비어 있습니다. ① 또는 ②로 먼저 담으세요.', 'fail')
      return
    }
    await draftOrder.startPayment()
    log(`✅ 호출 성공 — 포스에 결제 화면이 떴는지 확인하세요 (${Number(current?.price?.orderPriceValue ?? 0).toLocaleString('ko-KR')}원)`, 'ok')
  } catch (e) {
    log(`❌ 실패: ${e?.message || show(e)}`, 'fail')
  }
}

export function initDraftOrderProbe() {
  const panel = document.getElementById('probe-panel')
  if (!panel) return

  const bind = (id, fn) => {
    const el = document.getElementById(id)
    if (el) el.addEventListener('click', () => { fn().catch((e) => log(`예외: ${e?.message}`, 'fail')) })
  }

  bind('probe-adhoc', probeAdHoc)
  bind('probe-catalog', probeCatalog)
  bind('probe-get', probeGet)
  bind('probe-clear', probeClear)
  bind('probe-pay', probeStartPayment)
  bind('probe-readd', probeReadd)

  log('검증 패널 준비됨. ④ 비우기 → [주문] 탭에서 직접 담기 → ③ 덤프 순서로 확인하세요.')
}
