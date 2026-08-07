const test = require('node:test');
const assert = require('node:assert/strict');
const { contentTypeFor } = require('../src/main/archive-reader.cjs');

test('contentTypeFor returns strict MIME types for virtual preview files', () => {
  assert.equal(contentTypeFor('assets/app.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('assets/app.mjs'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('assets/app.css'), 'text/css; charset=utf-8');
  assert.equal(contentTypeFor('assets/data.json'), 'application/json; charset=utf-8');
  assert.equal(contentTypeFor('assets/icon.svg'), 'image/svg+xml');
  assert.equal(contentTypeFor('assets/module.wasm'), 'application/wasm');
  assert.equal(contentTypeFor('assets/blob.bin'), 'application/octet-stream');
});
