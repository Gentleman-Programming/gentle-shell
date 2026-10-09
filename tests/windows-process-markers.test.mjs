import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
const preload = new URL("../scripts/diagnostics/windows-process-markers.mjs", import.meta.url).href;
const run = code => spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 5000, maxBuffer: 128 * 1024 });
const bootstrap = `import assert from 'node:assert/strict'; import cp from 'node:child_process'; const esm = await import('node:child_process');`;
const load = `await import(${JSON.stringify(preload)});`;
const markers = text => text.trim().split("\n").map(line => { assert.ok(line.startsWith("PROCESS_MARKER ")); const item = JSON.parse(line.slice(15)); assert.ok(Number.isInteger(item.pid) && item.pid > 0); delete item.pid; return item; });
const expected = (phase, id, method = "spawnSync") => ({ phase, id, method, executable: "other", site: "unknown" });
test("ESM calls preserve receiver, argv/options, result and thrown error without leaking input", () => {
 const r = run(bootstrap + `const receiver={}; const args=['SECRET-argv']; const options={env:{SECRET:'SECRET-env'}}; const token={}; const error=new Error('SECRET-error'); let calls=0;
 cp.spawnSync=function(command,a,o){ assert.equal(this,receiver);assert.equal(command,'SECRET-path');assert.equal(a,args);assert.equal(o,options);if(++calls===2)throw error;return token; };
 cp.spawn=function(command,a,o){assert.equal(a,args);assert.equal(o,options);return token;};` + load + `assert.equal(esm.spawnSync.call(receiver,'SECRET-path',args,options),token); assert.throws(()=>esm.spawnSync.call(receiver,'SECRET-path',args,options),e=>e===error); assert.equal(esm.spawn('SECRET-path',args,options),token);console.log('OK');`);
 assert.equal(r.error, undefined); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, "OK\n");
 assert.deepEqual(markers(r.stderr), [expected("before",1),expected("after",1),expected("before",2),expected("throw",2),expected("before",3,"spawn"),expected("after",3,"spawn")]);
 assert.doesNotMatch(r.stderr, /SECRET/);
});
test("marker cap preserves all delegates and emits one limit marker", () => {
 const r = run(bootstrap + `let calls=0;cp.spawnSync=()=>++calls;` + load + `for(let n=1;n<=150;n++)assert.equal(esm.spawnSync('private'),n);console.log(calls);`);
 assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,"150\n"); const m=markers(r.stderr);assert.equal(m.length,257);
 assert.deepEqual(m.slice(0,2),[expected("before",1),expected("after",1)]);assert.deepEqual(m.at(-1),{phase:"limit"});
});
test("failed marker writer does not change delegate result or error", () => {
 const r=run(bootstrap + `import fs from 'node:fs';fs.writeSync=()=>{throw new Error('writer failure')}; const value={};const failure=new Error('original');let n=0;cp.spawnSync=()=>{if(++n===2)throw failure;return value};` + load + `assert.equal(esm.spawnSync('private'),value);assert.throws(()=>esm.spawnSync('private'),e=>e===failure);console.log('OK');`);
 assert.equal(r.status,0);assert.equal(r.stdout,"OK\n");assert.equal(r.stderr,"");
});
test("abrupt delegate exit retains the synchronous before marker", () => {
 const r=run(bootstrap + `cp.spawnSync=()=>process.exit(42);` + load + `esm.spawnSync('private');`);
 assert.equal(r.status,42);assert.equal(r.stdout,"");assert.deepEqual(markers(r.stderr),[expected("before",1)]);
});
test("stack sites require exact source basenames, frame boundaries and bounded coordinates", () => {
 const r=run(bootstrap + `cp.spawnSync=()=>0;` + load + `
 const frames=['at caller (file:///SECRET/source/scripts/installer-windows.mjs:77:12)', 'at caller (file:///SECRET/source/scripts/private-installer-windows.mjs:77:12)', 'at caller (file:///SECRET/source/scripts/installer-windows.mjs:77:12/private.mjs:1:1)', 'at caller (file:///SECRET/source/scripts/installer-windows.mjs:12345678901234567890:12)'];
 for(const frame of frames){Error.prepareStackTrace=()=> 'Error\\n    '+frame;esm.spawnSync('private');}console.log('OK');`);
 assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,"OK\n");
 const m=markers(r.stderr);assert.equal(m.length,8);
 assert.deepEqual(m.map(x=>x.site),['installer-windows.mjs:77:12','installer-windows.mjs:77:12',...Array(6).fill('unknown')]);
 assert.doesNotMatch(r.stderr,/SECRET|12345678901234567890/);
});
test("workflow selects one frozen file, original runtime/image and unchanged guard", () => {
 const w=readFileSync(new URL("../.github/workflows/windows-installer-markers.yml",import.meta.url),"utf8").replace(/\r\n/g,"\n");
 for(const text of ['ci/213-windows-markers','ref: 41210ef5d87f6242c507b04b818801ffa9b7f49b','node-version: "24.21.0"','process.version !== "v24.21.0"','process.env.ImageOS !== "win25-vs2026"','process.env.ImageVersion !== "20260925.250.1"','checkedOutSource !== sourceRef','deadlineMs = 180_000','maxOutputBytes = 8 * 1024 * 1024','"/pid", String(child.pid), "/T", "/F"','if: always()','retention-days: 7','"--import"','pathToFileURL','scripts/diagnostics/windows-process-markers.mjs'])assert.ok(w.includes(text),text);
 assert.equal((w.match(/"tests\/installer-windows-bootstrap\.test\.ts"/g)??[]).length,1);
 assert.equal((w.match(/persist-credentials: false/g)??[]).length,2);
 assert.match(w,/permissions:\n  contents: read/);assert.doesNotMatch(w,/workflow_dispatch|pull_request|matrix:|continue-on-error|npm install/);
 const script=w.match(/^\s*@'\n([\s\S]*?)^\s*'@ \| Set-Content/m)?.[1];assert.ok(script);
 const checked=spawnSync(process.execPath,["--check"],{input:script,encoding:"utf8",timeout:5000});assert.equal(checked.status,0,checked.stderr);assert.equal(checked.stdout,"");assert.equal(checked.stderr,"");
});
