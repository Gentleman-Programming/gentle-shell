import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const preload = new URL("../scripts/diagnostics/windows-post-spawn-markers.mjs", import.meta.url).href;
const run = code => spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 5000, maxBuffer: 128 * 1024 });
const bootstrap = `import a from 'node:assert/strict'; import fs from 'node:fs'; const check=a.equal.bind(a); const deep=a.deepEqual.bind(a); const esm=await import('node:fs'); const ae=await import('node:assert/strict');
const site=(line,extra='')=>{Error.prepareStackTrace=()=> 'Error\\n    at caller (file:///SECRET/source/tests/installer-windows-bootstrap.test.ts:'+line+':18)'+extra};`;
const load = `await import(${JSON.stringify(preload)});`;
const markers = stderr => stderr.trim().split("\n").filter(Boolean).map(line => {
 assert.ok(line.startsWith("POST_SPAWN_MARKER "), line);
 const value = JSON.parse(line.slice(18));
 assert.ok(Number.isInteger(value.pid) && value.pid > 0);
 delete value.pid;
 return value;
});
const expected = (phase, id, method, line) => ({ phase, id, method, site: `installer-windows-bootstrap.test.ts:${line}:18` });

test("assertions, directory read and cleanup preserve receivers, args, ESM results and exact thrown error", () => {
 const r = run(bootstrap + `const receiver={};const arg={SECRET:'payload'};const opts={recursive:true,force:true,SECRET:'options'};const token={};const failure=new Error('SECRET-error');let calls=0;
 for(const method of ['equal','match','deepEqual'])a[method]=function(...args){check(this,receiver);check(args[0],arg);check(args[1],opts);if(++calls===2)throw failure;return token};
 fs.readdirSync=function(p,o){check(this,receiver);check(p,arg);check(o,opts);return token};
 fs.rmSync=function(p,o){check(this,receiver);check(p,arg);check(o,opts);return token};` + load + `
 site(345);check(ae.equal.call(receiver,arg,opts),token);
 site(346);try{a.match.call(receiver,arg,opts);throw new Error('missing throw')}catch(e){check(e,failure)}
 site(347);check(a.deepEqual.call(receiver,arg,opts),token);check(esm.readdirSync.call(receiver,arg,opts),token);
 site(151,'\\n    at caller (file:///SECRET/source/tests/installer-windows-bootstrap.test.ts:348:18)');check(esm.rmSync.call(receiver,arg,opts),token);console.log('OK');`);
 assert.equal(r.error, undefined); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, "OK\n");
 assert.deepEqual(markers(r.stderr), [expected("before",1,"assert.equal",345),expected("after",1,"assert.equal",345),expected("before",2,"assert.match",346),expected("throw",2,"assert.match",346),expected("before",3,"assert.deepEqual",347),expected("after",3,"assert.deepEqual",347),expected("before",4,"fs.readdirSync",347),expected("after",4,"fs.readdirSync",347),expected("before",5,"fs.rmSync",151),expected("after",5,"fs.rmSync",151)]);
 assert.doesNotMatch(r.stderr, /SECRET|payload|options|recursive|force/);
});

test("only exact frozen call sites are observed; unrelated calls still delegate", () => {
 const r = run(bootstrap + `let calls=0;a.equal=()=>++calls;fs.rmSync=()=>++calls;` + load + `
 const frames=['at caller (file:///SECRET/private-installer-windows-bootstrap.test.ts:345:18)', 'at caller (file:///SECRET/installer-windows-bootstrap.test.ts:345:18/private.mjs:1:1)', 'at caller (file:///SECRET/installer-windows-bootstrap.test.ts:123456789012:18)', 'at caller (file:///SECRET/installer-windows-bootstrap.test.ts:345:0)', 'at caller (file:///SECRET/installer-windows-bootstrap.test.ts:346:18)', 'at caller (file:///SECRET/installer-windows-bootstrap.test.ts:345:18)'+ 'x'.repeat(17000)];
 for(const frame of frames){Error.prepareStackTrace=()=> 'Error\\n    '+frame;check(a.equal('secret'),++expectedCalls)}
 site(151);check(esm.rmSync('secret'),++expectedCalls);
 site(151,'\\n    at caller (file:///SECRET/installer-windows-bootstrap.test.ts:350:18)');check(esm.rmSync('secret'),++expectedCalls);
 site(348);check(esm.rmSync('secret'),++expectedCalls);console.log(calls);`.replace("const frames=", "let expectedCalls=0;const frames="));
 assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, "9\n"); assert.equal(r.stderr, "");
});

test("bounded markers and failed writer never suppress delegates or replace errors", () => {
 const r = run(bootstrap + `let calls=0;a.equal=()=>++calls;` + load + `site(345);for(let n=1;n<=150;n++)check(a.equal('SECRET'),n);console.log(calls);`);
 assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, "150\n");
 const events = markers(r.stderr); assert.equal(events.length, 257); assert.deepEqual(events.at(-1), { phase: "limit" });
 assert.deepEqual(events.slice(0,2), [expected("before",1,"assert.equal",345),expected("after",1,"assert.equal",345)]);
 const failed = run(bootstrap + `fs.writeSync=()=>{throw new Error('writer')};const value={};const error=new Error('original');let n=0;fs.rmSync=()=>{if(++n===2)throw error;return value};` + load + `site(151,'\\n    at caller (file:///SECRET/installer-windows-bootstrap.test.ts:348:18)');check(esm.rmSync('secret'),value);try{esm.rmSync('secret');throw new Error('missing throw')}catch(e){check(e,error)}console.log('OK');`);
 assert.equal(failed.status,0,failed.stderr);assert.equal(failed.stdout,"OK\n");assert.equal(failed.stderr,"");
});

test("abrupt cleanup retains before marker; actual assertion failure retains original semantics", () => {
 const abrupt = run(bootstrap + `fs.rmSync=()=>process.exit(42);` + load + `site(151,'\\n    at caller (file:///SECRET/installer-windows-bootstrap.test.ts:348:18)');esm.rmSync('secret');`);
 assert.equal(abrupt.status,42);assert.equal(abrupt.stdout,"");assert.deepEqual(markers(abrupt.stderr),[expected("before",1,"fs.rmSync",151)]);
 const failure = run(bootstrap + load + `site(345);try{a.equal(1,2);throw new Error('missing assertion')}catch(e){check(e.code,'ERR_ASSERTION');check(e.actual,1);check(e.expected,2);check(e.operator,'strictEqual')}console.log('OK');`);
 assert.equal(failure.status,0,failure.stderr);assert.equal(failure.stdout,"OK\n");assert.deepEqual(markers(failure.stderr),[expected("before",1,"assert.equal",345),expected("throw",1,"assert.equal",345)]);
});

test("workflow adds only the post-spawn preload to the prior frozen diagnostic", () => {
 const w = readFileSync(new URL("../.github/workflows/windows-post-spawn-markers.yml",import.meta.url),"utf8").replace(/\r\n/g,"\n");
 const previous = readFileSync(new URL("../.github/workflows/windows-installer-markers.yml",import.meta.url),"utf8").replace(/\r\n/g,"\n");
 const expanded = previous.replace("Windows original-file process markers (issue 213)","Windows post-spawn markers (issue 213)").replaceAll("ci/213-windows-markers","ci/213-windows-post-spawn").replaceAll(".github/workflows/windows-installer-markers.yml",".github/workflows/windows-post-spawn-markers.yml").replace("Capture one original installer file with process markers","Capture one original installer file with post-spawn markers").replace("process-boundary-markers-v1","post-spawn-markers-v1").replace('"--experimental-strip-types"','"--import", require("node:url").pathToFileURL(path.resolve("scripts/diagnostics/windows-post-spawn-markers.mjs")).href, "--experimental-strip-types"');
 assert.equal(w, expanded);
 for(const text of ['ref: 41210ef5d87f6242c507b04b818801ffa9b7f49b','node-version: "24.21.0"','process.env.ImageOS !== "win25-vs2026"','process.env.ImageVersion !== "20260925.250.1"','deadlineMs = 180_000','maxOutputBytes = 8 * 1024 * 1024','if: always()','retention-days: 7'])assert.ok(w.includes(text),text);
 assert.doesNotMatch(w,/workflow_dispatch|pull_request|matrix:|continue-on-error|npm install/);
 const script=w.match(/^\s*@'\n([\s\S]*?)^\s*'@ \| Set-Content/m)?.[1];assert.ok(script);
 const checked=spawnSync(process.execPath,["--check"],{input:script,encoding:"utf8",timeout:5000});assert.equal(checked.status,0,checked.stderr);assert.equal(checked.stdout,"");assert.equal(checked.stderr,"");
});
