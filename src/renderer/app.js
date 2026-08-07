const api = window.electronDecompiler;

const EMPTY_MOCKS = { version: 1, apis: {}, ipc: {} };
const state = {
  project: null,
  activePreviewPath: null,
  consoleLines: []
};

const $ = (id) => document.getElementById(id);
const els = {
  open: $('open-button'),
  reload: $('reload-button'),
  devtools: $('devtools-button'),
  dropZone: $('drop-zone'),
  projectSummary: $('project-summary'),
  fileTree: $('file-tree'),
  rendererEntries: $('renderer-entries'),
  preloadList: $('preload-list'),
  bridgeList: $('bridge-list'),
  apiList: $('api-list'),
  ipcList: $('ipc-list'),
  warningList: $('warning-list'),
  mockEditor: $('mock-editor'),
  mockStatus: $('mock-status'),
  saveMocks: $('save-mocks'),
  resetMocks: $('reset-mocks'),
  status: $('status-badge'),
  progressCard: $('progress-card'),
  progressLabel: $('progress-label'),
  progressPercent: $('progress-percent'),
  progressBar: $('progress-bar'),
  progressDetail: $('progress-detail'),
  previewHost: $('preview-host'),
  previewPlaceholder: $('preview-placeholder'),
  previewPath: $('preview-path'),
  console: $('console-output'),
  clearConsole: $('clear-console')
};

function setStatus(value) {
  els.status.textContent = value;
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function prettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function showProgress(progress) {
  setStatus(progress.phase);
  if (progress.phase === 'READY') {
    els.progressCard.classList.add('hidden');
    return;
  }
  els.progressCard.classList.remove('hidden');
  els.progressLabel.textContent = progress.phase;

  let percent = 0;
  if (progress.phase === 'EXTRACTING') {
    if (progress.totalBytes > 0) percent = (progress.bytesDone / progress.totalBytes) * 100;
    else if (progress.totalEntries > 0) percent = (progress.entriesDone / progress.totalEntries) * 100;
    els.progressDetail.textContent = `${progress.filesDone || 0}/${progress.totalFiles || 0} files · ${formatBytes(progress.bytesDone || 0)} / ${formatBytes(progress.totalBytes || 0)} · ${progress.currentFile || ''}`;
  } else if (progress.phase === 'SCANNING') {
    els.progressDetail.textContent = progress.totalEntries ? `${progress.totalEntries} archive entries detected` : 'Reading ASAR index…';
  } else if (progress.phase === 'ANALYZING' && progress.reason === 'schema-upgrade') {
    els.progressDetail.textContent = 'Updating cached analysis to v0.3 schema…';
  } else {
    els.progressDetail.textContent = progress.archivePath || '';
  }
  percent = Math.min(100, Math.max(0, percent));
  els.progressPercent.textContent = `${percent.toFixed(0)}%`;
  els.progressBar.style.width = `${percent}%`;
}

async function importArchive(filePath) {
  if (!filePath) return;
  state.project = null;
  api.hidePreview();
  els.previewPlaceholder.classList.remove('hidden');
  setStatus('IMPORTING');
  try {
    const project = await api.importAsar(filePath);
    state.project = project;
    renderProject(project);
    await loadRootTree();
    const firstLocal = project.manifest.rendererEntries.find((entry) => entry.type === 'file');
    if (firstLocal) await openPreview(firstLocal.path);
  } catch (error) {
    setStatus('ERROR');
    appendConsole({ source: 'host', level: 'error', message: error?.message || String(error), timestamp: Date.now() });
  }
}

function renderProject(project) {
  const manifest = project.manifest;
  els.projectSummary.classList.remove('empty');
  els.projectSummary.innerHTML = '';
  const name = document.createElement('div');
  name.className = 'project-name';
  name.textContent = manifest.package.name || 'Unnamed Electron App';
  const meta = document.createElement('div');
  meta.className = 'project-meta';
  meta.textContent = `${manifest.package.version || 'unknown version'} · ${project.projectId}\nMain: ${manifest.mainEntry || 'not detected'}\nAnalysis schema: ${manifest.schemaVersion}\n${project.archivePath}`;
  els.projectSummary.append(name, meta);

  renderEntries(manifest.rendererEntries || []);
  renderPreloads(manifest.preloadScripts || [], manifest.bridgeExposures || []);
  renderApis(manifest.rendererApis || []);
  renderIpc(manifest.ipcChannels || []);
  renderWarnings(manifest.warnings || []);
  setMockEditor(project.mocks || EMPTY_MOCKS);
  els.mockEditor.disabled = false;
  els.saveMocks.disabled = false;
  els.resetMocks.disabled = false;
}

function renderEntries(entries) {
  els.rendererEntries.innerHTML = '';
  if (!entries.length) { els.rendererEntries.textContent = '未检测到 Renderer'; els.rendererEntries.className = 'empty'; return; }
  els.rendererEntries.className = '';
  for (const entry of entries.slice(0, 25)) {
    const node = document.createElement('div');
    node.className = 'entry';
    const title = document.createElement('div');
    title.className = 'entry-path';
    title.textContent = entry.path || entry.url;
    const meta = document.createElement('div');
    meta.className = 'entry-meta';
    meta.textContent = `${entry.confidence}% · ${entry.source}`;
    node.append(title, meta);
    if (entry.type === 'file') node.addEventListener('click', () => openPreview(entry.path));
    node.title = entry.type === 'url' ? 'Remote URL is detected but not auto-loaded in safe mode.' : 'Open renderer';
    els.rendererEntries.appendChild(node);
  }
}

function renderPreloads(preloads, bridges) {
  els.preloadList.innerHTML = '';
  if (!preloads.length) {
    els.preloadList.textContent = '未检测到 preload';
    els.preloadList.className = 'empty';
  } else {
    els.preloadList.className = '';
    for (const preload of preloads) {
      const node = document.createElement('div');
      node.className = 'entry';
      const title = document.createElement('div');
      title.className = 'entry-path';
      title.textContent = preload.path;
      const meta = document.createElement('div');
      meta.className = 'entry-meta';
      meta.textContent = `${preload.confidence}% · ${preload.bridgeCount || 0} bridges · ${preload.apiCount || 0} APIs · ${preload.ipcCount || 0} IPC`;
      node.append(title, meta);
      els.preloadList.appendChild(node);
    }
  }

  els.bridgeList.innerHTML = '';
  for (const bridge of bridges) {
    const row = document.createElement('div');
    row.className = 'bridge-row';
    const title = document.createElement('div');
    title.className = 'api-path';
    title.textContent = `window.${bridge.root}`;
    const meta = document.createElement('div');
    meta.className = 'bridge-meta';
    meta.textContent = `${bridge.apiCount || 0} APIs · ${bridge.preload}${bridge.unresolved ? ' · unresolved object' : ''}`;
    row.append(title, meta);
    els.bridgeList.appendChild(row);
  }
}

function renderApis(apis) {
  els.apiList.innerHTML = '';
  if (!apis.length) { els.apiList.textContent = '未解析到 bridge API'; els.apiList.className = 'empty'; return; }
  els.apiList.className = '';
  for (const item of apis.slice(0, 80)) {
    const row = document.createElement('div');
    row.className = 'api-row';
    const title = document.createElement('div');
    title.className = 'api-path';
    title.textContent = item.path;
    const meta = document.createElement('div');
    meta.className = 'api-meta';
    meta.textContent = item.ipc
      ? `${item.kind} · ipcRenderer.${item.ipc.method}('${item.ipc.channel}')`
      : `${item.kind}${item.unresolvedReference ? ' · unresolved reference' : ''}`;
    row.append(title, meta);
    els.apiList.appendChild(row);
  }
}

function renderIpc(channels) {
  els.ipcList.innerHTML = '';
  if (!channels.length) { els.ipcList.textContent = '未解析到 IPC channel'; els.ipcList.className = 'empty'; return; }
  els.ipcList.className = '';
  for (const item of channels.slice(0, 100)) {
    const row = document.createElement('div');
    row.className = 'ipc-row';
    const title = document.createElement('div');
    title.className = 'ipc-channel';
    title.textContent = item.channel;
    const meta = document.createElement('div');
    meta.className = `ipc-meta status-${item.status}`;
    const renderer = item.rendererMethods.length ? `renderer: ${item.rendererMethods.join(', ')}` : 'renderer: —';
    const main = item.mainMethods.length ? `main: ${item.mainMethods.join(', ')}` : 'main: —';
    meta.textContent = `${item.status} · ${renderer} · ${main}`;
    row.append(title, meta);
    if (item.exposedAs?.length) {
      const exposed = document.createElement('div');
      exposed.className = 'ipc-meta';
      exposed.textContent = item.exposedAs.join(', ');
      row.appendChild(exposed);
    }
    els.ipcList.appendChild(row);
  }
}

function renderWarnings(warnings) {
  els.warningList.innerHTML = '';
  if (!warnings.length) { els.warningList.textContent = '暂无'; els.warningList.className = 'empty'; return; }
  els.warningList.className = '';
  for (const warning of warnings.slice(0, 50)) {
    const node = document.createElement('div');
    node.className = 'warning';
    node.textContent = `[${warning.code}] ${warning.path ? `${warning.path}: ` : ''}${warning.message}`;
    els.warningList.appendChild(node);
  }
}

function setMockEditor(mocks) {
  els.mockEditor.value = prettyJson(mocks || EMPTY_MOCKS);
  els.mockEditor.classList.remove('invalid');
  els.mockStatus.textContent = '';
}

function parseMockEditor() {
  try {
    const value = JSON.parse(els.mockEditor.value);
    els.mockEditor.classList.remove('invalid');
    return value;
  } catch (error) {
    els.mockEditor.classList.add('invalid');
    els.mockStatus.textContent = error.message;
    throw error;
  }
}

async function saveMocks() {
  if (!state.project) return;
  try {
    const mocks = parseMockEditor();
    const saved = await api.saveMocks(state.project.projectId, mocks);
    state.project.mocks = saved;
    setMockEditor(saved);
    els.mockStatus.textContent = 'saved';
    appendConsole({ source: 'host', level: 'info', message: 'Runtime mocks saved. Reloading preview…', timestamp: Date.now() });
    api.reloadPreview();
  } catch (error) {
    appendConsole({ source: 'host', level: 'error', message: `Failed to save mocks: ${error?.message || String(error)}`, timestamp: Date.now() });
  }
}

function addMockStub(runtimeEvent) {
  if (!state.project || !runtimeEvent) return;
  let mocks;
  try { mocks = parseMockEditor(); } catch { return; }
  mocks.version = 1;
  mocks.apis ||= {};
  mocks.ipc ||= {};
  if (runtimeEvent.type === 'missing-ipc' && runtimeEvent.channel) {
    if (!(runtimeEvent.channel in mocks.ipc)) mocks.ipc[runtimeEvent.channel] = { return: null };
  } else if (runtimeEvent.path) {
    if (!(runtimeEvent.path in mocks.apis)) {
      mocks.apis[runtimeEvent.path] = runtimeEvent.type === 'missing-value' ? { value: null } : { return: null };
    }
  } else return;
  setMockEditor(mocks);
  els.mockStatus.textContent = 'stub added — save to apply';
  els.mockEditor.scrollIntoView({ block: 'nearest' });
}

async function loadRootTree() {
  els.fileTree.innerHTML = '';
  els.fileTree.classList.remove('empty');
  const items = await api.listDirectory(state.project.projectId, '');
  await renderTreeItems(els.fileTree, items);
}

async function renderTreeItems(container, items) {
  for (const item of items) {
    const wrapper = document.createElement('div');
    const row = document.createElement('div');
    row.className = `tree-row ${item.path.toLowerCase().endsWith('.html') ? 'html' : ''}`;
    const twisty = document.createElement('span');
    twisty.className = 'twisty';
    twisty.textContent = item.type === 'directory' ? '▶' : '';
    const label = document.createElement('span');
    label.textContent = item.name;
    row.append(twisty, label);
    wrapper.appendChild(row);
    container.appendChild(wrapper);

    if (item.type === 'directory') {
      let expanded = false;
      let children;
      row.addEventListener('click', async () => {
        expanded = !expanded;
        twisty.textContent = expanded ? '▼' : '▶';
        if (!children) {
          children = document.createElement('div');
          children.className = 'tree-children';
          wrapper.appendChild(children);
          const childItems = await api.listDirectory(state.project.projectId, item.path);
          await renderTreeItems(children, childItems);
        }
        children.classList.toggle('hidden', !expanded);
      });
    } else if (item.path.toLowerCase().endsWith('.html')) {
      row.addEventListener('click', () => openPreview(item.path));
      row.title = `${formatBytes(item.size)} · Click to preview`;
    }
  }
}

async function openPreview(relativePath) {
  if (!state.project || !relativePath) return;
  state.activePreviewPath = relativePath;
  els.previewPath.textContent = relativePath;
  els.previewPlaceholder.classList.add('hidden');
  els.reload.disabled = false;
  els.devtools.disabled = false;
  try {
    await api.loadPreview(state.project.projectId, relativePath);
    updatePreviewBounds();
    setStatus('RUNNING');
  } catch (error) {
    appendConsole({ source: 'preview', level: 'error', message: error?.message || String(error), timestamp: Date.now() });
  }
}

function updatePreviewBounds() {
  const rect = els.previewHost.getBoundingClientRect();
  api.setPreviewBounds({ x: rect.left + 1, y: rect.top + 1, width: Math.max(0, rect.width - 2), height: Math.max(0, rect.height - 2) });
}

function appendConsole(entry) {
  if (state.consoleLines.length === 0) els.console.innerHTML = '';
  state.consoleLines.push(entry);
  if (state.consoleLines.length > 1000) state.consoleLines.shift();
  const line = document.createElement('div');
  line.className = `console-line ${entry.level || 'info'} ${entry.source || ''}`;
  const time = document.createElement('span');
  time.className = 'console-time';
  time.textContent = new Date(entry.timestamp || Date.now()).toLocaleTimeString();
  const source = document.createElement('span');
  source.className = 'console-source';
  source.textContent = entry.source || 'renderer';
  const message = document.createElement('span');
  message.textContent = `${entry.message || ''}${entry.sourceId ? `  (${entry.sourceId}${entry.line ? `:${entry.line}` : ''})` : ''}`;
  line.append(time, source, message);
  if (entry.runtimeEvent && ['missing-api', 'missing-value', 'missing-ipc'].includes(entry.runtimeEvent.type)) {
    line.title = 'Double click to add a mock stub';
    line.addEventListener('dblclick', () => addMockStub(entry.runtimeEvent));
  }
  els.console.appendChild(line);
  els.console.scrollTop = els.console.scrollHeight;
}

els.open.addEventListener('click', async () => importArchive(await api.chooseAsar()));
els.reload.addEventListener('click', () => api.reloadPreview());
els.devtools.addEventListener('click', () => api.openPreviewDevTools());
els.saveMocks.addEventListener('click', saveMocks);
els.resetMocks.addEventListener('click', () => { setMockEditor(EMPTY_MOCKS); els.mockStatus.textContent = 'editor reset — save to apply'; });
els.mockEditor.addEventListener('input', () => { els.mockStatus.textContent = 'unsaved'; els.mockEditor.classList.remove('invalid'); });
els.clearConsole.addEventListener('click', () => { state.consoleLines = []; els.console.innerHTML = '<div class="console-empty">Console cleared.</div>'; });

for (const eventName of ['dragenter', 'dragover']) {
  window.addEventListener(eventName, (event) => { event.preventDefault(); els.dropZone.classList.add('dragging'); });
}
for (const eventName of ['dragleave', 'drop']) {
  window.addEventListener(eventName, (event) => { event.preventDefault(); els.dropZone.classList.remove('dragging'); });
}
window.addEventListener('drop', async (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  await importArchive(api.getPathForFile(file));
});

api.onProgress(showProgress);
api.onPreviewConsole(appendConsole);

const resizeObserver = new ResizeObserver(updatePreviewBounds);
resizeObserver.observe(els.previewHost);
window.addEventListener('resize', updatePreviewBounds);
