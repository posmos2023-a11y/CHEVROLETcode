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
// ⚠️ zod 스키마가 전부가 아니다 — 실호출로 확인된 것:
// SDK는 parse() 결과를 버리고 **원본 객체를 그대로** 포스 본체로 보낸다(위 코드 참고).
// 그래서 스키마에 없는 키도 포스까지 전달되고, 반대로 **포스 본체는 스키마에 없는 필드를 읽는다.**
//   - item.options를 빼고 보냈더니 포스가 "Cannot read properties of undefined (reading 'map')"을
//     errorMessage로 돌려줬다. 즉 포스는 item.options를 배열로 가정하고 .map() 한다.
//   - 타입 선언(types/index.d.ts:1124)은 item을
//       Pick<PluginCatalogItem, 'id'|'title'|'category'|'options'|'code'> & { type }
//     로 정의한다. options는 필수, code는 선택(PluginCatalogItem.code?: string).
// 결론: **검증은 zod 스키마, 실제 소비는 타입 선언** 기준으로 맞춰야 한다.
// 그래서 item에는 스키마 필드 + options를 넣고, 선택 필드인 code는 넣지 않는다.
// options는 빈 배열로 둔다 — optionChoices도 비어 있으므로 서로 어긋나지 않는다.
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

// zod 스키마 필드 + 포스 본체가 실제로 읽는 item.options로 만든다(파일 상단 주석 참고).
// 선택 필드(sku)는 값이 있을 때만 넣는다 — z.string().optional()이라 undefined를 명시적으로
// 넣어도 통과하지만, 포스로 전달되는 건 원본 객체이므로 불필요한 키는 아예 만들지 않는다.
function buildLineItem({ itemId, title, category, priceValue, quantity, memo, sku, options }) {
  const lineItem = {
    item: {
      id: itemId,
      title,
      category: { id: category.id, title: category.title },
      // 포스가 .map()하므로 반드시 배열이어야 한다. 기본은 빈 배열 — optionChoices도 비어 있어
      // 서로 어긋나지 않는다.
      options: options ?? [],
      type: 'ITEM',
    },
    itemPrice: {
      isTaxFree: false,
      priceType: 'FIXED',
      priceUnit: 1,
      priceValue,
      title: '기본',
    },
    discount: [],
    optionChoices: [],
    quantity,
    diningOption: 'HERE',
  }
  if (memo) lineItem.memo = memo
  if (sku) lineItem.itemPrice.sku = sku
  return lineItem
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
  log('① 전산 품목 담기 (스키마 필드만 정확히)...')
  try {
    const base = await getBaseCatalogItem()
    if (!base) {
      log('⚠️ 카탈로그에 상품이 없습니다. POS에서 아무 상품이나 하나 만든 뒤 다시 시도하세요.', 'fail')
      return
    }
    log(`   기준 상품: id=${base.id} "${base.title}" / 카테고리 id=${base.category?.id} "${base.category?.title}"`)

    const lineItem = buildLineItem({
      itemId: base.id,
      title: '엔진오일 5W30 (4L)',
      category: base.category,
      priceValue: 45000,
      quantity: 1,
      memo: '12가3456 · 전산 연동 테스트',
    })
    log(`   보낼 값: ${show(lineItem)}`)

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

    const lineItem = {
      item: {
        id: base.id,
        title: base.title,
        category: { id: base.category.id, title: base.category.title },
        options: [],
        type: 'ITEM',
      },
      // 대조군이므로 가격 정보도 카탈로그 값을 그대로 쓴다(스키마에 있는 키만 골라서).
      itemPrice: {
        isTaxFree: base.price.isTaxFree,
        priceType: base.price.priceType,
        priceUnit: base.price.priceUnit,
        priceValue: base.price.priceValue,
        title: base.price.title,
      },
      discount: [],
      optionChoices: [],
      quantity: 1,
      diningOption: 'HERE',
    }
    if (base.price.sku) lineItem.itemPrice.sku = base.price.sku
    log(`   보낼 값: ${show(lineItem)}`)

    const result = await draftOrder.addLineItem(lineItem)
    log(`✅ 담기 성공 — 항목 ${result?.lineItems?.length ?? '?'}개`, 'ok')
  } catch (e) {
    log(`❌ 실패: ${e?.message || show(e)}`, 'fail')
  }
}

// ── 3) 현재 장바구니 상태 확인 ────────────────────────────────────
async function probeGet() {
  log('③ 현재 장바구니 조회...')
  try {
    const current = await draftOrder.get()
    const count = current?.lineItems?.length ?? 0
    const total = current?.price?.orderPriceValue ?? 0
    log(`   담긴 항목 ${count}개, 주문금액 ${Number(total).toLocaleString('ko-KR')}원`, count ? 'ok' : 'info')
    for (const li of current?.lineItems ?? []) {
      log(`     · ${li.item?.title} ×${li.quantity} — ${Number(li.itemPrice?.priceValue ?? 0).toLocaleString('ko-KR')}원`)
    }
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

  log('검증 패널 준비됨. ④로 비운 뒤 ①부터 눌러보세요.')
}
