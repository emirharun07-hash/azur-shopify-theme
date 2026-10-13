#!/bin/bash
# Kampagnen Board – Installer für macOS
# Lädt die offizielle Electron-Laufzeit von GitHub, baut daraus "Kampagnen Board.app"
# in ~/Applications (Programme) und startet sie.
set -euo pipefail

ELECTRON_VERSION="33.4.11"
APP_NAME="Kampagnen Board"
HERE="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$HERE/app"
DEST_DIR="$HOME/Applications"
APP="$DEST_DIR/$APP_NAME.app"
ARCH="$(uname -m)"; [ "$ARCH" = "arm64" ] || ARCH="x64"
URL="https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/electron-v$ELECTRON_VERSION-darwin-$ARCH.zip"
CACHE="$HOME/Library/Caches/KampagnenBoard"
ZIP="$CACHE/electron-v$ELECTRON_VERSION-darwin-$ARCH.zip"

step() { printf '\n  > %s\n' "$1"; }

printf '\n  Kampagnen Board wird installiert ...\n  ------------------------------------\n'

if [ ! -f "$SOURCE/package.json" ]; then
  echo "  Der Ordner 'app' fehlt. Bitte die ZIP-Datei zuerst komplett entpacken (Doppelklick auf die ZIP)."
  exit 1
fi

step "Laufende App beenden"
pkill -f "$APP_NAME.app/Contents/MacOS/" 2>/dev/null || true
sleep 0.5

mkdir -p "$CACHE" "$DEST_DIR"
if [ ! -s "$ZIP" ]; then
  step "Electron $ELECTRON_VERSION ($ARCH) herunterladen, ca. 100 MB, nur beim ersten Mal ..."
  curl -fL --progress-bar -o "$ZIP.part" "$URL"
  mv "$ZIP.part" "$ZIP"
fi

step "App zusammenbauen"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ditto -x -k "$ZIP" "$TMP"
rm -rf "$APP"
mv "$TMP/Electron.app" "$APP"

RES="$APP/Contents/Resources"
PLIST="$APP/Contents/Info.plist"
rm -f "$RES/default_app.asar"
cp -R "$SOURCE" "$RES/app"
cp "$SOURCE/build/icon.icns" "$RES/electron.icns"

plutil -replace CFBundleName        -string "$APP_NAME"                      "$PLIST"
plutil -replace CFBundleDisplayName -string "$APP_NAME"                      "$PLIST"
plutil -replace CFBundleIdentifier  -string "com.emirharun.kampagnenboard"   "$PLIST"

step "Lokal signieren"
xattr -cr "$APP"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
touch "$APP"

step "Starten"
open "$APP"

printf '\n  Fertig! "Kampagnen Board" liegt in deinem Programme-Ordner:\n'
printf '  %s\n' "$APP"
printf '  Tipp: Im Dock mit Rechtsklick > Optionen > "Im Dock behalten" anheften.\n\n'
