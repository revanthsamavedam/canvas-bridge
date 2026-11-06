import { validateCanvasApi } from "./allowlist.js";
import { assembleChunks, createFilesHandler, splitIntoChunks, validateRegistryCall } from "./files.js";

// Canvas host for agent-docs — the ONLY capability handed to
// Canvas inner code and to QuickJS sandbox code.
//
// Mapping (this is the adaptation — standalone Canvas used
// jsonplaceholder /posts and an in-memory store):
//   canvas.api.get(path)  -> agent-docs API, GET-only, allowlisted
//   canvas.api.fetch(app, path, opts) -> a registered internal API
//     through the chrome (GET/POST/PUT/DELETE, JSON body); the
//     chrome resolves the registry entry and fetches the token.
//   canvas.state.*        -> this document's KV state (/state endpoints)
//   canvas.files.*        -> upload/download through the chrome:
//     upload posts multipart to the registered API, download
//     returns bytes. The host form takes ArrayBuffers (no File or
//     Blob — the QuickJS sandbox has neither); the iframe client
//     converts File <-> Blob at its edge.
// The chrome owns network and tokens: inner/sandbox code never
// fetches, never sees a token, never sets Authorization. In this
// repo the chrome's network is fetch (the existing viewer
// convention); the Canvas principle — outer owns network — is
// preserved, the library is not axios here, deliberately, so
// Canvas mode does not introduce a second network stack.
//
// fetchFn is injected (default: global fetch) so this file is
// testable in node without a live API. onLog, if given, receives
// { label, status, ms } like the outer shell's network log.
// callRegisteredApi / fetchBinary are injected by the chrome
// (App.jsx): without them api.fetch and files throw NO_REGISTRY
// instead of silently doing nothing.
export function createCanvasHost({ apiBase, docId, fetchFn, onLog, callRegisteredApi, fetchBinary, maxFileSize }) {
  const fetchImpl = fetchFn || fetch;
  const base = String(apiBase || "").replace(/\/$/, "");

  async function callJson(path, method, body) {
    const started = Date.now();
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${res.status} ${path}`);
      onLog?.({ label: `${method} ${path}`, status: "ok", ms: Date.now() - started });
      try {
        return await res.json();
      } catch {
        return null;
      }
    } catch (e) {
      onLog?.({ label: `${method} ${path}`, status: "error", ms: Date.now() - started });
      throw e;
    }
  }

  async function apiGet(path) {
    const v = validateCanvasApi("GET", path);
    if (!v.ok) {
      const err = new Error(v.error);
      err.code = v.error;
      throw err;
    }
    return callJson(v.path, "GET");
  }

  async function apiFetch(app, path, opts) {
    const v = validateRegistryCall({ api: app, path, method: opts?.method, body: opts?.body });
    if (!v.ok) {
      const err = new Error(v.error);
      err.code = v.error;
      throw err;
    }
    if (!callRegisteredApi) {
      const err = new Error("registry not available in this host");
      err.code = "NO_REGISTRY";
      throw err;
    }
    return callRegisteredApi(app, path, null, { method: v.method, body: opts?.body ?? null });
  }

  // Files through the chrome, ArrayBuffer in/out. The iframe client
  // chunks over postMessage; the host feeds the same handler
  // directly, so both runtimes share one validation + upload path.
  const filesHandler =
    callRegisteredApi && fetchBinary
      ? createFilesHandler({ callRegisteredApi, fetchBinary, onLog, maxFileSize })
      : null;
  let hostUploadSeq = 0;
  function noRegistry() {
    const err = new Error("registry not available in this host");
    err.code = "NO_REGISTRY";
    throw err;
  }
  const files = {
    upload: async ({ api, path, bytes, filename, type, field }) => {
      if (!filesHandler) noRegistry();
      const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const uploadId = `host_${++hostUploadSeq}`;
      const up = filesHandler.startUpload({ uploadId, api, path, field, filename, size: buf.length, type });
      splitIntoChunks(buf).forEach((c, i) => filesHandler.receiveChunk({ uploadId, index: i, data: c }));
      return filesHandler.finishUpload({ uploadId });
    },
    download: async ({ api, path, params }) => {
      if (!filesHandler) noRegistry();
      const parts = [];
      const meta = await filesHandler.download({ api, path, params, onChunk: (c) => parts.push(c.data) });
      const bytes = assembleChunks(parts);
      return { bytes: bytes.buffer, contentType: meta.contentType, filename: meta.filename, size: meta.size };
    },
  };

  const statePath = (key) =>
    `/v1/documents/${docId}/state${key === undefined ? "" : "/" + encodeURIComponent(key)}`;

  return {
    canvas: {
      api: { get: apiGet, fetch: apiFetch },
      files,
      state: {
        get: async (key) => (await callJson(statePath(key), "GET")).value,
        all: async () => (await callJson(statePath(), "GET")).state,
        set: async (key, value) => {
          await callJson(statePath(key), "PUT", { value });
          return value;
        },
        delete: async (key) => {
          await callJson(statePath(key), "DELETE");
          return null;
        },
      },
    },
  };
}
