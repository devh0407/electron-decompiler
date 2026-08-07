const fs = require('node:fs');
const path = require('node:path');
const { normalizeRelative, resolveInside } = require('./path-utils.cjs');

const ANALYSIS_SCHEMA_VERSION = 2;

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

function extractStringLiterals(expression) {
  const values = [];
  const regex = /(['"`])((?:\\.|(?!\1).)*)\1/g;
  let match;
  while ((match = regex.exec(expression))) values.push(match[2].replace(/\\([\\'"`])/g, '$1'));
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

function resolveLoadFilePath(expression, mainDir) {
  if (!expression) return null;
  const trimmed = expression.trim();
  const direct = trimmed.match(/^(['"`])([^'"`]+)\1$/);
  if (direct) return normalizeRelative(direct[2]);
  return resolveCodePath(trimmed, mainDir);
}

function scanBalanced(source, start, open = '(', close = ')') {
  let depth = 1;
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
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return { text: source.slice(start, i), end: i };
    }
  }
  return { text: source.slice(start), end: source.length };
}

function splitTopLevel(expression, delimiter = ',') {
  const values = [];
  let start = 0;
  const stack = [];
  let quote = null;
  let escaped = false;
  const closers = { '(': ')', '[': ']', '{': '}' };
  for (let i = 0; i < expression.length; i += 1) {
    const ch = expression[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (closers[ch]) stack.push(closers[ch]);
    else if (stack.length && ch === stack[stack.length - 1]) stack.pop();
    else if (ch === delimiter && stack.length === 0) {
      values.push(expression.slice(start, i).trim());
      start = i + 1;
    }
  }
  values.push(expression.slice(start).trim());
  return values.filter(Boolean);
}

function firstTopLevelArgument(expression) {
  return splitTopLevel(expression)[0] || '';
}

function findTopLevelColon(segment) {
  const stack = [];
  let quote = null;
  let escaped = false;
  const closers = { '(': ')', '[': ']', '{': '}' };
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (closers[ch]) stack.push(closers[ch]);
    else if (stack.length && ch === stack[stack.length - 1]) stack.pop();
    else if (ch === ':' && stack.length === 0) return i;
  }
  return -1;
}

function normalizePropertyKey(value) {
  const trimmed = value.trim();
  const quoted = trimmed.match(/^(['"])(.*)\1$/s);
  if (quoted) return quoted[2];
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return trimmed;
  return null;
}

function parseObjectProperties(expression) {
  const trimmed = expression.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return [];
  const body = trimmed.slice(1, -1);
  const segments = splitTopLevel(body);
  const result = [];
  for (const segment of segments) {
    const colon = findTopLevelColon(segment);
    if (colon >= 0) {
      const key = normalizePropertyKey(segment.slice(0, colon));
      if (key) result.push({ key, expression: segment.slice(colon + 1).trim(), shorthand: false });
      continue;
    }
    const method = segment.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/);
    if (method) {
      result.push({ key: method[1], expression: segment, shorthand: false, method: true });
      continue;
    }
    const shorthand = segment.match(/^([A-Za-z_$][\w$]*)$/);
    if (shorthand) result.push({ key: shorthand[1], expression: shorthand[1], shorthand: true });
  }
  return result;
}

function readInitializer(source, start) {
  let i = start;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  const begin = i;
  const stack = [];
  let quote = null;
  let escaped = false;
  const closers = { '(': ')', '[': ']', '{': '}' };
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (closers[ch]) stack.push(closers[ch]);
    else if (stack.length && ch === stack[stack.length - 1]) stack.pop();
    else if ((ch === ';' || ch === '\n') && stack.length === 0) break;
  }
  return source.slice(begin, i).trim();
}

function findVariableInitializer(source, variableName) {
  if (!/^[A-Za-z_$][\w$]*$/.test(variableName)) return null;
  const regex = new RegExp(`\\b(?:const|let|var)\\s+${variableName.replace(/[$]/g, '\\$&')}\\s*=`, 'g');
  const match = regex.exec(source);
  return match ? readInitializer(source, regex.lastIndex) : null;
}

function collectMemberCalls(source, owner, methodNames) {
  const names = Array.isArray(methodNames) ? methodNames : [methodNames];
  const pattern = new RegExp(`\\b${owner}\\s*\\.\\s*(${names.join('|')})\\s*\\(`, 'g');
  const calls = [];
  let match;
  while ((match = pattern.exec(source))) {
    const parsed = scanBalanced(source, pattern.lastIndex);
    calls.push({ owner, method: match[1], expression: parsed.text.trim(), index: match.index });
    pattern.lastIndex = Math.max(pattern.lastIndex, parsed.end + 1);
  }
  return calls;
}

function collectCalls(source, methodName) {
  const calls = [];
  const regex = new RegExp(`\\.${methodName}\\s*\\(`, 'g');
  let match;
  while ((match = regex.exec(source))) {
    const parsed = scanBalanced(source, regex.lastIndex);
    calls.push({ expression: parsed.text.trim(), index: match.index });
    regex.lastIndex = Math.max(regex.lastIndex, parsed.end + 1);
  }
  return calls;
}

function readPropertyExpression(source, start) {
  let i = start;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  const begin = i;
  const stack = [];
  let quote = null;
  let escaped = false;
  const closers = { '(': ')', '[': ']', '{': '}' };
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (closers[ch]) stack.push(closers[ch]);
    else if (stack.length && ch === stack[stack.length - 1]) stack.pop();
    else if ((ch === ',' || ch === '}' || ch === '\n') && stack.length === 0) break;
  }
  return source.slice(begin, i).trim();
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
    const resolved = resolveLoadFilePath(firstTopLevelArgument(call.expression), mainDir);
    if (resolved) candidates.push({ path: resolved, type: 'file', confidence: 100, source: 'BrowserWindow.loadFile' });
  }
  for (const call of collectCalls(source, 'loadURL')) {
    const expr = firstTopLevelArgument(call.expression);
    const literal = expr.match(/^(['"`])([^'"`]+)\1$/);
    if (!literal) continue;
    const value = literal[2];
    if (/^https?:\/\//i.test(value)) candidates.push({ url: value, type: 'url', confidence: 95, source: 'BrowserWindow.loadURL' });
    else if (/^file:\/\//i.test(value)) candidates.push({ url: value, type: 'url', confidence: 80, source: 'BrowserWindow.loadURL(file)' });
  }
  return dedupeEntries(candidates);
}

function parseIpcCalls(expression) {
  const calls = collectMemberCalls(expression, 'ipcRenderer', ['invoke', 'send', 'sendSync', 'postMessage', 'on', 'once']);
  const result = [];
  for (const call of calls) {
    const arg = firstTopLevelArgument(call.expression);
    const literal = arg.match(/^(['"`])([^'"`]+)\1$/);
    if (!literal) continue;
    result.push({
      channel: literal[2],
      method: call.method,
      direction: ['on', 'once'].includes(call.method) ? 'main-to-renderer' : 'renderer-to-main',
      async: call.method === 'invoke'
    });
  }
  return result;
}

function isFunctionExpression(expression, method = false) {
  const trimmed = expression.trim();
  return method || /=>/.test(trimmed) || /^(?:async\s+)?function\b/.test(trimmed);
}

function collectBridgeMembers(objectExpression, root, preloadPath, source, prefix = '') {
  const members = [];
  for (const prop of parseObjectProperties(objectExpression)) {
    const memberPath = prefix ? `${prefix}.${prop.key}` : prop.key;
    const fullPath = `${root}.${memberPath}`;
    let valueExpression = prop.expression;
    if (prop.shorthand) valueExpression = findVariableInitializer(source, prop.expression) || prop.expression;
    if (valueExpression.trim().startsWith('{') && valueExpression.trim().endsWith('}')) {
      members.push(...collectBridgeMembers(valueExpression, root, preloadPath, source, memberPath));
      continue;
    }
    const ipc = parseIpcCalls(valueExpression)[0] || null;
    members.push({
      path: fullPath,
      root,
      memberPath,
      kind: isFunctionExpression(valueExpression, prop.method) || ipc ? 'function' : 'value',
      preload: preloadPath,
      ipc,
      unresolvedReference: prop.shorthand && valueExpression === prop.expression
    });
  }
  return members;
}

function analyzePreloadSource(source, preloadPath) {
  const exposures = [];
  const apis = [];
  const ipcCalls = parseIpcCalls(source);
  for (const call of collectCalls(source, 'exposeInMainWorld')) {
    const args = splitTopLevel(call.expression);
    if (args.length < 2) continue;
    const rootLiteral = args[0].match(/^(['"`])([^'"`]+)\1$/);
    if (!rootLiteral) continue;
    const root = rootLiteral[2];
    let valueExpression = args[1].trim();
    let resolvedFrom = null;
    if (/^[A-Za-z_$][\w$]*$/.test(valueExpression)) {
      resolvedFrom = valueExpression;
      valueExpression = findVariableInitializer(source, valueExpression) || valueExpression;
    }
    const members = valueExpression.startsWith('{') ? collectBridgeMembers(valueExpression, root, preloadPath, source) : [];
    exposures.push({ root, preload: preloadPath, resolvedFrom, unresolved: members.length === 0, apiCount: members.length });
    apis.push(...members);
  }
  return { exposures, apis, ipcCalls };
}

function analyzeMainIpc(source) {
  const result = [];
  for (const call of collectMemberCalls(source, 'ipcMain', ['handle', 'handleOnce', 'on', 'once'])) {
    const arg = firstTopLevelArgument(call.expression);
    const literal = arg.match(/^(['"`])([^'"`]+)\1$/);
    if (!literal) continue;
    result.push({ channel: literal[2], method: call.method });
  }
  return result;
}

function buildIpcRegistry(preloadAnalysis, mainIpc) {
  const map = new Map();
  const ensure = (channel) => {
    if (!map.has(channel)) map.set(channel, { channel, rendererMethods: [], mainMethods: [], exposedAs: [] });
    return map.get(channel);
  };
  for (const preload of preloadAnalysis) {
    for (const call of preload.ipcCalls) {
      const item = ensure(call.channel);
      if (!item.rendererMethods.includes(call.method)) item.rendererMethods.push(call.method);
    }
    for (const api of preload.apis) {
      if (!api.ipc) continue;
      const item = ensure(api.ipc.channel);
      if (!item.exposedAs.includes(api.path)) item.exposedAs.push(api.path);
    }
  }
  for (const call of mainIpc) {
    const item = ensure(call.channel);
    if (!item.mainMethods.includes(call.method)) item.mainMethods.push(call.method);
  }
  return [...map.values()].map((item) => {
    const invokes = item.rendererMethods.includes('invoke');
    const sends = item.rendererMethods.some((m) => ['send', 'sendSync', 'postMessage'].includes(m));
    const listens = item.rendererMethods.some((m) => ['on', 'once'].includes(m));
    const hasHandle = item.mainMethods.some((m) => ['handle', 'handleOnce'].includes(m));
    const hasOn = item.mainMethods.some((m) => ['on', 'once'].includes(m));
    let status = 'declared';
    if ((invokes && !hasHandle) || (sends && !hasOn)) status = 'missing-main-handler';
    else if (item.rendererMethods.length && item.mainMethods.length) status = 'matched';
    else if (item.rendererMethods.length) status = listens ? 'renderer-listener' : 'renderer-only';
    else status = 'main-only';
    return { ...item, status };
  }).sort((a, b) => a.channel.localeCompare(b.channel));
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
    if (!item.path || seen.has(item.path)) return false;
    seen.add(item.path);
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
  const packageJson = readJson(path.join(sourceDir, 'package.json')) || {};
  let mainEntry = typeof packageJson.main === 'string' ? normalizeRelative(packageJson.main) : null;
  if (!mainEntry) {
    for (const fallback of ['main.js', 'main.cjs', 'index.js', 'src/main.js']) {
      if (fs.existsSync(resolveInside(sourceDir, fallback))) { mainEntry = fallback; break; }
    }
  }

  let mainSource = null;
  let mainDir = '';
  if (mainEntry) {
    mainSource = safeReadText(resolveInside(sourceDir, mainEntry));
    mainDir = normalizeRelative(path.dirname(mainEntry) === '.' ? '' : path.dirname(mainEntry));
    if (mainSource == null) warnings.push({ code: 'MAIN_UNREADABLE', message: `Unable to read main entry: ${mainEntry}` });
  } else warnings.push({ code: 'MAIN_NOT_FOUND', message: 'No Electron main entry could be determined.' });

  const discovered = mainSource ? detectRendererEntries(mainSource, mainDir) : [];
  const detectedPreloads = mainSource ? detectPreloads(mainSource, mainDir) : [];
  const fallbackPreloads = findFiles(sourceDir, (rel) => /(?:^|\/)(?:[^/]*preload[^/]*\/|[^/]*preload[^/]*\.(?:c?js|mjs)$)/i.test(rel), 40)
    .filter((rel) => /\.(?:c?js|mjs)$/i.test(rel))
    .map((rel) => ({ path: rel, confidence: 45, source: 'Preload fallback scan' }));
  const preloadScripts = dedupeByPath([...detectedPreloads, ...fallbackPreloads]);
  const preloadAnalysis = [];
  for (const preload of preloadScripts) {
    const preloadSource = safeReadText(resolveInside(sourceDir, preload.path));
    if (preloadSource == null) {
      warnings.push({ code: 'PRELOAD_UNREADABLE', path: preload.path, message: 'Unable to read preload script.' });
      preloadAnalysis.push({ ...preload, exposures: [], apis: [], ipcCalls: [] });
      continue;
    }
    preloadAnalysis.push({ ...preload, ...analyzePreloadSource(preloadSource, preload.path) });
  }

  const bridgeExposures = preloadAnalysis.flatMap((item) => item.exposures);
  const rendererApis = preloadAnalysis.flatMap((item) => item.apis);
  const mainIpc = mainSource ? analyzeMainIpc(mainSource) : [];
  const ipcChannels = buildIpcRegistry(preloadAnalysis, mainIpc);
  const htmlEntries = findFiles(sourceDir, (rel) => rel.toLowerCase().endsWith('.html'));
  for (const rel of htmlEntries) discovered.push({ path: rel, type: 'file', confidence: scoreHtmlFallback(rel), source: 'HTML fallback scan' });
  const entries = dedupeEntries(discovered).map((entry, index) => ({ id: `entry-${index + 1}`, ...entry }));
  if (!entries.some((entry) => entry.type === 'file')) warnings.push({ code: 'RENDERER_NOT_FOUND', message: 'No local HTML renderer entry was detected.' });
  if (preloadScripts.length && !bridgeExposures.length) warnings.push({ code: 'BRIDGE_NOT_FOUND', message: 'Preload scripts were found, but no contextBridge.exposeInMainWorld call could be resolved.' });

  return {
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    package: {
      name: typeof packageJson.name === 'string' ? packageJson.name : null,
      version: typeof packageJson.version === 'string' ? packageJson.version : null,
      main: typeof packageJson.main === 'string' ? packageJson.main : null
    },
    mainEntry,
    preloadScripts: preloadAnalysis.map(({ exposures, apis, ipcCalls, ...item }) => ({ ...item, bridgeCount: exposures.length, apiCount: apis.length, ipcCount: ipcCalls.length })),
    bridgeExposures,
    rendererApis,
    ipcChannels,
    rendererEntries: entries,
    htmlEntries,
    warnings
  };
}

module.exports = {
  ANALYSIS_SCHEMA_VERSION,
  analyzeProject,
  analyzePreloadSource,
  analyzeMainIpc,
  buildIpcRegistry,
  parseObjectProperties,
  splitTopLevel,
  resolveCodePath,
  detectRendererEntries,
  detectPreloads,
  scoreHtmlFallback,
  resolveLoadFilePath
};
