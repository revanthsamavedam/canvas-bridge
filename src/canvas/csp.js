// Canvas shell for an agent-docs document render copy — adapted
// from standalone Canvas (CSP + lockdown + window.canvas bridge).
//
// The stored document HTML is NEVER changed. withCanvasShell()
// returns a render copy only, exactly like the existing withBridge()
// in App.jsx. The existing agentdocs bridge and this canvas bridge
// are not injected together: Canvas mode uses canvas only, the
// normal viewer uses agentdocs only, so their postMessage types
// never collide.
//
// Two layers, in this order, before any document code runs:
//  1. CSP (browser-enforced, JS cannot undo it): connect-src 'none'
//     blocks fetch / XHR / WebSocket / EventSource / sendBeacon.
//     postMessage is not network, so window.canvas still works.
//     Images are data: only, frames/workers/forms/media are 'none',
//     so data cannot leak out in a pixel, a nested frame, or a form.
//  2. Lockdown script: replaces those globals with throwing stubs
//     (clear error, not the enforcement) and blocks creating
//     <iframe>/<object>/<embed> — a nested frame would be a fresh
//     realm with fresh globals.
//
// Script policy note: script-src is 'unsafe-inline' only. Stored
// agent-docs documents are self-contained HTML, so this matches
// them. A document that loads an external script will not run in
// Canvas mode — that is why Canvas mode is opt-in, not the default
// viewer. The normal viewer is unchanged.

export const CANVAS_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data:; media-src 'none'; font-src 'none'; connect-src 'none'; " +
  "object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; " +
  "base-uri 'none'; manifest-src 'none'";

export const LOCKDOWN_SCRIPT = `(function () {
  function blocked(name) {
    return function () { throw new Error('Canvas inner shell: ' + name + ' is blocked. Use window.canvas.* via the outer shell.'); };
  }
  function lock(obj, prop, value) {
    try { Object.defineProperty(obj, prop, { value: value, writable: false, configurable: false }); }
    catch (e) { try { obj[prop] = value; } catch (_) {} }
  }
  lock(window, 'fetch', blocked('fetch'));
  lock(window, 'XMLHttpRequest', blocked('XMLHttpRequest'));
  lock(window, 'WebSocket', blocked('WebSocket'));
  lock(window, 'EventSource', blocked('EventSource'));
  lock(window, 'Worker', blocked('Worker'));
  lock(window, 'SharedWorker', blocked('SharedWorker'));
  lock(window, 'open', blocked('window.open'));
  try { lock(Navigator.prototype, 'sendBeacon', blocked('sendBeacon')); } catch (e) {}
  var origCreate = Document.prototype.createElement;
  Document.prototype.createElement = function (tag) {
    var t = String(tag || '').toLowerCase();
    if (t === 'iframe' || t === 'object' || t === 'embed' || t === 'frame') {
      throw new Error('Canvas inner shell: <' + t + '> is blocked.');
    }
    return origCreate.apply(this, arguments);
  };
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    // blob: and data: links are local downloads, not navigation:
    // canvas.files.save triggers a download this way, and it must
    // not be blocked. Anything else that would navigate away is.
    if (href.startsWith('#') || href.startsWith('blob:') || href.startsWith('data:')) return;
    e.preventDefault(); e.stopPropagation();
  }, true);
  document.addEventListener('submit', function (e) { e.preventDefault(); e.stopPropagation(); }, true);
})();`;

// window.canvas client v2, injected into the render copy only.
// This is the whole bridge: the viewer injects it into every page
// at view time, so any JavaScript in the page — vanilla, React,
// anything — just uses window.canvas with no wiring of its own.
//
//   canvas.api.get(path) — agent-docs API, GET-only, allowlisted.
//   canvas.api.fetch(app, path, opts) — a registered internal API
//     through the chrome (GET/POST/PUT/DELETE, JSON body). The page
//     never sees a token; the chrome resolves the registry entry
//     and fetches the token.
//   canvas.state.get/all/set/delete — document-scoped KV, via chrome.
//   canvas.state.subscribe(key, cb) — chrome pushes canvas-state-changed.
//   canvas.files.upload({api, path, file, field, onProgress}) — the
//     file goes to the chrome in 1 MB chunks over postMessage; the
//     chrome reassembles it and POSTs it multipart to the registered
//     API with the endpoint token. Resolves with the API's response.
//   canvas.files.download({api, path, params}) — the chrome fetches
//     binary from the registered API and streams it back in chunks;
//     resolves with a Blob.
//   canvas.files.save({api, path, params, filename}) — download,
//     then trigger the browser download in the page.
//
// Security: the chrome issues a per-view session nonce in
// canvas-init; every request echoes it, and the chrome rejects a
// request whose session is stale or missing. Requests made before
// init arrives wait for it, so page code never has to wait.
// Outside the viewer (opened directly) every call rejects with a
// plain error instead of hanging.
export const CANVAS_BRIDGE_SCRIPT = `(function () {
  var pending = {};
  var subs = {};
  var downloads = {};
  var nextId = 1;
  var docId = null;
  var session = null;
  var readyResolve = null;
  var ready = new Promise(function (res) { readyResolve = res; });
  var CHUNK = 1024 * 1024;
  function notInViewer() {
    return Promise.reject(new Error('canvas bridge: not running inside the Canvas viewer'));
  }
  function request(kind, extra) {
    if (window.parent === window) return notInViewer();
    return ready.then(function () {
      return new Promise(function (resolve, reject) {
        var id = nextId++;
        pending[id] = { resolve: resolve, reject: reject };
        window.parent.postMessage(Object.assign({ type: 'canvas-request', id: id, kind: kind, session: session }, extra), '*');
      });
    });
  }
  function requestChunk(kind, extra, buffer) {
    if (window.parent === window) return notInViewer();
    return ready.then(function () {
      return new Promise(function (resolve, reject) {
        var id = nextId++;
        pending[id] = { resolve: resolve, reject: reject };
        var msg = Object.assign({ type: 'canvas-request', id: id, kind: kind, session: session }, extra);
        if (buffer) window.parent.postMessage(msg, '*', [buffer]);
        else window.parent.postMessage(msg, '*');
      });
    });
  }
  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.type === 'canvas-init') {
      docId = d.docId; session = d.session || null;
      if (readyResolve) { readyResolve(); readyResolve = null; }
      return;
    }
    if (d.type === 'canvas-response' && pending[d.id]) {
      var p = pending[d.id]; delete pending[d.id];
      if (d.ok) p.resolve(d.value); else p.reject(new Error(d.error || 'canvas error'));
    }
    if (d.type === 'canvas-download-chunk' && downloads[d.id]) {
      var dl = downloads[d.id];
      if (d.error) { delete downloads[d.id]; dl.reject(new Error(d.error)); return; }
      if (d.data) dl.chunks.push(d.data);
      if (d.meta) dl.meta = d.meta;
      if (d.done) {
        delete downloads[d.id];
        var blob = new Blob(dl.chunks, { type: (dl.meta && dl.meta.contentType) || 'application/octet-stream' });
        blob.name = (dl.meta && dl.meta.filename) || 'download';
        dl.resolve(blob);
      }
    }
    if (d.type === 'canvas-state-changed' && subs[d.key]) {
      subs[d.key].forEach(function (cb) { cb(d.value); });
    }
  });
  function uploadFile(args) {
    var file = args.file;
    // Only what the upload actually uses: slice() + size. A real
    // File/Blob has arrayBuffer too, but the code calls it on the
    // slice result, so a Blob-like with slice() is enough.
    if (!file || typeof file.slice !== 'function' || typeof file.size !== 'number') {
      return Promise.reject(new Error('canvas.files.upload needs a File or Blob'));
    }
    var total = file.size;
    var uploadId = 'up_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e9).toString(36);
    return request('files:upload:start', { uploadId: uploadId, api: args.api, path: args.path, field: args.field, filename: file.name || 'upload', size: total, type: file.type || '' })
      .then(function (start) {
        var size = start.chunkSize || CHUNK;
        var chunks = start.chunks;
        var sent = 0;
        var chain = Promise.resolve();
        for (var i = 0; i < chunks; i++) {
          (function (index) {
            chain = chain.then(function () {
              var s = index * size;
              return file.slice(s, Math.min(s + size, total)).arrayBuffer().then(function (buf) {
                return requestChunk('files:upload:chunk', { uploadId: uploadId, index: index }, buf).then(function () {
                  sent += buf.byteLength;
                  if (args.onProgress) args.onProgress({ sent: sent, total: total, chunks: chunks, index: index });
                });
              });
            });
          })(i);
        }
        return chain.then(function () {
          return request('files:upload:finish', { uploadId: uploadId });
        });
      });
  }
  function downloadFile(args) {
    if (window.parent === window) return notInViewer();
    return ready.then(function () {
      return new Promise(function (resolve, reject) {
        var id = nextId++;
        downloads[id] = { chunks: [], meta: null, resolve: resolve, reject: reject };
        window.parent.postMessage({ type: 'canvas-request', id: id, kind: 'files:download', session: session, api: args.api, path: args.path, params: args.params || null }, '*');
      });
    });
  }
  window.canvas = {
    docId: function () { return docId; },
    api: {
      get: function (path) { return request('api', { method: 'GET', path: path }); },
      fetch: function (api, path, opts) {
        opts = opts || {};
        return request('api:fetch', { api: api, path: path, method: opts.method || 'GET', body: opts.body === undefined ? null : opts.body });
      },
    },
    state: {
      get: function (key) { return request('state:get', { key: key }); },
      all: function () { return request('state:all'); },
      set: function (key, value) { return request('state:set', { key: key, value: value }); },
      delete: function (key) { return request('state:delete', { key: key }); },
      subscribe: function (key, cb) {
        (subs[key] = subs[key] || []).push(cb);
        return Promise.resolve(true);
      },
    },
    files: {
      upload: uploadFile,
      download: downloadFile,
      save: function (args) {
        return downloadFile(args).then(function (blob) {
          var filename = args.filename || blob.name || 'download';
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
          return { filename: filename, size: blob.size };
        });
      },
    },
  };
})();`;

export function withCanvasShell(html) {
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${CANVAS_CSP}">`;
  const lockdown = `<script>${LOCKDOWN_SCRIPT}<\/script>`;
  const bridge = `<script>${CANVAS_BRIDGE_SCRIPT}<\/script>`;
  let out = html;
  if (out.includes("<head>")) {
    out = out.replace("<head>", `<head>${cspMeta}${lockdown}`);
  } else {
    out = cspMeta + lockdown + out;
  }
  if (out.includes("</body>")) {
    out = out.replace("</body>", `${bridge}</body>`);
  } else {
    out = out + bridge;
  }
  return out;
}
