// Kampagnen Board – App für Windows und Mac (Hauptprozess)
// Fenster, Einstellungen, lokale Speicherung (data.json + Ordner "assets") und Link-Vorschauen.
const { app, BrowserWindow, ipcMain, nativeTheme, shell, net, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL, fileURLToPath } = require('url');

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('com.emirharun.kampagnenboard');

const userDir = () => app.getPath('userData');
const file = (n) => path.join(userDir(), n);
const assetsDir = () => file('assets');
let win;
const isMac = process.platform === 'darwin';

function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function writeAtomic(f, text) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', text);
  if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak');
  fs.renameSync(f + '.tmp', f);
}
function assetName(ext) {
  const clean = String(ext || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.${clean}`;
}
const overlay = () => nativeTheme.shouldUseDarkColors
  ? { color: '#161617', symbolColor: '#f5f5f7', height: 44 }
  : { color: '#fbfbfd', symbolColor: '#1d1d1f', height: 44 };

function createWindow() {
  const saved = readJSON(file('window.json')) || {};
  win = new BrowserWindow({
    width: saved.width || 1440, height: saved.height || 900, x: saved.x, y: saved.y,
    minWidth: 820, minHeight: 520,
    title: 'Kampagnen Board',
    icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161617' : '#fbfbfd',
    // Mac: eigene Ampel-Knöpfe im Fenster. Windows: Fensterknöpfe oben rechts über der Fläche.
    ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 } } : { titleBarStyle: 'hidden', titleBarOverlay: overlay() }),
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: true },
  });
  if (saved.maximized) win.maximize();
  if (!isMac) win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Gezogene Dateien nie als Seite öffnen, Links im Browser bzw. mit dem passenden Programm.
  win.webContents.on('will-navigate', (e, url) => { if (url !== win.webContents.getURL()) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    else if (url.startsWith('file:')) {
      const p = fileURLToPath(url);
      if (p.startsWith(assetsDir())) shell.openPath(p);
    }
    return { action: 'deny' };
  });
  win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') win.webContents.toggleDevTools();
    if (input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r')) { e.preventDefault(); win.webContents.reload(); }
  });
  win.on('close', () => {
    if (win.isMinimized()) return;
    try { fs.writeFileSync(file('window.json'), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch {}
  });
}

nativeTheme.on('updated', () => { if (!isMac && win && !win.isDestroyed()) win.setTitleBarOverlay(overlay()); });

// Mac braucht ein Menü, sonst gehen Kopieren/Einfügen in Textfeldern nicht.
// Rückgängig, Wiederholen und Alles auswählen entscheidet die Oberfläche selbst (Text oder Board).
function buildMacMenu() {
  const send = (cmd) => () => win?.webContents.send('menu', cmd);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'Ablage', submenu: [{ label: 'Neues Board', accelerator: 'Cmd+N', click: send('new-board') }, { type: 'separator' }, { role: 'close' }] },
    { label: 'Bearbeiten', submenu: [
      { label: 'Widerrufen', accelerator: 'Cmd+Z', click: send('undo') },
      { label: 'Wiederholen', accelerator: 'Shift+Cmd+Z', click: send('redo') },
      { type: 'separator' },
      { role: 'cut', label: 'Ausschneiden' }, { role: 'copy', label: 'Kopieren' }, { role: 'paste', label: 'Einfügen' },
      { label: 'Alles auswählen', accelerator: 'Cmd+A', click: send('select-all') },
    ] },
    { label: 'Darstellung', submenu: [
      { label: 'Alles zeigen', accelerator: 'Cmd+0', click: send('fit') },
      { label: 'Vergrößern', accelerator: 'Cmd+Plus', click: send('zoom-in') },
      { label: 'Verkleinern', accelerator: 'Cmd+-', click: send('zoom-out') },
      { type: 'separator' }, { role: 'togglefullscreen', label: 'Vollbild' },
    ] },
    { role: 'windowMenu', label: 'Fenster' },
  ]));
}
app.on('second-instance', () => { if (!win) return; if (win.isMinimized()) win.restore(); win.focus(); });

ipcMain.handle('app:info', () => ({ username: os.userInfo().username, platform: process.platform, version: app.getVersion(), defaultCloud: readJSON(path.join(__dirname, 'default-cloud.json')) }));
ipcMain.handle('settings:get', () => readJSON(file('settings.json')) || {});
ipcMain.handle('settings:set', (_e, s) => { writeAtomic(file('settings.json'), JSON.stringify(s, null, 2)); return true; });

ipcMain.handle('local:load', () => {
  fs.mkdirSync(assetsDir(), { recursive: true });
  return { docs: readJSON(file('data.json')) || readJSON(file('data.json.bak')) || {}, assetsBase: pathToFileURL(assetsDir()).href + '/' };
});
ipcMain.on('local:save', (_e, json) => { try { writeAtomic(file('data.json'), json); } catch (err) { console.error(err); } });
ipcMain.on('local:save-sync', (e, json) => { try { writeAtomic(file('data.json'), json); e.returnValue = true; } catch { e.returnValue = false; } });

ipcMain.handle('asset:from-file', async (_e, src) => {
  fs.mkdirSync(assetsDir(), { recursive: true });
  const name = assetName(path.extname(src).slice(1));
  await fs.promises.copyFile(src, path.join(assetsDir(), name));
  return 'file:' + name;
});
ipcMain.handle('asset:from-bytes', (_e, bytes, ext) => {
  fs.mkdirSync(assetsDir(), { recursive: true });
  const name = assetName(ext);
  fs.writeFileSync(path.join(assetsDir(), name), Buffer.from(bytes));
  return 'file:' + name;
});
ipcMain.handle('asset:read', async (_e, src) => {
  if (!String(src).startsWith('file:')) return null;
  try { return new Uint8Array(await fs.promises.readFile(path.join(assetsDir(), path.basename(String(src).slice(5))))); } catch { return null; }
});

// Titel und Vorschaubild einer Webseite lesen.
ipcMain.handle('link:meta', async (_e, url) => {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await net.fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', 'Accept-Language': 'de,en;q=0.8' } });
    clearTimeout(timer);
    const type = res.headers.get('content-type') || '';
    if (type.startsWith('image/')) return { title: '', image: url };
    if (!type.includes('html')) return null;
    const html = (await res.text()).slice(0, 500000);
    const meta = (prop) => {
      const tag = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i'));
      const c = tag && tag[0].match(/content=["']([^"']*)["']/i);
      return c ? c[1] : '';
    };
    const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    const t = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    let image = meta('og:image') || meta('twitter:image');
    if (image) { try { image = new URL(decode(image), res.url || url).href; } catch { image = ''; } }
    return { title: decode(meta('og:title') || (t ? t[1] : '')), image };
  } catch { return null; }
});

app.whenReady().then(() => { if (isMac) buildMacMenu(); createWindow(); });
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
app.on('window-all-closed', () => { if (!isMac) app.quit(); });
