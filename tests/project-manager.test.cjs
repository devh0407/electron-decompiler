const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProjectManager } = require('../src/main/project-manager.cjs');

function createManager() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-decompiler-workspace-'));
  return new ProjectManager({ workspaceRoot });
}

test('inspectUnpackedSibling reports an absent companion', async () => {
  const manager = createManager();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-decompiler-asar-'));
  const archivePath = path.join(root, 'app.asar');
  fs.writeFileSync(archivePath, 'fixture');

  assert.deepEqual(await manager.inspectUnpackedSibling(archivePath), {
    present: false,
    fingerprint: null
  });
});

test('inspectUnpackedSibling fingerprint changes when companion files change', async () => {
  const manager = createManager();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-decompiler-asar-'));
  const archivePath = path.join(root, 'app.asar');
  const unpacked = `${archivePath}.unpacked`;
  fs.writeFileSync(archivePath, 'fixture');
  fs.mkdirSync(path.join(unpacked, 'native'), { recursive: true });
  const target = path.join(unpacked, 'native', 'addon.node');
  fs.writeFileSync(target, 'first');

  const first = await manager.inspectUnpackedSibling(archivePath);
  assert.equal(first.present, true);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);

  await new Promise((resolve) => setTimeout(resolve, 5));
  fs.writeFileSync(target, 'second-version');
  const second = await manager.inspectUnpackedSibling(archivePath);
  assert.equal(second.present, true);
  assert.notEqual(second.fingerprint, first.fingerprint);
});
