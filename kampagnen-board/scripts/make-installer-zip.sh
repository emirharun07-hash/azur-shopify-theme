#!/bin/bash
# Baut KampagnenBoard-Windows-Installer.zip (Windows-Dateien mit CRLF und UTF-8-BOM)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/KampagnenBoard-Windows-Installer.zip}"
python3 "$ROOT/scripts/build.py" >/dev/null
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
D="$TMP/KampagnenBoard"
mkdir -p "$D/setup" "$D/app"
cp -R "$ROOT/desktop/main.js" "$ROOT/desktop/preload.js" "$ROOT/desktop/package.json" "$ROOT/desktop/renderer" "$ROOT/desktop/build" "$D/app/"
python3 - "$ROOT/installer-win" "$D" <<'PY'
import sys, pathlib
src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
for f in src.rglob('*'):
    if f.is_dir(): continue
    rel = f.relative_to(src); out = dst / rel; out.parent.mkdir(parents=True, exist_ok=True)
    text = f.read_text(encoding='utf-8').replace('\r\n', '\n').replace('\n', '\r\n')
    enc = 'cp850' if f.suffix == '.bat' else 'utf-8-sig'
    out.write_bytes(text.encode(enc))
PY
rm -f "$OUT"
(cd "$TMP" && zip -qr -X "$OUT" KampagnenBoard)
echo "$OUT"
