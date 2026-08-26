// POS 장바구니(draftOrder)에 넣을 lineItem을 만드는 **유일한** 곳.
// 검증 패널(draftOrderProbe.js)과 운영 화면(erpCarts.js)이 둘 다 여기를 쓴다 — 실단말기에서
// 알아낸 규칙이 한 곳에만 있어야 다음에 또 바뀌어도 한 번만 고친다.
//
// ── 실단말기 덤프로 확정한 사실 (문서와 다르다) ──────────────────────────────
//
// (1) key는 **자동 생성되지 않는다.**
//     types/index.d.ts:1120은 "넣지 않으면 자동으로 생성됨"이라고 적혀 있고 런타임 zod 스키마도
//     key: z.string().optional() 이지만, 실제로 key 없이 넣었더니 담긴 항목의 key가 undefined로
//     남았다. 반면 포스가 스스로 담은 항목은 key: "BQ8-knv-Ns0z8_qKZzFmW"를 갖고 있었다.
//     key가 없으면 (a) [주문] 탭이 "일시적인 오류"로 깨지고 (b) addLineItem 응답의 lineItems가
//     비어서 돌아오고 (c) deleteLineItem(key)로 되돌릴 수도 없다. 그래서 우리가 직접 만든다.
//
// (2) item은 Pick으로 깎으면 안 되고 **카탈로그 원본을 통째로** 넣어야 한다.
//     포스가 담은 item에는 merchantId, description, state, prices[], defaultPriceId,
//     priceVariations, optionSets, color, imageUrl, labels, durationSeconds,
//     metadata(diningOptions, minQuantity/maxQuantity, kioskDetails, titleI18n, categoryId ...)가
//     전부 들어 있었다. 문서의 Pick<...'id'|'title'|'category'|'options'|'code'>대로 깎아 보냈더니
//     addLineItem은 성공을 반환하는데 포스가 렌더링에서 없는 필드를 참조해 깨졌다.
//
// (3) SDK 스키마가 SDK 자기 데이터를 거부한다.
//     getCatalogs()가 주는 카테고리에는 titleI18n: null이 들어 있는데, 검증 스키마의
//     titleI18n은 z.lazy(...).optional() 이라 undefined만 허용하고 **null은 거부**한다
//     ("Expected object, received null"). 그래서 넘기기 전에 null인 i18n 필드를 지운다.
//
// (4) memo는 undefined가 아니라 빈 문자열("")이었다.

// 포스가 쓰는 key와 같은 모양(21자, URL-safe 알파벳 = nanoid 기본값)으로 만든다.
// 길이·문자셋을 맞추는 이유는 포스가 key 형식을 검사할 수도 있어서다 — 확인된 바는 없지만
// 굳이 다르게 만들 이유도 없다.
const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'

export function makeLineItemKey() {
  const bytes = new Uint8Array(21)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += KEY_ALPHABET[b % KEY_ALPHABET.length]
  return out
}

// null인 i18n 필드만 골라 지운다((3) 참고). 원본을 건드리지 않으려고 얕은 복사본에서 지우고,
// 중첩된 category/price 안쪽까지 훑는다. 다른 null은 그대로 둔다 — 스키마가 거부하는 건
// 이 두 필드뿐이고, 근거 없이 더 지우면 포스가 렌더링할 때 참조할 값이 사라진다((2) 참고).
const NULLABLE_I18N_KEYS = ['titleI18n', 'descriptionI18n']

export function stripNullI18n(value) {
  if (Array.isArray(value)) return value.map(stripNullI18n)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (NULLABLE_I18N_KEYS.includes(k) && v === null) continue
    out[k] = stripNullI18n(v)
  }
  return out
}

// 카탈로그 상품 하나를 밑판 삼아, 화면에 보이는 값(이름·금액)만 갈아끼운 lineItem을 만든다.
// 전산 품목은 포스 카탈로그에 등록돼 있지 않아서 id/category를 새로 만들 수 없다 — 기존 상품의
// 것을 빌려 쓰는 수밖에 없다.
export function buildLineItem({ baseItem, title, priceValue, quantity, memo, key }) {
  // getCatalogs()가 주는 가격 객체가 price(단수)일 수도 prices(배열)일 수도 있어 둘 다 받는다.
  const basePrice = baseItem.price || (Array.isArray(baseItem.prices) ? baseItem.prices[0] : null) || {}
  return stripNullI18n({
    key: key || makeLineItemKey(),
    item: { ...baseItem, type: 'ITEM', title, options: baseItem.options ?? [] },
    itemPrice: { ...basePrice, priceValue, title: basePrice.title ?? '기본' },
    discount: [],
    memo: memo || '',
    optionChoices: [],
    quantity,
    diningOption: 'HERE',
  })
}
