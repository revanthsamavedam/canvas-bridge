import assert from 'node:assert'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { CANVAS_BRIDGE_SCRIPT, LOCKDOWN_SCRIPT } from './csp.js'

// Run the real injected bridge client (CANVAS_BRIDGE_SCRIPT) in a
// fake iframe window and drive it with a fake chrome. The client is
// the code the viewer injects into every page, so this test proves
// the exact bytes pages get: session queueing, chunked upload with
// progress, chunked download reassembly, and save().

function makeWindow({ inViewer = true } = {}) {
  const listeners = {}
  const sent = []
  const win = {
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn) },
    canvas: undefined,
  }
  win.parent = inViewer ? { postMessage: (msg, _origin, transfer) => sent.push({ msg, transfer }) } : win
  const sandbox = {
    window: win,
    document: {
      createElement: () => {
        const a = { click: () => { a.clicked = true }, remove: () => {}, appendChild: undefined }
        return a
      },
      body: { appendChild: () => {} },
    },
    Blob,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
    setTimeout: (fn) => fn(),
    console,
  }
  sandbox.window.window = win
  vm.createContext(sandbox)
  vm.runInContext(CANVAS_BRIDGE_SCRIPT, sandbox)
  const deliver = (data) => {
    for (const fn of listeners.message || []) fn({ data })
  }
  return { win, sandbox, sent, deliver }
}

const CHUNK = 1024 * 1024

// --- requests wait for canvas-init, then carry the session ---
{
  const { win, sent, deliver } = makeWindow()
  const p = win.canvas.api.get('/v1/documents')
  assert.equal(sent.length, 0, 'no request may leave before init')
  deliver({ type: 'canvas-init', docId: 'doc_1', session: 's1' })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(sent.length, 1, 'queued request leaves after init')
  assert.equal(sent[0].msg.session, 's1')
  assert.equal(sent[0].msg.kind, 'api')
  deliver({ type: 'canvas-response', id: sent[0].msg.id, ok: true, value: { documents: [] } })
  assert.deepEqual(await p, { documents: [] })
  // re-init with a new session: later requests carry the new one
  deliver({ type: 'canvas-init', docId: 'doc_2', session: 's2' })
  const p2 = win.canvas.state.all()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(sent[sent.length - 1].msg.session, 's2')
  deliver({ type: 'canvas-response', id: sent[sent.length - 1].msg.id, ok: true, value: { a: 1 } })
  assert.deepEqual(await p2, { a: 1 })
  assert.equal(win.canvas.docId(), 'doc_2')
}

// --- outside the viewer every call rejects instead of hanging ---
{
  const { win } = makeWindow({ inViewer: false })
  await assert.rejects(() => win.canvas.api.get('/v1/documents'), /not running inside the Canvas viewer/)
  await assert.rejects(() => win.canvas.files.download({ api: 'riskhub', path: '/x' }), /not running inside the Canvas viewer/)
}

// --- chunked upload: 2.5 MB, 3 chunks, progress, bytes intact ---
{
  const { win, sent, deliver } = makeWindow()
  const size = 2 * CHUNK + 400_000
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = i % 251
  const file = {
    name: 'q3.csv', size, type: 'text/csv',
    slice: (s, e) => ({ arrayBuffer: async () => bytes.slice(s, e).buffer }),
  }
  // Fake chrome: answer start/chunk/finish, collect the chunks.
  const received = []
  let uploadId = null
  const pump = () => {
    while (sent.length > 0) {
      const { msg, transfer } = sent.shift()
      if (msg.kind === 'files:upload:start') {
        uploadId = msg.uploadId
        assert.equal(msg.filename, 'q3.csv')
        assert.equal(msg.size, size)
        deliver({ type: 'canvas-response', id: msg.id, ok: true, value: { uploadId, chunkSize: CHUNK, chunks: 3 } })
      } else if (msg.kind === 'files:upload:chunk') {
        assert.equal(msg.uploadId, uploadId)
        received[msg.index] = new Uint8Array(transfer[0])
        deliver({ type: 'canvas-response', id: msg.id, ok: true, value: { received: msg.index + 1, total: 3 } })
      } else if (msg.kind === 'files:upload:finish') {
        deliver({ type: 'canvas-response', id: msg.id, ok: true, value: { status: 200, data: { stored: true } } })
      }
    }
  }
  deliver({ type: 'canvas-init', docId: 'doc_1', session: 's1' })
  const progress = []
  const p = win.canvas.files.upload({ api: 'riskhub', path: '/upload', file, onProgress: (e) => progress.push(e) })
  // Drive the pump until the upload settles: each iteration answers
  // whatever the client posted, then yields so it can post next.
  let settled = false
  p.then(() => { settled = true }, () => { settled = true })
  for (let i = 0; i < 50 && !settled; i++) { pump(); await new Promise((r) => setTimeout(r, 0)) }
  assert(settled, 'upload must settle')
  assert.deepEqual(await p, { status: 200, data: { stored: true } })
  assert.equal(progress.length, 3, 'one progress callback per chunk')
  assert.equal(progress[2].sent, size)
  assert.equal(progress[2].total, size)
  let total = 0
  const joined = new Uint8Array(size)
  for (const c of received) { joined.set(c, total); total += c.length }
  assert.equal(total, size)
  assert.deepEqual(joined, bytes, 'chunked bytes must reassemble exactly')
  await assert.rejects(
    () => win.canvas.files.upload({ api: 'riskhub', path: '/upload', file: { name: 'x' } }),
    /needs a File or Blob/
  )
}

// --- chunked download: chunks reassemble into a Blob ---
{
  const { win, sent, deliver } = makeWindow()
  const size = 2 * CHUNK + 10
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = (i * 7) % 253
  deliver({ type: 'canvas-init', docId: 'doc_1', session: 's1' })
  const p = win.canvas.files.download({ api: 'riskhub', path: '/reports/q3.csv', params: { year: '2026' } })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(sent.length, 1)
  const id = sent[0].msg.id
  assert.equal(sent[0].msg.kind, 'files:download')
  assert.deepEqual(sent[0].msg.params, { year: '2026' })
  for (let i = 0; i < 3; i++) {
    deliver({
      type: 'canvas-download-chunk', id,
      index: i, total: 3,
      data: bytes.slice(i * CHUNK, Math.min((i + 1) * CHUNK, size)).buffer,
      done: i === 2,
      meta: i === 0 ? { size, contentType: 'text/csv', filename: 'q3.csv' } : undefined,
    })
  }
  const blob = await p
  assert.equal(blob.type, 'text/csv')
  assert.equal(blob.name, 'q3.csv')
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes)

  // an error chunk rejects the download
  const p2 = win.canvas.files.download({ api: 'ghost', path: '/x' })
  await new Promise((r) => setTimeout(r, 0))
  const id2 = sent[sent.length - 1].msg.id
  deliver({ type: 'canvas-download-chunk', id: id2, error: 'api_not_registered' })
  await assert.rejects(() => p2, /api_not_registered/)
}

// --- save(): download, then a blob: anchor click ---
{
  const { win, sent, deliver, sandbox } = makeWindow()
  let clicked = null
  sandbox.document.createElement = () => {
    const a = { click: () => { clicked = a }, remove: () => {} }
    return a
  }
  deliver({ type: 'canvas-init', docId: 'doc_1', session: 's1' })
  const p = win.canvas.files.save({ api: 'riskhub', path: '/n.txt', filename: 'notes.txt' })
  await new Promise((r) => setTimeout(r, 0))
  const id = sent[sent.length - 1].msg.id
  const data = new TextEncoder().encode('hello').buffer
  deliver({ type: 'canvas-download-chunk', id, index: 0, total: 1, data, done: true, meta: { size: 5, contentType: 'text/plain', filename: 'n.txt' } })
  assert.deepEqual(await p, { filename: 'notes.txt', size: 5 })
  assert.ok(clicked, 'save must click an anchor')
  assert.equal(clicked.href, 'blob:fake')
  assert.equal(clicked.download, 'notes.txt')
}

// --- state.subscribe fires on chrome pushes ---
{
  const { win, deliver } = makeWindow()
  deliver({ type: 'canvas-init', docId: 'doc_1', session: 's1' })
  const seen = []
  await win.canvas.state.subscribe('k', (v) => seen.push(v))
  deliver({ type: 'canvas-state-changed', key: 'k', value: 42 })
  assert.deepEqual(seen, [42])
}

// --- the demo inner page stays in sync with the canonical bridge ---
{
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const inner = readFileSync(path.join(root, 'public', 'canvas-inner.html'), 'utf8')
  const between = (text, start, end) => {
    const i = text.indexOf(start)
    const j = text.indexOf(end)
    assert(i !== -1 && j !== -1 && j > i, `markers missing: ${start}`)
    return text.slice(i + start.length, j)
  }
  const bridgeBlock = between(inner, '<!-- canvas-bridge:start -->', '<!-- canvas-bridge:end -->')
  assert(bridgeBlock.includes(CANVAS_BRIDGE_SCRIPT), 'demo inner page must embed the canonical bridge')
  assert(bridgeBlock.includes('canvas.files.upload'), 'demo bridge must be v2 (files)')
  const lockBlock = between(inner, '<!-- canvas-lockdown:start -->', '<!-- canvas-lockdown:end -->')
  assert(lockBlock.includes(LOCKDOWN_SCRIPT), 'demo inner page must embed the canonical lockdown')
  assert(inner.includes("href.startsWith('blob:')"), 'demo lockdown must allow blob: downloads')
}

console.log('canvas bridge: ok (session queueing, chunked upload/download, save, subscribe, demo sync)')
