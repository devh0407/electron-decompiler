const path = require('node:path');

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_ILLEGAL_CHARS = /[<>:"|?*\x00-\x1f]/;

function normalizeArchivePath(input, { allowLeadingSlash = true } = {}) {
  const raw = String(input || '').replace(/\\/g, '/');
  if (!allowLeadingSlash && (/^\//.test(raw) || /^[A-Za-z]:\//.test(raw))) return null;
  const stripped = allowLeadingSlash ? raw.replace(/^\/+/, '') : raw;
  const normalized = path.posix.normalize(stripped || '.');
  if (!normalized || normalized === '.') return '';
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return null;
  return normalized.replace(/^\.\//, '');
}

function archiveEntryPathIssue(input) {
  if (String(input || '').includes('\0')) return 'NUL byte';
  return normalizeArchivePath(input) == null ? 'path escapes archive root' : null;
}

function linkTargetPathIssue(input) {
  if (String(input || '').includes('\0')) return 'NUL byte';
  return normalizeArchivePath(input, { allowLeadingSlash: false }) == null ? 'link target escapes archive root' : null;
}

function windowsPathIssue(relativePath) {
  const normalized = normalizeArchivePath(relativePath);
  if (normalized == null) return 'path escapes archive root';
  for (const segment of normalized.split('/')) {
    if (!segment) continue;
    if (WINDOWS_ILLEGAL_CHARS.test(segment)) return `illegal Windows filename characters in "${segment}"`;
    if (/[. ]$/.test(segment)) return `Windows filename ends with dot/space: "${segment}"`;
    if (WINDOWS_RESERVED.test(segment)) return `Windows reserved filename: "${segment}"`;
  }
  return null;
}

function entryType(stat) {
  if (stat && stat.files) return 'directory';
  if (stat && stat.link) return 'link';
  return 'file';
}

function resolveFinalLinkTarget(asar, archivePath, linkPath, maxDepth = 40) {
  let current = linkPath;
  const seen = new Set();
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (seen.has(current)) throw new Error(`Circular ASAR link detected at ${current}`);
    seen.add(current);
    const stat = asar.statFile(archivePath, current, false);
    if (!stat?.link) return current;
    const issue = linkTargetPathIssue(stat.link);
    if (issue) throw new Error(`${current}: ${issue}: ${stat.link}`);
    current = normalizeArchivePath(stat.link, { allowLeadingSlash: false });
  }
  throw new Error(`${linkPath}: too many levels of ASAR links`);
}

function buildExtractionPlan(asar, archivePath, entries, { platform = process.platform } = {}) {
  const records = [];
  const warnings = [];

  for (const fullPath of entries) {
    const issue = archiveEntryPathIssue(fullPath);
    const relativePath = normalizeArchivePath(fullPath);
    if (issue || !relativePath) {
      if (issue) warnings.push({ code: 'PATH_ESCAPE', path: String(fullPath), message: `Skipped unsafe archive entry: ${issue}.` });
      continue;
    }
    try {
      const stat = asar.statFile(archivePath, relativePath, false);
      records.push({ relativePath, stat, type: entryType(stat) });
    } catch (error) {
      warnings.push({ code: 'STAT_FAILED', path: relativePath, message: error?.message || String(error) });
    }
  }

  const tasks = new Map();
  const addTask = (task) => {
    if (!task?.relativePath || tasks.has(task.relativePath)) return;
    const winIssue = platform === 'win32' ? windowsPathIssue(task.relativePath) : null;
    tasks.set(task.relativePath, { ...task, virtualOnly: Boolean(winIssue), windowsPathIssue: winIssue });
    if (winIssue) {
      warnings.push({
        code: 'VIRTUAL_ONLY_WINDOWS_PATH',
        path: task.relativePath,
        message: `${winIssue}. Kept virtual and served directly from the ASAR at preview time.`
      });
    }
  };

  for (const record of records) {
    if (record.type === 'link') continue;
    addTask({
      relativePath: record.relativePath,
      sourcePath: record.relativePath,
      type: record.type,
      size: record.type === 'file' && Number.isFinite(record.stat?.size) ? record.stat.size : 0,
      executable: Boolean(record.stat?.executable),
      unpacked: Boolean(record.stat?.unpacked),
      materializedLink: false
    });
  }

  let linkRoots = 0;
  for (const record of records.filter((item) => item.type === 'link')) {
    const targetIssue = linkTargetPathIssue(record.stat?.link);
    if (targetIssue) {
      warnings.push({ code: 'LINK_TARGET_ESCAPE', path: record.relativePath, message: `${targetIssue}: ${record.stat?.link}` });
      continue;
    }

    let followed;
    let finalTarget;
    try {
      finalTarget = resolveFinalLinkTarget(asar, archivePath, record.relativePath);
      followed = asar.statFile(archivePath, record.relativePath, true);
    } catch (error) {
      warnings.push({ code: 'LINK_RESOLVE_FAILED', path: record.relativePath, message: error?.message || String(error) });
      continue;
    }

    linkRoots += 1;
    if (entryType(followed) === 'file') {
      addTask({
        relativePath: record.relativePath,
        sourcePath: record.relativePath,
        type: 'file',
        size: Number.isFinite(followed?.size) ? followed.size : 0,
        executable: Boolean(followed?.executable),
        unpacked: Boolean(followed?.unpacked),
        materializedLink: true,
        linkTarget: finalTarget
      });
      continue;
    }

    addTask({
      relativePath: record.relativePath,
      sourcePath: record.relativePath,
      type: 'directory',
      size: 0,
      executable: false,
      unpacked: Boolean(followed?.unpacked),
      materializedLink: true,
      linkTarget: finalTarget
    });

    const prefix = `${finalTarget}/`;
    for (const targetRecord of records) {
      if (!targetRecord.relativePath.startsWith(prefix)) continue;
      const suffix = targetRecord.relativePath.slice(prefix.length);
      if (!suffix) continue;
      const aliasPath = normalizeArchivePath(path.posix.join(record.relativePath, suffix));
      if (!aliasPath) continue;
      try {
        const aliasStat = asar.statFile(archivePath, aliasPath, true);
        const type = entryType(aliasStat);
        if (type === 'link') continue;
        addTask({
          relativePath: aliasPath,
          sourcePath: aliasPath,
          type,
          size: type === 'file' && Number.isFinite(aliasStat?.size) ? aliasStat.size : 0,
          executable: Boolean(aliasStat?.executable),
          unpacked: Boolean(aliasStat?.unpacked),
          materializedLink: true,
          linkTarget: finalTarget
        });
      } catch (error) {
        warnings.push({ code: 'LINK_CHILD_RESOLVE_FAILED', path: aliasPath, message: error?.message || String(error) });
      }
    }
  }

  const taskList = [...tasks.values()];
  const fileTasks = taskList.filter((task) => task.type === 'file');
  return {
    tasks: taskList,
    warnings,
    totalEntries: taskList.length,
    totalFiles: fileTasks.length,
    totalBytes: fileTasks.reduce((sum, task) => sum + task.size, 0),
    unpackedFiles: fileTasks.filter((task) => task.unpacked).length,
    linkRoots,
    virtualFiles: fileTasks.filter((task) => task.virtualOnly).length
  };
}

module.exports = {
  normalizeArchivePath,
  archiveEntryPathIssue,
  linkTargetPathIssue,
  windowsPathIssue,
  resolveFinalLinkTarget,
  buildExtractionPlan
};