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

grep -o 'screenshots/[a-z0-9-]*\.webp' index.html | sort -u | while read -r shot; do
  cp "$repo_dir/docs/$shot" "$out/$shot"
done

echo "Built $out"
