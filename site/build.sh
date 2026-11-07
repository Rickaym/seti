#!/usr/bin/env bash
set -euo pipefail

site_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(dirname "$site_dir")"
out="$site_dir/dist/seti"

cd "$site_dir"
rm -rf dist
mkdir -p "$out/fonts" "$out/screenshots"

cp index.html style.css og.png "$out/"
cp fonts/jetbrains-mono-latin-wght-normal.woff2 fonts/OFL.txt "$out/fonts/"
cp _headers _redirects dist/
for icon in favicon-32.png favicon-64.png apple-touch-icon.png; do
  cp "$repo_dir/ui/public/$icon" "$out/"
done

missing=0
while read -r shot; do
  if [[ ! -f "$repo_dir/docs/$shot" ]]; then
    echo "build.sh: index.html references docs/$shot, which does not exist" >&2
    missing=1
    continue
  fi
  cp "$repo_dir/docs/$shot" "$out/$shot"
done < <(grep -o 'screenshots/[a-z0-9-]*\.webp' index.html | sort -u)

if [[ "$missing" -ne 0 ]]; then
  echo "build.sh: fix the screenshot paths in site/index.html" >&2
  exit 1
fi

echo "Built $out"
