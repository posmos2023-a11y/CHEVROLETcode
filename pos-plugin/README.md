# 쉐보레 포스모스 — 토스 POS 탭앱 (정비 대기열 관리)

토스 POS 화면에 탭으로 추가되어, 직원이 POS에서 바로 정비 대기열을 확인하고
순서 호출(알림톡 발송) / 정비완료 처리를 할 수 있는 플러그인입니다.
`backend/`가 이미 갖고 있는 예약/대기열 데이터를 그대로 사용합니다(별도 DB 없음).

[토스플레이스 "탭 화면(iframe) 패키지" 방식](https://docs.tossplace.com/guide/pos-integration/plugin/develop/iframe-package.html)으로
만들어졌습니다. 매장 식별은 더 이상 `posPluginSdk.merchant.getMerchant()`(merchantId)로 하지 않습니다 —
merchantId는 값 자체가 평문이라 사실상 인증이 아니었기 때문에, 지금은 매장마다 발급된 64자리 hex
**POS 토큰**을 모든 `/api/pos/*` 요청의 `X-Store-Token` 헤더에 실어 보내야 백엔드의
`requireStoreToken` 미들웨어를 통과합니다. `getMerchant()`는 이제 헤더에 잠깐 보여줄 매장 이름을
채우는 화면 표시용 보조 정보로만 쓰입니다(§백엔드 API 참고).

토큰은 최초 실행 시 화면에 뜨는 입력창에서 한 번 입력하면 `localStorage`(`chevrolet_pos_store_token`)에
저장되어 다음 접속부터는 다시 묻지 않습니다. 서버가 401(`STORE_TOKEN_REQUIRED`/`INVALID_STORE_TOKEN`)을
돌려주면(토큰 미입력, 오입력, 또는 관리자가 재발급해 기존 토큰이 무효화된 경우) 저장된 토큰을 지우고
입력 화면으로 돌아갑니다.

## 왜 버튼을 두 번 눌러야 하나요

"대기번호 #1을 실수로 탭했다고 바로 순서 호출 알림톡이 나가면 안 된다"는 요구사항 때문에,
`호출`/`완료`/`취소`(노쇼 등으로 대기열에서 빼는 용도) 버튼은 첫 번째 탭에서 "확정" 상태로만 바뀌고
3초 안에 같은 버튼을 한 번 더 눌러야 실제로 서버에 요청이 나갑니다(`src/app.js`의
`handleActionClick`/`confirming` 참고). 3초 안에 다시 누르지 않으면 원래 상태로 되돌아갑니다.

## 로컬 미리보기

```bash
cd pos-plugin
npm install
# bash: CHEVROLET_API_BASE_URL=https://<cloud-run-url> npm run build
# PowerShell: $env:CHEVROLET_API_BASE_URL='https://<cloud-run-url>'; npm run build
```

`backend`를 실행 중이면(`backend`의 `npm start`) `http://localhost:3000/pos-plugin/index.html`에서
바로 미리볼 수 있습니다(`backend/server.js`가 `pos-plugin/dist`를 정적 서빙). 로컬 미리보기(`isPreview`)라고
해서 토큰 인증을 건너뛰지는 않습니다 — 실제 배포에서 인증이 어떻게 동작하는지 로컬에서도 그대로
확인할 수 있어야 하기 때문입니다(`src/app.js` 상단 주석 참고). 즉 처음 열면 토큰 입력 화면부터 나옵니다.

로컬 개발용 `merchantId '0'` 테스트 매장(`backend/src/store.js`의 `ensureDefaultStore`)은 자동으로
생성되지만 **POS 토큰까지 자동으로 채워주지는 않습니다.** 로컬에서 토큰을 얻으려면:

1. `backend`를 기동해 최초 부팅 시 자동 생성되는 `hq_admin` 계정(`.env`의 `ADMIN_BOOTSTRAP_EMAIL`/
   `ADMIN_BOOTSTRAP_PASSWORD`, 비워두면 콘솔에 1회 출력됨)으로 `http://localhost:3000/admin.html`에 로그인
2. **POS 토큰 관리** 표에서 `쉐보레 대리점 (테스트)`(merchantId `0`) 행을 찾아 토큰이 비어 있으면
   **재발급** 클릭 → **복사**
3. `http://localhost:3000/pos-plugin/index.html`의 토큰 입력 화면에 붙여넣기

토큰을 잘못 입력했거나 관리자가 재발급해 기존 값이 무효화됐다면, 화면 우측 상단의 재설정 버튼으로
언제든 입력 화면으로 돌아갈 수 있습니다.

## 배포 방식과 파일 구조

이 프로젝트는 토스 POS의 **탭 화면(iframe) 패키지 설치 방식**을 사용합니다. 따라서 공식 문서의
웹 워커/UMD 방식과 달리 `main.js`를 엔트리로 사용하지 않습니다.

```text
chevrolet-pos-plugin.zip
  index.html                 # iframe 화면 진입점
  iframe-manifest.json       # POS 탭 메타데이터
  bundle.js                  # src/app.js를 esbuild로 번들한 파일
```

`iframe-manifest.json`은 다음 세 필드를 사용합니다.

```json
{
  "tab": {
    "title": "정비 대기열",
    "description": "차량 정비 대기 손님을 확인하고 순서 호출/정비완료 처리를 합니다.",
    "href": "index.html"
  }
}
```

## 개발 배포 ZIP 만들기

```bash
cd pos-plugin
npm install
# bash: CHEVROLET_API_BASE_URL=https://<cloud-run-url> npm run zip
# PowerShell: $env:CHEVROLET_API_BASE_URL='https://<cloud-run-url>'; npm run zip
```

`npm run zip`은 먼저 `dist/`를 만들고, `dist/`의 실행 파일만 ZIP으로 묶습니다. 소스 코드,
`node_modules`, `.env`, 백엔드는 ZIP에 포함하지 않습니다.

`npm run zip`은 내부적으로 `package.ps1`(PowerShell)을 실행합니다. PowerShell이 없는
환경(Linux/CI/macOS)에서는 같은 일을 하는 `package.sh`를 직접 실행하세요 — 빌드(`npm run build`)부터
ZIP 생성까지 동일하게 동작합니다.

```bash
cd pos-plugin
npm install
CHEVROLET_API_BASE_URL="https://<cloud-run-url>" ./package.sh
```

`zip` 명령이 있으면 그것을 쓰고, 없으면 `bsdtar -a -cf`로 대체합니다(최신 Linux 배포판과 Windows 10+에는
기본 포함). 둘 다 없으면 에러 메시지로 안내합니다. (`package.json`의 `zip` 스크립트를 OS 자동감지형으로
바꾸는 건 이번 변경 범위에서는 하지 않았습니다 — `package.json`을 건드리지 않기로 했기 때문입니다.)

## 실제 POS 단말기에 배포하려면 (사업자 계정 필요)

1. [토스플레이스 개발자센터](https://developers.tossplace.com/login)에서 **내 플러그인 → 플러그인 등록**을
   열고 타입을 `토스 POS`로 선택합니다. ACL에는 배포한 Cloud Run API URL을 등록합니다.
2. 테스트 가맹점을 생성/연결하고, 해당 가맹점에서 이 플러그인 사용 여부를 켭니다.
3. 테스트 POS를 테스트 단말기로 등록합니다.
4. `npm run zip`으로 만든 `chevrolet-pos-plugin.zip`을
   **내 플러그인 → 개발 배포 → 개발용 파일 추가**에 업로드합니다.
5. POS 우측 상단 설정 → **다시 시작** 또는 새로고침으로 새 버전을 반영합니다.
6. 개발 배포는 검수 없이 최대 5개 단말기에서 확인할 수 있고, 전체 매장 배포는 검수 후
   라이브 배포가 필요합니다. 라이브 매장에서는 VAN 대리점의 플러그인 활성화도 필요합니다.
7. 문의: developer-support@tossplace.com

`main.js`가 반드시 필요한 것은 POS의 **스크립트 직접 로드(UMD/웹 워커) 방식**입니다.
그 방식은 DOM을 사용할 수 없으므로 현재처럼 대기열 UI를 제공하는 앱과 맞지 않습니다.
현재 구현을 UMD 방식으로 바꾸려면 별도 `main.js` 웹 워커 플러그인으로 다시 설계해야 하므로,
지금은 `iframe-manifest.json` + `index.html` + `bundle.js` 구조를 유지합니다.

공식 문서:

- [POS iframe 패키지 개발 가이드](https://docs.tossplace.com/guide/pos-integration/plugin/develop/iframe-package.html)
- [POS 플러그인 개발 튜토리얼](https://docs.tossplace.com/guide/pos-integration/plugin/develop/develop-tutorial.html)
- [POS UMD 방식(main.js) 가이드](https://docs.tossplace.com/guide/pos-integration/plugin/develop/umd.html)
- [POS 검수·배포 가이드](https://docs.tossplace.com/guide/pos-integration/plugin/deploy.html)

## 파일 구조

```
pos-plugin/
  build.js                   # esbuild로 src/app.js -> dist/bundle.js 번들 + public/* 복사
  public/
    index.html                # 탭 화면 셸(스타일 포함)
    iframe-manifest.json       # 탭 이름/설명/href (POS에 노출되는 탭 메타데이터)
  src/
    app.js                     # 대기열 조회/호출/완료 로직 (SDK + 백엔드 API 호출)
```

## 백엔드 API (X-Store-Token 기반, 로그인 불필요)

`backend/server.js`에 추가된 전용 엔드포인트입니다. 관리자 대시보드(JWT)와는 별개로,
POS 탭앱은 모든 요청에 매장별 64자리 hex 토큰을 `X-Store-Token` 헤더로 실어 보내는 것만으로
동작합니다. merchantId는 더 이상 인증 수단이 아니며(보내도 무시), 토큰을 발급/재발급하는
절차는 루트 [`README.md`의 "POS 토큰 발급·재발급 운영 절차"](../README.md#pos-토큰-발급재발급-운영-절차) 참고.

| 메서드/경로 | 설명 |
| --- | --- |
| `GET /api/pos/queue` | 오늘(KST) 대기열 중 정비완료·취소가 아닌 예약을 대기번호순으로 조회. 응답에 `storeName`과 마스킹된 전화번호(`phoneMasked`, 예: `010-****-5678`)를 포함 — POS 화면에는 원본 전화번호가 필요 없어 노출하지 않음 |
| `POST /api/pos/queue/:id/call` | 특정 예약 호출(오늘 등록된 예약만, 아니면 404) |
| `POST /api/pos/queue/:id/complete` | 정비완료 처리(오늘 등록된 예약만) |
| `POST /api/pos/queue/:id/cancel` | 노쇼 등으로 대기열에서 취소(`waiting`/`called`/`notify_failed`만 가능) |

인증 실패 시 공통 응답: 헤더 없음/빈값이면 `401 STORE_TOKEN_REQUIRED`, 토큰이 틀리면
`401 INVALID_STORE_TOKEN`, 매장이 비활성화 상태면 `403`. 세 경우 모두 저장된 토큰을 지우고
토큰 입력 화면으로 돌려보냅니다(`src/app.js`의 `showTokenScreen`).
