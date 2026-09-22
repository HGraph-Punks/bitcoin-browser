'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const CHANNELS = {
  READY: 'wallet-bridge:ready',
  EVENT: 'wallet-bridge:event',
  COMMAND: 'wallet-bridge:command'
};
contextBridge.exposeInMainWorld('walletHost', {
  ready: () => ipcRenderer.send(CHANNELS.READY),
  emit: (event) => ipcRenderer.send(CHANNELS.EVENT, event),
  onCommand: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, command) => callback(command);
    ipcRenderer.on(CHANNELS.COMMAND, listener);
    return () => ipcRenderer.removeListener(CHANNELS.COMMAND, listener);
  }
});
