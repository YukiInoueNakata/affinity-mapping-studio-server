// Preload script for the tray settings window.
// Exposes a tiny `window.tray` API to the renderer with contextIsolation=true.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tray', {
  getState: () => ipcRenderer.invoke('tray:get-state'),
  saveSettings: (opts) => ipcRenderer.invoke('tray:save-settings', opts),
  startServer: () => ipcRenderer.invoke('tray:start'),
  stopServer: () => ipcRenderer.invoke('tray:stop'),
});
