#!/usr/bin/env node
// 관리자 비밀번호의 bcrypt 해시를 만든다.
//
// 왜 필요한가: 본사 관리자 계정은 서버가 부팅할 때 "관리자가 하나도 없으면" 한 번만 만든다
// (src/store.js의 ensureDefaultHqAdmin). 그래서 ADMIN_BOOTSTRAP_PASSWORD 시크릿을 바꾸고
// 재배포해도 **이미 만들어진 계정의 비밀번호는 바뀌지 않는다.** 비밀번호를 잊었을 때 들어갈
// 방법이 없어서, DB의 passwordHash를 직접 갈아끼우는 경로가 필요하다.
//
// 이 스크립트는 해시만 찍는다. DB에는 손대지 않는다 — 운영 DB 접속 정보를 로컬에 두지 않으려는
// 의도이고, 실제 갱신은 Cloud SQL Studio에서 SQL 한 줄로 한다.
//
// 사용법:
//   node scripts/hash-password.js '내가정한비밀번호'
//
// ⚠️ 비밀번호는 셸 히스토리에 남는다. 끝난 뒤 히스토리를 지우거나, 인자 없이 실행해
//    입력 프롬프트를 쓰는 편이 안전하다(인자를 안 주면 stdin으로 받는다).

const bcrypt = require('bcryptjs')
const readline = require('node:readline')

const MIN_LENGTH = 8

function printResult(password) {
  if (password.length < MIN_LENGTH) {
    console.error(`비밀번호는 ${MIN_LENGTH}자 이상이어야 합니다(서버도 같은 기준으로 거부합니다).`)
    process.exitCode = 1
    return
  }
  // 서버(src/auth.js의 hashPassword)와 동일한 라운드 수를 써야 검증이 통과한다.
  const hash = bcrypt.hashSync(password, 10)
  console.log('\n아래 SQL을 Cloud SQL Studio에서 실행하세요:')
  console.log('  https://console.cloud.google.com/sql/instances?project=tossplugincar-dev\n')
  // 잠금 카운터도 함께 초기화한다 — 여러 번 실패해 계정이 잠겨 있으면 새 비밀번호로도
  // 423으로 막혀서, 비밀번호만 바꿔서는 못 들어간다(server.js의 계정 잠금 로직).
  console.log(`UPDATE "AdminUser"`)
  console.log(`   SET "passwordHash" = '${hash}',`)
  console.log(`       "failedLoginCount" = 0,`)
  console.log(`       "lockedUntil" = NULL`)
  console.log(` WHERE role = 'hq_admin';\n`)
  console.log('실행 후 관리자 웹에서 기존 이메일 + 방금 정한 비밀번호로 로그인하면 됩니다.')
  console.log('(이메일을 모르면 먼저 확인:  SELECT email FROM "AdminUser" WHERE role = \'hq_admin\';)')
}

const fromArgv = process.argv[2]
if (fromArgv) {
  printResult(fromArgv)
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  rl.question('새 비밀번호(8자 이상): ', (answer) => {
    rl.close()
    printResult(answer.trim())
  })
}
