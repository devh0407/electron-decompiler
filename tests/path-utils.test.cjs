const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { normalizeRelative, resolveInside } = require('../src/main/path-utils.cjs');

test('normalizeRelative normalizes separators and leading slashes', () => {
  assert.equal(normalizeRelative('\\dist\\renderer\\index.html'), 'dist/renderer/index.html');
  assert.equal(normalizeRelative('./dist/renderer/index.html'), 'dist/renderer/index.html');
});

test('resolveInside accepts paths within the root', () => {
  const root = path.resolve('/tmp/example-root');
  assert.equal(resolveInside(root, 'dist/index.html'), path.join(root, 'dist/index.html'));
});

test('resolveInside rejects traversal', () => {
  const root = path.resolve('/tmp/example-root');
  assert.throws(() => resolveInside(root, '../secret.txt'), /escapes project root/);
});
