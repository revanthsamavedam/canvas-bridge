import assert from 'node:assert'
import { runJS } from './run.js'
import { createCanvasHost } from './canvasHost.js'

async function mockFetch(url, init) {
  const json = async (v) => v
  if (url.endsWith('/v1/documents')) return { ok: true, json: () => json({ documents: [{ id: 'doc_1' }] }) }
  if (url.endsWith('/v1/documents/doc_1/state')) return { ok: true, json: () => json({ state: { a: 1 } }) }
  return { ok: false, status: 404, json: () => json({}) }
}
const host = createCanvasHost({ apiBase: 'http://127.0.0.1:8000', docId: 'doc_1', fetchFn: mockFetch })

let r = await runJS(`canvas.api.get('/v1/documents').documents.length + ' docs, state a=' + canvas.state.all().a`, { host })
assert.equal(r.error, undefined, r.error)
assert.equal(r.result, '1 docs, state a=1')
console.log('ok - sandbox runs against agent-docs host (api + state)')

r = await runJS(`[typeof fetch, typeof process].join(',')`, { host })
assert.equal(r.result, 'undefined,undefined')
console.log('ok - sandbox sees no host capability beyond canvas')

r = await runJS(`canvas.api.get('/v1/documents/doc_1/draft/publish')`, { host })
assert(r.error && r.error.includes('FORBIDDEN_PATH'), r.error)
console.log('ok - sandbox forbidden path rejected by host allowlist')

console.log('canvas run: 3/3 ok')
