#!/bin/bash
# Baut KampagnenBoard-Mac-Installer.zip
#   KB_CLOUD_URL=https://xyz.supabase.co KB_CLOUD_KEY=eyJ... ./scripts/make-installer-zip-mac.sh   (Cloud fest hinterlegen)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/KampagnenBoard-Mac-Installer.zip}"
python3 "$ROOT/scripts/build.py" >/dev/null
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
D="$TMP/KampagnenBoard"
mkdir -p "$D/app"
cp -R "$ROOT/desktop/main.js" "$ROOT/desktop/preload.js" "$ROOT/desktop/package.json" "$ROOT/desktop/renderer" "$ROOT/desktop/build" "$D/app/"
if [ -n "${KB_CLOUD_URL:-}" ] && [ -n "${KB_CLOUD_KEY:-}" ]; then
  printf '{"url":"%s","key":"%s"}\n' "$KB_CLOUD_URL" "$KB_CLOUD_KEY" > "$D/app/default-cloud.json"
fi
cp "$ROOT/installer-mac/Installieren.command" "$ROOT/installer-mac/Deinstallieren.command" "$ROOT/installer-mac/LIESMICH.txt" "$D/"
chmod 755 "$D/Installieren.command" "$D/Deinstallieren.command"
rm -f "$OUT"
(cd "$TMP" && zip -qr -X "$OUT" KampagnenBoard)
echo "$OUT"
