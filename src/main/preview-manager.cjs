const { WebContentsView } = require('electron');

const RUNTIME_PREFIX = '[EDC_RUNTIME]';

function formatRuntimeEvent(payload) {
  switch (payload.type) {
    case 'missing-api': return `Missing API: ${payload.path}(${Array.isArray(payload.args) ? payload.args.map((arg) => JSON.stringify(arg)).join(', ') : ''})`;
    case 'missing-value': return `Missing value: ${payload.path}`;
    case 'missing-ipc': return `Missing IPC: ${payload.channel} via ${payload.path} [${payload.method}]`;
    case 'mock-hit': return `Mock hit: ${payload.path}${payload.channel ? ` → ${payload.channel}` : ''}`;
    case 'bridge-installed': return `Runtime bridge installed: window.${payload.root}`;
    case 'bridge-conflict': return `Runtime bridge skipped because window.${payload.root} already exists`;
    case 'renderer-error': return `Renderer error: ${payload.message}`;
    case 'renderer-rejection': return `Unhandled rejection: ${payload.message}`;
    default: return `${payload.type || 'runtime'}: ${payload.message || payload.path || ''}`;
  }
}

class PreviewManager {
  constructor({ mainWindow, onConsole }) {
    this.mainWindow = mainWindow;
    this.onConsole = onConsole || (() => {});
    this.view = null;
    this.projectId = null;
  }

  ensureView() {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    this.view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: true
      }
    });
    this.mainWindow.contentView.addChildView(this.view);
    this.attachDiagnostics(this.view.webContents);
    this.view.setVisible(false);
    return this.view;
  }

  attachDiagnostics(webContents) {
    webContents.on('console-message', (details) => {
      if (typeof details.message === 'string' && details.message.startsWith(RUNTIME_PREFIX)) {
        try {
          const payload = JSON.parse(details.message.slice(RUNTIME_PREFIX.length));
          this.onConsole({
            source: payload.type === 'missing-ipc' ? 'ipc' : 'runtime',
            level: details.level,
            message: formatRuntimeEvent(payload),
            runtimeEvent: payload,
            line: details.lineNumber,
            sourceId: details.sourceId,
            timestamp: payload.timestamp || Date.now()
          });
          return;
        } catch {}
      }
      this.onConsole({
        source: 'renderer',
        level: details.level,
        message: details.message,
        line: details.lineNumber,
        sourceId: details.sourceId,
        timestamp: Date.now()
      });
    });
    webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      this.onConsole({ source: 'preview', level: 'error', message: `Load failed (${errorCode}): ${errorDescription}`, sourceId: validatedURL, timestamp: Date.now() });
    });
    webContents.on('preload-error', (_event, preloadPath, error) => {
      this.onConsole({ source: 'preload', level: 'error', message: error?.message || String(error), sourceId: preloadPath, timestamp: Date.now() });
    });
    webContents.on('render-process-gone', (_event, details) => {
      this.onConsole({ source: 'preview', level: 'error', message: `Renderer process gone: ${details.reason}`, timestamp: Date.now() });
    });
    webContents.on('unresponsive', () => {
      this.onConsole({ source: 'preview', level: 'warn', message: 'Preview renderer became unresponsive.', timestamp: Date.now() });
    });
    webContents.on('will-navigate', (details) => {
      try {
        const target = new URL(details.url);
        if (target.protocol !== 'asar-preview:' || target.hostname !== this.projectId) {
          details.preventDefault();
          this.onConsole({ source: 'preview', level: 'warn', message: `Blocked navigation: ${details.url}`, timestamp: Date.now() });
        }
      } catch {
        details.preventDefault();
      }
    });
    webContents.setWindowOpenHandler(({ url }) => {
      this.onConsole({ source: 'preview', level: 'warn', message: `Blocked window.open: ${url}`, timestamp: Date.now() });
      return { action: 'deny' };
    });
  }

  setBounds(bounds) {
    const view = this.ensureView();
    view.setBounds({
      x: Math.max(0, Math.round(bounds.x || 0)),
      y: Math.max(0, Math.round(bounds.y || 0)),
      width: Math.max(0, Math.round(bounds.width || 0)),
      height: Math.max(0, Math.round(bounds.height || 0))
    });
  }

  async load(projectId, relativePath) {
    const view = this.ensureView();
    this.projectId = projectId;
    const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/');
    const url = `asar-preview://${encodeURIComponent(projectId)}/${encodedPath}`;
    view.setVisible(true);
    await view.webContents.loadURL(url);
    return { url };
  }

  hide() {
    if (this.view && !this.view.webContents.isDestroyed()) this.view.setVisible(false);
  }

  reload() {
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.reload();
  }

  openDevTools() {
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.openDevTools({ mode: 'detach' });
  }
}

module.exports = { PreviewManager, formatRuntimeEvent };
