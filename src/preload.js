const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nixvpn', {
  getState: () => ipcRenderer.invoke('state:get'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close'),
  copyText: (value) => ipcRenderer.invoke('clipboard:write', value),
  addProfile: (url) => ipcRenderer.invoke('profiles:add', url),
  updateProfile: (id) => ipcRenderer.invoke('profiles:update', id),
  renameProfile: (id, name) => ipcRenderer.invoke('profiles:rename', id, name),
  removeProfile: (id) => ipcRenderer.invoke('profiles:remove', id),
  checkPings: () => ipcRenderer.invoke('servers:ping'),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
  selectServer: (id) => ipcRenderer.invoke('connection:select-server', id),
  setMode: (mode) => ipcRenderer.invoke('connection:set-mode', mode),
  toggleConnection: () => ipcRenderer.invoke('connection:toggle'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  onStateChanged: (callback) => ipcRenderer.on('state:changed', (_event, nextState) => callback(nextState)),
  onLogsChanged: (callback) => ipcRenderer.on('logs:changed', (_event, logs) => callback(logs))
});
