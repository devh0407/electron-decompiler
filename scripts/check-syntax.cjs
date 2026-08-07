const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const roots = ['src', 'tests', 'scripts'];
const files = [];

function walk(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) walk(fullPath);
    else if (/\.(cjs|js)$/.test(entry.name)) files.push(fullPath);
  }
}

for (const root of roots) walk(path.resolve(root));
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
console.log(`Syntax OK: ${files.length} JavaScript files`);
