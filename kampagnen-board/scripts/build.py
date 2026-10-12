#!/usr/bin/env python3
"""Baut aus src/ die beiden Fassungen des Kampagnen Boards:
  artifact/index.html   – eine Datei für claude.ai (geteilt über claude.ai)
  desktop/renderer/     – Oberfläche der Windows-App (lokal oder eigene Cloud)
"""
import json
import pathlib
import shutil

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'src'
read = lambda name: (SRC / name).read_text(encoding='utf-8')

head, css, markup, board = read('head.html'), read('board.css'), read('markup.html'), read('board.js')

# claude.ai: alles in einer Datei
artifact = (
    f"{head.strip()}\n<style>\n{css.strip()}\n</style>\n\n{markup.strip()}\n\n"
    f"<script>\n{read('backend-local.js').strip()}\n</script>\n"
    f"<script>\n{read('backend-claude.js').strip()}\n</script>\n"
    f"<script>\n{board.strip()}\n</script>\n"
)
(ROOT / 'artifact').mkdir(exist_ok=True)
(ROOT / 'artifact' / 'index.html').write_text(artifact, encoding='utf-8')

# Windows-App
out = ROOT / 'desktop' / 'renderer'
shutil.rmtree(out, ignore_errors=True)
out.mkdir(parents=True)
sql = (ROOT / 'supabase' / 'setup.sql').read_text(encoding='utf-8')
desktop_js = read('backend-desktop.js').replace("/*SETUP_SQL*/''", json.dumps(sql, ensure_ascii=False))
for name, text in {
    'board.css': css, 'board.js': board,
    'backend-local.js': read('backend-local.js'), 'backend-cloud.js': read('backend-cloud.js'),
    'backend-desktop.js': desktop_js,
}.items():
    (out / name).write_text(text, encoding='utf-8')
shutil.copy(ROOT / 'desktop' / 'vendor' / 'supabase.js', out / 'supabase.js')
(out / 'index.html').write_text(f"""<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kampagnen Board</title>
<link rel="stylesheet" href="board.css">
</head>
<body>
{markup.strip()}
<script src="supabase.js"></script>
<script src="backend-local.js"></script>
<script src="backend-cloud.js"></script>
<script src="backend-desktop.js"></script>
<script src="board.js"></script>
</body>
</html>
""", encoding='utf-8')
print('gebaut:', ROOT / 'artifact' / 'index.html', 'und', out)
