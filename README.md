# canvas-bridge

The `window.canvas` JavaScript bridge for Canvas — the governed publication layer for agent-built web pages.

A Canvas page is untrusted code running in a sandboxed iframe with no network. The bridge is the only way out: the page asks the viewer (the outer shell) for things through `window.canvas`, and the viewer decides whether the ask is allowed, does the network call itself with its own tokens, and hands back only the result. Tokens never enter the page.

What it provides:

- `canvas.api.get(path)` — read the Canvas API itself, GET-only, allowlisted.
- `canvas.api.fetch(app, path, opts)` — call a registered internal API (GET/POST/PUT/DELETE, JSON), by registered name, never by URL.
- `canvas.state.*` — document-scoped shared state (get/all/set/delete/subscribe).
- `canvas.files.upload` / `download` / `save` — files in 1 MB chunks over postMessage, 25 MB cap, validated before any bytes flow.

The full protocol is documented for a newcomer in [docs/canvas-bridge-protocol.md](docs/canvas-bridge-protocol.md) — every message type, every error code, the security model, and what does not work yet.

## Layout

- `src/canvas/` — the bridge: CSP + lockdown (`csp.js`), the host (`canvasHost.js`, QuickJS sandbox), file transfer (`files.js`), the allowlist (`allowlist.js`), the runner (`run.js`), and tests.
- `public/canvas-inner.html` — the Canvas-mode demo page that runs in the sandboxed iframe.
- `scripts/sync-bridge.mjs` — keeps the demo page's scripts in sync with `csp.js`; a test fails on drift.

## Run the tests

```sh
npm install
npm run test:canvas
```

## Status

Extracted from [agent-docs-ui](https://github.com/revanthsamavedam/agent-docs-ui) (the `canvas` branch), where the bridge was built and tested. The bridge itself is complete and tested; wiring `withCanvasShell()` into the normal published-document render path is still open — today the normal viewer renders through its older `window.agentdocs` bridge, and `window.canvas` lives in the Canvas-mode demo and the QuickJS sandbox. See §5 of the protocol doc for the honest status.
