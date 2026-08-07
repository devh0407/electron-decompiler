# Architecture (v0.3)

## Runtime boundary

Electron Decompiler treats imported ASAR content as untrusted. v0.3 still does **not** execute the target application's `main` or original `preload` scripts.

```text
app.asar
   |
   +--> archive-fs (original-fs inside Electron)
   |       |- stat/hash the archive as a real file
   |       `- fingerprint app.asar.unpacked metadata
   |
   +--> extraction plan
   |       |- validate archive paths
   |       |- expand safe in-archive links
   |       `- mark Windows-unrepresentable entries virtual-only
   |
   v
Worker Thread ---- materialize ----> Workspace/source
   |                                  |
   |                                  v
   |                            Static Analyzer
   |                  package/main/preload/contextBridge/IPC
   |                                  |
   |                                  v
   |                             manifest.json
   |                                  |
   |                         +--------+--------+
   |                         |                 |
   |                         v                 v
   |                  runtime/mocks.json   Runtime Shim builder
   |                         |                 |
   |                         +--------+--------+
   |                                  v
   +---- virtual fallback ----> Main ---- asar-preview://<projectId>/...
                                      |
                                      +-- workspace file when materialized
                                      +-- original ASAR for virtual-only files
                                      +-- HTML response gets shim first
                                      |
                                      v
                               WebContentsView
                                      |
                         Missing API / IPC / Mock logs
```

## Main modules

- `archive-fs.cjs`: explicit filesystem boundary for the imported ASAR container. Uses Electron `original-fs` in Electron and regular `node:fs` in dependency-free Node tests.
- `archive-reader.cjs`: direct ASAR file fallback for preview paths that cannot be represented in the host filesystem, including strict MIME mapping for scripts/styles/assets.
- `extraction-plan.cjs`: validates archive paths, resolves link chains, expands directory links, detects Windows-invalid/reserved names, and produces the safe materialization plan.
- `project-manager.cjs`: workspace lifecycle, SHA-256 identity, `.asar.unpacked` cache fingerprint, extraction schema invalidation, analysis schema upgrade, extraction orchestration, mock persistence facade.
- `asar-extractor-worker.cjs`: executes the extraction plan. Archive reads are performed by `@electron/asar`; workspace output uses normal Node filesystem APIs and never creates a real symlink.
- `analyzer.cjs`: package/main/renderer/preload detection plus contextBridge API and IPC analysis.
- `mock-registry.cjs`: validates and persists per-project `runtime/mocks.json`.
- `runtime-shim.cjs`: builds the browser-side proxy/mock compatibility runtime from manifest + mocks.
- `preview-manager.cjs`: isolated `WebContentsView`, navigation restrictions, renderer diagnostics, structured Runtime events.
- `main.cjs`: project IPC and `asar-preview://` protocol; injects the runtime script and falls back to the original ASAR when a path is virtual-only/not materialized.
- `path-utils.cjs`: workspace path normalization and traversal protection.

## ASAR filesystem boundary

Electron patches the ordinary Node `fs` APIs so a path ending in `.asar` behaves like a virtual directory. That behavior is useful when an Electron application reads files *inside* its own archive, but it is wrong when Electron Decompiler needs to validate or hash the imported archive container itself.

For this reason all operations targeting the imported archive as a container go through `archive-fs.cjs`:

- archive `stat`;
- SHA-256 stream reads;
- `app.asar.unpacked` companion inspection.

The ASAR worker delegates archive parsing/extraction to `@electron/asar`, which has its own Electron-aware real-filesystem handling. Files that have already been extracted into `workspace/source` intentionally continue to use ordinary `node:fs`.

The cache identity remains based on the ASAR SHA-256, while cache validity additionally records a metadata fingerprint for `app.asar.unpacked` (relative path, type, size, mtime, and symlink target). Adding, removing, or changing the companion therefore forces re-extraction instead of reusing stale workspace content.

## Extraction schema v2

Extraction has its own schema version separate from analysis. This matters because a workspace created by an older extractor can be structurally incomplete even when the ASAR SHA-256 and analysis schema still match.

Extraction schema v2 adds safe link materialization and Windows virtual-only entries. `project.json` stores `extractionSchemaVersion`; a mismatch invalidates the cached `workspace/source` and forces a clean re-extraction.

### Safe ASAR links

ASAR links are never materialized as operating-system symlinks.

The planner instead:

1. validates that the link target is relative and stays inside the archive;
2. follows link chains with cycle/depth protection;
3. for a file link, extracts the resolved bytes into the link's path;
4. for a directory link, expands the target subtree into ordinary directories/files below the alias path;
5. reports malformed, circular, or escaping targets without writing outside the workspace.

This preserves renderer-visible paths while avoiding arbitrary symlink creation.

### Windows-unrepresentable ASAR names

An ASAR created on another platform can legally contain names that Windows cannot create on disk, including reserved device names (`CON`, `NUL`, `COM1`, etc.), illegal filename characters, and trailing dot/space names.

On Windows those entries are marked `VIRTUAL_ONLY_WINDOWS_PATH` instead of failing the whole extraction. The `asar-preview://` protocol first checks `workspace/source`; when a physical file is unavailable it reads the same path directly from the original ASAR using `@electron/asar` and returns it with an extension-derived MIME type.

This allows renderer assets to remain loadable without renaming them and breaking URL references.

## Analysis schema v2

The manifest includes:

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

## Remaining extraction compatibility limits

- The `.asar.unpacked` fingerprint hashes metadata rather than every companion file's bytes. This makes normal cache invalidation inexpensive but cannot detect the pathological case where content changes while path, size, and mtime are all preserved.
- Import currently reads the installed archive in place. If another process replaces an application while hashing/extraction are in progress, a future snapshot-import mode would be a stronger consistency boundary.
- Direct ASAR fallback currently serves complete files and does not implement HTTP byte-range responses for uncommon media assets that require range loading.

The next milestone, v0.4, can build a Virtual Main runtime on top of this manifest and mock registry instead of weakening the Safe Render boundary.
