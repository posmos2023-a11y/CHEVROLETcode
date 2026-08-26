// @tossplace/pos-plugin-sdk는 npm 전용 패키지(ESM import)라 브라우저에서 바로 못 쓴다.
// "탭 화면(iframe) 패키지" 방식(https://docs.tossplace.com/guide/pos-integration/plugin/develop/iframe-package.html)이
// 요구하는 산출물(dist/에 index.html + iframe-manifest.json + 번들 JS)을 esbuild로 직접 만든다.
// 이 프로젝트에는 React 등 별도 프레임워크가 없어(백엔드도 순수 JS 스타일) 의도적으로 가장 단순한 구성으로 뒀다.
const esbuild = require('esbuild')
const fs = require('node:fs')
const path = require('node:path')

const watch = process.argv.includes('--watch')
const distDir = path.join(__dirname, 'dist')
const apiBaseUrl = String(process.env.CHEVROLET_API_BASE_URL || '').trim().replace(/\/$/, '')

// 배포 빌드는 API 주소가 번들 안에 구워져야 한다. 이걸 빠뜨리면 API_BASE가 빈 문자열이 되어
// 단말기에서 상대경로로 요청이 나가고, 화면에는 원인을 알 수 없는 "네트워크 연결을 확인한 뒤
// 다시 시도해주세요"만 뜬다 — 실제로 그렇게 한 번 배포해서 토큰 화면이 안 넘어갔다.
// 조용히 통과시키지 않고 빌드를 멈춘다. (watch는 localhost라 same-origin으로 동작하므로 예외)
if (!watch && !apiBaseUrl) {
  console.error('[pos-plugin] CHEVROLET_API_BASE_URL 환경변수가 없습니다. 배포 번들을 만들 수 없습니다.')
  console.error("  PowerShell: $env:CHEVROLET_API_BASE_URL = 'https://chevrolet-api-813801981857.asia-northeast3.run.app'")
  console.error('  (docs/배포-패키징-가이드.md §1 참고)')
  process.exit(1)
}

fs.rmSync(distDir, { recursive: true, force: true })
fs.mkdirSync(distDir, { recursive: true })
fs.copyFileSync(path.join(__dirname, 'public', 'index.html'), path.join(distDir, 'index.html'))
fs.copyFileSync(path.join(__dirname, 'public', 'iframe-manifest.json'), path.join(distDir, 'iframe-manifest.json'))

const options = {
  entryPoints: [path.join(__dirname, 'src', 'app.js')],
  bundle: true,
  outfile: path.join(distDir, 'bundle.js'),
  format: 'iife',
  target: 'es2018',
  minify: !watch,
  sourcemap: watch,
  define: {
    __CHEVROLET_API_BASE_URL__: JSON.stringify(apiBaseUrl),
  },
}

if (watch) {
  esbuild.context(options).then((ctx) => {
    ctx.watch()
    console.log('[pos-plugin] watching for changes...')
  })
} else {
  esbuild.build(options).then(() => {
    console.log('[pos-plugin] build complete -> dist/')
  })
}
