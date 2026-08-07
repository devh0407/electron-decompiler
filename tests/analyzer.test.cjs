const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  analyzeProject,
  analyzePreloadSource,
  splitTopLevel,
  resolveCodePath,
  resolveLoadFilePath
} = require('../src/main/analyzer.cjs');

test('splitTopLevel ignores nested commas', () => {
  assert.deepEqual(splitTopLevel("'api', { open: () => ipcRenderer.invoke('x', { a: 1 }) }, true"), [
    "'api'",
    "{ open: () => ipcRenderer.invoke('x', { a: 1 }) }",
    'true'
  ]);
});

test('resolveCodePath handles path.join(__dirname, ...)', () => {
  assert.equal(resolveCodePath("path.join(__dirname, 'renderer', 'index.html')", 'dist/main'), 'dist/main/renderer/index.html');
});

test('resolveLoadFilePath treats string literals as app-root relative', () => {
  assert.equal(resolveLoadFilePath("'dist/renderer/index.html'", 'dist/main'), 'dist/renderer/index.html');
});

test('analyzePreloadSource extracts contextBridge API and IPC mapping', () => {
  const result = analyzePreloadSource(`
    const { contextBridge, ipcRenderer } = require('electron');
    contextBridge.exposeInMainWorld('electronAPI', {
      getConfig: (key) => ipcRenderer.invoke('config:get', key),
      minimize: () => ipcRenderer.send('window:minimize'),
      events: {
        onUpdated: (callback) => ipcRenderer.on('config:updated', callback)
      },
      platform: process.platform
    });
  `, 'dist/preload/index.js');

  assert.equal(result.exposures[0].root, 'electronAPI');
  assert.equal(result.exposures[0].apiCount, 4);
  assert.deepEqual(result.apis.find((api) => api.path === 'electronAPI.getConfig').ipc, {
    channel: 'config:get', method: 'invoke', direction: 'renderer-to-main', async: true
  });
  assert.equal(result.apis.find((api) => api.path === 'electronAPI.events.onUpdated').kind, 'function');
  assert.equal(result.apis.find((api) => api.path === 'electronAPI.platform').kind, 'value');
});

test('analyzePreloadSource resolves simple bridge variable', () => {
  const result = analyzePreloadSource(`
    const bridge = {
      ping: () => ipcRenderer.invoke('ping')
    };
    contextBridge.exposeInMainWorld('bridge', bridge);
  `, 'preload.js');
  assert.equal(result.exposures[0].unresolved, false);
  assert.equal(result.apis[0].path, 'bridge.ping');
});

test('analyzeProject finds renderer, preload bridges and matches main IPC', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-decompiler-'));
  fs.mkdirSync(path.join(root, 'dist', 'main'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'renderer'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'preload'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture-app', version: '1.0.0', main: 'dist/main/index.js' }));
  fs.writeFileSync(path.join(root, 'dist', 'main', 'index.js'), `
    const { BrowserWindow, ipcMain } = require('electron');
    const path = require('node:path');
    const win = new BrowserWindow({ webPreferences: { preload: path.join(__dirname, '../preload/index.js') } });
    ipcMain.handle('config:get', () => ({ theme: 'dark' }));
    ipcMain.on('window:minimize', () => {});
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  `);
  fs.writeFileSync(path.join(root, 'dist', 'renderer', 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(root, 'dist', 'preload', 'index.js'), `
    contextBridge.exposeInMainWorld('electronAPI', {
      getConfig: () => ipcRenderer.invoke('config:get'),
      minimize: () => ipcRenderer.send('window:minimize')
    });
  `);

  const result = analyzeProject(root);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.mainEntry, 'dist/main/index.js');
  assert.equal(result.rendererEntries[0].path, 'dist/renderer/index.html');
  assert.equal(result.preloadScripts[0].path, 'dist/preload/index.js');
  assert.equal(result.bridgeExposures[0].root, 'electronAPI');
  assert.equal(result.rendererApis.length, 2);
  assert.equal(result.ipcChannels.find((ipc) => ipc.channel === 'config:get').status, 'matched');
  assert.equal(result.ipcChannels.find((ipc) => ipc.channel === 'window:minimize').status, 'matched');
});
