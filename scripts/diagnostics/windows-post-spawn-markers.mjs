import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// Diagnostic-only preload: frozen source remains unchanged. Never inspect args.
const MAX_EVENTS = 256;
let emitted = 0;
let limited = false;
let nextId = 0;

function sourceSite(method) {
 try {
  const stack = new Error().stack;
  if (typeof stack !== "string" || stack.length > 16384) return null;
  const frames = [];
  for (const line of stack.split("\n")) {
   const match = line.match(/^\s+at (?:[^\r\n]*? \()?(?:file:\/\/\/|[A-Za-z]:[\\/]|\/)[^\r\n]*[\\/](installer-windows-bootstrap\.test\.ts):([1-9]\d{0,5}):([1-9]\d{0,5})\)?$/);
   if (match) frames.push({ line: Number(match[2]), site: `${match[1]}:${match[2]}:${match[3]}` });
  }
  const first = frames[0];
  if (!first) return null;
  if (method === "fs.rmSync") {
   return first.line === 151 && frames[1]?.line === 348 ? first.site : null;
  }
  const line = { "assert.equal": 345, "assert.match": 346, "assert.deepEqual": 347, "fs.readdirSync": 347 }[method];
  return first.line === line ? first.site : null;
 } catch {
  return null; // Observation failure never blocks the delegate.
 }
}

function observe(phase, id, method, site) {
 try {
  if (emitted >= MAX_EVENTS) {
   if (!limited) {
    limited = true;
    fs.writeSync(2, "POST_SPAWN_MARKER " + JSON.stringify({ pid: process.pid, phase: "limit" }) + "\n");
   }
   return;
  }
  emitted++;
  fs.writeSync(2, "POST_SPAWN_MARKER " + JSON.stringify({ pid: process.pid, phase, id, method, site }) + "\n");
 } catch { /* Best-effort writes preserve the original result or error. */ }
}

for (const [target, methods, prefix] of [[assert, ["equal", "match", "deepEqual"], "assert"], [fs, ["readdirSync", "rmSync"], "fs"]]) {
 for (const name of methods) {
  const original = target[name];
  const method = `${prefix}.${name}`;
  target[name] = function (...args) {
   const site = sourceSite(method);
   if (!site) return Reflect.apply(original, this, args);
   const id = ++nextId;
   observe("before", id, method, site);
   let result;
   try { result = Reflect.apply(original, this, args); }
   catch (error) { observe("throw", id, method, site); throw error; }
   observe("after", id, method, site);
   return result;
  };
 }
}
// Frozen tests use both default assert and named filesystem ESM imports.
syncBuiltinESMExports();
