const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { analyzeProject } = require('./analyzer.cjs');
const { normalizeRelative, resolveInside } = require('./path-utils.cjs');

class ProjectManager {
  constructor({ workspaceRoot, onProgress }) {
    this.workspaceRoot = workspaceRoot;
    this.onProgress = onProgress || (() => {});
    this.projects = new Map();
    fs.mkdirSync(workspaceRoot, { recursive: true });
  }

  async hashFile(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  emit(projectId, phase, payload = {}) {
    this.onProgress({ projectId, phase, ...payload });
  }

  async importAsar(archivePath) {
    const resolvedArchive = path.resolve(archivePath);
    const stat = await fsp.stat(resolvedArchive);
    if (!stat.isFile()) throw new Error('Selected path is not a file.');
    if (path.basename(resolvedArchive).toLowerCase() !== 'app.asar' && !resolvedArchive.toLowerCase().endsWith('.asar')) {
      throw new Error('Please select an .asar archive.');
    }

    this.emit(null, 'HASHING', { archivePath: resolvedArchive });
    const hash = await this.hashFile(resolvedArchive);
    const projectId = hash.slice(0, 16);
    const projectRoot = path.join(this.workspaceRoot, projectId);
    const sourceDir = path.join(projectRoot, 'source');
    const analysisDir = path.join(projectRoot, 'analysis');
    const metaPath = path.join(projectRoot, 'project.json');
    const manifestPath = path.join(analysisDir, 'manifest.json');

    const cached = await this.loadCachedProject({ projectId, projectRoot, sourceDir, metaPath, manifestPath, archivePath: resolvedArchive, hash });
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
    const project = {
      projectId,
      hash,
      archivePath: resolvedArchive,
      projectRoot,
      sourceDir,
      manifest,
      importedAt: new Date().toISOString(),
      unpackedSiblingPresent: fs.existsSync(`${resolvedArchive}.unpacked`)
    };

    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await fsp.writeFile(metaPath, JSON.stringify({
      projectId,
      hash,
      archivePath: resolvedArchive,
      importedAt: project.importedAt
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
      const manifest = JSON.parse(await fsp.readFile(ctx.manifestPath, 'utf8'));
      const project = {
        projectId: ctx.projectId,
        hash: ctx.hash,
        archivePath: ctx.archivePath,
        projectRoot: ctx.projectRoot,
        sourceDir: ctx.sourceDir,
        manifest,
        importedAt: meta.importedAt,
        unpackedSiblingPresent: fs.existsSync(`${ctx.archivePath}.unpacked`)
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
      worker.on('message', (message) => {
        if (message.type === 'scan') this.emit(projectId, 'SCANNING', message);
        else if (message.type === 'extract') this.emit(projectId, 'EXTRACTING', message);
        else if (message.type === 'done') resolve({ warnings: message.warnings || [] });
        else if (message.type === 'error') reject(new Error(message.message));
      });
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`ASAR extraction worker exited with code ${code}`));
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
      manifest: project.manifest
    };
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

module.exports = { ProjectManager };
