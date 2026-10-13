const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  info: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  loadLocal: () => ipcRenderer.invoke('local:load'),
  saveLocal: (json) => ipcRenderer.send('local:save', json),
  saveLocalSync: (json) => ipcRenderer.sendSync('local:save-sync', json),
  assetFromFile: (file) => {
    let p = '';
    try { p = webUtils.getPathForFile(file); } catch {}
    return p ? ipcRenderer.invoke('asset:from-file', p) : Promise.resolve(null);
  },
  assetFromBytes: (bytes, ext) => ipcRenderer.invoke('asset:from-bytes', bytes, ext),
  assetRead: (src) => ipcRenderer.invoke('asset:read', src),
  linkMeta: (url) => ipcRenderer.invoke('link:meta', url),
  onMenu: (fn) => ipcRenderer.on('menu', (_e, cmd) => fn(cmd)),
});
