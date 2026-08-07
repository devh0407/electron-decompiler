# Electron Decompiler

A safe Electron `app.asar` inspector and renderer compatibility previewer.

> Current milestone: **v0.3.1** — v0.3 compatibility runtime plus hardened ASAR extraction/link handling.

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

### v0.3.1 ASAR hardening

- Read the imported ASAR container with Electron's unpatched `original-fs` semantics, so the archive is treated as a real file for validation and SHA-256 hashing.
- Track the presence and metadata fingerprint of `app.asar.unpacked`; changing/restoring the companion directory invalidates stale extraction caches.
- Safely materialize ASAR file and directory links as ordinary extracted files/directories instead of creating real filesystem symlinks.
- Reject circular or archive-escaping link targets.
- Keep ASAR entries that Windows cannot represent on disk (for example `CON.txt`, illegal filename characters, trailing dot/space) as virtual files and serve them directly from the original archive through the preview protocol.
- Version the extraction format so workspaces created before link materialization are automatically re-extracted.

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

v0.3.1 still **does not execute the target application's main process or original preload script**. Preview pages run in a dedicated `WebContentsView` with:

```text
sandbox: true
contextIsolation: true
nodeIntegration: false
```

The original renderer JavaScript still executes inside that sandbox. The compatibility runtime is injected by the host protocol and only exposes proxy/mock objects derived from static analysis.

The target archive itself is a special case: Electron patches normal `node:fs` calls so `.asar` paths behave like virtual directories. Electron Decompiler therefore uses a small `archive-fs` boundary that selects `original-fs` inside Electron for operations on the ASAR container and its `.unpacked` companion. Files already extracted into the workspace continue to use normal `node:fs`.

ASAR links are also handled without weakening the boundary: the extractor follows only in-archive link targets and writes ordinary files/directories into the workspace. It never creates an operating-system symlink. Entries that are valid inside ASAR but cannot be represented safely on Windows remain virtual and are read on demand from the archive.

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

Analyzer, extraction-plan, cache and Runtime Shim tests are dependency-free and do not require an Electron GUI.

## How it works

```text
app.asar
   |
   +--> archive-fs (real file semantics for stat/hash)
   |
   +--> extraction plan
   |      |- regular files/directories
   |      |- safe link materialization
   |      `- Windows-unrepresentable entries -> virtual-only
   |
   +--> ASAR worker --> workspace/source
   |        `--> @electron/asar reads app.asar.unpacked when required
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
             +--> physical workspace file when available
             +--> original ASAR fallback for virtual-only/missing extracted paths
             +--> host injects Runtime Shim first
             `--> Missing API / IPC -> Console -> optional Mock -> Reload
```

Workspace data is stored under Electron's `userData/workspaces/<sha256-prefix>` directory.

## Current limitations

- The analyzer is intentionally conservative and does not evaluate target main/preload code.
- Bundled/minified preload code that constructs bridge objects dynamically may not be fully resolved.
- Event-style APIs backed by `ipcRenderer.on` are identified, but v0.3 does not yet simulate event delivery.
- Native modules are not executed in safe mode.
- The `.asar.unpacked` cache fingerprint uses path/size/mtime metadata rather than hashing every unpacked file's contents, trading perfect detection for import speed.
- Import reads the source application in place; replacing/updating that application concurrently with an import can still produce an inconsistent snapshot.
- Virtual-only ASAR fallback currently returns complete files and does not implement HTTP byte-range responses for rare media assets that require range loading.
- Remote `loadURL(http/https)` entries are detected but not auto-loaded.
- Full main-process behavior is deferred to the Virtual Main runtime.

## Roadmap

- **v0.4** — virtual main runtime, fake `app`/`BrowserWindow`/`ipcMain`, dynamic window discovery.
- **v0.5** — multi-window tabs, network inspector, storage tools and snapshots.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module boundaries and the v0.3 runtime flow.
