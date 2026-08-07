function serialize(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function buildRuntimeConfig(manifest, mocks) {
  return {
    version: 1,
    roots: [...new Set((manifest.bridgeExposures || []).map((item) => item.root).filter(Boolean))],
    apis: manifest.rendererApis || [],
    ipc: manifest.ipcChannels || [],
    namespaces: [...new Set((manifest.rendererApis || []).flatMap((item) => {
      const parts = String(item.path || '').split('.');
      const result = [];
      for (let i = 1; i < parts.length - 1; i += 1) result.push(parts.slice(0, i + 1).join('.'));
      return result;
    }))],
    mocks: mocks || { version: 1, apis: {}, ipc: {} }
  };
}

function buildRuntimeShim(manifest, mocks) {
  const config = buildRuntimeConfig(manifest, mocks);
  return `(() => {
  'use strict';
  const config = ${serialize(config)};
  const PREFIX = '[EDC_RUNTIME]';
  const apiMeta = new Map((config.apis || []).map((item) => [item.path, item]));
  const namespaces = new Set(config.namespaces || []);
  const warned = new Set();

  function emit(type, payload, level = 'warn') {
    try {
      const data = { type, ...payload, timestamp: Date.now() };
      (console[level] || console.log).call(console, PREFIX + JSON.stringify(data));
    } catch {}
  }

  function mockFor(path, meta) {
    const apiMocks = config.mocks?.apis || {};
    if (Object.prototype.hasOwnProperty.call(apiMocks, path)) return { source: 'api', spec: apiMocks[path] };
    const channel = meta?.ipc?.channel;
    const ipcMocks = config.mocks?.ipc || {};
    if (channel && Object.prototype.hasOwnProperty.call(ipcMocks, channel)) return { source: 'ipc', spec: ipcMocks[channel] };
    return null;
  }

  function materialize(spec, asyncExpected) {
    let value = spec;
    if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
      if (Object.prototype.hasOwnProperty.call(spec, 'throw')) {
        const error = new Error(String(spec.throw));
        return asyncExpected ? Promise.reject(error) : (() => { throw error; })();
      }
      if (Object.prototype.hasOwnProperty.call(spec, 'return')) value = spec.return;
      else if (Object.prototype.hasOwnProperty.call(spec, 'value')) value = spec.value;
    }
    return asyncExpected ? Promise.resolve(value) : value;
  }

  function safeArgs(args) {
    return Array.from(args || []).map((value) => {
      try {
        if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
        return JSON.parse(JSON.stringify(value));
      } catch {
        return Object.prototype.toString.call(value);
      }
    });
  }

  function reportMissing(path, meta, args, kind = 'call') {
    const safe = safeArgs(args);
    const key = kind + ':' + path;
    if (warned.has(key)) return;
    warned.add(key);
    if (meta?.ipc?.channel) {
      emit('missing-ipc', {
        path,
        channel: meta.ipc.channel,
        method: meta.ipc.method,
        async: Boolean(meta.ipc.async),
        args: safe
      });
    } else {
      emit(kind === 'value' ? 'missing-value' : 'missing-api', { path, args: safe });
    }
  }

  function node(path, callable = false) {
    const target = callable ? function electronDecompilerRuntimeProxy() {} : {};
    const handler = {
      get(_target, prop) {
        if (prop === 'then') return undefined;
        if (prop === Symbol.toStringTag) return 'ElectronDecompilerProxy';
        if (prop === Symbol.toPrimitive) return () => undefined;
        const childPath = path ? path + '.' + String(prop) : String(prop);
        const meta = apiMeta.get(childPath);
        const mock = mockFor(childPath, meta);
        if (meta?.kind === 'value') {
          if (mock) return materialize(mock.spec, false);
          reportMissing(childPath, meta, [], 'value');
          return undefined;
        }
        if (!meta && mock?.spec && typeof mock.spec === 'object' && Object.prototype.hasOwnProperty.call(mock.spec, 'value')) {
          return materialize(mock.spec, false);
        }
        if (namespaces.has(childPath)) return node(childPath, false);
        return node(childPath, true);
      }
    };
    if (callable) {
      handler.apply = (_target, _thisArg, args) => {
        const meta = apiMeta.get(path);
        const mock = mockFor(path, meta);
        const asyncExpected = Boolean(meta?.ipc?.async);
        if (mock) {
          emit('mock-hit', { path, channel: meta?.ipc?.channel || null, source: mock.source }, 'info');
          return materialize(mock.spec, asyncExpected);
        }
        reportMissing(path, meta, args, 'call');
        return asyncExpected ? Promise.resolve(undefined) : undefined;
      };
    }
    return new Proxy(target, handler);
  }

  for (const root of config.roots || []) {
    if (!root || Object.prototype.hasOwnProperty.call(window, root)) {
      if (root) emit('bridge-conflict', { root }, 'info');
      continue;
    }
    try {
      Object.defineProperty(window, root, {
        configurable: true,
        enumerable: true,
        writable: false,
        value: node(root, false)
      });
      emit('bridge-installed', { root }, 'info');
    } catch (error) {
      emit('bridge-install-failed', { root, message: error?.message || String(error) }, 'error');
    }
  }

  window.addEventListener('error', (event) => {
    emit('renderer-error', { message: event.message, source: event.filename, line: event.lineno, column: event.colno }, 'error');
  });
  window.addEventListener('unhandledrejection', (event) => {
    emit('renderer-rejection', { message: String(event.reason?.stack || event.reason || 'Unhandled rejection') }, 'error');
  });
})();\n`;
}

module.exports = { buildRuntimeConfig, buildRuntimeShim };
