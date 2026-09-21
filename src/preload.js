const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('printerAPI', {
  choosePdf: () => ipcRenderer.invoke('choose-pdf'),
  getPathForFile: file => webUtils.getPathForFile(file),
  getPrinters: () => ipcRenderer.invoke('printers'),
  print: options => ipcRenderer.invoke('print-pdf', options),
  createPreview: options => ipcRenderer.invoke('create-preview', options),
  generatePreview: request => ipcRenderer.invoke('generate-job-preview', request),
  confirmPreview: options => ipcRenderer.invoke('confirm-preview', options),
  cancelPreview: jobId => ipcRenderer.invoke('cancel-preview', jobId),
  exitForm: () => ipcRenderer.invoke('exit-form'),
  exportPdf: jobId => ipcRenderer.invoke('export-preview-pdf', jobId),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  onPrintProgress: callback => ipcRenderer.on('print-progress', (_e, message) => callback(message)),
  onUpdateStatus: callback => ipcRenderer.on('update-status', (_e, data) => callback(data)),
  onVersion: callback => ipcRenderer.on('app-version', (_e, version) => callback(version)),
  onIncomingDocument: callback => ipcRenderer.on('incoming-document', (_e, job) => callback(job))
});
