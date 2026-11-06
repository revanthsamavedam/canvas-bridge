// Sync the canonical Canvas bridge + lockdown from src/canvas/csp.js
// into public/canvas-inner.html (the demo inner shell).
//
// The demo page's inline scripts must match the canonical constants
// in csp.js — the bridge test fails if they drift. Run after any
// change to CANVAS_BRIDGE_SCRIPT or LOCKDOWN_SCRIPT:
//   node scripts/sync-bridge.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CANVAS_BRIDGE_SCRIPT, LOCKDOWN_SCRIPT } from "../src/canvas/csp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const innerPath = path.join(root, "public", "canvas-inner.html");
let html = readFileSync(innerPath, "utf8");

function replaceBetween(text, start, end, replacement) {
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  if (i === -1 || j === -1 || j <= i) throw new Error(`markers not found: ${start}`);
  return text.slice(0, i + start.length) + "\n" + replacement + "\n" + text.slice(j);
}

html = replaceBetween(
  html,
  "<!-- canvas-lockdown:start -->",
  "<!-- canvas-lockdown:end -->",
  `<script>\n${LOCKDOWN_SCRIPT}\n</script>`
);
html = replaceBetween(
  html,
  "<!-- canvas-bridge:start -->",
  "<!-- canvas-bridge:end -->",
  `<script>\n${CANVAS_BRIDGE_SCRIPT}\n</script>`
);
writeFileSync(innerPath, html);
console.log("canvas-inner.html synced from src/canvas/csp.js");
