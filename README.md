# Electron Decompiler

A safe Electron `app.asar` inspector and renderer previewer.

> Current milestone: **v0.2** — import/extract + progress + file explorer + renderer entry detection + safe page preview.

## Features

### v0.1 foundation

- Drag & drop or choose an `.asar` file.
- SHA-256 based workspace/cache identity.
- Extract in a worker thread so the Electron main process stays responsive.
- File/byte progress reporting.
- Lazy extracted file tree.
- Manually preview any extracted HTML file.
- Capture preview `console-message`, load failures and renderer crashes.

### v0.2 analysis

- Parse `package.json` and detect the Electron `main` entry.
- Detect common `BrowserWindow.loadFile(...)` renderer entries.
- Detect literal `BrowserWindow.loadURL(...)` calls.
- Detect common `webPreferences.preload` paths.
- Rank fallback HTML files with confidence scores.
- Automatically open the highest-confidence local renderer entry.
- Serve extracted pages from the isolated `asar-preview://` protocol.

## Safety model

Imported ASAR files should be treated as untrusted.

v0.2 **does not execute the target application's main process or preload script**. Preview pages run in a dedicated `WebContentsView` with:

```text
sandbox: true
contextIsolation: true
nodeIntegration: false
```

The original renderer JavaScript still executes inside that sandbox, so only inspect ASAR files you are authorized to analyze and avoid opening unknown remote links.

## Requirements

- Node.js 22.12+
- Windows 10+, macOS Monterey+, or a Linux environment supported by Electron 43

## Run

```bash
npm install
npm start
```

## Test

The analyzer/path tests do not require Electron binaries:

```bash
npm test
npm run check
```

## How it works

```text
app.asar
   |
   +--> ASAR worker
   |      |- list archive
   |      |- calculate extraction totals
   |      `- extract with progress
   |
   +--> workspace/source
   |      `- lazy file tree
   |
   +--> analyzer
   |      |- package.json.main
   |      |- loadFile/loadURL
   |      `- preload detection
   |
   `--> manifest
          `--> WebContentsView safe preview
```

Workspace data is stored under Electron's `userData/workspaces/<sha256-prefix>` directory.

## Current limitations

v0.2 focuses on renderer recovery, not full Electron application emulation.

- Target `preload` is detected but intentionally not executed.
- `ipcRenderer` / `ipcMain` dependencies are not mocked yet.
- Missing `window.electronAPI` style bridges can still break application-specific renderer logic.
- Bundled/minified main process code may not match the conservative static analyzer.
- Native modules and symlinks are not executed/recreated in safe mode.
- Remote `loadURL(http/https)` entries are detected but not auto-loaded.

These are the main targets for v0.3 (`RendererCompatibilityLayer`) and v0.4 (`VirtualMainRuntime`).

## Roadmap

- **v0.3** — preload/contextBridge analysis, missing API proxy, IPC registry, editable mocks.
- **v0.4** — virtual main runtime, fake `app`/`BrowserWindow`/`ipcMain`, dynamic window discovery.
- **v0.5** — multi-window tabs, network inspector, mock editor, storage tools and snapshots.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the v0.2 module boundaries.
