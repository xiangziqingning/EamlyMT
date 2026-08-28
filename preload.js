// 预加载脚本：安全地向页面暴露 Obsidian 与网络工具箱 API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('obsidianAPI', {
  pickVault: () => ipcRenderer.invoke('obs:pickVault'),
  openFolder: (p) => ipcRenderer.invoke('obs:openFolder', p),
  openInObsidian: (o) => ipcRenderer.invoke('obs:openInObsidian', o),
  scan: (root) => ipcRenderer.invoke('obs:scan', root),
  write: (o) => ipcRenderer.invoke('obs:write', o)
});

contextBridge.exposeInMainWorld('netAPI', {
  dnsTest: (o) => ipcRenderer.invoke('net:dnsTest', o),
  httpLatency: (o) => ipcRenderer.invoke('net:httpLatency', o),
  tcpPing: (o) => ipcRenderer.invoke('net:tcpPing', o),
  flushDns: () => ipcRenderer.invoke('net:flushDns'),
  openNcpa: () => ipcRenderer.invoke('net:openNcpa'),
  copy: (t) => ipcRenderer.invoke('net:copy', t),
  getCurrentDns: () => ipcRenderer.invoke('net:getCurrentDns'),
  applyFastDns: (o) => ipcRenderer.invoke('net:applyFastDns', o),
  restoreDns: (o) => ipcRenderer.invoke('net:restoreDns', o),
  wifiInfo: () => ipcRenderer.invoke('net:wifiInfo'),
  gateway: () => ipcRenderer.invoke('net:gateway'),
  ping: (o) => ipcRenderer.invoke('net:ping', o),
  speedTest: (o) => ipcRenderer.invoke('net:speedTest', o)
});

contextBridge.exposeInMainWorld('perfAPI', {
  status: () => ipcRenderer.invoke('perf:status'),
  apply: () => ipcRenderer.invoke('perf:apply'),
  restore: (o) => ipcRenderer.invoke('perf:restore', o)
});

contextBridge.exposeInMainWorld('apiAPI', {
  balance: (o) => ipcRenderer.invoke('api:balance', o)
});

contextBridge.exposeInMainWorld('diskAPI', {
  scan: () => ipcRenderer.invoke('disk:scan'),
  clean: (o) => ipcRenderer.invoke('disk:clean', o),
  bigFiles: (o) => ipcRenderer.invoke('disk:bigFiles', o),
  showInFolder: (p) => ipcRenderer.invoke('disk:showInFolder', p),
  cleanmgr: () => ipcRenderer.invoke('disk:cleanmgr')
});

contextBridge.exposeInMainWorld('updateAPI', {
  check: () => ipcRenderer.invoke('upd:check'),
  status: () => ipcRenderer.invoke('upd:status'),
  downloadInstall: () => ipcRenderer.invoke('upd:downloadInstall'),
  currentVersion: () => ipcRenderer.invoke('upd:currentVersion'),
  config: () => ipcRenderer.invoke('upd:config'),
  onStatus: (cb) => ipcRenderer.on('upd:status', (e, data) => cb(data))
});
