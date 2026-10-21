$ErrorActionPreference = 'Stop'

$pluginDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$zipPath = Join-Path $pluginDir 'chevrolet-front-plugin.zip'
$stageDir = Join-Path $pluginDir '.package-front-plugin'
$apiBaseUrl = if ($env:CHEVROLET_API_BASE_URL) { $env:CHEVROLET_API_BASE_URL.Trim().TrimEnd('/') } else { '' }
if (-not $apiBaseUrl) {
  throw 'CHEVROLET_API_BASE_URL 환경변수를 설정한 뒤 패키징하세요. 예: $env:CHEVROLET_API_BASE_URL="https://chevrolet-xxxxx-uc.a.run.app"'
}
$runtimeFiles = @(
  'index.html',
  'onboarding.html',
  'payment.html',
  'reservation.html',
  'sdk.js',
  'settings.html',
  'api-config.js',
  'erp-pay.html',
  'erp-front-pay.js'
)

if (Test-Path -LiteralPath $stageDir) {
  Remove-Item -LiteralPath $stageDir -Recurse -Force
}
New-Item -ItemType Directory -Path $stageDir | Out-Null

try {
  foreach ($file in $runtimeFiles) {
    $source = Join-Path $pluginDir $file
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw "배포 파일이 없습니다: $file"
    }
    $destination = Join-Path $stageDir $file
    if ($file -eq 'api-config.js') {
      (Get-Content -LiteralPath $source -Raw -Encoding utf8).Replace('__CHEVROLET_API_BASE_URL__', $apiBaseUrl) |
        Set-Content -LiteralPath $destination -Encoding utf8 -NoNewline
    } else {
      Copy-Item -LiteralPath $source -Destination $destination
    }
  }

  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }
  Compress-Archive -Path (Join-Path $stageDir '*') -DestinationPath $zipPath -CompressionLevel Optimal
  Write-Output "생성 완료: $zipPath"
  Write-Output 'ZIP 내용: index.html, onboarding.html, payment.html, reservation.html, sdk.js, settings.html, api-config.js, erp-pay.html, erp-front-pay.js'
}
finally {
  if (Test-Path -LiteralPath $stageDir) {
    Remove-Item -LiteralPath $stageDir -Recurse -Force
  }
}
