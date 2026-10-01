#!/usr/bin/env bash
# 由單一原圖 assets/BPA.png 生成 favicon／Logo 全套圖示（需要 ImageMagick 6+ 的 convert）。
# 換支部標誌時：換掉 assets/BPA.png 後執行 `bash scripts/make-icons.sh`，再 commit assets/ 內的產物。
# 產物：
#   assets/rover-badge-256.png        header logo（首頁／登入頁，56px 顯示用）
#   assets/rover-badge-128.png        主畫面 mini logo + PNG favicon 後備
#   assets/favicon-32.png             瀏覽器分頁（32px）
#   assets/favicon-16.png             瀏覽器分頁（16px）
#   assets/favicon.ico                舊瀏覽器／/favicon.ico 自動請求（16/32/48 多尺寸）
#   assets/apple-touch-icon-180.png   iOS 加到主畫面（白底不透明，iOS 唔支援透明）
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=assets/BPA.png
convert "$SRC" -strip -filter Lanczos -resize 256x256 -unsharp 0x0.75+0.6+0.008 -colors 220 -define png:compression-level=9 assets/rover-badge-256.png
convert "$SRC" -strip -filter Lanczos -resize 128x128 -unsharp 0x0.6+0.5+0.008 -colors 180 -define png:compression-level=9 assets/rover-badge-128.png
# 16/32px 先縮到 96px 再輕微模糊，避免原圖 JPEG 雜訊在細尺寸出現紅藍斑點
convert "$SRC" -strip -filter Lanczos -resize 96x96 -blur 0x0.8 -resize 32x32 -colors 96 -define png:compression-level=9 assets/favicon-32.png
convert "$SRC" -strip -filter Lanczos -resize 96x96 -blur 0x0.8 -resize 16x16 -colors 64 -define png:compression-level=9 assets/favicon-16.png
convert "$SRC" -strip -filter Lanczos -resize 180x180 -background white -alpha remove -alpha off -colors 220 -define png:compression-level=9 assets/apple-touch-icon-180.png
convert assets/favicon-16.png assets/favicon-32.png \
  \( "$SRC" -strip -filter Lanczos -resize 144x144 -blur 0x1.0 -resize 48x48 -colors 128 \) \
  -depth 8 assets/favicon.ico
echo "Icons generated from $SRC:"
ls -l assets/rover-badge-*.png assets/favicon*.png assets/favicon.ico assets/apple-touch-icon-180.png
