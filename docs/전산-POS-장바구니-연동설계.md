# 전산 → POS 장바구니 연동 설계

- 작성: 포스모스 · 2026-08-26
- 목표(MOU): **쉐보레 전산에서 "물건 담기"를 누르면 토스 POS 장바구니에 품목이 들어가고, 매장 직원은 결제만 누르면 된다.**

---

## 1. 왜 Open API 경로를 버렸나

먼저 만든 `POST /api/erp/draft-orders`는 토스 Open API로 주문을 생성한다. 실단말기에서 확인한 결과
**그렇게 만든 주문은 POS에서 결제할 수 없다.** 상세는 `docs/ERP연동-결제경로-조사결과.md`에 있고, 요지는:

> "Open API를 통해 생성한 주문에 포함된 결제건은 모두 **외부결제수단**으로 처리된다"

즉 Open API는 *이미 다른 데서 결제된 주문을 기록*하는 용도지, POS로 카드 승인을 일으키는 수단이 아니다.
POS [현황] 탭에 주문이 뜨긴 하지만 결제 진입점이 없다.

**대신 POS 플러그인 SDK의 `draftOrder`를 쓴다.** 여기엔 두 메서드가 있다
(`@tossplace/pos-plugin-sdk` `types/index.d.ts:268~281`):

```ts
addLineItem(lineItem: PluginDraftOrderItemDto): Promise<PluginDraftOrder>
startPayment(): Promise<void>
```

`draftOrder`는 POS [주문] 탭의 **장바구니 그 자체**다. 여기 담고 `startPayment()`를 부르면
직원이 보는 화면 그대로 결제가 시작된다 — MOU 문구와 정확히 일치한다.

기존 `/api/erp/draft-orders`와 `ErpOrder` 테이블은 **지우지 않고 그대로 둔다.** 매출 기록 용도로
쓸 여지가 있고, 이미 계약서(`쉐보레전산-토스POS-연동스펙`)에 문서화돼 있다.

---

## 2. 전체 흐름

```
① 쉐보레 전산 (실제로는 벤더 시스템 / 지금은 PyQt 시뮬레이터)
      │  직원이 부품·공임을 담고 [POS로 전송]
      ▼
② POST /api/erp/carts        (X-ERP-Token)
      │  우리 서버가 ErpCart를 status=pending으로 저장
      ▼
③ GET /api/pos/erp-carts     (X-Store-Token, 5초 폴링)
      │  POS 플러그인이 pending 목록을 가져와 화면에 띄움
      ▼
④ posPluginSdk.draftOrder.addLineItem() × N   ← POS 장바구니에 직접 담김
      │  autoPay면 이어서 startPayment()
      ▼
⑤ POST /api/pos/erp-carts/:id/consume  → status=loaded
      │
      ▼
⑥ 전산이 GET /api/erp/carts/:referenceId 로 "담겼음"을 확인
```

### 왜 우리 서버를 경유하나

전산은 매장 PC(또는 본사 서버)에서 돌고, `posPluginSdk`는 **토스 POS 앱 안 iframe에서만** 산다.
둘은 서로를 직접 부를 수 없다. 그래서 중간에 우리 서버가 우편함 역할을 한다.
PyQt 시뮬레이터가 실제 전산과 정확히 같은 자리에 놓이는 이유이기도 하다 — 시뮬레이터로 검증하면
그대로 실연동 검증이 된다.

---

## 3. 데이터 모델

```prisma
model ErpCart {
  id           String    @id @default(uuid())
  storeId      String
  store        Store     @relation(fields: [storeId], references: [id])
  referenceId  String    @unique   // 전산 측 참조번호 = 멱등키
  itemsJson    String
  totalAmount  Int
  memo         String?             // "12가3456 김민준님"
  autoPay      Boolean   @default(true)
  status       String    @default("pending")  // pending | loaded | failed | cancelled
  errorMessage String?
  createdAt    DateTime  @default(now())
  loadedAt     DateTime?

  @@index([storeId, status, createdAt])
}
```

`ErpOrder`(Open API 경로)와 **별도 테이블**이다. 두 경로의 상태 기계가 다르고, 하나로 합치면
어느 쪽 흐름인지 status만 봐서는 알 수 없게 된다.

---

## 4. API 계약

### 전산 → 서버 (`X-ERP-Token`)

| 메서드 | 경로 | 용도 |
|---|---|---|
| POST | `/api/erp/carts` | 장바구니 전송 (멱등: referenceId) |
| GET | `/api/erp/carts/:referenceId` | 상태 조회 |
| POST | `/api/erp/carts/:referenceId/cancel` | 취소 (pending일 때만) |

```jsonc
// POST /api/erp/carts
{
  "storeCode": "CHV-001",
  "referenceId": "ERP-20260826-001",     // 멱등키
  "items": [
    { "productId": "P-1001", "name": "엔진오일 5W30 (4L)",
      "category": "부품", "unitPrice": 45000, "quantity": 1 }
  ],
  "totalAmount": 45000,                   // Σ(unitPrice × quantity)와 일치해야 함
  "memo": "12가3456 김민준님",
  "autoPay": true                         // true면 담은 뒤 바로 결제 시작
}
```

### POS 플러그인 → 서버 (`X-Store-Token`)

| 메서드 | 경로 | 용도 |
|---|---|---|
| GET | `/api/pos/erp-carts` | pending 목록 (최대 20건) |
| POST | `/api/pos/erp-carts/:id/consume` | 담기 결과 보고 (`loaded` / `failed`) |

**매장 격리**: `consume`은 `X-Store-Token`이 가리키는 매장 소유의 cart만 처리한다.
다른 매장 것이면 404다 — 토큰 하나가 새어도 다른 매장 주문을 건드릴 수 없어야 한다.

**멱등**: `consume`을 두 번 불러도 안전하다(`alreadyProcessed: true`). POS 단말기가 두 대인
매장에서 동시에 소비를 시도할 수 있으므로, 상태 전이는 `updateMany({ where: { id, status: 'pending' } })`의
반환 count로 판별한다.

---

## 5. `addLineItem` — 해결 (2026-08-26 실단말기 검증 완료)

**결론: 쉐보레 품목을 토스 POS 카탈로그에 미리 등록할 필요가 없다. MOU 원안대로 성립한다.**

카탈로그에 "제육 7,000원" 하나뿐인 매장에서 "엔진오일 5W30 (4L) 45,000원"이 [주문] 탭에 정상
표시됐고, 메모(차량번호)도 함께 보이며, 결제 버튼이 45,000원으로 활성화됐다.

### 공개 문서에 없거나 **틀리게** 적힌 것들 (전부 실호출로 확인)

| # | 사실 | 문서는 뭐라고 하나 |
|---|---|---|
| 1 | **`key`는 자동 생성되지 않는다. 직접 발급해야 한다.** | `types/index.d.ts:1120` "넣지 않으면 자동으로 생성됨", zod도 `optional` — **둘 다 틀렸다** |
| 2 | `item`은 카탈로그 **원본 객체 통째**여야 한다 | `Pick<PluginCatalogItem, 'id'\|'title'\|'category'\|'options'\|'code'>` — 실제보다 좁다 |
| 3 | `item.category`도 원본 통째(`merchantId`, `order`, `enabled`, `kioskOrder`, `position`...) | `{id, title, titleI18n?}` — 좁다 |
| 4 | `itemPrice`에 `id`, `isDefault`, `state`, `barcode`, `isStockable`, `stockQuantity`도 있다 | 6개 필드 `Pick` — 좁다 |
| 5 | `item.options`는 필수. 없으면 포스가 `.map()`에서 터진다 | zod 스키마에는 아예 없다 |
| 6 | **SDK 스키마가 SDK 자기 데이터를 거부한다** — `getCatalogs()`의 카테고리에 `titleI18n: null`이 들어있는데 스키마는 `.optional()`이라 `null`을 거부 | 문서에 언급 없음 |
| 7 | `memo`는 `undefined`가 아니라 빈 문자열(`""`) | 문서에 언급 없음 |
| 8 | SDK는 `parse()` 결과를 버리고 **원본 객체를 그대로** 보낸다 → 스키마에 없는 키도 포스까지 전달된다 | 문서에 언급 없음 |
| 9 | `OrderItemType`에 `AD_HOC`이 없다 (Open API의 `targetType`과 다른 체계) | `types/index.d.ts:580` |

### `key`가 없을 때의 증상 (셋 다 같은 원인)

- POS [주문] 탭이 "일시적인 오류가 발생했습니다"로 깨진다
- `addLineItem` 응답의 `lineItems`가 비어서 돌아온다 ("담기 성공 — 항목 0개")
- `deleteLineItem(key)`로 되돌릴 수 없다

포스가 스스로 담은 항목은 `key: "BQ8-knv-Ns0z8_qKZzFmW"`(21자 URL-safe)를 갖고 있었다.
같은 형식으로 직접 발급한다.

### 어떻게 알아냈나

플러그인에 임시 검증 패널을 넣어 **포스가 스스로 담은 항목을 통째로 덤프**했다. 필드를 하나씩
추측해 채우는 걸 그만두고 정답지를 직접 본 것이 결정적이었다 — 문서만 봤다면 `key`가 자동
생성된다고 계속 믿었을 것이다.

구현은 `pos-plugin/src/lineItem.js` 한 곳에 모여 있다.

---

## 6. 배포 선결 조건

### ~~`ERP_API_TOKEN`이 Cloud Run에 설정돼 있지 않다~~ → 2026-08-26 설정 완료

확인 방법 — 아무 값이나 넣고 호출해 본다:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  -H "Content-Type: application/json" -H "X-ERP-Token: x" -d '{}' \
  https://chevrolet-api-813801981857.asia-northeast3.run.app/api/erp/carts
```

| 응답 | 의미 |
|---|---|
| `503` | 토큰 미설정 |
| `401` | **설정됨** (값이 틀렸을 뿐) — 현재 이 상태 |
| `400` | 설정됨 + 토큰 일치 (body만 잘못) |

설정 방법 (PowerShell). 토큰은 **로컬에서 생성**하고 채팅·문서에 남기지 않는다:

```powershell
$token = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
gcloud run services update chevrolet-api `
  --region asia-northeast3 --project tossplugincar-dev `
  --update-env-vars "ERP_API_TOKEN=$token"
$token   # 이 값을 PyQt 앱 설정에 넣는다. 다시 볼 일 없게 안전한 곳에 보관할 것.
```

### 매장코드 매핑

전산은 `storeCode`로 매장을 지정한다. 각 매장에 `erpStoreCode`를 먼저 붙여야 한다:

```
POST /api/admin/stores/:id/erp-code   (관리자 로그인 필요)
```

---

## 7. 구성 요소

| 위치 | 역할 |
|---|---|
| `backend/` | `ErpCart` 모델 + 위 5개 라우트 |
| `erp-simulator/` | PyQt5 전산 시뮬레이터 (정비소 목데이터, 장바구니, 전송) |
| `pos-plugin/` | 전산 주문 목록 표시 + `addLineItem`/`startPayment` |

시뮬레이터는 시연·검증용이지만, 실제 전산 벤더에게 **"이렇게 부르면 됩니다"의 살아있는 예제**로도
쓴다. `erp-simulator/api.py`가 곧 참조 구현이다.

---

## 8. 실패 경로 설계 (돈이 오가는 구간이라 명시해 둔다)

세 컴포넌트가 각자 실패할 수 있어서, "어디까지 진행됐는지 아무도 모르는 상태"가 생기지 않도록
경계를 정해 뒀다.

| 실패 지점 | 처리 | 이유 |
|---|---|---|
| 담기 도중 `addLineItem` 실패 | **우리가 방금 넣은 항목만** 지운다(`clear()` 금지) | 직원이 이미 담아둔 것을 날리면 안 되고, 절반만 담긴 채로 두면 잘못된 금액으로 결제된다 |
| 항목은 다 담겼는데 `startPayment()` 실패 | `loaded`로 보고하고 되돌리지 **않는다** | 장바구니 내용은 이미 정확하다. UI 실행 실패 때문에 멀쩡한 장바구니를 버리는 게 더 손해 — 직원에게 직접 결제를 누르라고 안내한다 |
| `consume` 보고가 서버에 못 닿음 | 1회 재시도 후 직원에게 알림 | 보고가 유실되면 그 건은 계속 `pending`이라 재시작 후 되살아나 중복 담기가 된다 |
| POS가 `failed`로 보고 | 카드를 치우고 전산이 재전송 | 서버에서 이미 종료된 건인데 카드를 남기면, 다시 눌렀을 때 POS엔 담기지만 서버는 `alreadyProcessed`로 흘려 **전산엔 "실패"인데 실제로는 결제되는** 불일치가 생긴다 |
| 전산 쪽: 위 재전송이 필요할 때 | **[장바구니 복원]** 버튼 | 전송 시 장바구니를 비우므로, 없으면 부품·공임 여러 건을 처음부터 다시 골라야 한다 |
| 폴링이 담기 도중에 화면을 새로 그림 | 담는 동안 렌더링 차단(`inFlight`) | 비활성 버튼이 되살아나 직원이 한 번 더 누르면 중복 결제 |
| 늦게 도착한 폴링 응답이 처리된 건을 되살림 | 처리한 id를 영구 제외(`consumed`) | 위와 같은 중복 경로 |

## 9. 검증 방법

`erp-simulator`의 **실제 코드**로 요청을 만들어 로컬 백엔드에 왕복시키는 통합 점검을 돌렸다
(품목 왕복 무손실, 양방향 멱등, 인증 경계, `addLineItem`에 필요한 필드 존재 여부).
백엔드 단위 테스트는 81개다.

`addLineItem`은 실단말기에서 검증됐다(§5) — 카탈로그 등록 없이 임의 품목이 [주문] 탭에
정상 표시되고 결제 버튼이 활성화된다. `lineItem.js`의 순수 함수(key 발급, null i18n 제거,
원본 필드 보존)는 브라우저 밖에서 별도로 점검한다.

남은 것은 `startPayment()` 실호출 확인, 그리고 PyQt 앱 → POS 단말기까지 이어지는 시연이다.
