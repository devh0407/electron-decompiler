function selectArchiveFs({
  isElectron = Boolean(process.versions?.electron),
  requireFn = require
} = {}) {
  return isElectron ? requireFn('original-fs') : requireFn('node:fs');
}

// Electron patches node:fs so paths ending in .asar behave like virtual
// directories. All I/O that targets the archive container itself must bypass
// that patch. Outside Electron (tests/CLI tooling), regular node:fs is correct.
const archiveFs = selectArchiveFs();

module.exports = { archiveFs, selectArchiveFs };
