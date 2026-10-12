# Kampagnen Board

Freie Arbeitsfläche für kreative Kampagnen: Text, Notizen, Checklisten, Links, Bilder,
Videos, PDFs und Bereiche frei anordnen und mit geschwungenen Linien verbinden. Live zu zweit,
mit Cursor und Auswahl der anderen Person.

Es gibt zwei Fassungen aus demselben Code:

| Fassung | Speicherung | Teilen |
|---|---|---|
| **Windows-App** (`desktop/`) | lokal in `%APPDATA%\Kampagnen Board` oder eigene Supabase-Cloud | Einladungscode |
| **claude.ai** (`artifact/index.html`) | claude.ai | „Teilen“ in claude.ai |

## Aufbau

```
src/                  gemeinsamer Code
  markup.html, board.css, board.js   Oberfläche
  backend-local.js    Speicherung im Browser bzw. in einer Datei
  backend-claude.js   claude.ai (db, room, assets, user)
  backend-cloud.js    eigene Supabase-Cloud (Tabelle kb_docs, Speicher kb-media, Realtime)
  backend-desktop.js  Windows-App: wählt lokal/Cloud, Dialog „Live zu zweit“
desktop/              Electron-Hauptprozess, Preload, Symbole, vendor/supabase.js
installer-win/        Installieren.bat, Deinstallieren.bat, setup/*.ps1, LIESMICH.txt
supabase/setup.sql    einmalige Einrichtung der Cloud
scripts/build.py      baut artifact/index.html und desktop/renderer/
scripts/make-installer-zip.sh   baut KampagnenBoard-Windows-Installer.zip
```

## Entwickeln

```bash
python3 scripts/build.py                 # beide Fassungen bauen
cd desktop && npm install && npm start   # Windows-App lokal starten
./scripts/make-installer-zip.sh          # Installer-ZIP bauen
```

Daten-Pfade: `boards/{board}`, `boards/{board}/items/{item}`, `boards/{board}/links/{link}`.
Anwesenheit je Person: `{ pid, cur:[x,y], sel:[ids], drag:[[id,x,y,w,h]], edit }`.
