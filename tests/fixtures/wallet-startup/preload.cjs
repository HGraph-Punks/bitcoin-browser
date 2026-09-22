const { contextBridge, ipcRenderer } = require('electron');

const marker = Object.freeze({
  href: location.href,
  sandboxed: process.sandboxed === true,
  contextIsolated: process.contextIsolated === true
});

contextBridge.exposeInMainWorld('walletStartupMarker', marker);
ipcRenderer.send('wallet-startup:preload', marker);
