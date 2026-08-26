# 쉐보레 정비 전산 시뮬레이터를 단독 실행파일(.exe)로 묶는다.
#
# 왜 exe로 만드나: 시연·검증은 정비소나 회의실 PC에서 하는데 거기엔 파이썬이 없다.
# 이 exe 하나만 복사하면 바로 뜬다.
#
# 사용법:
#   .\build.ps1
#   .\build.ps1 -Clean     # 이전 산출물까지 지우고 새로 빌드
#
# 산출물: dist\쉐보레정비전산.exe (단일 파일)

param([switch]$Clean)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $here

try {
  if ($Clean) {
    foreach ($d in @('build', 'dist', '__pycache__')) {
      if (Test-Path $d) { Remove-Item $d -Recurse -Force }
    }
    Get-ChildItem -Filter '*.spec' | Remove-Item -Force
  }

  python -c "import PyInstaller" 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller가 없습니다. 먼저 실행하세요:  python -m pip install pyinstaller"
  }

  # --add-data 의 구분자는 윈도우에서 세미콜론이다(리눅스/맥은 콜론).
  #
  # style.qss와 config.example.ini는 **읽기 전용 리소스**라 번들 안에 넣는다 — 실행 시
  # sys._MEIPASS 아래에 풀리고, config.py의 resource_dir()가 그 경로를 찾는다.
  #
  # config.ini는 **넣지 않는다.** ERP 토큰이 들어가는 파일이라 exe에 구워넣으면 그 exe를
  # 받는 사람 모두에게 토큰이 새어나간다. 대신 실행하면 exe 옆에 새로 만들어진다
  # (config.py의 data_dir() 참고).
  # 변수명을 $args로 두면 안 된다 — PowerShell 자동 변수라 대입 자체가 에러다.
  $pyArgs = @(
    '-m', 'PyInstaller',
    '--noconfirm',
    '--onefile',            # 파일 하나로 (복사해서 건네주기 쉽게)
    '--windowed',           # 콘솔 창 없이 (GUI 앱이라 검은 창이 같이 뜨면 안 된다)
    '--name', '쉐보레정비전산',
    '--add-data', 'style.qss;.',
    '--add-data', 'config.example.ini;.',
    'main.py'
  )

  Write-Output '빌드 중... (처음이면 1~3분 걸립니다)'
  & python @pyArgs
  if ($LASTEXITCODE -ne 0) { throw "빌드 실패(exit $LASTEXITCODE)" }

  $exe = Join-Path $here 'dist\쉐보레정비전산.exe'
  if (-not (Test-Path $exe)) { throw "산출물이 없습니다: $exe" }

  $sizeMb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
  Write-Output ''
  Write-Output "완료: $exe  ($sizeMb MB)"
  Write-Output '이 파일 하나만 복사하면 파이썬 없는 PC에서도 실행됩니다.'
  Write-Output '첫 실행 시 exe 옆에 config.ini가 생기고, [설정]에서 ERP 토큰을 넣으면 거기 저장됩니다.'
}
finally {
  Pop-Location
}
