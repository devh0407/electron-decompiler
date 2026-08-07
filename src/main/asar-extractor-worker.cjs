const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const asar = await import('@electron/asar');
  const archivePath = workerData.archivePath;
  const outputDir = workerData.outputDir;
  fs.mkdirSync(outputDir, { recursive: true });

  const entries = asar.listPackage(archivePath, { isPack: false });
  const records = [];
  let totalBytes = 0;
  let totalFiles = 0;
  let unpackedFiles = 0;

  for (const fullPath of entries) {
    const relativePath = String(fullPath).replace(/^[/\\]+/, '');
    if (!relativePath) continue;
    let stat;
    try { stat = asar.statFile(archivePath, relativePath, false); } catch { continue; }
    const isDirectory = Boolean(stat && stat.files);
    const isLink = Boolean(stat && stat.link);
    const size = !isDirectory && !isLink && Number.isFinite(stat.size) ? stat.size : 0;
    if (!isDirectory && !isLink) {
      totalFiles += 1;
      totalBytes += size;
      if (stat.unpacked) unpackedFiles += 1;
    }
    records.push({ relativePath, isDirectory, isLink, size, executable: Boolean(stat.executable), unpacked: Boolean(stat.unpacked) });
  }

  parentPort.postMessage({ type: 'scan', totalEntries: records.length, totalFiles, totalBytes, unpackedFiles });

  let filesDone = 0;
  let entriesDone = 0;
  let bytesDone = 0;
  const warnings = [];

  for (const record of records) {
    const destination = path.resolve(outputDir, record.relativePath);
    const relGuard = path.relative(path.resolve(outputDir), destination);
    if (relGuard.startsWith('..') || path.isAbsolute(relGuard)) {
      warnings.push({ code: 'PATH_ESCAPE', path: record.relativePath, message: 'Skipped path escaping extraction root.' });
      continue;
    }

    try {
      if (record.isDirectory) {
        fs.mkdirSync(destination, { recursive: true });
      } else if (record.isLink) {
        warnings.push({ code: 'SYMLINK_SKIPPED', path: record.relativePath, message: 'Symlink skipped in safe extraction mode.' });
      } else {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const content = asar.extractFile(archivePath, record.relativePath);
        fs.writeFileSync(destination, content);
        if (record.executable && process.platform !== 'win32') fs.chmodSync(destination, 0o755);
        filesDone += 1;
        bytesDone += record.size;
      }
    } catch (error) {
      warnings.push({ code: record.unpacked ? 'UNPACKED_FILE_MISSING' : 'EXTRACT_FAILED', path: record.relativePath, message: error?.message || String(error) });
    }

    entriesDone += 1;
    parentPort.postMessage({
      type: 'extract',
      currentFile: record.relativePath,
      entriesDone,
      totalEntries: records.length,
      filesDone,
      totalFiles,
      bytesDone,
      totalBytes
    });
  }

  parentPort.postMessage({ type: 'done', warnings });
}

main().catch((error) => {
  parentPort.postMessage({ type: 'error', message: error?.message || String(error), stack: error?.stack });
});
