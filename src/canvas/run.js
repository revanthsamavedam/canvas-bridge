import { newAsyncContext, shouldInterruptAfterDeadline } from 'quickjs-emscripten'

// Monty-for-JS, without Docker:
// - A fresh QuickJS interpreter (compiled to WASM) per run. Nothing leaks
//   between runs, and a crashed / timed-out run cannot take down the host.
// - By default the interpreter has NO host capability at all: no fetch,
//   no fs, no process, no require, no network, no DOM. Those things do
//   not exist in the VM, they are not merely blocked.
// - The ONLY way out is a host function you explicitly inject (here:
//   `canvas`), exactly like Monty's external functions. The host
//   function runs on the host with host authority, validates its
//   arguments, and returns a plain value. The sandbox never sees a
//   token, a client, or a host object reference.
// - Limits: wall-clock interrupt, heap memory limit, stack limit,
//   code-size limit, output truncation. Async host functions are
//   supported via the asyncified build: inside the sandbox they look
//   synchronous (like Monty's suspension), the host awaits them.

const DEFAULTS = {
  timeoutMs: 2000,
  memoryLimitBytes: 16 * 1024 * 1024,
  maxStackSizeBytes: 320 * 1024,
  maxCodeChars: 100_000,
  maxOutputChars: 100_000,
}

function toHandle(context, value) {
  if (value === undefined) return context.undefined
  if (value === null) return context.null
  if (typeof value === 'string') return context.newString(value)
  if (typeof value === 'number') return context.newNumber(value)
  if (typeof value === 'boolean') return value ? context.true : context.false
  if (Array.isArray(value)) {
    const arr = context.newArray()
    value.forEach((item, i) => {
      const h = toHandle(context, item)
      context.setProp(arr, i, h)
      h.dispose()
    })
    return arr
  }
  if (typeof value === 'object') {
    const obj = context.newObject()
    for (const [k, v] of Object.entries(value)) {
      const h = toHandle(context, v)
      context.setProp(obj, k, h)
      h.dispose()
    }
    return obj
  }
  // Functions, symbols, bigint, etc. are not passed across the boundary.
  return context.newString(String(value))
}

function makeHandle(context, name, value) {
  if (typeof value === 'function') {
    // Asyncified: the sandbox calls it synchronously, the host awaits.
    // It must not call another asyncified function (see quickjs docs).
    return context.newAsyncifiedFunction(name, async (...handles) => {
      const args = handles.map((h) => context.dump(h))
      const out = await value(...args)
      return toHandle(context, out)
    })
  }
  if (Array.isArray(value)) {
    const arr = context.newArray()
    value.forEach((item, i) => {
      const h = makeHandle(context, name, item)
      context.setProp(arr, i, h)
      h.dispose()
    })
    return arr
  }
  if (value && typeof value === 'object') {
    const obj = context.newObject()
    for (const [k, v] of Object.entries(value)) {
      const h = makeHandle(context, k, v)
      context.setProp(obj, k, h)
      h.dispose()
    }
    return obj
  }
  return toHandle(context, value)
}

function formatDumped(value, maxChars) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text === undefined) return undefined
  return text.length > maxChars ? text.slice(0, maxChars) + '…[truncated]' : text
}

/**
 * Run untrusted JS. `host` is the ONLY capability handed to the sandbox,
 * e.g. { canvas: { api: { get: async (path) => {...} }, state: {...} } }.
 * Returns { result, output, error } — result is the last expression's
 * value (dumped to a plain JS value), output is captured console text.
 */
export async function runJS(code, options = {}) {
  const opts = { ...DEFAULTS, ...options }
  if (typeof code !== 'string' || code.length > opts.maxCodeChars) {
    return { result: undefined, output: '', error: 'CODE_TOO_LARGE' }
  }
  const logs = []
  let context
  try {
    context = await newAsyncContext()
    context.runtime.setMemoryLimit(opts.memoryLimitBytes)
    context.runtime.setMaxStackSize(opts.maxStackSizeBytes)
    context.runtime.setInterruptHandler(
      shouldInterruptAfterDeadline(Date.now() + opts.timeoutMs),
    )

    // console.* — captured, never the host console directly.
    const consoleHandle = context.newObject()
    for (const level of ['log', 'warn', 'error']) {
      const fn = context.newFunction(level, (...handles) => {
        logs.push(handles.map((h) => {
          const v = context.dump(h)
          return typeof v === 'string' ? v : JSON.stringify(v)
        }).join(' '))
      })
      context.setProp(consoleHandle, level, fn)
      fn.dispose()
    }
    context.setProp(context.global, 'console', consoleHandle)
    consoleHandle.dispose()

    // Host capabilities only. Nothing else is injected.
    const host = opts.host || {}
    for (const [key, value] of Object.entries(host)) {
      const h = makeHandle(context, key, value)
      context.setProp(context.global, key, h)
      h.dispose()
    }

    const res = await context.evalCodeAsync(code)
    if (res.error) {
      const dumped = context.dump(res.error)
      res.error.dispose()
      const message =
        dumped && typeof dumped === 'object'
          ? dumped.message || JSON.stringify(dumped)
          : String(dumped)
      return { result: undefined, output: logs.join('\n'), error: message }
    }
    const value = context.dump(res.value)
    res.value.dispose()
    const output = logs.join('\n')
    return {
      result: typeof value === 'string' ? value : value,
      output: output.length > opts.maxOutputChars
        ? output.slice(0, opts.maxOutputChars) + '…[truncated]'
        : output,
      error: undefined,
    }
  } catch (e) {
    return { result: undefined, output: logs.join('\n'), error: String(e && e.message ? e.message : e) }
  } finally {
    if (context) {
      try { context.dispose() } catch (_) {}
    }
  }
}

// Agent-docs adaptation: no demo host here. The host is built by
// ./canvasHost.js (document KV + allowlisted agent-docs API) and
// passed to runJS by App.jsx. Copied from standalone Canvas
// js-sandbox/src/run.js, demoHost removed — same QuickJS/WASM
// runner, no Docker, fresh context per run, host functions only.

export { formatDumped }
