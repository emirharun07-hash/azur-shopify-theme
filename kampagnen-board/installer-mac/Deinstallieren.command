#!/bin/bash
# Kampagnen Board entfernen. Deine Boards bleiben in ~/Library/Application Support/Kampagnen Board.
APP_NAME="Kampagnen Board"
pkill -f "$APP_NAME.app/Contents/MacOS/" 2>/dev/null || true
sleep 0.5
rm -rf "$HOME/Applications/$APP_NAME.app"
printf '\n  Kampagnen Board wurde entfernt.\n'
printf '  Deine Boards liegen weiterhin in: ~/Library/Application Support/%s\n\n' "$APP_NAME"
