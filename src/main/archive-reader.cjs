const path = require('node:path');

let asarPromise;

function getAsar() {
  asarPromise ||= import('@electron/asar');
  return asarPromise;
}

function contentTypeFor(relativePath) {
  const ext = path.extname(String(relativePath || '')).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.cjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.xml': 'application/xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8'
  })[ext] || 'application/octet-stream';
}

async function readArchiveFile(archivePath, relativePath) {
  const asar = await getAsar();
  const stat = asar.statFile(archivePath, relativePath, true);
  if (stat?.files) throw new Error(`Expected file but found directory in ASAR: ${relativePath}`);
  return asar.extractFile(archivePath, relativePath, true);
}

module.exports = { contentTypeFor, readArchiveFile };
