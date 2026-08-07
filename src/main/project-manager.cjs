const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { ANALYSIS_SCHEMA_VERSION, analyzeProject } = require('./analyzer.cjs');
const { archiveFs } = require('./archive-fs.cjs');
const { MockRegistry } = require('./mock-registry.cjs');
const { normalizeRelative, resolveInside } = require('./path-utils.cjs');

const archiveFsp = archiveFs.promises;
const EXTRACTION_SCHEMA_VERSION = 2;

class ProjectManager {
  constructor({ workspaceRoot, onProgress }) {
    this.workspaceRoot = workspaceRoot;
    this.onProgress = onProgress || (() => {});
    this.projects = new Map();
    this.mockRegistry = new MockRegistry();
    fs.mkdirSync(workspaceRoot, { recursive: true });
  }

  async hashFile(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = archiveFs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  emit(projectId, phase, payload = {}) {
    this.onProgress({ projectId, phase, ...payload });
  }

  async inspectUnpackedSibling(archivePath) {
    const root = `${archivePath}.unpacked`;
    let rootStat;
    try {
      rootStat = await archiveFsp.stat(root);
    } catch (error) {
      if (error?.code === 'ENOENT') return { present: false, fingerprint: null };
      throw new Error(`Unable to inspect ASAR unpacked companion: ${root} (${error?.code || error?.message || String(error)})`);
    }
    if (!rootStat.isDirectory()) return { present: false, fingerprint: null };

    const hash = crypto.createHash('sha256');
    const queue = [{ absolute: root, relative: '' }];
    while (queue.length) {
      const current = queue.shift();
      let entries;
      try {
        entries = await archiveFsp.readdir(current.absolute, { withFileTypes: true });
      } catch (error) {
        throw new Error(`Unable to read ASAR unpacked directory: ${current.absolute} (${error?.code || error?.message || String(error)})`);
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const relative = normalizeRelative(path.posix.join(current.relative, entry.name));
        const absolute = path.join(current.absolute, entry.name);
        if (entry.isDirectory()) {
          hash.update(`D\0${relative}\n`);
          queue.push({ absolute, relative });
        } else if (entry.isFile()) {
          const stat = await archiveFsp.stat(absolute);
          hash.update(`F\0${relative}\0${stat.size}\0${Math.trunc(stat.mtimeMs)}\n`);
        } else if (entry.isSymbolicLink()) {
          let target = '';
          try { target = await archiveFsp.readlink(absolute); } catch {}
          hash.update(`L\0${relative}\0${target}\n`);
        } else {
          hash.update(`O\0${relative}\n`);
        }
      }
    }
    return { present: true, fingerprint: hash.digest('hex') };
  }

  async importAsar(archivePath) {
    if (typeof archivePath !== 'string' || !archivePath.trim()) {
      throw new Error('No ASAR file path was provided.');
    }

    const resolvedArchive = path.resolve(archivePath);
    let stat;
    try {
      stat = await archiveFsp.stat(resolvedArchive);
    } catch (error) {
      const detail = error?.code || error?.message || String(error);
      throw new Error(`Unable to access selected ASAR file: ${resolvedArchive} (${detail})`);
    }

    if (!stat.isFile()) {
      throw new Error(`Selected ASAR path is not a regular file: ${resolvedArchive}`);
    }
    if (path.basename(resolvedArchive).toLowerCase() !== 'app.asar' && !resolvedArchive.toLowerCase().endsWith('.asar')) {
      throw new Error(`Please select an .asar archive: ${resolvedArchive}`);
    }

    this.emit(null, 'HASHING', { archivePath: resolvedArchive });
    const [hash, unpackedState] = await Promise.all([
      this.hashFile(resolvedArchive),
      this.inspectUnpackedSibling(resolvedArchive)
    ]);
    const projectId = hash.slice(0, 16);
    const projectRoot = path.join(this.workspaceRoot, projectId);
    const sourceDir = path.join(projectRoot, 'source');
    const analysisDir = path.join(projectRoot, 'analysis');
    const metaPath = path.join(projectRoot, 'project.json');
    const manifestPath = path.join(analysisDir, 'manifest.json');

    const cached = await this.loadCachedProject({
      projectId,
      projectRoot,
      sourceDir,
      metaPath,
      manifestPath,
      archivePath: resolvedArchive,
      hash,
      unpackedState
    });
    if (cached) {
      this.emit(projectId, 'READY', { cached: true });
      return cached;
    }

    await fsp.rm(sourceDir, { recursive: true, force: true });
    await fsp.mkdir(sourceDir, { recursive: true });
    await fsp.mkdir(analysisDir, { recursive: true });

    this.emit(projectId, 'SCANNING', { archivePath: resolvedArchive });
    const extraction = await this.extractInWorker(resolvedArchive, sourceDir, projectId);

    this.emit(projectId, 'ANALYZING');
    const manifest = analyzeProject(sourceDir);
    manifest.warnings.push(...extraction.warnings);
    const mocks = await this.mockRegistry.load(projectRoot);
    const project = {
      projectId,
      hash,
      archivePath: resolvedArchive,
      projectRoot,
      sourceDir,
      manifest,
      mocks,
      importedAt: new Date().toISOString(),
      unpackedSiblingPresent: unpackedState.present,
      unpackedFingerprint: unpackedState.fingerprint,
      extractionSchemaVersion: EXTRACTION_SCHEMA_VERSION
    };

    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await fsp.writeFile(metaPath, JSON.stringify({
      projectId,
      hash,
      archivePath: resolvedArchive,
      importedAt: project.importedAt,
      unpackedSiblingPresent: unpackedState.present,
      unpackedFingerprint: unpackedState.fingerprint,
      extractionSchemaVersion: EXTRACTION_SCHEMA_VERSION
    }, null, 2));

    this.projects.set(projectId, project);
    this.emit(projectId, 'READY', { cached: false });
    return this.publicProject(project);
  }

  async loadCachedProject(ctx) {
    try {
      if (!fs.existsSync(ctx.metaPath) || !fs.existsSync(ctx.manifestPath) || !fs.existsSync(ctx.sourceDir)) return null;
      const meta = JSON.parse(await fsp.readFile(ctx.metaPath, 'utf8'));
      if (meta.hash !== ctx.hash) return null;
      if (meta.extractionSchemaVersion !== EXTRACTION_SCHEMA_VERSION) return null;
      if (Boolean(meta.unpackedSiblingPresent) !== ctx.unpackedState.present) return null;
      if ((meta.unpackedFingerprint || null) !== ctx.unpackedState.fingerprint) return null;

      let manifest = JSON.parse(await fsp.readFile(ctx.manifestPath, 'utf8'));
      if (manifest.schemaVersion !== ANALYSIS_SCHEMA_VERSION) {
        this.emit(ctx.projectId, 'ANALYZING', { reason: 'schema-upgrade' });
        manifest = analyzeProject(ctx.sourceDir);
        await fsp.writeFile(ctx.manifestPath, JSON.stringify(manifest, null, 2));
      }
      const mocks = await this.mockRegistry.load(ctx.projectRoot);
      const project = {
        projectId: ctx.projectId,
        hash: ctx.hash,
        archivePath: ctx.archivePath,
        projectRoot: ctx.projectRoot,
        sourceDir: ctx.sourceDir,
        manifest,
        mocks,
        importedAt: meta.importedAt,
        unpackedSiblingPresent: ctx.unpackedState.present,
        unpackedFingerprint: ctx.unpackedState.fingerprint,
        extractionSchemaVersion: EXTRACTION_SCHEMA_VERSION
      };
      this.projects.set(ctx.projectId, project);
      return this.publicProject(project);
    } catch {
      return null;
    }
  }

  extractInWorker(archivePath, outputDir, projectId) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'asar-extractor-worker.cjs'), { workerData: { archivePath, outputDir } });
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      worker.on('message', (message) => {
        if (message.type === 'scan') this.emit(projectId, 'SCANNING', message);
        else if (message.type === 'extract') this.emit(projectId, 'EXTRACTING', message);
        else if (message.type === 'done') finish(resolve, {
          warnings: message.warnings || [],
          linkRoots: message.linkRoots || 0,
          virtualFiles: message.virtualFiles || 0
        });
        else if (message.type === 'error') finish(reject, new Error(message.message));
      });
      worker.on('error', (error) => finish(reject, error));
      worker.on('exit', (code) => {
        if (code !== 0) finish(reject, new Error(`ASAR extraction worker exited with code ${code}`));
      });
    });
  }

  getProject(projectId) {
    return this.projects.get(projectId) || null;
  }

  publicProject(project) {
    return {
      projectId: project.projectId,
      hash: project.hash,
      archivePath: project.archivePath,
      importedAt: project.importedAt,
      unpackedSiblingPresent: project.unpackedSiblingPresent,
      extractionSchemaVersion: project.extractionSchemaVersion,
      manifest: project.manifest,
      mocks: project.mocks
    };
  }

  getMocks(projectId) {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    return project.mocks;
  }

  async saveMocks(projectId, input) {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    project.mocks = await this.mockRegistry.save(project.projectRoot, input);
    return project.mocks;
  }

  async listDirectory(projectId, relativePath = '') {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    const targetDir = resolveInside(project.sourceDir, relativePath);
    const entries = await fsp.readdir(targetDir, { withFileTypes: true });
    const items = await Promise.all(entries.map(async (entry) => {
      const rel = normalizeRelative(path.posix.join(normalizeRelative(relativePath), entry.name));
      const full = resolveInside(project.sourceDir, rel);
      let size = 0;
      try { if (entry.isFile()) size = (await fsp.stat(full)).size; } catch {}
      return { name: entry.name, path: rel, type: entry.isDirectory() ? 'directory' : 'file', size };
    }));
    return items.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1);
  }
}

module.exports = { EXTRACTION_SCHEMA_VERSION, ProjectManager };
