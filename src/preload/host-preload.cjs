const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronDecompiler', {
  chooseAsar: () => ipcRenderer.invoke('asar:choose'),
  importAsar: (filePath) => ipcRenderer.invoke('project:import', filePath),
  listDirectory: (projectId, path = '') => ipcRenderer.invoke('project:list-directory', { projectId, path }),
  getMocks: (projectId) => ipcRenderer.invoke('project:get-mocks', projectId),
  saveMocks: (projectId, mocks) => ipcRenderer.invoke('project:save-mocks', { projectId, mocks }),
  loadPreview: (projectId, path) => ipcRenderer.invoke('preview:load', { projectId, path }),
  setPreviewBounds: (bounds) => ipcRenderer.send('preview:set-bounds', bounds),
  hidePreview: () => ipcRenderer.send('preview:hide'),
  reloadPreview: () => ipcRenderer.send('preview:reload'),
  openPreviewDevTools: () => ipcRenderer.send('preview:devtools'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('project:progress', listener);
    return () => ipcRenderer.removeListener('project:progress', listener);
  },
  onPreviewConsole: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('preview:console', listener);
    return () => ipcRenderer.removeListener('preview:console', listener);
  }
});
