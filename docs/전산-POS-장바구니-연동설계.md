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

## 5. 미해결 — `addLineItem` 렌더링 문제

`addLineItem()`이 **성공을 반환하는데도** POS [주문] 탭이 "일시적인 오류가 발생했습니다"로 깨진다.
실단말기에서 진단 중이다.

지금까지 확정된 것:

| 사실 | 근거 |
|---|---|
| SDK는 `parse()` 결과를 버리고 **원본 객체를 그대로** 포스로 보낸다 | `dist/index.esm.js`의 `addLineItem` 구현 |
| 따라서 zod 스키마에 없는 키도 포스까지 전달된다 | 위와 동일 |
| `item.options`는 **필수** — 없으면 포스가 `.map()`에서 터진다 | 실호출 errorMessage |
| zod 스키마의 `item`에는 `options`가 **없다** | `PluginDraftOrderItemDtoSchema` 원문 |
| 즉 **검증은 zod, 실제 소비는 타입 선언** 기준으로 맞춰야 한다 | 위 둘의 조합 |
| `OrderItemType`에 `AD_HOC`이 없다 (Open API의 `targetType`과 다른 체계) | `types/index.d.ts:580` |

다음 진단: POS가 **스스로 만든** 정상 lineItem을 덤프해서(플러그인 검증 패널 ③) 우리가 만든 것과
필드 단위로 비교한다. 그리고 그 항목을 그대로 되담아(④) `addLineItem` 자체의 가용성을 가른다.

이 문제 때문에 **lineItem을 만드는 코드는 함수 하나에 모아 뒀다.** 진단이 끝나면 거기만 고치면 된다.

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

한 가지 남은 것: **`addLineItem` 렌더링 문제(§5)가 풀리기 전까지는 POS 단말기에서의
끝단 확인이 불가능하다.** 그 앞 구간(전산 → 서버 → 플러그인 수신)은 전부 검증됐다.
