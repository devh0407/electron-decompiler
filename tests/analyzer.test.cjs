const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyzeProject, resolveCodePath, resolveLoadFilePath } = require('../src/main/analyzer.cjs');

test('resolveCodePath handles path.join(__dirname, ...)', () => {
  assert.equal(resolveCodePath("path.join(__dirname, 'renderer', 'index.html')", 'dist/main'), 'dist/main/renderer/index.html');
});

test('resolveLoadFilePath treats string literals as app-root relative', () => {
  assert.equal(resolveLoadFilePath("'dist/renderer/index.html'", 'dist/main'), 'dist/renderer/index.html');
});

test('analyzeProject finds package main, loadFile and preload', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-decompiler-'));
  fs.mkdirSync(path.join(root, 'dist', 'main'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'renderer'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'preload'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture-app', version: '1.0.0', main: 'dist/main/index.js' }));
  fs.writeFileSync(path.join(root, 'dist', 'main', 'index.js'), `
    const { BrowserWindow } = require('electron');
    const path = require('node:path');
    const win = new BrowserWindow({ webPreferences: { preload: path.join(__dirname, '../preload/index.js') } });
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  `);
  fs.writeFileSync(path.join(root, 'dist', 'renderer', 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(root, 'dist', 'preload', 'index.js'), '');

  const result = analyzeProject(root);
  assert.equal(result.mainEntry, 'dist/main/index.js');
  assert.equal(result.rendererEntries[0].path, 'dist/renderer/index.html');
  assert.equal(result.rendererEntries[0].confidence, 100);
  assert.equal(result.preloadScripts[0].path, 'dist/preload/index.js');
});
