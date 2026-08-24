#!/usr/bin/env bash
# package.ps1의 bash 대응 스크립트. 두 스크립트는 동작이 동일해야 한다 —
# 한쪽을 고치면 반드시 다른 쪽도 같이 고칠 것.
#
# CHEVROLET_API_BASE_URL 환경변수를 필수로 받아 api-config.js의 __CHEVROLET_API_BASE_URL__
# placeholder를 치환한 뒤, 배포에 필요한 7개 런타임 파일만 chevrolet-front-plugin.zip으로 묶는다.
set -euo pipefail

plugin_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
zip_path="$plugin_dir/chevrolet-front-plugin.zip"
stage_dir="$plugin_dir/.package-front-plugin"

api_base_url="${CHEVROLET_API_BASE_URL:-}"
# 앞뒤 공백 제거 + 끝 슬래시 제거 (PowerShell 버전의 .Trim().TrimEnd('/')와 동일)
api_base_url="$(echo "$api_base_url" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's:/*$::')"
if [ -z "$api_base_url" ]; then
  echo 'CHEVROLET_API_BASE_URL 환경변수를 설정한 뒤 패키징하세요. 예: CHEVROLET_API_BASE_URL="https://chevrolet-xxxxx-uc.a.run.app" npm run zip' >&2
  exit 1
fi

runtime_files=(
  "index.html"
  "onboarding.html"
  "payment.html"
  "reservation.html"
  "sdk.js"
  "settings.html"
  "api-config.js"
)

rm -rf "$stage_dir"
mkdir -p "$stage_dir"

cleanup() {
  rm -rf "$stage_dir"
}
trap cleanup EXIT

for file in "${runtime_files[@]}"; do
  source="$plugin_dir/$file"
  if [ ! -f "$source" ]; then
    echo "배포 파일이 없습니다: $file" >&2
    exit 1
  fi
  destination="$stage_dir/$file"
  if [ "$file" = "api-config.js" ]; then
    # __CHEVROLET_API_BASE_URL__ placeholder만 치환한다. sed 구분자로 쓰는 '|'는 URL에 나오지 않는다고
    # 가정한다(https:// URL이라 '|'가 들어갈 일이 없음).
    sed "s|__CHEVROLET_API_BASE_URL__|${api_base_url}|g" "$source" > "$destination"
  else
    cp "$source" "$destination"
  fi
done

rm -f "$zip_path"

# stage_dir로 cd한 뒤 파일명만 넘겨서 압축한다 — "." 전체를 넘기면 디렉터리 엔트리(./)가
# 같이 들어가 도구별로 ZIP 내부 경로가 미묘하게 달라질 수 있어서 피한다.
if command -v zip >/dev/null 2>&1; then
  (cd "$stage_dir" && zip -X -q -9 "$zip_path" "${runtime_files[@]}")
elif command -v bsdtar >/dev/null 2>&1; then
  (cd "$stage_dir" && bsdtar -a -cf "$zip_path" "${runtime_files[@]}")
else
  echo '이 시스템에는 zip과 bsdtar가 모두 없습니다. 둘 중 하나를 설치한 뒤 다시 실행하세요' \
    '(Debian/Ubuntu: apt-get install -y zip, 또는 bsdtar가 포함된 libarchive-tools).' >&2
  exit 1
fi

echo "생성 완료: $zip_path"
echo 'ZIP 내용: index.html, onboarding.html, payment.html, reservation.html, sdk.js, settings.html, api-config.js'
