// Canvas files bridge — container-side protocol for upload/download.
//
// Pure JS, no React, no DOM — unit-testable in plain node.
//
// The page (sandboxed iframe, fetch blocked) never touches the
// network or a token. It sends file bytes to the container in
// 1 MB chunks over postMessage; the container reassembles them and
// makes the privileged call to a registered internal API with the
// endpoint token. Downloads run the other way: the container
// fetches binary from the registered API and streams it back in
// chunks; the page reassembles a Blob. The container is the only
// side that ever sees a token, and it never sends one to the page.
//
// Validation happens BEFORE any bytes flow: unknown app, bad path,
// oversize file, or blocked extension is rejected at start, so a
// bad upload costs one message, not a 25 MB transfer.

export const CHUNK_SIZE = 1024 * 1024; // 1 MB per postMessage
export const DEFAULT_MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
export const API_METHODS = ["GET", "POST", "PUT", "DELETE"];
export const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const FIELD_NAME = /^[A-Za-z0-9_-]+$/;
// Executables, scripts, and HTML are never uploaded through the
// bridge: an HTML file served back could run as a page, a script
// could run as code. The internal API is the authority on what it
// accepts beyond this; the bridge only refuses what is unsafe to
// move at all.
export const BLOCKED_EXTENSIONS = new Set([
  "exe", "bat", "cmd", "sh", "ps1", "js", "mjs", "cjs",
  "html", "htm", "jar", "msi", "com", "scr", "vbs",
  "dll", "so", "dylib", "app", "apk",
]);

export function fileExtension(filename) {
  const m = String(filename || "").match(/\.([A-Za-z0-9]+)$/);
  return m ? m[1].toLowerCase() : "";
}

export function validatePath(path) {
  if (typeof path !== "string" || !path.startsWith("/")) return { ok: false, error: "INVALID_PATH" };
  if (path.includes("..") || path.includes("\\") || path.includes("\0")) return { ok: false, error: "INVALID_PATH" };
  return { ok: true };
}

// canvas.api.fetch validation: registered NAME only — never a full
// URL. The sandbox must not be able to aim the container's token
// at an arbitrary host, even one that matches a registry prefix.
export function validateRegistryCall({ api, path, method, body }) {
  if (typeof api !== "string" || !APP_NAME.test(api)) return { ok: false, error: "INVALID_API" };
  if (typeof api === "string" && api.indexOf("http") === 0) return { ok: false, error: "API_NAME_ONLY" };
  const p = validatePath(path === undefined || path === null ? "" : path);
  if (!p.ok) return p;
  const m = String(method || "GET").toUpperCase();
  if (!API_METHODS.includes(m)) return { ok: false, error: "UNSUPPORTED_METHOD" };
  if (m === "GET" && body !== undefined && body !== null) return { ok: false, error: "GET_WITH_BODY_NOT_ALLOWED" };
  return { ok: true, method: m };
}

export function validateFilesCall({ api, path, filename, size, field, maxFileSize }) {
  if (typeof api !== "string" || !APP_NAME.test(api)) return { ok: false, error: "INVALID_API" };
  const p = validatePath(typeof path === "string" ? path : "");
  if (!p.ok) return p;
  if (typeof filename !== "string" || filename.length === 0) return { ok: false, error: "INVALID_FILENAME" };
  if (filename.includes("/") || filename.includes("\\") || filename.includes("\0")) return { ok: false, error: "INVALID_FILENAME" };
  if (BLOCKED_EXTENSIONS.has(fileExtension(filename))) return { ok: false, error: "BLOCKED_FILE_TYPE" };
  if (field !== undefined && (typeof field !== "string" || !FIELD_NAME.test(field))) return { ok: false, error: "INVALID_FIELD" };
  const max = Number.isFinite(maxFileSize) ? maxFileSize : DEFAULT_MAX_FILE_SIZE;
  if (!Number.isFinite(size) || size < 0 || size > max) return { ok: false, error: "FILE_TOO_LARGE" };
  return { ok: true };
}

export function splitIntoChunks(bytes, chunkSize = CHUNK_SIZE) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const out = [];
  for (let i = 0; i < buf.length; i += chunkSize) {
    out.push(buf.slice(i, i + chunkSize).buffer);
  }
  return out;
}

export function assembleChunks(chunks) {
  let total = 0;
  const parts = chunks.map((c) => {
    const u = c instanceof Uint8Array ? c : new Uint8Array(c);
    total += u.length;
    return u;
  });
  const out = new Uint8Array(total);
  let off = 0;
  for (const u of parts) {
    out.set(u, off);
    off += u.length;
  }
  return out;
}

export function buildMultipart({ field, filename, type, bytes }) {
  const form = new FormData();
  form.append(field || "file", new Blob([bytes], { type: type || "application/octet-stream" }), filename);
  return form;
}

function error(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Container-side upload/download state machine. callRegisteredApi
// is the chrome's registry caller: (api, path, tokenUrlOverride,
// {method, body, isMultipart, raw}) => {status, data, contentType}.
// fetchBinary is (api, path, params) => {bytes, contentType,
// filename}. Neither ever hands a token to the page — they run in
// the chrome, and only their results cross postMessage.
export function createFilesHandler({ callRegisteredApi, fetchBinary, onLog, maxFileSize, isAppRegistered, store }) {
  const max = Number.isFinite(maxFileSize) ? maxFileSize : DEFAULT_MAX_FILE_SIZE;
  // The upload store can live outside the handler (a React ref):
  // the chrome creates a fresh handler per message with the
  // current render's registry caller, but partial uploads survive
  // across renders in the shared store.
  const uploads = store || new Map();

  function log(label, status, extra) {
    onLog?.({ label, status, ...(extra || {}) });
  }

  function startUpload({ uploadId, api, path, field, filename, size, type }) {
    if (typeof uploadId !== "string" || uploadId.length === 0) throw error("missing uploadId", "INVALID_UPLOAD");
    if (uploads.has(uploadId)) throw error("upload already started", "INVALID_UPLOAD");
    const v = validateFilesCall({ api, path, filename, size, field, maxFileSize: max });
    if (!v.ok) throw error(v.error, v.error);
    if (isAppRegistered && !isAppRegistered(api)) throw error("api_not_registered", "API_NOT_REGISTERED");
    const totalChunks = Math.ceil(size / CHUNK_SIZE);
    uploads.set(uploadId, { api, path, field: field || "file", filename, size, type, chunks: [], received: 0, totalChunks });
    log(`files upload start ${api} ${path} (${filename}, ${size} bytes)`, "ok");
    return { uploadId, chunkSize: CHUNK_SIZE, chunks: totalChunks };
  }

  function receiveChunk({ uploadId, index, data }) {
    const up = uploads.get(uploadId);
    if (!up) throw error("unknown upload", "UNKNOWN_UPLOAD");
    if (index !== up.received) throw error(`expected chunk ${up.received}, got ${index}`, "OUT_OF_ORDER_CHUNK");
    const buf = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
    if (!buf) throw error("chunk must be an ArrayBuffer", "INVALID_CHUNK");
    up.chunks.push(buf);
    up.received += 1;
    return { uploadId, received: up.received, total: up.totalChunks };
  }

  async function finishUpload({ uploadId }) {
    const up = uploads.get(uploadId);
    if (!up) throw error("unknown upload", "UNKNOWN_UPLOAD");
    uploads.delete(uploadId);
    if (up.received !== up.totalChunks) throw error(`incomplete upload: ${up.received}/${up.totalChunks} chunks`, "INCOMPLETE_UPLOAD");
    const bytes = assembleChunks(up.chunks);
    if (bytes.length !== up.size) throw error(`size mismatch: expected ${up.size}, got ${bytes.length}`, "SIZE_MISMATCH");
    const form = buildMultipart({ field: up.field, filename: up.filename, type: up.type, bytes });
    const started = Date.now();
    const res = await callRegisteredApi(up.api, up.path, null, { method: "POST", body: form, isMultipart: true });
    log(`files upload ${up.api} ${up.path} (${up.filename}, ${up.size} bytes)`, "ok", { ms: Date.now() - started });
    return res;
  }

  function cancelUpload({ uploadId }) {
    uploads.delete(uploadId);
    return { uploadId, cancelled: true };
  }

  // Drop every partial upload: called when the view changes or the
  // iframe reloads, so a page that went away mid-upload cannot
  // leave bytes behind for the next document.
  function clearAll() {
    const n = uploads.size;
    uploads.clear();
    return { cleared: n };
  }

  async function download({ api, path, params, onChunk }) {
    const v = validateRegistryCall({ api, path, method: "GET" });
    if (!v.ok) throw error(v.error, v.error);
    if (isAppRegistered && !isAppRegistered(api)) throw error("api_not_registered", "API_NOT_REGISTERED");
    const started = Date.now();
    const { bytes, contentType, filename } = await fetchBinary(api, path, params);
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const chunks = splitIntoChunks(buf);
    log(`files download ${api} ${path} (${buf.length} bytes)`, "ok", { ms: Date.now() - started });
    const meta = { size: buf.length, contentType: contentType || "application/octet-stream", filename: filename || path.split("/").filter(Boolean).pop() || "download" };
    for (let i = 0; i < chunks.length; i++) {
      onChunk?.({ index: i, total: chunks.length, data: chunks[i], done: i === chunks.length - 1, meta: i === 0 ? meta : undefined });
    }
    if (chunks.length === 0) onChunk?.({ index: 0, total: 0, data: new ArrayBuffer(0), done: true, meta });
    return meta;
  }

  return { startUpload, receiveChunk, finishUpload, cancelUpload, clearAll, download };
}
