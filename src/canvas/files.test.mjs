import assert from 'node:assert'
import {
  CHUNK_SIZE, DEFAULT_MAX_FILE_SIZE,
  validateRegistryCall, validateFilesCall,
  splitIntoChunks, assembleChunks, buildMultipart,
  createFilesHandler,
} from './files.js'
import { createCanvasHost } from './canvasHost.js'

// --- validation: registry calls are names only, never URLs ---
assert.equal(validateRegistryCall({ api: 'riskhub', path: '/risks', method: 'GET' }).ok, true)
assert.equal(validateRegistryCall({ api: 'https://evil.example/x', path: '/x' }).error, 'INVALID_API')
assert.equal(validateRegistryCall({ api: 'riskhub', path: '/x', method: 'PATCH' }).error, 'UNSUPPORTED_METHOD')
assert.equal(validateRegistryCall({ api: 'riskhub', path: '/x', method: 'GET', body: { a: 1 } }).error, 'GET_WITH_BODY_NOT_ALLOWED')
assert.equal(validateRegistryCall({ api: 'riskhub', path: '../etc' }).error, 'INVALID_PATH')
assert.equal(validateRegistryCall({ api: 'riskhub', path: 'no-leading-slash' }).error, 'INVALID_PATH')

// --- validation: files ---
const good = { api: 'riskhub', path: '/upload', filename: 'q3.csv', size: 100, field: 'file' }
assert.equal(validateFilesCall(good).ok, true)
assert.equal(validateFilesCall({ ...good, filename: 'run.exe' }).error, 'BLOCKED_FILE_TYPE')
assert.equal(validateFilesCall({ ...good, filename: 'page.html' }).error, 'BLOCKED_FILE_TYPE')
assert.equal(validateFilesCall({ ...good, filename: 'x.js' }).error, 'BLOCKED_FILE_TYPE')
assert.equal(validateFilesCall({ ...good, size: DEFAULT_MAX_FILE_SIZE + 1 }).error, 'FILE_TOO_LARGE')
assert.equal(validateFilesCall({ ...good, path: '/up/../etc' }).error, 'INVALID_PATH')
assert.equal(validateFilesCall({ ...good, filename: '../q3.csv' }).error, 'INVALID_FILENAME')
assert.equal(validateFilesCall({ ...good, field: 'a b' }).error, 'INVALID_FIELD')
assert.equal(validateFilesCall({ ...good, api: 'not a name!' }).error, 'INVALID_API')

// --- chunking round-trip ---
const bytes = new Uint8Array(2 * CHUNK_SIZE + 400_000)
for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
const chunks = splitIntoChunks(bytes)
assert.equal(chunks.length, 3, '2.4 MB must split into 3 x 1 MB chunks')
assert.deepEqual(assembleChunks(chunks), bytes)
assert.deepEqual(assembleChunks([]), new Uint8Array(0))

// --- multipart build ---
const form = buildMultipart({ field: 'evidence', filename: 'q3.csv', type: 'text/csv', bytes })
assert.ok(form instanceof FormData, 'must build a FormData')
const part = form.get('evidence')
assert.equal(part.name, 'q3.csv')
assert.equal(part.type, 'text/csv')
assert.equal(part.size, bytes.length)
assert.deepEqual(new Uint8Array(await part.arrayBuffer()), bytes)

// --- handler: full upload flow ---
const calls = []
async function mockCallRegisteredApi(api, path, _tokenUrl, options) {
  calls.push({ api, path, options })
  return { status: 200, data: { stored: true } }
}
const logs = []
const handler = createFilesHandler({
  callRegisteredApi: mockCallRegisteredApi,
  fetchBinary: async () => { throw new Error('no binary in upload test') },
  onLog: (e) => logs.push(e),
  isAppRegistered: (n) => n === 'riskhub',
})

const start = handler.startUpload({ uploadId: 'u1', api: 'riskhub', path: '/upload', field: 'evidence', filename: 'q3.csv', size: bytes.length, type: 'text/csv' })
assert.equal(start.chunks, 3)
assert.equal(start.chunkSize, CHUNK_SIZE)
for (let i = 0; i < chunks.length; i++) {
  const ack = handler.receiveChunk({ uploadId: 'u1', index: i, data: chunks[i] })
  assert.equal(ack.received, i + 1)
}
const res = await handler.finishUpload({ uploadId: 'u1' })
assert.deepEqual(res, { status: 200, data: { stored: true } })
assert.equal(calls.length, 1, 'exactly one registry call per upload')
assert.equal(calls[0].api, 'riskhub')
assert.equal(calls[0].path, '/upload')
assert.equal(calls[0].options.method, 'POST')
assert.equal(calls[0].options.isMultipart, true)
const sent = calls[0].options.body.get('evidence')
assert.equal(sent.name, 'q3.csv')
assert.deepEqual(new Uint8Array(await sent.arrayBuffer()), bytes)
assert.ok(logs.some((l) => l.label.includes('files upload')), 'upload must be logged')

// --- handler: failures, before any bytes flow ---
function throwsWith(fn, code) {
  let e = null
  try { fn() } catch (err) { e = err }
  assert(e && e.code === code, `expected ${code}, got ${e && e.code}`)
}
throwsWith(() => handler.startUpload({ uploadId: 'u2', api: 'riskhub', path: '/upload', filename: 'big.bin', size: DEFAULT_MAX_FILE_SIZE + 1 }), 'FILE_TOO_LARGE')
throwsWith(() => handler.startUpload({ uploadId: 'u2', api: 'riskhub', path: '/upload', filename: 'x.exe', size: 10 }), 'BLOCKED_FILE_TYPE')
throwsWith(() => handler.startUpload({ uploadId: 'u2', api: 'ghost', path: '/upload', filename: 'q3.csv', size: 10 }), 'API_NOT_REGISTERED')
assert.equal(calls.length, 1, 'rejected uploads must never reach the registry')

// out-of-order chunk + incomplete finish
handler.startUpload({ uploadId: 'u3', api: 'riskhub', path: '/upload', filename: 'a.csv', size: 100 })
throwsWith(() => handler.receiveChunk({ uploadId: 'u3', index: 1, data: new ArrayBuffer(10) }), 'OUT_OF_ORDER_CHUNK')
await assert.rejects(() => handler.finishUpload({ uploadId: 'u3' }), /incomplete upload/)
handler.cancelUpload({ uploadId: 'u3' })
throwsWith(() => handler.receiveChunk({ uploadId: 'u3', index: 0, data: new ArrayBuffer(10) }), 'UNKNOWN_UPLOAD')

// clearAll drops partial uploads
handler.startUpload({ uploadId: 'u4', api: 'riskhub', path: '/upload', filename: 'a.csv', size: 100 })
assert.equal(handler.clearAll().cleared, 1)
throwsWith(() => handler.receiveChunk({ uploadId: 'u4', index: 0, data: new ArrayBuffer(10) }), 'UNKNOWN_UPLOAD')

// shared store: start on one handler, chunk + finish on another
const store = new Map()
const h1 = createFilesHandler({ callRegisteredApi: mockCallRegisteredApi, fetchBinary: async () => { throw new Error('x') }, store })
const h2 = createFilesHandler({ callRegisteredApi: mockCallRegisteredApi, fetchBinary: async () => { throw new Error('x') }, store })
h1.startUpload({ uploadId: 'u5', api: 'riskhub', path: '/upload', filename: 'a.csv', size: 4 })
h2.receiveChunk({ uploadId: 'u5', index: 0, data: new Uint8Array([1, 2, 3, 4]).buffer })
await h2.finishUpload({ uploadId: 'u5' })
assert.equal(calls.length, 2, 'shared-store upload must complete')

// --- handler: download streams chunks in order ---
const bin = new Uint8Array(2 * CHUNK_SIZE + 10)
for (let i = 0; i < bin.length; i++) bin[i] = (i * 7) % 253
let binaryCalls = 0
const dlHandler = createFilesHandler({
  callRegisteredApi: mockCallRegisteredApi,
  fetchBinary: async (api, path, params) => {
    binaryCalls++
    assert.equal(api, 'riskhub')
    assert.equal(path, '/reports/q3.csv')
    assert.deepEqual(params, { year: '2026' })
    return { bytes: bin, contentType: 'text/csv', filename: 'q3.csv' }
  },
  isAppRegistered: (n) => n === 'riskhub',
})
const got = []
const meta = await dlHandler.download({
  api: 'riskhub', path: '/reports/q3.csv', params: { year: '2026' },
  onChunk: (c) => got.push(c),
})
assert.equal(meta.size, bin.length)
assert.equal(meta.contentType, 'text/csv')
assert.equal(meta.filename, 'q3.csv')
assert.equal(got.length, 3, 'download must stream 3 chunks')
assert.equal(got[0].meta.filename, 'q3.csv', 'first chunk carries the meta')
assert.equal(got[2].done, true)
assert.deepEqual(assembleChunks(got.map((c) => c.data)), bin)
await assert.rejects(
  () => dlHandler.download({ api: 'ghost', path: '/x', onChunk: () => {} }),
  /api_not_registered/
)
assert.equal(binaryCalls, 1, 'rejected download must never fetch binary')

// --- host: api.fetch + files route through the same handler ---
const hostCalls = []
const host = createCanvasHost({
  apiBase: 'http://127.0.0.1:8000/',
  docId: 'doc_1',
  callRegisteredApi: async (api, path, _t, options) => {
    hostCalls.push({ api, path, options })
    return { status: 200, data: { ok: true } }
  },
  fetchBinary: async () => ({ bytes: new Uint8Array([9, 8, 7]), contentType: 'text/plain', filename: 'n.txt' }),
})
assert.deepEqual(await host.canvas.api.fetch('riskhub', '/risks', { method: 'POST', body: { q: 1 } }), { status: 200, data: { ok: true } })
assert.equal(hostCalls[0].options.method, 'POST')
await assert.rejects(() => host.canvas.api.fetch('https://evil.example/x', '/x'), /INVALID_API/)
await assert.rejects(() => host.canvas.api.fetch('riskhub', '/x', { method: 'GET', body: { a: 1 } }), /GET_WITH_BODY_NOT_ALLOWED/)
const up = await host.canvas.files.upload({ api: 'riskhub', path: '/upload', bytes: new Uint8Array([1, 2, 3]).buffer, filename: 'a.csv', type: 'text/csv' })
assert.deepEqual(up, { status: 200, data: { ok: true } })
assert.equal(hostCalls[1].options.isMultipart, true)
const down = await host.canvas.files.download({ api: 'riskhub', path: '/n.txt' })
assert.equal(down.filename, 'n.txt')
assert.deepEqual(new Uint8Array(down.bytes), new Uint8Array([9, 8, 7]))

// without registry injections the host refuses instead of faking it
const bare = createCanvasHost({ apiBase: 'http://127.0.0.1:8000/', docId: 'doc_1' })
await assert.rejects(() => bare.canvas.api.fetch('riskhub', '/x'), /registry not available/)
await assert.rejects(() => bare.canvas.files.upload({ api: 'riskhub', path: '/u', bytes: new ArrayBuffer(1), filename: 'a.csv' }), /registry not available/)

console.log('canvas files: ok (validation, chunking, multipart, handler flow, host api.fetch/files, NO_REGISTRY)')
