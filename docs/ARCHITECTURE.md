# Architecture (v0.2)

## Runtime boundary

Electron Decompiler does **not** execute the target application's `main` or `preload` scripts in v0.2.
The imported ASAR is treated as untrusted input.

```text
app.asar
   |
   v
Worker Thread ---- list/stat/extract ----> Workspace/source
   |                                      |
   | progress                             v
   +-----------------------------> Static Analyzer
                                          |
                                          v
                                      manifest.json
                                          |
                                          v
Host Renderer UI <---- IPC ---- Main Process ---- WebContentsView
                                          |
                                          v
                              asar-preview://project/...
```

## Main modules

- `project-manager.cjs`: workspace lifecycle, SHA-256 cache identity, extraction orchestration, lazy file listing.
- `asar-extractor-worker.cjs`: ASAR index scan and file-level extraction progress.
- `analyzer.cjs`: package/main/preload/renderer entry detection with confidence scores.
- `preview-manager.cjs`: isolated `WebContentsView` lifecycle and console diagnostics.
- `path-utils.cjs`: path normalization and traversal protection.

## Safe preview

The preview uses:

- `sandbox: true`
- `contextIsolation: true`
- `nodeIntegration: false`
- no target preload script
- custom `asar-preview://` protocol mapped only to the extracted project root

This means UI assets and renderer JavaScript can run, but renderer behavior that depends on the original preload/main IPC will not work yet. That compatibility layer starts in v0.3.

## v0.2 entry detection

The analyzer currently recognizes common static patterns:

- `package.json.main`
- `BrowserWindow.loadFile(...)`
- literal `BrowserWindow.loadURL(...)`
- `webPreferences.preload`
- fallback scanning of `.html` files

It intentionally uses conservative static matching rather than evaluating target code.
