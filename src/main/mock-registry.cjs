const fsp = require('node:fs/promises');
const path = require('node:path');

const MOCK_SCHEMA_VERSION = 1;
const DEFAULT_MOCKS = Object.freeze({ version: MOCK_SCHEMA_VERSION, apis: {}, ipc: {} });

function cloneDefaults() {
  return { version: MOCK_SCHEMA_VERSION, apis: {}, ipc: {} };
}

function normalizeMocks(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Mocks must be a JSON object.');
  const apis = input.apis == null ? {} : input.apis;
  const ipc = input.ipc == null ? {} : input.ipc;
  if (!apis || typeof apis !== 'object' || Array.isArray(apis)) throw new Error('mocks.apis must be an object.');
  if (!ipc || typeof ipc !== 'object' || Array.isArray(ipc)) throw new Error('mocks.ipc must be an object.');
  return { version: MOCK_SCHEMA_VERSION, apis: structuredClone(apis), ipc: structuredClone(ipc) };
}

class MockRegistry {
  getPath(projectRoot) {
    return path.join(projectRoot, 'runtime', 'mocks.json');
  }

  async load(projectRoot) {
    const filePath = this.getPath(projectRoot);
    try {
      const parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'));
      return normalizeMocks(parsed);
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      return cloneDefaults();
    }
  }

  async save(projectRoot, input) {
    const normalized = normalizeMocks(input);
    const filePath = this.getPath(projectRoot);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    return normalized;
  }
}

module.exports = { MOCK_SCHEMA_VERSION, DEFAULT_MOCKS, normalizeMocks, MockRegistry };
