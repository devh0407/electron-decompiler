const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildRuntimeShim } = require('../src/main/runtime-shim.cjs');
const { normalizeMocks } = require('../src/main/mock-registry.cjs');

function runShim(manifest, mocks) {
  const logs = [];
  const context = {
    window: {
      addEventListener() {}
    },
    console: {
      warn: (value) => logs.push(String(value)),
      info: (value) => logs.push(String(value)),
      error: (value) => logs.push(String(value)),
      log: (value) => logs.push(String(value))
    },
    Date,
    Error,
    Object,
    Promise,
    Proxy,
    Symbol,
    JSON,
    String,
    Array,
    Boolean
  };
  vm.createContext(context);
  vm.runInContext(buildRuntimeShim(manifest, mocks), context);
  return { context, logs };
}

test('runtime shim installs bridge root and resolves API mock', () => {
  const { context, logs } = runShim({
    bridgeExposures: [{ root: 'electronAPI' }],
    rendererApis: [{ path: 'electronAPI.getVersion', kind: 'function', ipc: null }]
  }, { version: 1, apis: { 'electronAPI.getVersion': { return: '1.2.3' } }, ipc: {} });
  assert.equal(context.window.electronAPI.getVersion(), '1.2.3');
  assert.ok(logs.some((line) => line.includes('mock-hit')));
});

test('runtime shim returns Promise for mocked ipcRenderer.invoke bridge', async () => {
  const { context } = runShim({
    bridgeExposures: [{ root: 'electronAPI' }],
    rendererApis: [{ path: 'electronAPI.getConfig', kind: 'function', ipc: { channel: 'config:get', method: 'invoke', async: true } }]
  }, { version: 1, apis: {}, ipc: { 'config:get': { return: { theme: 'dark' } } } });
  const result = context.window.electronAPI.getConfig('theme');
  assert.equal(typeof result.then, 'function');
  assert.equal((await result).theme, 'dark');
});

test('runtime shim logs missing API once and tolerates nested unknown methods', () => {
  const { context, logs } = runShim({ bridgeExposures: [{ root: 'desktop' }], rendererApis: [] }, { version: 1, apis: {}, ipc: {} });
  assert.equal(context.window.desktop.window.minimize(), undefined);
  assert.equal(context.window.desktop.window.minimize(), undefined);
  assert.equal(logs.filter((line) => line.includes('missing-api')).length, 1);
});

test('normalizeMocks validates sections', () => {
  assert.deepEqual(normalizeMocks({ apis: { a: { return: 1 } }, ipc: {} }), { version: 1, apis: { a: { return: 1 } }, ipc: {} });
  assert.throws(() => normalizeMocks({ apis: [], ipc: {} }), /mocks\.apis/);
});
