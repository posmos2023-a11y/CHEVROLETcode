# 쉐보레 포스모스 — 토스프론트 플러그인 (예약/결제)

매장에 설치된 **토스프론트 결제 단말기**에서 실행되는 플러그인입니다. 빌드 과정이 없는
순수 HTML/JS라 이 폴더 자체가 곧 배포 산출물입니다. `backend/`(Express 서버 + Prisma DB)의
API를 호출해 예약 접수, 대기번호 발급, 결제 후 전자영수증 발송을 처리합니다.

## 왜 별도 폴더인가

이 프로젝트에는 토스 SDK를 쓰는 플러그인이 두 개 있습니다 — 이 폴더(토스프론트)와
[`pos-plugin/`](../pos-plugin/README.md)(토스 POS 탭앱). 서로 다른 SDK(`toss-front-sdk` vs
`@tossplace/pos-plugin-sdk`), 다른 배포 방식(CDN 스크립트 태그 vs npm 빌드)을 쓰기 때문에
독립된 폴더로 나눠뒀습니다. 둘 다 같은 `backend/` 서버·DB를 공유합니다.

## 파일 구조

```
front-plugin/
  index.html          # 대기화면 (예약하기/결제하기 2버튼, Template API: renderIdlePage)
  reservation.html      # 차량번호 → 정비항목 → 전화번호 → 대기번호 발급
  payment.html           # 금액입력 → sdk.payment.requestPayment() 실결제 → 전화번호 → 영수증
  onboarding.html         # 템플릿이 요구하는 표준 파일(단일 매장이라 실질 로직 없음)
  settings.html            # 템플릿이 요구하는 표준 파일(설정 없음 안내만 표시)
  sdk.js                    # 로컬 브라우저 미리보기 전용 오버라이드
                            # (sdk.app.getMerchant/getSerialNumber가 없을 때만 테스트값 채움)
  api-config.js              # window.CHEVROLET_API_BASE_URL 설정. 로컬/백엔드 미리보기에서는 같은
                            # origin(빈 문자열)을 쓰고, 실제 배포 ZIP에서는 package.ps1/package.sh가
                            # __CHEVROLET_API_BASE_URL__ placeholder를 CHEVROLET_API_BASE_URL 값으로 치환
  package.ps1, package.sh    # 배포용 ZIP 생성 스크립트(Windows/그 외 OS, npm run zip은 package.ps1만 호출)
```

## 백엔드와의 연동

- CDN에서 `https://cdn.tossplace.com/toss-front-sdk/v0/index.js`를 불러와 `window.TossFrontSDK`를 사용합니다.
- 화면 구성은 전부 SDK의 **Template API**(`sdk.template.renderIdlePage/renderInputPage/renderSelectPage/renderResultPage`)로만 합니다 — 자유 HTML/CSS는 검수를 통과하지 못합니다.
- 실제 결제는 `sdk.payment.requestPayment({ paymentKey, tax, supplyValue, tip })`로 **단말기가 직접 처리**하고, 이 플러그인은 결제 성공 후 전화번호를 받아 `backend`의 `POST /api/payments`를 호출해 영수증 알림톡 발송 + DB 적재만 담당합니다.
- 가맹점 식별은 `await sdk.app.getMerchant()`로 받은 `merchant.id`를 모든 API 요청 바디에 `merchantId`로 실어 보냅니다(`backend/server.js`의 `requireStore` 미들웨어가 이 값으로 매장을 조회).

## 로컬 미리보기

`backend`를 실행 중이면(`cd backend && npm start`) 별도 빌드 없이 바로 확인 가능합니다
(`backend/server.js`가 이 폴더를 `/toss-plugin` 경로로 정적 서빙).

```
http://localhost:3000/toss-plugin/index.html
```

로컬 미리보기에서는 `sdk.js`가 `merchant.id: 0` 테스트 매장 정보를 자동으로 채워 넣으므로,
실제 단말기 없이도 예약/결제 흐름을 끝까지 눌러볼 수 있습니다
(개발 환경에서만 백엔드가 `merchantId: '0'` 테스트 매장을 자동 시드함).

## 개발 배포 ZIP 만들기

공식 프론트 플러그인 템플릿처럼 플러그인 파일 전체를 ZIP으로 만들어 개발자센터에 업로드합니다.
이 저장소에서는 백엔드 파일과 문서가 섞이지 않도록 배포에 필요한 파일만 묶습니다.

```bash
cd front-plugin
# bash: CHEVROLET_API_BASE_URL=https://<cloud-run-url> npm run zip
# PowerShell: $env:CHEVROLET_API_BASE_URL='https://<cloud-run-url>'; npm run zip
```

`npm run zip`은 `package.json`의 스크립트라서 내부적으로 `package.ps1`(PowerShell)을 호출합니다.
PowerShell이 없는 환경(Linux/CI/macOS)에서는 같은 일을 하는 `package.sh`를 직접 실행하세요 — 두
스크립트는 동작이 완전히 동일합니다(`__CHEVROLET_API_BASE_URL__` 치환 포함).

```bash
cd front-plugin
CHEVROLET_API_BASE_URL="https://<cloud-run-url>" ./package.sh
```

`zip` 명령이 있으면 그것을 쓰고, 없으면 `bsdtar -a -cf`로 대체합니다(최신 Linux 배포판과 Windows 10+에는
기본 포함). 둘 다 없으면 무엇을 설치해야 하는지 알려주는 에러 메시지와 함께 실패합니다.

> `package.json`의 `zip` 스크립트는 아직 `package.ps1`만 가리킵니다. `npm run zip`을 Linux/CI에서도
> 쓰게 하려면 OS를 감지해 두 스크립트 중 하나를 고르도록 `package.json`을 고쳐야 하지만, 지금은
> `package.json`을 건드리지 않기로 하고 `package.sh`를 직접 호출하는 방식으로만 문서화해뒀습니다.
> `npm run zip:sh` 같은 별도 스크립트 추가는 다음 변경에서 검토하세요.

생성 파일: `chevrolet-front-plugin.zip`

ZIP 최상위에는 다음 파일이 들어갑니다.

```text
index.html
onboarding.html
payment.html
reservation.html
sdk.js
settings.html
api-config.js
```

프론트 플러그인 ZIP에는 `main.js`가 필요하지 않습니다. `main.js`는 토스 POS의 별도
스크립트 직접 로드(UMD/웹 워커) 방식에서 요구되는 엔트리 파일이며, 현재 POS 플러그인은
UI를 사용하는 iframe 패키지 방식입니다.

## 실제 단말기 배포 (사업자 계정 필요)

루트 [`README.md`의 "토스프론트 플러그인 연동"](../README.md#토스프론트-플러그인-연동) 섹션에
전체 절차(플러그인 등록 → 테스트 가맹점 연결 → ZIP 배포)가 정리되어 있습니다. 요약하면:

1. [토스플레이스 개발자센터](https://developers.tossplace.com/login)에서 **내 플러그인 → 플러그인 등록**을
   열고 타입을 `토스프론트`로 선택합니다. ACL에는 배포한 Cloud Run API URL을 등록합니다.
2. 테스트 가맹점에 플러그인을 연결하고, 테스트 프론트를 테스트 단말기로 등록합니다.
3. `CHEVROLET_API_BASE_URL=https://<cloud-run-url> cd front-plugin && npm run zip`으로 만든 `chevrolet-front-plugin.zip`을
   **내 플러그인 → 개발 배포 → 개발용 파일 추가**에 업로드한 뒤 테스트 기기에 배포합니다.
4. 프론트 설정에서 `7055` 입력 → **플러그인 업데이트** 또는 **토스 프론트 재시작**을 실행합니다.
5. 개발 배포는 검수 없이 최대 5개 단말기에서 즉시 확인할 수 있고, 전체 매장 배포는 검수 후
   라이브 배포가 필요합니다. 라이브 매장에서는 VAN 대리점의 플러그인 활성화도 필요합니다.

공식 문서 기준으로 프론트 화면은 Template API를 사용해야 하며, 직접 HTML/CSS 화면으로 대체하면
검수 대상에서 문제가 될 수 있습니다. 이 폴더의 화면들은 `sdk.template.*`로 구성되어 있습니다.

참고 문서:

- [프론트 플러그인 개발 튜토리얼](https://docs.tossplace.com/guide/front-integration/plugin/develop/develop-tutorial.html)
- [프론트 개발 환경·개발 배포](https://docs.tossplace.com/guide/front-integration/plugin/develop/develop-environment.html)
- [프론트 Template API](https://docs.tossplace.com/reference/plugin-sdk/front/template.html)
- [프론트 App API](https://docs.tossplace.com/reference/plugin-sdk/front/app.html)
