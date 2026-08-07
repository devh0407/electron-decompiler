const { app, BrowserWindow, dialog, ipcMain, net, protocol } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { contentTypeFor, readArchiveFile } = require('./archive-reader.cjs');
const { archiveEntryPathIssue, windowsPathIssue } = require('./extraction-plan.cjs');
const { ProjectManager } = require('./project-manager.cjs');
const { PreviewManager } = require('./preview-manager.cjs');
const { buildRuntimeShim } = require('./runtime-shim.cjs');
const { resolveInside } = require('./path-utils.cjs');

const RUNTIME_PATH = '__electron_decompiler_runtime__.js';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'asar-preview',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
]);

let mainWindow;
let projectManager;
let previewManager;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function injectRuntimeScript(html) {
  const tag = `<script src="/${RUNTIME_PATH}"></script>`;
  const head = /<head(?:\s[^>]*)?>/i;
  if (head.test(html)) return html.replace(head, (match) => `${match}\n  ${tag}`);
  return `${tag}\n${html}`;
}

async function findPhysicalProjectFile(project, relativePath) {
  if (archiveEntryPathIssue(relativePath)) return null;
  if (process.platform === 'win32' && windowsPathIssue(relativePath)) return null;

  const filePath = resolveInside(project.sourceDir, relativePath);
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile() ? filePath : null;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

async function readProjectBytes(project, relativePath) {
  const physical = await findPhysicalProjectFile(project, relativePath);
  if (physical) return { source: 'workspace', physical, bytes: null };

  const issue = archiveEntryPathIssue(relativePath);
  if (issue) throw new Error(`Unsafe preview path: ${relativePath} (${issue})`);
  const bytes = await readArchiveFile(project.archivePath, relativePath);
  return { source: 'archive', physical: null, bytes };
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1540,
    height: 960,
    minWidth: 1180,
    minHeight: 720,
    title: 'Electron Decompiler',
    webPreferences: {
      preload: path.join(__dirname, '../preload/host-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  previewManager = new PreviewManager({
    mainWindow,
    onConsole: (entry) => send('preview:console', entry)
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function registerProtocol() {
  protocol.handle('asar-preview', async (request) => {
    try {
      const url = new URL(request.url);
      const projectId = decodeURIComponent(url.hostname);
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const project = projectManager.getProject(projectId);
      if (!project) return new Response('Unknown project', { status: 404 });

      if (parts.length === 1 && parts[0] === RUNTIME_PATH) {
        return new Response(buildRuntimeShim(project.manifest, project.mocks), {
          status: 200,
          headers: {
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'no-store'
          }
        });
      }

      const relativePath = parts.join('/');
      if (!relativePath || archiveEntryPathIssue(relativePath)) {
        return new Response('Unsafe or empty project path', { status: 400 });
      }

      let resolved;
      try {
        resolved = await readProjectBytes(project, relativePath);
      } catch (error) {
        return new Response(error?.message || 'Project file not found', { status: 404 });
      }

      if (/\.html?$/i.test(relativePath)) {
        const bytes = resolved.physical ? await fsp.readFile(resolved.physical) : resolved.bytes;
        const html = Buffer.from(bytes).toString('utf8');
        return new Response(injectRuntimeScript(html), {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'x-electron-decompiler-source': resolved.source
          }
        });
      }

      if (resolved.physical) return net.fetch(pathToFileURL(resolved.physical).toString());

      return new Response(resolved.bytes, {
        status: 200,
        headers: {
          'content-type': contentTypeFor(relativePath),
          'cache-control': 'no-store',
          'x-electron-decompiler-source': 'archive'
        }
      });
    } catch (error) {
      return new Response(error?.message || 'Preview protocol error', { status: 500 });
    }
  });
}

function registerIpc() {
  ipcMain.handle('asar:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose app.asar',
      properties: ['openFile'],
      filters: [{ name: 'Electron ASAR', extensions: ['asar'] }]
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('project:import', async (_event, archivePath) => projectManager.importAsar(archivePath));
  ipcMain.handle('project:list-directory', async (_event, args) => projectManager.listDirectory(args.projectId, args.path || ''));
  ipcMain.handle('project:get-mocks', async (_event, projectId) => projectManager.getMocks(projectId));
  ipcMain.handle('project:save-mocks', async (_event, args) => projectManager.saveMocks(args.projectId, args.mocks));

  ipcMain.handle('preview:load', async (_event, args) => previewManager.load(args.projectId, args.path));
  ipcMain.on('preview:set-bounds', (_event, bounds) => previewManager.setBounds(bounds));
  ipcMain.on('preview:hide', () => previewManager.hide());
  ipcMain.on('preview:reload', () => previewManager.reload());
  ipcMain.on('preview:devtools', () => previewManager.openDevTools());
}

app.whenReady().then(() => {
  projectManager = new ProjectManager({
    workspaceRoot: path.join(app.getPath('userData'), 'workspaces'),
    onProgress: (progress) => send('project:progress', progress)
  });
  registerProtocol();
  registerIpc();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

module.exports = { injectRuntimeScript, findPhysicalProjectFile };
