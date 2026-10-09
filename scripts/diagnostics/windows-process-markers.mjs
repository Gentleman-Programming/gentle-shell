import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// Diagnostic preload only. Never log argv, environment, payloads or full paths.
const MAX_EVENTS = 256;
let emitted = 0;
let limited = false;
let nextId = 0;
const executables = new Set(["node", "node.exe", "cmd.exe", "powershell.exe", "git.exe", "taskkill.exe"]);
function observe(phase, id, method, command) {
 try {
  if (emitted >= MAX_EVENTS) {
   if (!limited) { limited = true; fs.writeSync(2, "PROCESS_MARKER " + JSON.stringify({ pid: process.pid, phase: "limit" }) + "\n"); }
   return;
  }
  emitted++;
  const basename = typeof command === "string" && command.length <= 512 ? command.split(/[\\/]/).at(-1).toLowerCase() : "";
  const executable = executables.has(basename) ? basename : "other";
  const stack = new Error().stack;
  const match = typeof stack === "string" && stack.length <= 16384
   ? stack.match(/^\s+at (?:[^\r\n]*? \()?(?:file:\/\/\/|[A-Za-z]:[\\/]|\/)[^\r\n]*[\\/](installer-windows-bootstrap\.test\.ts|installer-windows\.mjs):([1-9]\d{0,5}):([1-9]\d{0,5})\)?$/m)
   : null;
  const site = match ? `${match[1]}:${match[2]}:${match[3]}` : "unknown";
  fs.writeSync(2, "PROCESS_MARKER " + JSON.stringify({ pid: process.pid, phase, id, method, executable, site }) + "\n");
 } catch { /* Best-effort observation never replaces delegate results/errors. */ }
}
for (const method of ["spawn", "spawnSync"]) {
 const original = cp[method];
 cp[method] = function (...args) {
  const id = ++nextId;
  observe("before", id, method, args[0]);
  let result;
  try { result = Reflect.apply(original, this, args); }
  catch (error) { observe("throw", id, method, args[0]); throw error; }
  observe("after", id, method, args[0]);
  return result;
 };
}
// Frozen source uses named ESM imports. Do not add child listeners or timers.
syncBuiltinESMExports();
