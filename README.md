# Electron Decompiler

A safe Electron `app.asar` inspector and renderer compatibility previewer.

> Current milestone: **v0.3** — preload/contextBridge analysis + IPC registry + injected compatibility runtime + editable mocks.

## Features

### v0.1 foundation

- Drag & drop or choose an `.asar` file.
- SHA-256 based workspace/cache identity.
- Extract in a worker thread with file/byte progress.
- Lazy extracted file tree and manual HTML preview.
- Capture preview console/load/crash diagnostics.

### v0.2 renderer recovery

- Parse `package.json` and detect the Electron `main` entry.
- Detect common `BrowserWindow.loadFile(...)`, literal `loadURL(...)`, and `webPreferences.preload` patterns.
- Rank fallback HTML files and automatically open the best local renderer candidate.
- Serve extracted pages through the isolated `asar-preview://<projectId>/...` protocol.

### v0.3 compatibility runtime

- Analyze `contextBridge.exposeInMainWorld(...)` from detected preload scripts.
- Resolve common direct object and simple variable bridge definitions.
- Extract nested renderer API paths such as `electronAPI.events.onUpdated`.
- Detect `ipcRenderer.invoke/send/sendSync/postMessage/on/once` usage.
- Detect matching `ipcMain.handle/handleOnce/on/once` declarations and build an IPC registry.
- Inject a same-origin Runtime Shim before target page scripts without executing the original preload.
- Create bridge proxies for missing APIs and log `Missing API`, `Missing value`, and `Missing IPC` calls instead of immediately crashing.
- Preserve Promise behavior for APIs backed by `ipcRenderer.invoke`.
- Persist editable mocks under `runtime/mocks.json` per workspace.
- Mock by exposed API path or IPC channel and reload the preview after saving.
- Double-click a Missing API/IPC console line to add a mock stub to the editor.
- Automatically re-analyze cached v0.2 workspaces when the analysis schema changes.

## Runtime mock format

```json
{
  "version": 1,
  "apis": {
    "electronAPI.getVersion": { "return": "1.0.0" },
    "electronAPI.platform": { "value": "win32" }
  },
  "ipc": {
    "config:get": { "return": { "theme": "dark" } }
  }
}
```

For an API mapped to `ipcRenderer.invoke`, the runtime returns a resolved Promise so renderer code can continue using `await`.

## Safety model

Imported ASAR files should be treated as untrusted.

v0.3 still **does not execute the target application's main process or original preload script**. Preview pages run in a dedicated `WebContentsView` with:

```text
sandbox: true
contextIsolation: true
nodeIntegration: false
```

The original renderer JavaScript still executes inside that sandbox. The compatibility runtime is injected by the host protocol and only exposes proxy/mock objects derived from static analysis.

## Requirements

- Node.js 22.12+
- Windows 10+, macOS Monterey+, or a Linux environment supported by Electron 43

## Run

```bash
npm install
npm start
```

## Test

```bash
npm test
npm run check
```

Analyzer and Runtime Shim tests are dependency-free and do not require an Electron GUI.

## How it works

```text
app.asar
   |
   +--> ASAR worker --> workspace/source
   |
   +--> static analyzer
   |      |- package/main/renderer/preload
   |      |- contextBridge API surface
   |      `- IPC registry
   |
   +--> manifest.json + runtime/mocks.json
   |
   `--> asar-preview://<projectId>/page.html
             |
             +--> host injects Runtime Shim first
             +--> target renderer scripts execute
             `--> Missing API / IPC -> Console -> optional Mock -> Reload
```

Workspace data is stored under Electron's `userData/workspaces/<sha256-prefix>` directory.

## Current limitations

- The analyzer is intentionally conservative and does not evaluate target main/preload code.
- Bundled/minified preload code that constructs bridge objects dynamically may not be fully resolved.
- Event-style APIs backed by `ipcRenderer.on` are identified, but v0.3 does not yet simulate event delivery.
- Native modules are not executed in safe mode.
- Remote `loadURL(http/https)` entries are detected but not auto-loaded.
- Full main-process behavior is deferred to the Virtual Main runtime.

## Roadmap

- **v0.4** — virtual main runtime, fake `app`/`BrowserWindow`/`ipcMain`, dynamic window discovery.
- **v0.5** — multi-window tabs, network inspector, storage tools and snapshots.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module boundaries and the v0.3 runtime flow.
