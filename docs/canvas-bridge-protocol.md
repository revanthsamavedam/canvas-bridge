# Canvas bridge protocol (v2) — `window.canvas`

> **Who this is for.** Someone completely new to Canvas and to this
> codebase. No prior knowledge is assumed: every idea is introduced in
> plain language first, then stated precisely, then shown in code. If
> you only need the quick version, read §1–§5 and §6. If you are
> implementing against the protocol, read §7–§9 in full — they are the
> contract. Everything in this document is true of the code on the
> `canvas` branch of `agent-docs-ui` as of 2026-11-06 (commit
> `1884025`). Numbers come from actually running the code; see §16
> for the exact outputs.

## 1. What Canvas is, in one paragraph

Canvas is a governed publication layer for agent-built web pages. An
agent (for example Copilot) builds a web page — one self-contained HTML
file — publishes it, and people open it by one durable link. Every
publish creates a new numbered version; a published version is never
edited. A page is supposed to be **live**: its numbers come from the
team's real internal APIs when the page is opened, not from numbers
baked into the HTML. Canvas is the thing that makes that safe: it
decides which APIs a page may call, fetches the tokens for those APIs
itself, and never lets the page touch a token or the network directly.

## 2. The problem: a page cannot just fetch

A Canvas page is untrusted code. It was written by an agent, and it
runs in the reader's browser. If the page could call `fetch()` directly,
three bad things would be possible:

1. **It could call any URL.** Nothing would stop it phoning data out to
   an attacker's server.
2. **It would need the token.** To call a real internal API it would
   need an access token in the page, where any reader could copy it.
3. **It could exfiltrate data.** A page that can fetch can send the
   data it was given somewhere else.

So Canvas does the opposite: the page is locked in a box with **no
network at all**, and the only way out is a narrow, supervised bridge
to the viewer — the app that shows the page. The page asks the viewer
for things; the viewer decides whether the ask is allowed, does the
network call itself with its own tokens, and hands back only the
result. That bridge is what this document specifies.

## 3. The big idea: two shells

There are exactly two sides, and they never blur:

```
┌─────────────────────────────────────────────────────────────────┐
│ OUTER SHELL — the viewer chrome (agent-docs-ui, this repo)      │
│                                                                 │
│  Owns: the network, the tokens, the registry, the state store.  │
│  Knows: which APIs exist, which endpoints have tokens.          │
│  Never: hands a token to the page.                              │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │ INNER SHELL — the page, in a sandboxed iframe           │   │
│   │                                                         │   │
│   │  Owns: the pixels, the buttons, the JavaScript.         │   │
│   │  Knows: nothing about tokens, URLs, or credentials.     │   │
│   │  Can: ask the outer shell, through window.canvas only.  │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  The only connection between them is postMessage.               │
└─────────────────────────────────────────────────────────────────┘
```

- **Outer shell (also called the chrome, or the container).** The
  React app in `src/App.jsx`. It renders the page inside an `<iframe
  sandbox="allow-scripts">`. Note what is *not* in that sandbox
  attribute: there is no `allow-same-origin`. The iframe therefore has
  an opaque origin — it cannot reach the app's origin, cookies, or
  storage even if it tried.
- **Inner shell (also called the page).** The published HTML document,
  running inside that iframe. Its JavaScript is ordinary JavaScript —
  vanilla, React, anything — but it runs under two locks (see §4).

The bridge is the *only* connection between the shells. It is not a
network connection: `postMessage` sends JavaScript objects between a
page and its parent window. The browser's network stack is never
involved, which is why the bridge keeps working even though the page's
network is entirely switched off.

## 4. Why the page cannot cheat: CSP + lockdown, in that order

Before any page code runs, the viewer wraps the stored HTML in a
render copy. The stored document is never changed. `withCanvasShell()`
in `src/canvas/csp.js` adds two layers, in this order:

### 4.1 Layer 1 — Content Security Policy (CSP), enforced by the browser

```js
export const CANVAS_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data:; media-src 'none'; font-src 'none'; connect-src 'none'; " +
  "object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; " +
  "base-uri 'none'; manifest-src 'none'";
```

Read it as a list of refusals:

| Directive | What it means for the page |
|---|---|
| `default-src 'none'` | Nothing is allowed unless another directive says so. |
| `script-src 'unsafe-inline'` | Only inline scripts run. No external scripts — a page cannot load a library from a CDN. |
| `style-src 'unsafe-inline'` | Only inline styles. No external stylesheets. |
| `img-src data:` | Images only as `data:` URLs embedded in the page. No tracking pixels, no external images. |
| `media-src 'none'`, `font-src 'none'` | No audio/video, no web fonts. |
| `connect-src 'none'` | **No network.** `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, and `sendBeacon` are all blocked by the browser itself. JavaScript cannot undo this. |
| `object-src 'none'`, `frame-src 'none'`, `worker-src 'none'` | No plugins, no nested frames, no workers. A nested frame would be a fresh realm with fresh globals — a way around the locks. |
| `form-action 'none'` | **No native form submission.** A `<form action="...">` cannot send anything anywhere. (§10 explains what to do instead.) |
| `base-uri 'none'`, `manifest-src 'none'` | No base-URL tricks, no web-app manifest. |

`postMessage` is not network, so the bridge is unaffected by
`connect-src 'none'`.

### 4.2 Layer 2 — lockdown script, clear errors instead of silent blocks

The CSP is the enforcement; the lockdown script is the explanation.
It runs before any page code and replaces the dangerous globals with
functions that throw a readable error:

```js
lock(window, 'fetch', blocked('fetch'));
lock(window, 'XMLHttpRequest', blocked('XMLHttpRequest'));
lock(window, 'WebSocket', blocked('WebSocket'));
lock(window, 'EventSource', blocked('EventSource'));
lock(window, 'Worker', blocked('Worker'));
lock(window, 'SharedWorker', blocked('SharedWorker'));
lock(window, 'open', blocked('window.open'));
```

(`lock` defines the property as non-writable and non-configurable, so
page code cannot restore the original.)

It also blocks creating nested frames:

```js
Document.prototype.createElement = function (tag) {
  var t = String(tag || '').toLowerCase();
  if (t === 'iframe' || t === 'object' || t === 'embed' || t === 'frame') {
    throw new Error('Canvas inner shell: <' + t + '> is blocked.');
  }
  return origCreate.apply(this, arguments);
};
```

And it blocks navigation away from the page, with two deliberate
exceptions:

```js
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
```

A `blob:` or `data:` link is a local download, not a trip to another
server, so it is allowed — this is exactly how `canvas.files.save`
delivers a file (§6.4). A `#` link is an in-page anchor, also allowed.
Everything else that would navigate is stopped. And the `submit`
listener runs in the capture phase and stops propagation, which means
**a native form submit never reaches the page's own submit handler
either** — see §10.

### 4.3 The three rules that follow from the locks

1. **No direct network, ever.** The page never calls `fetch`,
   `XMLHttpRequest`, `WebSocket`, or anything like them. If page code
   tries, it gets a thrown error, not data.
2. **No tokens in the page, ever.** No API key, access token, password,
   or token URL appears in the page's HTML or JavaScript. Tokens live
   only in the outer shell.
3. **Everything goes through `window.canvas`.** It is the one object
   the viewer injects into the page, and the one way the page reaches
   data, state, or files.

## 5. How the page gets the bridge: injection at view time

The viewer injects the bridge client into a *render copy* of the
stored HTML. The stored version is never modified. `withCanvasShell()`
(`src/canvas/csp.js`) does three things:

```js
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
```

Order matters: CSP meta and lockdown go into `<head>` (before any
page code), the bridge client goes just before `</body>`. The bridge
client is the constant `CANVAS_BRIDGE_SCRIPT` — the exact bytes every
page receives. Because the viewer injects it, **page code never imports
anything, never configures anything, and never wires anything up**:
any JavaScript in the page — vanilla, React, anything — just uses
`window.canvas`.

> **Current integration status (2026-11-06, be honest about it).**
> The protocol, both ends of it, and its tests live on the `canvas`
> branch of this repo, and the Canvas-mode demo page uses it. The
> normal viewer still renders published documents through its older
> `withBridge()` (which injects `window.agentdocs`, not
> `window.canvas`). Wiring `withCanvasShell()` into the
> published-document render path is the remaining integration step;
> until then, a published page that calls `window.canvas` will find
> it undefined in the normal viewer. Do not assume the bridge exists
> in a page unless the page was rendered through `withCanvasShell()`.

## 6. The API in full — `window.canvas`

Every method returns a Promise (except where noted). Every method
rejects with an `Error` whose message is one of the codes in §7.6 —
never with a token, a URL, or a stack trace from the chrome.

### 6.1 `canvas.api.get(path)` — read the Canvas API itself

```js
const versions = await canvas.api.get('/v1/documents/doc_123/versions')
```

- **What it does:** a GET against the agent-docs API — the API that
  stores the documents themselves.
- **It is GET-only and allowlisted.** The chrome checks the path
  against a fixed list *before* fetching anything; an unlisted path
  is never fetched. The allowed paths are exactly:

  | Method | Path |
  |---|---|
  | GET | `/v1/documents` |
  | GET | `/v1/documents/:id` |
  | GET | `/v1/documents/:id/versions` |
  | GET | `/v1/documents/:id/state` |
  | GET | `/v1/documents/:id/state/:key` |
  | GET | `/v1/apis` |

  (`:id` is letters, digits, `_`, `-`; `:key` also allows `.`, `%`,
  `~`. Anything else — a POST, a publish path, a `..` — is rejected
  with `FORBIDDEN_PATH` or `INVALID_PATH`, and the chrome never
  fetches it.)
- **Why it is read-only:** writes must go through `canvas.state`
  (document KV). Canvas code cannot create documents, versions, or
  drafts through this method, and cannot bypass the publish gate.
- **Returns:** the API's JSON response, as-is.

### 6.2 `canvas.api.fetch(app, path, opts)` — call a registered internal API

```js
// Read live numbers when the page opens:
const { status, data } = await canvas.api.fetch('riskhub', '/risks/summary')

// Search with a query string:
const res = await canvas.api.fetch('riskhub', '/risks?q=' + encodeURIComponent('leak'))

// Write something back:
await canvas.api.fetch('riskhub', '/risks', { method: 'POST', body: { title: 'New risk' } })
```

- `app` is a **registered name** — a name in the API registry
  (`api_registry`), for example `riskhub`. It is never a URL. If the
  name is not registered, the call is rejected with
  `API_NOT_REGISTERED` before any network happens.
- `path` must start with `/` and must not contain `..`, a backslash,
  or a NUL byte. A query string (`?q=...`) is allowed and is passed
  through to the API.
- `opts.method` is `GET` (the default), `POST`, `PUT`, or `DELETE`.
  Anything else is `UNSUPPORTED_METHOD`.
- `opts.body` is a plain JSON object (or a string). A GET with a body
  is rejected (`GET_WITH_BODY_NOT_ALLOWED`). **Do not pass a
  `FormData` object here** — the chrome JSON-stringifies the body, and
  a `FormData` stringifies to `{}`, so your fields would silently
  vanish. Plain objects only; files go through `canvas.files.upload`
  (§6.4).
- **Returns:** `{ status, data }` — the HTTP status and the API's
  response (parsed as JSON when possible, otherwise as text).
- **What the chrome does, step by step:** it looks the app name up in
  the registry, fetches that endpoint's token (cached per API until
  expiry, refreshed once on a 401 for idempotent methods — never
  automatically for POST, because a blind retry could create a
  duplicate), calls the endpoint with `Authorization: Bearer <token>`,
  and returns only `{ status, data }`. The token is fetched at view
  time, per endpoint; it never appears in the page.
- **No token-URL override.** Unlike the older `window.agentdocs`
  bridge, the Canvas bridge does not accept an author-provided token
  URL. The registry is the only source of token URLs.

### 6.3 `canvas.state.*` — the document's shared key-value store

```js
await canvas.state.set('last_checked', '2026-11-06')
const when = await canvas.state.get('last_checked')   // '2026-11-06'
const all = await canvas.state.all()                  // { last_checked: '2026-11-06', ... }
await canvas.state.delete('draft_note')               // setting a key to null deletes it too

canvas.state.subscribe('last_checked', (value) => {
  // Runs whenever the chrome pushes a change for this key.
})
```

- State is **document-scoped**: it belongs to the document, not to
  the version. Changing state never creates a version, and state
  survives publishing a new version.
- Values are JSON. `set` returns the value you set; `delete` returns
  `null`.
- After a `set` or `delete`, the chrome broadcasts
  `canvas-state-changed` to the page (and reloads its own state panel,
  so the page and the viewer stay in sync). `subscribe` registers a
  callback for those pushes; it returns a Promise that resolves to
  `true`.
- Typical uses: "last checked" timestamps, a freshness ledger
  (`last_checked`, `source_hash`, `next_check`), a user's filter
  choices — small facts the page wants to remember across versions.

### 6.4 `canvas.files.*` — upload and download through the chrome

```js
// Upload a file the user picked. Resolves with the API's response.
const res = await canvas.files.upload({
  api: 'riskhub',
  path: '/upload',
  file,                       // a File or Blob
  field: 'evidence',          // multipart field name, default 'file'
  onProgress: ({ sent, total }) => { /* update a progress bar */ },
})

// Download a file as a Blob.
const blob = await canvas.files.download({
  api: 'riskhub',
  path: '/reports/q3.csv',
  params: { year: '2026' },   // becomes ?year=2026
})

// Download AND trigger the browser download in the page.
const { filename, size } = await canvas.files.save({
  api: 'riskhub',
  path: '/reports/q3.csv',
  filename: 'q3.csv',         // optional; defaults to the API's filename
})
```

The rules, all enforced before any byte flows (§7.5):

- **Upload is POST-only.** The chrome POSTs the file as
  `multipart/form-data` to the registered API. There is no PUT-upload
  in this version.
- **25 MB cap.** `DEFAULT_MAX_FILE_SIZE` is 25 × 1024 × 1024 bytes.
  Bigger files are rejected with `FILE_TOO_LARGE` at the start
  message — before a single byte is sent.
- **1 MB chunks.** The file is sliced into 1 MB pieces and sent one
  at a time, each acknowledged by the chrome. A 2.5 MB file is 3
  chunks; a 25 MB file is 25.
- **Blocked file types.** Executables, scripts, and HTML are never
  uploaded through the bridge, whatever the API would accept:
  `exe, bat, cmd, sh, ps1, js, mjs, cjs, html, htm, jar, msi, com,
  scr, vbs, dll, so, dylib, app, apk`. Reason: an HTML file served
  back could run as a page; a script could run as code. The internal
  API is the authority on everything beyond this list.
- **Registered name only**, exactly as in §6.2. An unregistered app
  is rejected with `API_NOT_REGISTERED` at the start message.
- **Downloads have no progress events.** `upload` reports progress
  through `onProgress`; `download` resolves with the whole `Blob`
  when it is complete. If you need a download progress bar, that is a
  protocol gap, not a page bug.
- **`save` needs the `blob:` exception.** It works by creating an
  object URL and clicking a temporary `<a download>` element. The
  lockdown allows `blob:` and `data:` clicks precisely for this
  (§4.2). `save` returns `{ filename, size }`.
- **No resume.** If the page goes away mid-upload, the upload is
  abandoned; the chrome drops partial uploads when the view changes
  (§7.4). There is no way to resume an interrupted upload in this
  version.

A React example — no import, no provider, no setup, because the
viewer already injected the bridge:

```jsx
function UploadButton() {
  const [pct, setPct] = useState(null)
  async function onFile(e) {
    const file = e.target.files[0]
    const res = await window.canvas.files.upload({
      api: 'riskhub', path: '/upload', file,
      onProgress: ({ sent, total }) => setPct(Math.round(sent / total * 100)),
    })
    setPct(null)
  }
  return (
    <label>Upload evidence
      <input type="file" onChange={onFile} />
      {pct !== null && ` ${pct}%`}
    </label>
  )
}
```

### 6.5 `canvas.docId()` — which document this is

```js
const id = window.canvas.docId()   // e.g. 'doc_123', or null before init
```

Returns the document id the chrome sent in `canvas-init`, or `null`
if init has not arrived yet. It is a plain function, not a Promise.

## 7. The protocol in full detail

This section is the contract. If you implement a client, a container,
or a test against the bridge, implement exactly this.

### 7.1 Transport: `postMessage`, not network

Every protocol message is a `window.postMessage` call between the
iframe and its parent window. The payload is a plain JavaScript
object (structured-cloneable). File chunks are sent as `ArrayBuffer`
transferables — the third argument to `postMessage` — so the bytes
move without being copied.

There is no HTTP, no WebSocket, and no shared memory. There is also
no ordering guarantee *between* different requests: two concurrent
requests can complete in either order. Each request carries its own
numeric `id`, and responses are matched to requests by that `id`
only. Page code must never assume that request 2 finishes after
request 1.

### 7.2 The message envelope

Every message the page sends has this shape:

```js
{
  type: 'canvas-request',   // always this string for page -> chrome
  id: 7,                    // a number, unique per request from this page
  kind: 'api:fetch',        // which operation (see §7.4)
  session: 'c1a2…',         // the per-view nonce from canvas-init (§7.4)
  // ...kind-specific fields
}
```

Every reply from the chrome has one of two shapes — a single response,
or a stream of download chunks:

```js
// Single response (all kinds except files:download)
{ type: 'canvas-response', id: 7, ok: true, value: { status: 200, data: { … } } }
{ type: 'canvas-response', id: 7, ok: false, error: 'STALE_SESSION' }

// Download chunk stream (files:download only)
{ type: 'canvas-download-chunk', id: 9, index: 0, total: 3,
  data: <ArrayBuffer>, done: false, meta: { size, contentType, filename } }
{ type: 'canvas-download-chunk', id: 9, index: 2, total: 3,
  data: <ArrayBuffer>, done: true }
{ type: 'canvas-download-chunk', id: 9, error: 'api_not_registered' }
```

Rules of the envelope:

- `id` is chosen by the page, starting at 1 and incrementing. The
  chrome echoes it; it never invents ids.
- `ok: false` always comes with an `error` string, which is one of the
  codes in §7.6. The error never contains a token, a URL, or file
  content.
- For `files:download` there is **no** `canvas-response`. Success is a
  stream of `canvas-download-chunk` messages ending with `done: true`;
  failure is a single `canvas-download-chunk` carrying only `error`.
- The chrome only honours messages that come from the Canvas iframe
  itself (`e.source === frame.contentWindow`). A message from any
  other window is ignored silently.

### 7.3 The five message types

| Type | Direction | Purpose |
|---|---|---|
| `canvas-init` | chrome → page | "Here is your document and your session." Sent on iframe load. `{ type, docId, session }`. |
| `canvas-request` | page → chrome | "Do this." One operation per message (§7.4). |
| `canvas-response` | chrome → page | "Done" or "failed", for one request id. |
| `canvas-download-chunk` | chrome → page | One 1 MB piece of a download, or a download error (§7.2). |
| `canvas-state-changed` | chrome → page | "This state key changed." `{ type, key, value }` (value `null` means deleted). Sent after every `state:set` / `state:delete`. |

### 7.4 Every kind

`kind` is the operation name inside a `canvas-request`. This table is
complete for v2.

| Kind | Page sends | Chrome does | Chrome replies |
|---|---|---|---|
| `api` | `{ path }` | GET against the agent-docs API, if the path is allowlisted (§6.1) | `canvas-response` with the JSON value |
| `api:fetch` | `{ api, path, method, body }` | Validate (§7.5), then the registered-API call (§6.2) | `canvas-response` with `{ status, data }` |
| `state:get` | `{ key }` | `GET /v1/documents/:id/state/:key` | `canvas-response` with the value |
| `state:all` | `{}` | `GET /v1/documents/:id/state` | `canvas-response` with the whole state object |
| `state:set` | `{ key, value }` | `PUT …/state/:key { value }`, then broadcast `canvas-state-changed` | `canvas-response` with the value |
| `state:delete` | `{ key }` | `DELETE …/state/:key`, then broadcast `canvas-state-changed` with `value: null` | `canvas-response` with `null` |
| `files:upload:start` | `{ uploadId, api, path, field, filename, size, type }` | Validate everything (§7.5); reserve the upload id | `canvas-response` with `{ uploadId, chunkSize, chunks }` |
| `files:upload:chunk` | `{ uploadId, index, data }` (`data` is an `ArrayBuffer`, transferred) | Store the chunk; index must be exactly the next expected one | `canvas-response` with `{ uploadId, received, total }` |
| `files:upload:finish` | `{ uploadId }` | Check all chunks arrived and the size matches; reassemble; POST multipart to the registered API | `canvas-response` with the API's `{ status, data }` |
| `files:upload:cancel` | `{ uploadId }` | Drop the partial upload | `canvas-response` with `{ uploadId, cancelled: true }` |
| `files:download` | `{ api, path, params }` | Validate; fetch binary from the registered API; stream it back | A stream of `canvas-download-chunk` (§7.2), never a `canvas-response` |

Notes on the kinds:

- `uploadId` is chosen by the page. The client builds it as
  `'up_' + Date.now().toString(36) + '_' + random`. Starting an
  upload with an id that is already in use is rejected
  (`INVALID_UPLOAD`).
- `files:upload:cancel` exists in the protocol and the chrome
  implements it, but the v2 client (`window.canvas`) exposes **no**
  cancel method: a page cannot cancel an in-flight upload through the
  public API. It can only abandon it (close the page, or let the view
  change — the chrome then drops it, below).
- `field` in `files:upload:start` is the multipart field name
  (default `'file'`). It must match `/^[A-Za-z0-9_-]+$/`.
- `params` in `files:download` is a plain object; the chrome turns it
  into a query string (`?year=2026`). Omit it or pass `null` for no
  query string.

#### The session nonce

On iframe load the chrome generates a fresh nonce and posts it:

```js
// chrome (App.jsx, iframe onLoad)
canvasSessionRef.current =
  (window.crypto && window.crypto.randomUUID
    ? window.crypto.randomUUID()
    : 's_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e9).toString(36));
canvasUploadsRef.current.clear();   // drop any partial upload from the old view
frame.contentWindow.postMessage(
  { type: 'canvas-init', docId: selectedId, session: canvasSessionRef.current }, '*');
```

Every `canvas-request` must echo that nonce in its `session` field.
The chrome rejects a request whose session is missing or different
with `STALE_SESSION` — and it rejects it *before* doing anything
else. A new view (new document, iframe reload) issues a new nonce, so
a request from a stale view cannot act on the new document. The
client stores the nonce from `canvas-init` and never exposes it to
page code as anything other than an opaque field it echoes.

Two client behaviours make the session invisible to page authors:

- **Requests wait for init.** The client keeps a `ready` promise that
  resolves on the first `canvas-init`. A call made before init
  arrives simply waits; page code never has to wait for init itself.
- **Outside the viewer, calls reject cleanly.** If the page is opened
  directly (not inside the viewer), `window.parent === window`, and
  every call rejects immediately with
  `'canvas bridge: not running inside the Canvas viewer'` instead of
  hanging forever.

### 7.5 Validation order — what is checked, and when

The chrome validates in this order, and stops at the first failure.
The point of the order is that a bad request is rejected as cheaply
as possible — ideally before a single byte moves.

For `api:fetch` (also used by `files:download`):

1. `api` is a string matching `/^[A-Za-z0-9][A-Za-z0-9_-]*$/` —
   otherwise `INVALID_API`. A full URL fails this check
   (`API_NAME_ONLY` is the explicit error for a URL-shaped name).
2. `path` starts with `/` and contains no `..`, backslash, or NUL —
   otherwise `INVALID_PATH`.
3. `method` is one of `GET, POST, PUT, DELETE` — otherwise
   `UNSUPPORTED_METHOD`.
4. A GET must not carry a body — otherwise
   `GET_WITH_BODY_NOT_ALLOWED`.
5. For uploads and downloads, the app must actually be registered —
   otherwise `API_NOT_REGISTERED`. (For `api:fetch` the registry
   lookup itself produces this error one step later.)

For `files:upload:start`, additionally, before any chunk is accepted:

6. `filename` is non-empty and contains no `/`, `\`, or NUL —
   otherwise `INVALID_FILENAME`.
7. The file extension is not in the blocked list (§6.4) — otherwise
   `BLOCKED_FILE_TYPE`.
8. `field`, if given, matches `/^[A-Za-z0-9_-]+$/` — otherwise
   `INVALID_FIELD`.
9. `size` is a finite number, `0 <= size <= 25 MB` — otherwise
   `FILE_TOO_LARGE`.

For `files:upload:chunk`:

10. The `uploadId` must exist — otherwise `UNKNOWN_UPLOAD`.
11. `index` must be exactly the next expected chunk (`0, 1, 2, …` in
    order — no skipping, no re-sending) — otherwise
    `OUT_OF_ORDER_CHUNK`.
12. `data` must be an `ArrayBuffer` or `Uint8Array` — otherwise
    `INVALID_CHUNK`.

For `files:upload:finish`:

13. All chunks must have arrived (`received === total`) — otherwise
    `INCOMPLETE_UPLOAD`.
14. The reassembled size must equal the declared `size` — otherwise
    `SIZE_MISMATCH`. Only then does the chrome call the API.

### 7.6 Error codes — the complete list

| Code | Where | Meaning |
|---|---|---|
| `STALE_SESSION` | chrome | Missing or outdated session nonce. Reload the page. |
| `UNKNOWN_KIND` | chrome | No such `kind`. |
| `INVALID_PATH` | allowlist, files | Path is not a string, does not start with `/`, or contains `..`, `\`, or NUL. |
| `FORBIDDEN_PATH` | allowlist (`api.get`) | Path is well-formed but not on the allowlist (§6.1). |
| `INVALID_API` | files | App name is not a string or does not match the name pattern. |
| `API_NAME_ONLY` | files | The "name" is a URL. Registered names only. |
| `API_NOT_REGISTERED` | chrome | The name is not in the registry. |
| `UNSUPPORTED_METHOD` | files | Method is not GET, POST, PUT, or DELETE. |
| `GET_WITH_BODY_NOT_ALLOWED` | files | A GET carried a body. |
| `INVALID_FILENAME` | files | Empty filename, or one containing `/`, `\`, or NUL. |
| `BLOCKED_FILE_TYPE` | files | Extension is on the blocked list (§6.4). |
| `INVALID_FIELD` | files | Multipart field name does not match the pattern. |
| `FILE_TOO_LARGE` | files | Size exceeds the 25 MB cap. |
| `INVALID_UPLOAD` | files | Missing upload id, or an upload id already in use. |
| `UNKNOWN_UPLOAD` | files | Chunk/finish/cancel for an id the chrome does not hold. |
| `OUT_OF_ORDER_CHUNK` | files | Chunk index is not the next expected one. |
| `INVALID_CHUNK` | files | Chunk data is not an `ArrayBuffer`/`Uint8Array`. |
| `INCOMPLETE_UPLOAD` | files | `finish` arrived before all chunks. |
| `SIZE_MISMATCH` | files | Reassembled bytes do not equal the declared size. |
| `NO_REGISTRY` | host | The host was built without registry functions (QuickJS/context without a chrome). The call refuses instead of faking it. |
| `api_not_registered` | chrome | Same as `API_NOT_REGISTERED`, lowercase — this is the string the registry caller itself throws when the name is unknown. Both spellings mean the same thing. |
| `download failed <status>` | chrome | The registered API answered a download with a non-2xx status. |
| `token fetch failed <status>` | chrome | The endpoint's token URL did not answer. |
| `token URL did not return an access_token` | chrome | The token endpoint answered without an access token. |

The client turns a `canvas-response` with `ok: false` into a
rejected Promise whose `Error.message` is the code string above. The
client also rejects locally with two plain-language errors that never
come from the chrome:

- `'canvas bridge: not running inside the Canvas viewer'` — the page
  was opened outside the viewer (§7.4).
- `'canvas.files.upload needs a File or Blob'` — the `file` argument
  has no `slice()` method or no numeric `size`.

## 8. Upload, step by step

A 2.5 MB file called `q3.csv`, uploaded to the registered app
`riskhub` at `/upload`. The numbers are real: the bridge test does
exactly this upload and checks that the reassembled bytes are
identical.

```
page                                chrome                            riskhub API
  │                                   │                                   │
  │  files:upload:start               │                                   │
  │  {uploadId, api:'riskhub',        │                                   │
  │   path:'/upload', field:'file',   │                                   │
  │   filename:'q3.csv', size:2500000,│                                   │
  │   type:'text/csv'}                │                                   │
  │ ─────────────────────────────────>│  validate ( §7.5 steps 1–9 )     │
  │                                   │  reserve uploadId                 │
  │  canvas-response {ok,             │                                   │
  │   value:{uploadId, chunkSize:     │                                   │
  │   1048576, chunks:3}}             │                                   │
  │ <─────────────────────────────────│                                   │
  │                                   │                                   │
  │  files:upload:chunk {index:0,     │                                   │
  │   data:<1 MB ArrayBuffer>}        │                                   │
  │ ─────────────────────────────────>│  store chunk 0                    │
  │  canvas-response {received:1,     │                                   │
  │   total:3}                        │                                   │
  │ <─────────────────────────────────│                                   │
  │  files:upload:chunk {index:1, …}  │                                   │
  │ ─────────────────────────────────>│  store chunk 1                    │
  │  canvas-response {received:2}     │                                   │
  │ <─────────────────────────────────│                                   │
  │  files:upload:chunk {index:2, …}  │  (≈0.4 MB — the last chunk is     │
  │ ─────────────────────────────────>│   whatever is left)               │
  │  canvas-response {received:3}     │                                   │
  │ <─────────────────────────────────│                                   │
  │                                   │                                   │
  │  files:upload:finish {uploadId}   │                                   │
  │ ─────────────────────────────────>│  all 3 chunks? size matches?      │
  │                                   │  reassemble; build FormData       │
  │                                   │  POST multipart ─────────────────>│
  │                                   │                                   │
  │                                   │  {status:200, data:{…}}           │
  │                                   │  <────────────────────────────────│
  │  canvas-response {ok,             │                                   │
  │   value:{status:200, data:{…}}}   │                                   │
  │ <─────────────────────────────────│                                   │
  │  → the upload() Promise resolves  │                                   │
  │    with {status, data}            │                                   │
```

What the client actually does (the real code, from
`src/canvas/csp.js` — `uploadFile`):

```js
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
```

Read it line by line:

- **Guard first.** Only `slice()` and a numeric `size` are required.
  (An earlier version also demanded `file.arrayBuffer` directly on
  the file; that rejected a valid Blob-like. See §18.)
- **`uploadId`** is made from the time plus a random number — unique
  enough that two uploads never collide.
- **`start`** asks the chrome to validate and reserve the upload. The
  chrome answers with how many chunks it expects. The client uses
  the chrome's `chunkSize` for slicing, not its own constant, so the
  two sides can never disagree about chunk boundaries.
- **The chain** sends one chunk at a time, each awaited: slice →
  `arrayBuffer()` → `requestChunk` (which transfers the buffer — the
  page gives up ownership of those bytes) → wait for the ack → call
  `onProgress`. Sequential, not parallel: if chunk 1 is rejected the
  chain stops and no later chunk is sent.
- **`finish`** asks the chrome to reassemble and POST. The Promise
  returned by `upload()` resolves with the API's `{ status, data }`.

What the chrome does at `finish` (the real code, from
`src/canvas/files.js` — `finishUpload`):

```js
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
```

And `buildMultipart` — one field, one file, nothing else:

```js
export function buildMultipart({ field, filename, type, bytes }) {
  const form = new FormData();
  form.append(field || "file", new Blob([bytes], { type: type || "application/octet-stream" }), filename);
  return form;
}
```

Note what is *not* in the multipart body: no extra form fields. A
form with text fields plus a file is two calls today (§10.3). Note
also that the chrome never sets a `Content-Type` header for this
request: when the body is a `FormData`, the browser sets the
multipart boundary itself, and setting the header by hand would break
it. That is what `isMultipart: true` means in `callRegisteredApi`.

## 9. Download, step by step

```
page                                chrome                            riskhub API
  │                                   │                                   │
  │  files:download                   │                                   │
  │  {api:'riskhub',                  │                                   │
  │   path:'/reports/q3.csv',         │                                   │
  │   params:{year:'2026'}}           │                                   │
  │ ─────────────────────────────────>│  validate; registry lookup;       │
  │                                   │  token fetch;                     │
  │                                   │  GET /reports/q3.csv?year=2026 ─>│
  │                                   │  (raw binary, not JSON)           │
  │                                   │  <── bytes + content-type + ─────│
  │                                   │      filename (from               │
  │                                   │      Content-Disposition, else    │
  │                                   │      last path segment)           │
  │  canvas-download-chunk {index:0,  │                                   │
  │   total:3, data:<1 MB>,           │                                   │
  │   meta:{size, contentType,        │                                   │
  │   filename}}                      │                                   │
  │ <─────────────────────────────────│                                   │
  │  canvas-download-chunk {index:1,  │                                   │
  │   total:3, data:<1 MB>}           │                                   │
  │ <─────────────────────────────────│                                   │
  │  canvas-download-chunk {index:2,  │                                   │
  │   total:3, data:<…>, done:true}   │                                   │
  │ <─────────────────────────────────│                                   │
  │  → the download() Promise         │                                   │
  │    resolves with a Blob           │                                   │
```

What the client does with the chunks (the real code, from
`src/canvas/csp.js`):

```js
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
```

The `meta` (size, content type, filename) rides on the **first**
chunk only. An error is a single chunk carrying only `error` — the
client rejects the download Promise with it. An empty file (0 bytes)
is still one chunk: an empty `ArrayBuffer` with `done: true` and the
meta attached, so the client resolves with an empty Blob rather than
hanging.

And `files.save` — download, then a local download (the real code):

```js
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
```

The temporary anchor's `blob:` URL is allowed by the lockdown (§4.2)
because a `blob:` click is a local download, not navigation. The
object URL is revoked one second later.

## 10. Forms — what works, what does not, and the pattern to use

### 10.1 Native form submission does not work. This is deliberate.

A normal web form works like this: the browser collects the fields
and sends them to the URL in `action`, by navigating there. On Canvas,
both halves of that are blocked:

- The CSP has `form-action 'none'` (§4.1): the browser itself refuses
  to submit the form anywhere.
- The lockdown swallows every `submit` event in the capture phase
  (§4.2): the page's own `submit` handler never fires either.

So: a `<form action="...">` does nothing on Canvas, and a submit
button does not navigate anywhere. This is not a bug. A native submit
is a network call the page controls — a hole in the exact wall the
shell exists to maintain. If native submit mattered, the fix would be
in the shell (intercept the submit and route it through the bridge),
not something a page could do on its own.

### 10.2 The pattern that works: button click + bridge

The form *elements* all work — inputs, selects, textareas, checkboxes,
and file pickers render and hold values, because holding a value is
not network. The page reads them in JavaScript and sends them through
the bridge. Use a button of `type="button"` with a click handler, not
a submit button:

```html
<label>Title <input id="title"></label>
<label>Priority
  <select id="priority">
    <option>low</option><option>high</option>
  </select>
</label>
<label>Evidence <input id="file" type="file"></label>
<button type="button" id="send">Send</button>
<p id="msg"></p>
<script>
  document.getElementById('send').onclick = async () => {
    const msg = document.getElementById('msg')
    try {
      // Text fields go as a plain JSON object in an api.fetch POST.
      await window.canvas.api.fetch('riskhub', '/reports', {
        method: 'POST',
        body: {
          title: document.getElementById('title').value,
          priority: document.getElementById('priority').value,
        },
      })
      // A file goes through files.upload.
      const file = document.getElementById('file').files[0]
      if (file) {
        await window.canvas.files.upload({ api: 'riskhub', path: '/upload', file })
      }
      msg.textContent = 'Sent.'
    } catch (e) {
      msg.textContent = 'Failed: ' + e.message
    }
  }
</script>
```

A complete form example, with validation in the page's own JavaScript
and a visible result — copy this shape:

```html
<label>Title <input id="title"></label>
<label>File <input id="file" type="file"></label>
<button type="button" id="send">Send</button>
<p id="msg"></p>
<script>
  document.getElementById('send').onclick = async () => {
    const title = document.getElementById('title').value.trim()
    const file = document.getElementById('file').files[0]
    const msg = document.getElementById('msg')
    if (!title) { msg.textContent = 'Title is required.'; return }
    if (!file) { msg.textContent = 'Pick a file.'; return }
    msg.textContent = 'Sending…'
    try {
      await window.canvas.api.fetch('riskhub', '/reports', {
        method: 'POST', body: { title },
      })
      const res = await window.canvas.files.upload({
        api: 'riskhub', path: '/upload', file,
        onProgress: ({ sent, total }) => {
          msg.textContent = 'Uploading ' + Math.round(sent / total * 100) + '%'
        },
      })
      msg.textContent = 'Sent. The API answered ' + res.status + '.'
    } catch (e) {
      msg.textContent = 'Failed: ' + e.message
    }
  }
</script>
```

### 10.3 Text fields, files, and mixed forms

- **Text fields** (text, numbers, selects, checkboxes, textareas):
  read the values, put them in a plain object, POST them with
  `canvas.api.fetch`. This is the normal path.
- **Files** (a file input): `canvas.files.upload`. The page hands the
  `File` object to the bridge; the bridge chunks it to the chrome.
- **Mixed forms** (text fields *and* a file in one submission): two
  calls today — POST the fields first, then upload the file, as in
  the examples above. The multipart body the chrome builds contains
  only the file (§8); there is no way to attach extra fields to it in
  v2. One request for a mixed form would need a `fields` option on
  `files.upload` — a small, well-understood extension, not yet built.
- **Do not pass a `FormData` object to `api.fetch`.** The chrome
  JSON-stringifies the body, and a `FormData` stringifies to `{}`.
  Your fields would silently vanish. Plain objects only.
- **There is no redirect after submit.** The page cannot navigate
  anywhere (§4.2). Show the result in place — a success message, a
  cleared form, a new state key — instead of sending the reader to a
  thank-you page.

## 11. Search-as-you-type — it works, with two things the page must do

A page with search filters (a text box, dropdowns) can call the API on
every keystroke through `canvas.api.fetch`. The protocol supports it:
each request has its own `id`, responses are matched by `id`, and
concurrent requests do not block each other. But the protocol has no
cancel and no deduplication, so the page must do two things itself:

```js
let seq = 0
input.addEventListener('input', debounce(async (e) => {
  const my = ++seq
  const { data } = await window.canvas.api.fetch(
    'riskhub', '/risks?q=' + encodeURIComponent(e.target.value))
  if (my !== seq) return // a newer keystroke already fired; ignore this stale one
  render(data)
}, 250))
```

1. **Debounce.** Without a delay (about 250 ms is a good default),
   typing "risk" fires four API calls. The bridge will happily make
   all four; the page is responsible for not asking.
2. **Ignore stale responses.** A slow earlier response can arrive
   after a newer one. The `seq` counter above is the standard guard:
   only the latest request is allowed to render. Without it, the
   results on screen can show an older query than the text in the box.

What the bridge does help with: the endpoint token is cached per API
until expiry, so repeated searches do not re-fetch a token each time.
And a GET with a query string is the right shape — `api.fetch` passes
`?q=...` through to the API (§6.2).

The missing piece, stated plainly: there is no `canvas.api.cancel`
in v2. A page can ignore a stale response, but it cannot stop the
in-flight call. For type-ahead search that is workable, not clean;
cancellation is the natural next protocol addition.

## 12. The security model — why each rule exists

| Rule | Why it exists |
|---|---|
| Page runs in a sandboxed iframe, no `allow-same-origin` | So page code cannot reach the viewer's origin, cookies, or storage. The iframe's origin is opaque. |
| CSP `connect-src 'none'` | The browser itself blocks all network from the page. JavaScript cannot undo a CSP. |
| Lockdown replaces network globals with throwing stubs | So a mistake fails loudly with a readable error instead of failing silently at the CSP. The CSP is the enforcement; the script is the explanation. |
| No nested frames, no workers | A nested frame or worker would be a fresh realm with fresh globals — a way around the locks. |
| No external scripts, styles, images, fonts | An external resource is a network call the page controls, and a way to smuggle code or leak data (a tracking pixel is an exfiltration channel). |
| `form-action 'none'` + submit swallowing | A native form submit is a network call the page controls. |
| Registered names only, never URLs | So the sandbox cannot aim the chrome's token at an arbitrary host — not even one that happens to share a prefix with a registered API. |
| Tokens live only in the chrome | A token in the page is a token any reader can copy. The chrome fetches the token at view time, per endpoint, and sets `Authorization` itself. |
| Token cached per API, refreshed once on 401 (never for POST) | A blind POST retry could create a duplicate. A POST that 401s is returned to the page, which can retry explicitly if it knows the call is safe to repeat. |
| Validation before bytes (§7.5) | A bad upload should cost one message, not a 25 MB transfer. |
| Blocked extensions (§6.4) | An HTML file served back could run as a page; a script could run as code. The bridge refuses what is unsafe to move at all; the API decides the rest. |
| Per-view session nonce (§7.4) | A request from a stale view (old document) cannot act on the new document. A new view issues a new nonce and drops partial uploads. |
| Chunks must arrive in order | The chrome never has to buffer out-of-order pieces or guess what a gap means; a gap is an error, not a puzzle. |
| Audit logging | Every bridge file/API call is logged by the chrome — kind, app, path, size. Never file content. If something goes wrong, there is a record of what was asked for, without the data itself. |

What the model does *not* promise: it does not promise the *content*
of a page is true (the publish gate checks for secrets and direct
fetch, not for correctness), and it does not promise the registered
API will accept what the page sends — the API is the authority on its
own inputs.

## 13. What does NOT work

An honest list. None of these is a bug in the page; each is either a
deliberate rule or a known gap.

- **Native form submission.** Blocked by CSP + lockdown (§10.1). Use
  the button-click + bridge pattern.
- **Direct network of any kind.** `fetch`, `XMLHttpRequest`,
  `WebSocket`, `EventSource`, `Worker`, `sendBeacon`, `window.open`
  — all blocked. Third-party SDKs, analytics, CDNs, and web fonts
  will not load. Pages must be fully self-contained.
- **External scripts, stylesheets, images, iframes.** Same reason.
  Images must be `data:` URLs embedded in the page.
- **Doc-to-doc calls.** A page cannot fetch another document's
  content or state. There is no `canvas.documents.get`; that contract
  was never decided, and the bridge does not invent it.
- **Arbitrary URLs.** `api.fetch` and `files.*` take registered names
  only. There is no way to call an unregistered URL, and no
  token-URL override in the Canvas bridge.
- **Upload is POST-only.** No PUT-upload in v2.
- **25 MB cap on uploads**, and the blocked-extension list (§6.4).
  Both are bridge limits, not API limits: raising the cap needs the
  constant changed in `files.js` *and* the receiving API to accept
  the bigger file.
- **No download progress events.** Uploads report progress;
  downloads resolve with the whole Blob when done.
- **No resume.** An interrupted upload cannot be resumed; start over.
- **No request cancellation.** A page can ignore a stale response
  (§11) but cannot stop an in-flight call. There is no `cancel` kind
  on the public client (the container-side `files:upload:cancel`
  kind exists, but `window.canvas` exposes no method for it).
- **No file endpoint on the Canvas API itself.** Upload/download go
  to registered internal APIs. The Canvas API stores pages, versions,
  state, and the registry — not files.
- **A GET with a body** is rejected. A `FormData` passed to
  `api.fetch` silently becomes `{}`. Plain JSON objects only.
- **The bridge is not in the normal viewer yet** (§5). A page
  rendered through the older `withBridge()` gets `window.agentdocs`,
  not `window.canvas`.

## 14. The other runtime: the QuickJS sandbox host

The same capability object exists in a second runtime: the QuickJS
sandbox panel in the viewer, where untrusted JavaScript runs in a
fresh QuickJS/WASM interpreter instead of the page's V8. The host is
`createCanvasHost()` in `src/canvas/canvasHost.js`, and it is the
*only* capability handed to sandbox code — no fetch, no token, no
host capability beyond `canvas`.

The surface is the same, with one difference forced by the runtime:
QuickJS has no `File` or `Blob`, so `files` takes and returns
`ArrayBuffer`s:

```js
// In the sandbox: bytes in, bytes out.
const { bytes, contentType, filename, size } =
  await canvas.files.download({ api: 'riskhub', path: '/n.txt' })

await canvas.files.upload({
  api: 'riskhub', path: '/upload',
  bytes: new Uint8Array([1, 2, 3]).buffer,
  filename: 'a.csv', type: 'text/csv',
})
```

The host feeds the *same* files handler directly (no postMessage in
the middle), so both runtimes share one validation and upload path.
And if the host was built without the chrome's registry functions,
`api.fetch` and `files` throw `NO_REGISTRY` instead of silently doing
nothing — a refusal, not a fake.

## 15. Where the code lives

All paths are relative to the repo root, on the `canvas` branch.

| File | What it is | Lines* |
|---|---|---|
| `src/canvas/csp.js` | `CANVAS_CSP`, `LOCKDOWN_SCRIPT`, `CANVAS_BRIDGE_SCRIPT` (the v2 client — the exact bytes pages get), `withCanvasShell()` | 261 |
| `src/canvas/files.js` | Container-side protocol: constants, validation, chunking, multipart, `createFilesHandler` | 196 |
| `src/canvas/allowlist.js` | The `api.get` allowlist (`validateCanvasApi`) | ~35 |
| `src/canvas/canvasHost.js` | `createCanvasHost()` — the capability object for iframe + QuickJS | 134 |
| `src/App.jsx` | `callRegisteredApi` (registry + tokens, `raw`/`isMultipart`), `fetchBinaryFromRegistry`, the `onCanvasMessage` router, the `canvas-init` posting, the Canvas-mode iframe | 938 |
| `public/canvas-inner.html` | The demo inner shell. Its lockdown + bridge are *copies* synced from `csp.js` — edit the constants, not this file | 291 |
| `scripts/sync-bridge.mjs` | `node scripts/sync-bridge.mjs` — copies the canonical lockdown + bridge into the demo page | — |
| `src/canvas/allowlist.test.mjs` | Allowlist tests | — |
| `src/canvas/csp.test.mjs` | Shell tests (CSP + lockdown + bridge, order, stored HTML untouched) | — |
| `src/canvas/host.test.mjs` | Host tests (api allowlist, KV, logging) | — |
| `src/canvas/run.test.mjs` | QuickJS sandbox tests (3/3) | — |
| `src/canvas/files.test.mjs` | Files tests (validation, chunking, multipart, handler flow, host api.fetch/files, NO_REGISTRY) | — |
| `src/canvas/bridge.test.mjs` | Client tests (session queueing, chunked upload/download, save, subscribe, demo sync) | — |

\* Line counts as of commit `1884025`.

The container side of the protocol — the part that receives a
`canvas-request` and decides what happens — lives in `onCanvasMessage`
in `src/App.jsx`. This is the router, in full, because it is the
single place where every kind is dispatched:

```js
async function onCanvasMessage(e) {
  const frame = canvasIframeRef.current;
  if (!frame || e.source !== frame.contentWindow) return;
  const d = e.data || {};
  if (d.type !== "canvas-request" || !d.id || !selectedId) return;
  const host = canvasHost();
  const reply = (ok, value, error) =>
    frame.contentWindow.postMessage({ type: "canvas-response", id: d.id, ok, value, error }, "*");
  if (!d.session || d.session !== canvasSessionRef.current) {
    reply(false, undefined, "STALE_SESSION");
    return;
  }
  const filesHandler = createFilesHandler({
    callRegisteredApi,
    fetchBinary: fetchBinaryFromRegistry,
    onLog: (ev) => setCanvasLog((prev) => [...prev, ev].slice(-20)),
    isAppRegistered: (name) => apisRef.current.some((a) => a.name === name),
    store: canvasUploadsRef.current,
  });
  try {
    if (d.kind === "api") {
      reply(true, await host.canvas.api.get(d.path));
    } else if (d.kind === "api:fetch") {
      const v = validateRegistryCall({ api: d.api, path: d.path, method: d.method, body: d.body });
      if (!v.ok) throw new Error(v.error);
      reply(true, await callRegisteredApi(d.api, d.path, null, { method: v.method, body: d.body ?? null }));
    } else if (d.kind === "state:get") {
      reply(true, await host.canvas.state.get(d.key));
    } else if (d.kind === "state:all") {
      reply(true, await host.canvas.state.all());
    } else if (d.kind === "state:set") {
      const value = await host.canvas.state.set(d.key, d.value);
      frame.contentWindow.postMessage({ type: "canvas-state-changed", key: d.key, value }, "*");
      await loadState(selectedId);
      reply(true, value);
    } else if (d.kind === "state:delete") {
      await host.canvas.state.delete(d.key);
      frame.contentWindow.postMessage({ type: "canvas-state-changed", key: d.key, value: null }, "*");
      await loadState(selectedId);
      reply(true, null);
    } else if (d.kind === "files:upload:start") {
      reply(true, filesHandler.startUpload(d));
    } else if (d.kind === "files:upload:chunk") {
      reply(true, filesHandler.receiveChunk({ uploadId: d.uploadId, index: d.index, data: d.data }));
    } else if (d.kind === "files:upload:finish") {
      reply(true, await filesHandler.finishUpload({ uploadId: d.uploadId }));
    } else if (d.kind === "files:upload:cancel") {
      reply(true, filesHandler.cancelUpload({ uploadId: d.uploadId }));
    } else if (d.kind === "files:download") {
      try {
        await filesHandler.download({
          api: d.api, path: d.path, params: d.params,
          onChunk: (c) =>
            frame.contentWindow.postMessage(
              { type: "canvas-download-chunk", id: d.id, index: c.index, total: c.total, data: c.data, done: c.done, meta: c.meta },
              "*",
              [c.data]
            ),
        });
      } catch (dlErr) {
        frame.contentWindow.postMessage({ type: "canvas-download-chunk", id: d.id, error: String(dlErr.message || dlErr) }, "*");
      }
    } else {
      reply(false, undefined, "UNKNOWN_KIND");
    }
  } catch (err) {
    reply(false, undefined, String(err.message || err));
  }
}
```

Read it top to bottom and you have the whole container side: source
check, type/id/document check, session check, a fresh files handler
per message sharing the upload store in a ref, then one branch per
kind. Note the download branch: it never calls `reply` — it streams
`canvas-download-chunk` messages, and on failure sends a single
error chunk.

## 16. How to run it

From the repo root, on the `canvas` branch:

```bash
npm ci
npm run test:canvas    # all 6 test files, plain node, no browser needed
npm run build          # Vite production build
npm run preview -- --port 4173 --strictPort --host 127.0.0.1
```

Verified outputs (run 2026-11-06, on this branch):

- `npm run test:canvas` — all 6 files pass:
  - allowlist 11/11
  - shell (CSP + lockdown + bridge, order, stored HTML untouched)
  - host (api allowlist, KV get/all/set/delete, logging)
  - run 3/3 (QuickJS sandbox)
  - files (validation, 2.4 MB chunk round-trip in 3 chunks,
    multipart, handler flow, host api.fetch/files, NO_REGISTRY)
  - bridge (session queueing, 2.5 MB chunked upload with progress
    and byte-exact reassembly, chunked download into a Blob, save()
    anchor click, subscribe, demo sync)
- `npm run build` — passes in 2.38s.
- Preview smoke test — `/` returns 200, `/canvas-inner.html`
  returns 200, the served inner page contains the v2 bridge, and
  headless Chromium renders the app with the Canvas mode button in
  the DOM.

**The demo page.** `public/canvas-inner.html` is the inner shell you
can click through: turn on Canvas mode in the sidebar, and it shows
buttons for state, versions, the forbidden-path case, the direct-fetch
case, plus an upload control (API name + path + file picker, with
progress text) and a download control. It needs a registered API to
actually complete an upload or download — without one, the chrome
answers `api_not_registered`, which itself proves the bridge carried
the request end to end. Its lockdown + bridge scripts are synced from
`src/canvas/csp.js` — after any change to those constants, run:

```bash
node scripts/sync-bridge.mjs
```

The bridge test fails if the demo page drifts from the constants, so
a stale demo cannot slip through silently.

**Done-when check for a change to the bridge.** After editing any
file in `src/canvas/` or `src/App.jsx`: `npm run test:canvas` passes,
`npm run build` passes, and if you touched `csp.js`, the sync script
has been run and `git status` shows the demo page updated with it.

## 17. How to extend it — adding a kind

Every new capability follows the same four places. Example: adding
download progress events (the gap named in §6.4 and §13).

1. **Client** (`CANVAS_BRIDGE_SCRIPT` in `src/canvas/csp.js`):
   add the method on `window.canvas`, the `request`/`requestChunk`
   call that sends the new kind, and the message handling for any
   new reply shape. Keep the client dependency-free plain JavaScript
   with `var`, no imports, no template literals — it is injected as a
   string into pages.
2. **Container** (`onCanvasMessage` in `src/App.jsx`): add a branch
   for the new kind. Validate before doing work; reply with
   `canvas-response` (or a chunk stream, if it is a download-like
   shape). Never send a token, a token URL, or file content in an
   error.
3. **Host** (`src/canvas/canvasHost.js`): add the same capability to
   the host object, so the QuickJS sandbox gets it too. If it needs
   the registry, it goes through the injected `callRegisteredApi` /
   `fetchBinary`, and throws `NO_REGISTRY` when they are absent.
4. **Tests**: a case in `files.test.mjs` (container logic) and a case
   in `bridge.test.mjs` (client behaviour against a fake chrome), plus
   a `csp.test.mjs` assertion if the client gained a new string the
   shell must contain. Then `node scripts/sync-bridge.mjs` and
   `npm run test:canvas`.

Do not add a kind in only one place. A client method with no
container branch gets `UNKNOWN_KIND`; a container branch with no
client method is dead code no page can reach.

## 18. When it breaks — real failures seen while building this

Each box below is a failure that actually happened during
verification of v2, what caused it, and what fixed it. They are here
so the next person does not repeat them.

> **A too-strict file guard rejected a valid upload.**
> The client's `uploadFile` first required `file.arrayBuffer` as a
> direct method on the file. The test's Blob-like only had
> `slice().arrayBuffer()`, so a perfectly good upload was rejected
> with "needs a File or Blob". Fix: guard only what the code actually
> uses — `slice()` and a numeric `size`. Lesson: a validation that
> demands more than the implementation needs is a bug, not safety.

> **A test pump exited before the first message was posted.**
> The test drove the fake chrome with a loop that ran "while the
> outbox is non-empty". But the client's first message is posted from
> a microtask after `canvas-init` resolves, so on the first iteration
> the outbox was empty and the loop exited — and the upload promise
> never settled. Fix: drive the pump "until the promise settles",
> not "while there is mail". Lesson: with async message passing,
> wait for the outcome, never for the queue to look busy.

> **A misplaced transfer destructure lost the chunk bytes.**
> The test read `msg.transfer[0]` for the chunk's `ArrayBuffer`.
> But `transfer` is the third argument to `postMessage` — it lives
> on the call, not on the message object. The fix was one
> destructure: `const { msg, transfer } = sent.shift()`. Lesson:
> the envelope and the payload are different things; keep them
> apart in code the same way the protocol keeps them apart on the
> wire.

> **The preview server answered 000 on 127.0.0.1.**
> `vite preview` binds to `localhost`, which in this sandbox can
> resolve to IPv6 only — so `curl http://127.0.0.1:4173/` got
> "connection failed" while the server was up and healthy. Fix:
> start it with `--host 127.0.0.1`. Lesson: a 000 from curl is a
> listening-address problem until proven otherwise; check where the
> server actually bound before doubting the app.

And the two failures users will hit most often (from §7.6, restated
as symptoms):

> **Upload rejects immediately with `API_NOT_REGISTERED`.**
> The app name is not in the registry, or the "name" is a URL.
> Register the API first; `api.fetch` and `files.*` take registered
> names only.

> **Every request rejects with `STALE_SESSION`.**
> The page is from an old view (document changed, iframe reloaded).
> Reload the page; the new `canvas-init` carries the new session.
> Page code must never cache the session itself.

## 19. Glossary

- **Canvas.** The governed publication layer for agent-built web
  pages: publish, view, version history, shared state. The viewer is
  `agent-docs-ui`; the API is `agent-docs-api`.
- **Outer shell / chrome / container.** The viewer app that hosts the
  page. Owns the network, the tokens, and the registry. The trusted
  side.
- **Inner shell / page.** The published HTML document running inside
  the sandboxed iframe. Owns the pixels and the JavaScript. The
  untrusted side.
- **Sandbox.** The iframe's `sandbox="allow-scripts"` attribute: the
  page may run scripts, but it has an opaque origin and no
  `allow-same-origin`, so it cannot reach the viewer's origin.
- **CSP (Content Security Policy).** The browser-enforced list of
  what the page may load and contact (§4.1). `connect-src 'none'`
  switches the page's network off.
- **Lockdown script.** The script that replaces dangerous globals
  with throwing stubs and blocks nested frames, navigation, and form
  submission (§4.2).
- **Bridge.** The whole `window.canvas` system: the injected client,
  the `postMessage` protocol, and the chrome's handlers.
- **Registry.** `api_registry`: the list of internal APIs the viewer
  may call, one row per app name, with its endpoint URL and its
  token URL.
- **Token.** An access token for a registered API's endpoint,
  fetched by the chrome at view time. Never in the page.
- **Session (nonce).** A random value the chrome issues per view in
  `canvas-init`; every request echoes it (§7.4).
- **Kind.** The operation name inside a `canvas-request` (§7.4).
- **Chunk.** A 1 MB piece of a file in flight. Uploads and downloads
  move as a sequence of chunks.
- **Allowlist.** A fixed list of paths the chrome will fetch
  (`api.get`, §6.1). Anything not on it is never fetched.
- **Multipart.** `multipart/form-data`: the encoding the chrome uses
  to POST a file to an API (§8). The browser sets the boundary; the
  chrome never sets the `Content-Type` header for it.
- **QuickJS sandbox.** A panel in the viewer that runs untrusted
  JavaScript in a fresh QuickJS/WASM interpreter, with the same
  `canvas` host object and no other capability (§14).

## 20. Version and status

- **Protocol version:** v2, as implemented on the `canvas` branch,
  commit `1884025` (2026-11-06). v1 had only `api.get` and
  `state.*`; v2 adds `api.fetch`, `files.upload` / `files.download`
  / `files.save`, the per-view session nonce, and the
  `canvas-download-chunk` stream.
- **Status:** implemented, tested, and demoed on this branch. The
  remaining integration step is wiring `withCanvasShell()` into the
  published-document render path (§5).
- **Known gaps, by design or awaiting a decision:** no doc-to-doc
  calls; no request cancellation; no download progress events; no
  mixed form fields + file in one request; upload is POST-only;
  25 MB cap. Each is named where it bites (§6.4, §10.3, §11, §13).
- **The one rule for changing this document:** if the protocol
  changes, change this file in the same commit, and change the
  tests in the same commit. A protocol doc that disagrees with the
  code is worse than no doc, because the next person will trust it.

## 21. Related open specs — is there a standard for this?

Short answer: there is no standard that *is* this protocol, but there
is a close relative, and the resemblance is worth knowing about.

The closest open spec is **MCP Apps** — an extension to the Model
Context Protocol, finalized in January 2026 and live in Claude and
VS Code Copilot. It solves the same problem from the same direction:
an agent-built UI runs in a sandboxed iframe, talks to its host over
`postMessage`, and the host proxies privileged calls so tokens never
enter the frame. MCP Apps uses JSON-RPC 2.0 as its message format.

This bridge is custom, not MCP Apps: it uses its own message kinds
(`api`, `api:fetch`, `state:*`, `files:upload/*`, `files:download`)
instead of JSON-RPC, and it adds things MCP Apps does not define —
chunked file transfer with a 1 MB framing, the per-view session
nonce, and the upload validation order in §7.5. Other things in the
same neighbourhood: the **Snug Protocol**, plain **JSON-RPC 2.0**,
and the small `postMessage` helper libraries **Penpal**,
**Postmate**, and **Rimless** (which solve the transport — a typed
`postMessage` channel — but not the capability model: allowlist,
registry, tokens, session).

If Canvas ever needs to interoperate with other hosts, MCP Apps is
the candidate to align with: same shape (sandboxed iframe +
host proxy + no tokens in the frame), different message format.
Nothing in this protocol depends on that decision today.
