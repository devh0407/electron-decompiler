const { app, BrowserWindow, dialog, ipcMain, net, protocol } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ProjectManager } = require('./project-manager.cjs');
const { PreviewManager } = require('./preview-manager.cjs');
const { resolveInside } = require('./path-utils.cjs');

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

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
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
      if (url.hostname !== 'project') return new Response('Not found', { status: 404 });
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const projectId = parts.shift();
      const project = projectManager.getProject(projectId);
      if (!project) return new Response('Unknown project', { status: 404 });
      const filePath = resolveInside(project.sourceDir, parts.join('/'));
      return net.fetch(pathToFileURL(filePath).toString());
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
