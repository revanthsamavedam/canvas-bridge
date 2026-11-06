// Canvas API allowlist for agent-docs — adapted from standalone Canvas.
//
// Standalone Canvas allowed jsonplaceholder /posts. Here the outer
// shell is agent-docs-ui, so canvas.api may only read the agent-docs
// API itself. It is GET-only in this mode: writes go through
// canvas.state (document KV), never through canvas.api, so Canvas
// cannot create documents, versions, or drafts and cannot bypass
// the publish gate. The outer chrome checks this before any fetch;
// an unlisted path is never fetched.
//
// Pure JS, no React, no fetch — unit-testable in plain node.
const DOC = "[A-Za-z0-9_-]+";
const KEY = "[A-Za-z0-9._%~-]+";
const RULES = [
  { method: "GET", pattern: /^\/v1\/documents$/ },
  { method: "GET", pattern: new RegExp(`^/v1/documents/${DOC}$`) },
  { method: "GET", pattern: new RegExp(`^/v1/documents/${DOC}/versions$`) },
  { method: "GET", pattern: new RegExp(`^/v1/documents/${DOC}/state$`) },
  { method: "GET", pattern: new RegExp(`^/v1/documents/${DOC}/state/${KEY}$`) },
  { method: "GET", pattern: /^\/v1\/apis$/ },
];

export function validateCanvasApi(method, rawPath) {
  if (typeof rawPath !== "string" || !rawPath.startsWith("/v1/")) {
    return { ok: false, error: "INVALID_PATH" };
  }
  if (rawPath.includes("..")) return { ok: false, error: "INVALID_PATH" };
  const path = rawPath.split("?")[0];
  const m = String(method || "").toUpperCase();
  const allowed = RULES.some((r) => r.method === m && r.pattern.test(path));
  if (!allowed) return { ok: false, error: "FORBIDDEN_PATH" };
  return { ok: true, method: m, path: rawPath };
}
