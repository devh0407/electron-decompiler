# Architecture (v0.3)

## Runtime boundary

Electron Decompiler treats imported ASAR content as untrusted. v0.3 still does **not** execute the target application's `main` or original `preload` scripts.

```text
app.asar
   |
   v
Worker Thread ---- extract ----> Workspace/source
                                 |
                                 v
                           Static Analyzer
                 package/main/preload/contextBridge/IPC
                                 |
                                 v
                            manifest.json
                                 |
                        +--------+--------+
                        |                 |
                        v                 v
                 runtime/mocks.json   Runtime Shim builder
                        |                 |
                        +--------+--------+
                                 v
Host UI <---- IPC ---- Main ---- asar-preview://<projectId>/...
                                 |
                                 +-- HTML response gets shim script first
                                 |
                                 v
                          WebContentsView
                                 |
                    Missing API / IPC / Mock logs
```

## Main modules

- `project-manager.cjs`: workspace lifecycle, SHA-256 identity, cache/schema upgrade, extraction orchestration, mock persistence facade.
- `asar-extractor-worker.cjs`: ASAR scan/extraction progress.
- `analyzer.cjs`: package/main/renderer/preload detection plus contextBridge API and IPC analysis.
- `mock-registry.cjs`: validates and persists per-project `runtime/mocks.json`.
- `runtime-shim.cjs`: builds the browser-side proxy/mock compatibility runtime from manifest + mocks.
- `preview-manager.cjs`: isolated `WebContentsView`, navigation restrictions, renderer diagnostics, structured Runtime events.
- `main.cjs`: project IPC and `asar-preview://` protocol; injects the runtime script before target page scripts.
- `path-utils.cjs`: path normalization and traversal protection.

## Analysis schema v2

The manifest now includes:

- `preloadScripts`: detected preload files and bridge/API/IPC counts.
- `bridgeExposures`: `contextBridge.exposeInMainWorld` roots.
- `rendererApis`: flattened API paths, value/function kind, and optional IPC metadata.
- `ipcChannels`: merged renderer/main declarations with statuses such as `matched` and `missing-main-handler`.

Cached v0.2 workspaces are re-analyzed automatically when imported because the manifest schema version changed from 1 to 2.

## Runtime Shim

The host rewrites HTML responses to insert:

```html
<script src="/__electron_decompiler_runtime__.js"></script>
```

immediately after the opening `<head>`, before target CSP meta tags and renderer scripts. The script is served from the same `asar-preview://<projectId>` origin.

For each detected bridge root, the runtime creates a Proxy-backed object. Known API metadata controls behavior:

- value API + `{ "value": ... }` mock -> return the value on property access;
- function API + `{ "return": ... }` mock -> return the configured result;
- `ipcRenderer.invoke` bridge -> return a Promise, including when the call is missing;
- missing API/IPC -> emit a structured `[EDC_RUNTIME]` console event and tolerate the call with `undefined`/resolved `undefined`.

Unknown nested paths stay proxyable, allowing calls like `desktop.window.minimize()` to be observed even when only the root bridge could be recovered.

## IPC registry

The analyzer currently recognizes:

Renderer/preload side:

- `ipcRenderer.invoke`
- `ipcRenderer.send`
- `ipcRenderer.sendSync`
- `ipcRenderer.postMessage`
- `ipcRenderer.on`
- `ipcRenderer.once`

Main side:

- `ipcMain.handle`
- `ipcMain.handleOnce`
- `ipcMain.on`
- `ipcMain.once`

The registry is descriptive in v0.3. Original main handlers are not executed. IPC mocks are keyed by channel and are consumed by the Runtime Shim.

## Safe preview

The preview continues to use:

- `sandbox: true`
- `contextIsolation: true`
- `nodeIntegration: false`
- no target preload
- project-scoped custom protocol
- blocked `window.open`
- blocked top-level navigation outside the current imported project

The next milestone, v0.4, can build a Virtual Main runtime on top of this manifest and mock registry instead of weakening the Safe Render boundary.
