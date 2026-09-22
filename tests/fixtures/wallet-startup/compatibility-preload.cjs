// Diagnostic-only authority marker. Never reads application data or credentials.
const { contextBridge, ipcRenderer } = require('electron');
const marker = Object.freeze({ href: location.href, contextId: process.contextId,
  sandboxed: process.sandboxed === true, contextIsolated: process.contextIsolated === true,
  isMainFrame: process.isMainFrame === true });
contextBridge.exposeInMainWorld('startupCompatibility', Object.freeze({ contextId: marker.contextId }));
ipcRenderer.send('startup-compatibility:preload', marker);
