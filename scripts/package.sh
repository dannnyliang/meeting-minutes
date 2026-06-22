#!/usr/bin/env bash
# 打包擴充套件成可發布的 zip（給使用者下載、解壓即可載入）。
# 只收執行期需要的檔，排除 node_modules / package*.json / .git / .env / 開發雜物。
# 用法：bash scripts/package.sh  →  產出 meeting-minutes-v<版號>.zip
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./manifest.json').version")
OUT="meeting-minutes-v${VERSION}.zip"
rm -f "$OUT"

zip -r "$OUT" \
  manifest.json \
  background.js popup.html popup.js offscreen.html offscreen.js \
  options.html options.js styles.css README.md \
  icons lib vendor \
  -x "*.DS_Store" >/dev/null

echo "已打包 ${OUT} - $(du -h "${OUT}" | cut -f1)"
