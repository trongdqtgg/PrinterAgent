const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('jobAPI', {
  onPrepare: callback => ipcRenderer.on('prepare', (_e, data) => callback(data)),
  readPdf: filePath => ipcRenderer.invoke('read-pdf', filePath),
  ready: id => ipcRenderer.send(`print-ready-${id}`, { ok: true }),
  startupError: (id, error) => ipcRenderer.send(`print-ready-${id}`, { ok: false, error }),
  done: (id, info) => ipcRenderer.send(`prepared-${id}`, info)
});
