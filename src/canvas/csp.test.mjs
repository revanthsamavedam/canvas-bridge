import assert from 'node:assert'
import { withCanvasShell, CANVAS_CSP, LOCKDOWN_SCRIPT, CANVAS_BRIDGE_SCRIPT } from './csp.js'

const original = '<html><head><title>t</title></head><body><p>hi</p><script>console.log(1)</script></body></html>'
const out = withCanvasShell(original)
assert.equal(original.includes('Content-Security-Policy'), false)
assert(out.includes(CANVAS_CSP), 'CSP meta must be injected')
assert(out.includes("connect-src 'none'"), 'connect-src must be none')
assert(out.includes("frame-src 'none'"), 'frame-src must be none')
assert(out.includes(LOCKDOWN_SCRIPT), 'lockdown must be injected')
assert(out.includes(CANVAS_BRIDGE_SCRIPT), 'canvas bridge must be injected')
assert(out.includes('window.canvas'), 'bridge must define window.canvas')
assert(!out.includes('window.agentdocs'), 'canvas shell must not inject the agentdocs bridge')
const cspIdx = out.indexOf(CANVAS_CSP)
const lockIdx = out.indexOf(LOCKDOWN_SCRIPT)
const bridgeIdx = out.indexOf(CANVAS_BRIDGE_SCRIPT)
assert(cspIdx < lockIdx && lockIdx < bridgeIdx, 'order must be CSP < lockdown < bridge')
assert(out.includes('<p>hi</p>'), 'document content must survive unchanged')

// Bridge v2: every page gets api.fetch + files, no wiring of its own.
assert(CANVAS_BRIDGE_SCRIPT.includes('canvas.api.fetch') || CANVAS_BRIDGE_SCRIPT.includes('api:fetch'), 'bridge v2 must offer api.fetch')
assert(CANVAS_BRIDGE_SCRIPT.includes('files:upload:start'), 'bridge v2 must offer files.upload')
assert(CANVAS_BRIDGE_SCRIPT.includes('files:download'), 'bridge v2 must offer files.download')
assert(CANVAS_BRIDGE_SCRIPT.includes('session'), 'bridge v2 must echo the session nonce')
assert(CANVAS_BRIDGE_SCRIPT.includes('not running inside the Canvas viewer'), 'bridge must reject cleanly outside the viewer')
// Lockdown: blob: and data: anchor clicks are local downloads, not
// navigation — files.save depends on them, and they cannot leak.
assert(LOCKDOWN_SCRIPT.includes("href.startsWith('blob:')"), 'lockdown must allow blob: downloads')
assert(LOCKDOWN_SCRIPT.includes("href.startsWith('data:')"), 'lockdown must allow data: downloads')
assert(LOCKDOWN_SCRIPT.includes("href.startsWith('#')"), 'lockdown must still allow # anchors')
console.log('canvas shell: ok (CSP + lockdown + bridge, order, stored HTML untouched)')
