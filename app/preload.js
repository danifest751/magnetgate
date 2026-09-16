// Bridges a small, explicit API into the sandboxed renderer (contextIsolation on, no nodeIntegration).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mg', {
  getState: () => ipcRenderer.invoke('getState'),
  getLog: () => ipcRenderer.invoke('getLog'),
  getConfig: () => ipcRenderer.invoke('getConfig'),
  saveConfig: (cfg) => ipcRenderer.invoke('saveConfig', cfg),
  genPsk: () => ipcRenderer.invoke('genPsk'),
  startClient: () => ipcRenderer.invoke('startClient'),
  stopClient: () => ipcRenderer.invoke('stopClient'),
  vpnOn: () => ipcRenderer.invoke('vpnOn'),
  vpnOff: () => ipcRenderer.invoke('vpnOff'),
  connect: () => ipcRenderer.invoke('connect'),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  openConfigDir: () => ipcRenderer.invoke('openConfigDir'),
  openLogs: () => ipcRenderer.invoke('openLogs'),
  getLogPath: () => ipcRenderer.invoke('getLogPath'),
  clearLog: () => ipcRenderer.invoke('clearLog'),
  onLog: (cb) => ipcRenderer.on('log', (_e, line) => cb(line)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
})
