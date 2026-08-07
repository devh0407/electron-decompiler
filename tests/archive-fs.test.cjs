const test = require('node:test');
const assert = require('node:assert/strict');
const { selectArchiveFs } = require('../src/main/archive-fs.cjs');

test('selectArchiveFs uses original-fs inside Electron', () => {
  const calls = [];
  const original = { id: 'original' };
  const nodeFs = { id: 'node' };
  const selected = selectArchiveFs({
    isElectron: true,
    requireFn(id) {
      calls.push(id);
      if (id === 'original-fs') return original;
      if (id === 'node:fs') return nodeFs;
      throw new Error(`unexpected module: ${id}`);
    }
  });
  assert.equal(selected, original);
  assert.deepEqual(calls, ['original-fs']);
});

test('selectArchiveFs uses node:fs outside Electron', () => {
  const calls = [];
  const original = { id: 'original' };
  const nodeFs = { id: 'node' };
  const selected = selectArchiveFs({
    isElectron: false,
    requireFn(id) {
      calls.push(id);
      if (id === 'original-fs') return original;
      if (id === 'node:fs') return nodeFs;
      throw new Error(`unexpected module: ${id}`);
    }
  });
  assert.equal(selected, nodeFs);
  assert.deepEqual(calls, ['node:fs']);
});
