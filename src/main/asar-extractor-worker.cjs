const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { buildExtractionPlan } = require('./extraction-plan.cjs');

async function main() {
  const asar = await import('@electron/asar');
  const archivePath = workerData.archivePath;
  const outputDir = workerData.outputDir;
  fs.mkdirSync(outputDir, { recursive: true });

  const entries = asar.listPackage(archivePath, { isPack: false });
  const plan = buildExtractionPlan(asar, archivePath, entries);
  const warnings = [...plan.warnings];

  parentPort.postMessage({
    type: 'scan',
    totalEntries: plan.totalEntries,
    totalFiles: plan.totalFiles,
    totalBytes: plan.totalBytes,
    unpackedFiles: plan.unpackedFiles,
    linkRoots: plan.linkRoots,
    virtualFiles: plan.virtualFiles
  });

  let filesDone = 0;
  let entriesDone = 0;
  let bytesDone = 0;
  const outputRoot = path.resolve(outputDir);

  for (const task of plan.tasks) {
    const destination = path.resolve(outputRoot, task.relativePath);
    const relGuard = path.relative(outputRoot, destination);
    if (relGuard.startsWith('..') || path.isAbsolute(relGuard)) {
      warnings.push({ code: 'PATH_ESCAPE', path: task.relativePath, message: 'Skipped path escaping extraction root.' });
      entriesDone += 1;
      continue;
    }

    try {
      if (task.virtualOnly) {
        // Some valid ASAR names cannot be represented by the Windows filesystem
        // (for example CON.txt or names ending with a dot). Keep them virtual;
        // the preview protocol can read the original path directly from ASAR.
        if (task.type === 'file') {
          filesDone += 1;
          bytesDone += task.size;
        }
      } else if (task.type === 'directory') {
        fs.mkdirSync(destination, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const content = asar.extractFile(archivePath, task.sourcePath, true);
        fs.writeFileSync(destination, content);
        if (task.executable && process.platform !== 'win32') fs.chmodSync(destination, 0o755);
        filesDone += 1;
        bytesDone += task.size;
      }
    } catch (error) {
      const code = task.unpacked
        ? 'UNPACKED_FILE_MISSING'
        : task.materializedLink
          ? 'LINK_MATERIALIZE_FAILED'
          : 'EXTRACT_FAILED';
      warnings.push({ code, path: task.relativePath, message: error?.message || String(error) });
    }

    entriesDone += 1;
    parentPort.postMessage({
      type: 'extract',
      currentFile: task.relativePath,
      entriesDone,
      totalEntries: plan.totalEntries,
      filesDone,
      totalFiles: plan.totalFiles,
      bytesDone,
      totalBytes: plan.totalBytes
    });
  }

  parentPort.postMessage({
    type: 'done',
    warnings,
    linkRoots: plan.linkRoots,
    virtualFiles: plan.virtualFiles
  });
}

main().catch((error) => {
  parentPort.postMessage({ type: 'error', message: error?.message || String(error), stack: error?.stack });
});
