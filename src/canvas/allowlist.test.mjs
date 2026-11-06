import assert from 'node:assert'
import { validateCanvasApi } from './allowlist.js'

assert.equal(validateCanvasApi('GET', '/v1/documents').ok, true)
assert.equal(validateCanvasApi('GET', '/v1/documents/doc_123').ok, true)
assert.equal(validateCanvasApi('GET', '/v1/documents/doc_123/versions').ok, true)
assert.equal(validateCanvasApi('GET', '/v1/documents/doc_123/state').ok, true)
assert.equal(validateCanvasApi('GET', '/v1/documents/doc_123/state/my-key').ok, true)
assert.equal(validateCanvasApi('GET', '/v1/apis').ok, true)
assert.equal(validateCanvasApi('POST', '/v1/documents').error, 'FORBIDDEN_PATH')
assert.equal(validateCanvasApi('GET', '/v1/documents/doc_123/draft/publish').error, 'FORBIDDEN_PATH')
assert.equal(validateCanvasApi('GET', '/v1/documents/doc_123/state/a/b').error, 'FORBIDDEN_PATH')
assert.equal(validateCanvasApi('GET', 'https://example.com/v1/documents').error, 'INVALID_PATH')
assert.equal(validateCanvasApi('GET', '/v1/documents/../etc').error, 'INVALID_PATH')
console.log('canvas allowlist: 11/11 ok')
