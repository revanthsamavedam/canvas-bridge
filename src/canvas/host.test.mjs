import assert from 'node:assert'
import { createCanvasHost } from './canvasHost.js'

const calls = []
async function mockFetch(url, init) {
  calls.push({ url, method: init.method, body: init.body })
  const json = async (v) => v
  if (url.endsWith('/v1/documents')) return { ok: true, json: () => json({ documents: [{ id: 'doc_1', title: 'T' }] }) }
  if (url.endsWith('/v1/documents/doc_1/state')) return { ok: true, json: () => json({ state: { a: 1 } }) }
  if (url.endsWith('/v1/documents/doc_1/state/k')) {
    if (init.method === 'PUT') return { ok: true, json: () => json({ value: JSON.parse(init.body).value }) }
    if (init.method === 'DELETE') return { ok: true, json: () => json({}) }
    return { ok: true, json: () => json({ value: 42 }) }
  }
  return { ok: false, status: 404, json: () => json({}) }
}

const logs = []
const host = createCanvasHost({ apiBase: 'http://127.0.0.1:8000/', docId: 'doc_1', fetchFn: mockFetch, onLog: (e) => logs.push(e) })

const docs = await host.canvas.api.get('/v1/documents')
assert.equal(docs.documents[0].id, 'doc_1')
assert.equal(host.canvas.api.get.length, 1)

let threw = null
try { await host.canvas.api.get('/v1/documents/doc_1/draft/publish') } catch (e) { threw = e }
assert(threw && threw.code === 'FORBIDDEN_PATH', 'forbidden api must throw FORBIDDEN_PATH')
assert(!calls.some((c) => c.url.includes('draft/publish')), 'forbidden path must never be fetched')

const state = await host.canvas.state.all()
assert.deepEqual(state, { a: 1 })
assert.equal(await host.canvas.state.get('k'), 42)
await host.canvas.state.set('k', 'hello')
assert(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/state/k') && c.body.includes('hello')), 'state.set must PUT')
await host.canvas.state.delete('k')
assert(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/state/k')), 'state.delete must DELETE')
assert(logs.length > 0, 'host must log calls')
console.log('canvas host: ok (api allowlist, doc KV get/all/set/delete, logging)')
