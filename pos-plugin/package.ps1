$ErrorActionPreference = 'Stop'

$pluginDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$distDir = Join-Path $pluginDir 'dist'
$zipPath = Join-Path $pluginDir 'chevrolet-pos-plugin.zip'
# ⚠️ 개발자센터는 POS 플러그인을 산출물이 dist/ 폴더로 감싸인 구조로 요구한다(루트에 흩뿌리면 거부).
# 그래서 루트 구조(chevrolet-pos-plugin.zip)와 함께 dist/ 래핑 구조(-foldered.zip)를 둘 다 만들고,
# 실제 업로드에는 -foldered를 쓴다(docs/배포-패키징-가이드.md §2 참고).
$folderedZipPath = Join-Path $pluginDir 'chevrolet-pos-plugin-foldered.zip'
$stageDir = Join-Path $pluginDir '.package-pos-plugin'

Push-Location $pluginDir
try {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) {
    throw "POS 플러그인 빌드 실패(exit code: $LASTEXITCODE)"
  }
}
finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath $distDir -PathType Container)) {
  throw 'dist 폴더가 생성되지 않았습니다.'
}
if (Test-Path -LiteralPath $stageDir) {
  Remove-Item -LiteralPath $stageDir -Recurse -Force
}
New-Item -ItemType Directory -Path $stageDir | Out-Null

try {
  foreach ($file in Get-ChildItem -LiteralPath $distDir -Force) {
    Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $stageDir $file.Name) -Recurse
  }
  if (-not (Get-ChildItem -LiteralPath $stageDir -Force)) {
    throw 'dist 폴더가 비어 있어 ZIP을 만들 수 없습니다.'
  }
  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }
  if (Test-Path -LiteralPath $folderedZipPath) {
    Remove-Item -LiteralPath $folderedZipPath -Force
  }

  # ⚠️ Compress-Archive / .NET ZipFile은 Windows에서 ZIP 내부 경로를 백슬래시(dist\bundle.js)로 쓴다.
  # ZIP 표준은 슬래시(/)라 토스 개발자센터가 백슬래시 항목을 거부한다. Windows 내장 tar.exe(libarchive)는
  # 슬래시로 zip을 만들므로 그걸 우선 쓰고, 없으면 zip -> bsdtar 순으로 폴백한다.
  # (docs/배포-패키징-가이드.md §2에 이 함정을 기록해 뒀다.)
  $winTar = Join-Path $env:SystemRoot 'System32\tar.exe'

  function New-PluginZip($outPath, $baseDir, $itemRelative) {
    # $baseDir 기준으로 $itemRelative(파일 또는 dist 폴더)를 슬래시 경로로 zip에 담는다.
    if (Test-Path -LiteralPath $winTar) {
      Push-Location $baseDir
      try {
        & $winTar -a -cf $outPath $itemRelative
        if ($LASTEXITCODE -ne 0) { throw "tar.exe ZIP 생성 실패($outPath, exit $LASTEXITCODE)" }
      } finally { Pop-Location }
    } else {
      # 최후 폴백: Compress-Archive(백슬래시 위험). tar.exe가 없는 예외적 환경 경고.
      Write-Warning 'Windows tar.exe를 찾지 못해 Compress-Archive로 대체합니다. ZIP 경로 구분자가 백슬래시가 되어 업로드가 거부될 수 있습니다.'
      Compress-Archive -Path (Join-Path $baseDir $itemRelative) -DestinationPath $outPath -CompressionLevel Optimal
    }
  }

  # 루트 구조: stageDir 안의 파일들을 최상위에 (프론트처럼 하위폴더가 없어 구분자 이슈 없음)
  Push-Location $stageDir
  try {
    if (Test-Path -LiteralPath $winTar) {
      & $winTar -a -cf $zipPath *
      if ($LASTEXITCODE -ne 0) { throw "tar.exe 루트 ZIP 생성 실패(exit $LASTEXITCODE)" }
    } else {
      Compress-Archive -Path (Join-Path $stageDir '*') -DestinationPath $zipPath -CompressionLevel Optimal
    }
  } finally { Pop-Location }

  # foldered 구조: dist/ 폴더째 (개발자센터 업로드용)
  New-PluginZip $folderedZipPath $pluginDir 'dist'

  Write-Output "생성 완료(루트): $zipPath"
  Write-Output "생성 완료(업로드용, dist/ 래핑): $folderedZipPath"
  Write-Output 'ZIP 내용: dist/index.html, dist/iframe-manifest.json, dist/bundle.js'
  Write-Output '개발자센터에는 -foldered.zip 을 업로드하세요.'
}
finally {
  if (Test-Path -LiteralPath $stageDir) {
    Remove-Item -LiteralPath $stageDir -Recurse -Force
  }
}
