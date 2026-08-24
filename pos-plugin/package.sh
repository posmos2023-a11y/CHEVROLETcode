#!/usr/bin/env bash
# package.ps1의 bash 대응 스크립트. 두 스크립트는 동작이 동일해야 한다 —
# 한쪽을 고치면 반드시 다른 쪽도 같이 고칠 것.
#
# dist/를 빌드(npm run build, build.js가 CHEVROLET_API_BASE_URL을 esbuild define으로 굽는다)한 뒤,
# dist/의 산출물만 chevrolet-pos-plugin.zip으로 묶는다.
set -euo pipefail

plugin_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dist_dir="$plugin_dir/dist"
zip_path="$plugin_dir/chevrolet-pos-plugin.zip"
stage_dir="$plugin_dir/.package-pos-plugin"

(
  cd "$plugin_dir"
  npm run build
)

if [ ! -d "$dist_dir" ]; then
  echo 'dist 폴더가 생성되지 않았습니다.' >&2
  exit 1
fi

rm -rf "$stage_dir"
mkdir -p "$stage_dir"

cleanup() {
  rm -rf "$stage_dir"
}
trap cleanup EXIT

# dist/의 숨김 파일 포함 전체 내용을 스테이징 디렉터리로 복사한다 (PowerShell 버전의
# Get-ChildItem -Force와 동일하게 숨김 파일도 놓치지 않도록 shopt dotglob 사용).
shopt -s dotglob nullglob
dist_entries=("$dist_dir"/*)
shopt -u dotglob nullglob

if [ ${#dist_entries[@]} -eq 0 ]; then
  echo 'dist 폴더가 비어 있어 ZIP을 만들 수 없습니다.' >&2
  exit 1
fi

staged_names=()
for entry in "${dist_entries[@]}"; do
  cp -R "$entry" "$stage_dir/"
  staged_names+=("$(basename "$entry")")
done

rm -f "$zip_path"

# stage_dir로 cd한 뒤 파일명만 넘겨서 압축한다 — "." 전체를 넘기면 디렉터리 엔트리(./)가
# 같이 들어가 도구별로 ZIP 내부 경로가 미묘하게 달라질 수 있어서 피한다.
if command -v zip >/dev/null 2>&1; then
  (cd "$stage_dir" && zip -X -q -r -9 "$zip_path" "${staged_names[@]}")
elif command -v bsdtar >/dev/null 2>&1; then
  (cd "$stage_dir" && bsdtar -a -cf "$zip_path" "${staged_names[@]}")
else
  echo '이 시스템에는 zip과 bsdtar가 모두 없습니다. 둘 중 하나를 설치한 뒤 다시 실행하세요' \
    '(Debian/Ubuntu: apt-get install -y zip, 또는 bsdtar가 포함된 libarchive-tools).' >&2
  exit 1
fi

echo "생성 완료: $zip_path"
echo 'ZIP 내용: index.html, iframe-manifest.json, bundle.js'
