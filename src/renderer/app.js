const api = window.electronDecompiler;

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
  warningList: $('warning-list'),
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
  meta.textContent = `${manifest.package.version || 'unknown version'} · ${project.projectId}\nMain: ${manifest.mainEntry || 'not detected'}\n${project.archivePath}`;
  els.projectSummary.append(name, meta);

  renderEntries(manifest.rendererEntries);
  renderPreloads(manifest.preloadScripts);
  renderWarnings(manifest.warnings);
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
    node.title = entry.type === 'url' ? 'Remote URL is detected but not auto-loaded in safe v0.2 mode.' : 'Open renderer';
    els.rendererEntries.appendChild(node);
  }
}

function renderPreloads(preloads) {
  els.preloadList.innerHTML = '';
  if (!preloads.length) { els.preloadList.textContent = '未检测到 preload'; els.preloadList.className = 'empty'; return; }
  els.preloadList.className = '';
  for (const preload of preloads) {
    const node = document.createElement('div');
    node.className = 'entry';
    node.innerHTML = `<div class="entry-path"></div><div class="entry-meta"></div>`;
    node.children[0].textContent = preload.path;
    node.children[1].textContent = `${preload.confidence}% · ${preload.source}`;
    els.preloadList.appendChild(node);
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
  line.className = `console-line ${entry.level || 'info'}`;
  const time = document.createElement('span');
  time.className = 'console-time';
  time.textContent = new Date(entry.timestamp || Date.now()).toLocaleTimeString();
  const source = document.createElement('span');
  source.className = 'console-source';
  source.textContent = entry.source || 'renderer';
  const message = document.createElement('span');
  message.textContent = `${entry.message || ''}${entry.sourceId ? `  (${entry.sourceId}${entry.line ? `:${entry.line}` : ''})` : ''}`;
  line.append(time, source, message);
  els.console.appendChild(line);
  els.console.scrollTop = els.console.scrollHeight;
}

els.open.addEventListener('click', async () => importArchive(await api.chooseAsar()));
els.reload.addEventListener('click', () => api.reloadPreview());
els.devtools.addEventListener('click', () => api.openPreviewDevTools());
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
  const filePath = api.getPathForFile(file);
  await importArchive(filePath);
});

api.onProgress(showProgress);
api.onPreviewConsole(appendConsole);

const resizeObserver = new ResizeObserver(updatePreviewBounds);
resizeObserver.observe(els.previewHost);
window.addEventListener('resize', updatePreviewBounds);
