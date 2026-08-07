const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildExtractionPlan,
  normalizeArchivePath,
  windowsPathIssue
} = require('../src/main/extraction-plan.cjs');

function fakeAsar() {
  const dir = () => ({ files: {} });
  const file = (size = 1) => ({ size, unpacked: false, executable: false });
  const raw = {
    assets: dir(),
    'assets/app.js': file(7),
    'alias.js': { link: 'assets/app.js' },
    'linked-assets': { link: 'assets' }
  };
  return {
    statFile(_archive, relativePath, followLinks = true) {
      if (!followLinks) {
        if (!raw[relativePath]) throw new Error(`missing raw ${relativePath}`);
        return raw[relativePath];
      }
      if (relativePath === 'alias.js') return raw['assets/app.js'];
      if (relativePath === 'linked-assets') return raw.assets;
      if (relativePath === 'linked-assets/app.js') return raw['assets/app.js'];
      if (!raw[relativePath]) throw new Error(`missing followed ${relativePath}`);
      return raw[relativePath];
    }
  };
}

test('normalizeArchivePath rejects traversal', () => {
  assert.equal(normalizeArchivePath('/assets/app.js'), 'assets/app.js');
  assert.equal(normalizeArchivePath('../secret.txt'), null);
  assert.equal(normalizeArchivePath('a/../../secret.txt'), null);
});

test('windowsPathIssue detects reserved and invalid names', () => {
  assert.match(windowsPathIssue('assets/CON.txt'), /reserved filename/);
  assert.match(windowsPathIssue('assets/trailing.'), /ends with dot\/space/);
  assert.match(windowsPathIssue('assets/a:b.js'), /illegal Windows filename/);
  assert.equal(windowsPathIssue('assets/app.js'), null);
});

test('buildExtractionPlan materializes file and directory links without symlinks', () => {
  const entries = ['/assets', '/assets/app.js', '/alias.js', '/linked-assets'];
  const plan = buildExtractionPlan(fakeAsar(), 'fixture.asar', entries, { platform: 'linux' });
  const tasks = new Map(plan.tasks.map((task) => [task.relativePath, task]));

  assert.equal(tasks.get('alias.js').type, 'file');
  assert.equal(tasks.get('alias.js').sourcePath, 'alias.js');
  assert.equal(tasks.get('alias.js').materializedLink, true);
  assert.equal(tasks.get('linked-assets').type, 'directory');
  assert.equal(tasks.get('linked-assets/app.js').type, 'file');
  assert.equal(tasks.get('linked-assets/app.js').sourcePath, 'linked-assets/app.js');
  assert.equal(plan.linkRoots, 2);
  assert.equal(plan.warnings.some((warning) => warning.code === 'SYMLINK_SKIPPED'), false);
});

test('buildExtractionPlan keeps Windows-unrepresentable files virtual', () => {
  const asar = {
    statFile() { return { size: 3, unpacked: false, executable: false }; }
  };
  const plan = buildExtractionPlan(asar, 'fixture.asar', ['/assets/CON.txt'], { platform: 'win32' });
  assert.equal(plan.tasks[0].virtualOnly, true);
  assert.equal(plan.virtualFiles, 1);
  assert.equal(plan.warnings[0].code, 'VIRTUAL_ONLY_WINDOWS_PATH');
});

test('buildExtractionPlan rejects a link target escaping the archive', () => {
  const asar = {
    statFile(_archive, relativePath, followLinks = true) {
      if (relativePath === 'escape') return followLinks ? { size: 1 } : { link: '../outside' };
      throw new Error('unexpected');
    }
  };
  const plan = buildExtractionPlan(asar, 'fixture.asar', ['/escape'], { platform: 'linux' });
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.warnings[0].code, 'LINK_TARGET_ESCAPE');
});
