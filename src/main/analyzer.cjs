const fs = require('node:fs');
const path = require('node:path');
const { normalizeRelative, resolveInside, toPosixRelative } = require('./path-utils.cjs');

function safeReadText(filePath, maxBytes = 8 * 1024 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readJson(filePath) {
  const text = safeReadText(filePath, 2 * 1024 * 1024);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function findFiles(root, predicate, limit = 500) {
  const result = [];
  const queue = [''];
  while (queue.length && result.length < limit) {
    const relDir = queue.shift();
    const dir = resolveInside(root, relDir);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (result.length >= limit) break;
      const rel = normalizeRelative(path.posix.join(relDir.replace(/\\/g, '/'), entry.name));
      if (entry.isDirectory()) queue.push(rel);
      else if (entry.isFile() && predicate(rel)) result.push(rel);
    }
  }
  return result;
}

function resolveLoadFilePath(expression, mainDir) {
  if (!expression) return null;
  const trimmed = expression.trim();
  const direct = trimmed.match(/^(['"`])([^'"`]+)\1$/);
  if (direct) return normalizeRelative(direct[2]);
  return resolveCodePath(trimmed, mainDir);
}

function extractStringLiterals(expression) {
  const values = [];
  const regex = /(['"`])((?:\\.|(?!\1).)*)\1/g;
  let match;
  while ((match = regex.exec(expression))) {
    values.push(match[2].replace(/\\([\\'"`])/g, '$1'));
  }
  return values;
}

function resolveCodePath(expression, mainDir) {
  if (!expression) return null;
  const trimmed = expression.trim();
  const direct = trimmed.match(/^(['"`])([^'"`]+)\1$/);
  if (direct) return normalizeRelative(path.join(mainDir, direct[2]));

  if (/\b(?:path\.)?(?:join|resolve)\s*\(/.test(trimmed) && /__dirname/.test(trimmed)) {
    const parts = extractStringLiterals(trimmed);
    if (parts.length) return normalizeRelative(path.join(mainDir, ...parts));
  }

  const template = trimmed.match(/^`\$\{__dirname\}[\\/]([^`]+)`$/);
  if (template) return normalizeRelative(path.join(mainDir, template[1]));
  return null;
}

function readBalanced(source, start, initialDepth = 1) {
  let depth = initialDepth;
  let quote = null;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { text: source.slice(start, i), end: i };
    }
  }
  return { text: source.slice(start), end: source.length };
}

function firstTopLevelArgument(expression) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = 0; i < expression.length; i += 1) {
    const ch = expression[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) return expression.slice(0, i).trim();
  }
  return expression.trim();
}

function readPropertyExpression(source, start) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let i = start;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  const valueStart = i;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === '}' && depth === 0) break;
    else if (ch === '}' && depth > 0) depth -= 1;
    else if (ch === ',' && depth === 0) break;
    if (ch === '\n' && depth === 0) break;
  }
  return source.slice(valueStart, i).trim();
}

function collectCalls(source, methodName) {
  const calls = [];
  const regex = new RegExp(`\\.${methodName}\\s*\\(`, 'g');
  let match;
  while ((match = regex.exec(source))) {
    const parsed = readBalanced(source, regex.lastIndex, 1);
    calls.push({ expression: parsed.text.trim(), index: match.index });
    regex.lastIndex = Math.max(regex.lastIndex, parsed.end + 1);
  }
  return calls;
}

function detectPreloads(source, mainDir) {
  const results = [];
  const regex = /\bpreload\s*:/g;
  let match;
  while ((match = regex.exec(source))) {
    const expression = readPropertyExpression(source, regex.lastIndex);
    const resolved = resolveCodePath(expression, mainDir);
    if (resolved) results.push({ path: resolved, confidence: 85, source: 'BrowserWindow.webPreferences.preload' });
  }
  return dedupeByPath(results);
}

function detectRendererEntries(source, mainDir) {
  const candidates = [];

  for (const call of collectCalls(source, 'loadFile')) {
    const firstArg = firstTopLevelArgument(call.expression);
    const resolved = resolveLoadFilePath(firstArg, mainDir);
    if (resolved) candidates.push({ path: resolved, type: 'file', confidence: 100, source: 'BrowserWindow.loadFile' });
  }

  for (const call of collectCalls(source, 'loadURL')) {
    const expr = firstTopLevelArgument(call.expression);
    const literal = expr.match(/^(['"`])([^'"`]+)\1$/);
    if (!literal) continue;
    const value = literal[2];
    if (/^https?:\/\//i.test(value)) {
      candidates.push({ url: value, type: 'url', confidence: 95, source: 'BrowserWindow.loadURL' });
    } else if (/^file:\/\//i.test(value)) {
      candidates.push({ url: value, type: 'url', confidence: 80, source: 'BrowserWindow.loadURL(file)' });
    }
  }

  return dedupeEntries(candidates);
}

function scoreHtmlFallback(rel) {
  const normalized = normalizeRelative(rel).toLowerCase();
  if (normalized === 'index.html') return 50;
  if (/^(dist|build|out)\/renderer\/index\.html$/.test(normalized)) return 75;
  if (/^(dist|build|out)\/index\.html$/.test(normalized)) return 65;
  if (/\/renderer\/index\.html$/.test(normalized)) return 60;
  if (/\/index\.html$/.test(normalized)) return 45;
  return 20;
}

function dedupeByPath(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.path;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeEntries(items) {
  const map = new Map();
  for (const item of items) {
    const key = item.path ? `file:${item.path}` : `url:${item.url}`;
    const prev = map.get(key);
    if (!prev || item.confidence > prev.confidence) map.set(key, item);
  }
  return [...map.values()].sort((a, b) => b.confidence - a.confidence);
}

function analyzeProject(sourceDir) {
  const warnings = [];
  const packagePath = path.join(sourceDir, 'package.json');
  const packageJson = readJson(packagePath) || {};

  let mainEntry = typeof packageJson.main === 'string' ? normalizeRelative(packageJson.main) : null;
  if (!mainEntry) {
    for (const fallback of ['main.js', 'main.cjs', 'index.js', 'src/main.js']) {
      if (fs.existsSync(resolveInside(sourceDir, fallback))) {
        mainEntry = fallback;
        break;
      }
    }
  }

  let mainSource = null;
  let mainDir = '';
  if (mainEntry) {
    const mainPath = resolveInside(sourceDir, mainEntry);
    mainSource = safeReadText(mainPath);
    mainDir = normalizeRelative(path.dirname(mainEntry) === '.' ? '' : path.dirname(mainEntry));
    if (mainSource == null) warnings.push({ code: 'MAIN_UNREADABLE', message: `Unable to read main entry: ${mainEntry}` });
  } else {
    warnings.push({ code: 'MAIN_NOT_FOUND', message: 'No Electron main entry could be determined.' });
  }

  const discovered = mainSource ? detectRendererEntries(mainSource, mainDir) : [];
  const preloadScripts = mainSource ? detectPreloads(mainSource, mainDir) : [];
  const htmlEntries = findFiles(sourceDir, (rel) => rel.toLowerCase().endsWith('.html'));

  for (const rel of htmlEntries) {
    discovered.push({ path: rel, type: 'file', confidence: scoreHtmlFallback(rel), source: 'HTML fallback scan' });
  }

  const entries = dedupeEntries(discovered).map((entry, index) => ({ id: `entry-${index + 1}`, ...entry }));
  const localEntries = entries.filter((entry) => entry.type === 'file');
  if (!localEntries.length) warnings.push({ code: 'RENDERER_NOT_FOUND', message: 'No local HTML renderer entry was detected.' });

  return {
    schemaVersion: 1,
    package: {
      name: typeof packageJson.name === 'string' ? packageJson.name : null,
      version: typeof packageJson.version === 'string' ? packageJson.version : null,
      main: typeof packageJson.main === 'string' ? packageJson.main : null
    },
    mainEntry,
    preloadScripts,
    rendererEntries: entries,
    htmlEntries,
    warnings
  };
}

module.exports = {
  analyzeProject,
  resolveCodePath,
  detectRendererEntries,
  detectPreloads,
  scoreHtmlFallback,
  resolveLoadFilePath
};
