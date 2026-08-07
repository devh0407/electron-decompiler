const path = require('node:path');

function normalizeRelative(input) {
  return String(input || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+/g, '/');
}

function resolveInside(root, relativePath) {
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, normalizeRelative(relativePath));
  const rel = path.relative(rootResolved, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes project root: ${relativePath}`);
  }
  return target;
}

function toPosixRelative(fromDir, absolutePath) {
  return normalizeRelative(path.relative(fromDir, absolutePath));
}

module.exports = { normalizeRelative, resolveInside, toPosixRelative };
