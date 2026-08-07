const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EXTRACTION_SCHEMA_VERSION, ProjectManager } = require('../src/main/project-manager.cjs');

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

test('loadCachedProject invalidates workspaces from an older extraction schema', async () => {
  const manager = createManager();
  const projectId = 'fixture-project';
  const projectRoot = path.join(manager.workspaceRoot, projectId);
  const sourceDir = path.join(projectRoot, 'source');
  const analysisDir = path.join(projectRoot, 'analysis');
  const metaPath = path.join(projectRoot, 'project.json');
  const manifestPath = path.join(analysisDir, 'manifest.json');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(analysisDir, { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify({
    hash: 'abc',
    extractionSchemaVersion: EXTRACTION_SCHEMA_VERSION - 1,
    unpackedSiblingPresent: false,
    unpackedFingerprint: null
  }));
  fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 2 }));

  const cached = await manager.loadCachedProject({
    projectId,
    projectRoot,
    sourceDir,
    metaPath,
    manifestPath,
    archivePath: '/fixture/app.asar',
    hash: 'abc',
    unpackedState: { present: false, fingerprint: null }
  });

  assert.equal(cached, null);
});
