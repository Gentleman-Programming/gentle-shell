import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const PI = '@earendil-works/pi-coding-agent';
// A virtual symlink filesystem: listed global links point into a pnpm store.
// The store's adjacent peer is a sibling, not Shell/node_modules/Pi.
function launch(args: string[], scenario = 'owned') {
 const adjacent = scenario.startsWith('adjacent');
 const npm = scenario.startsWith('npm-');
 const nodeModules = '/global/v11/selected/node_modules';
 const shellRoot = '/store/shell-peer/node_modules/gentle-pi';
 const piRoot = adjacent ? '/store/shell-peer/node_modules/' + PI : '/store/pi/node_modules/' + PI;
 const target = adjacent ? 'gentle-pi' : PI;
 const dependencies: Record<string, object> = {[target]:{path: `${nodeModules}/${target}`,
  ...(scenario === 'npm-link' ? {link:true} : {}),
  ...(scenario === 'npm-file' ? {resolved:'file:/source/pi'} : {})}};
 if (scenario.endsWith('shared')) dependencies['unrelated'] = {path:`${nodeModules}/unrelated`};
 if (scenario === 'separate') dependencies['unrelated'] = {path:'/global/v11/other/node_modules/unrelated'};
 const groups = [{path:'/global/v11',dependencies}, ...(scenario === 'ambiguous' ? [{path:'/global/other',dependencies}] : [])];
 const listing = scenario === 'malformed' ? '{' : JSON.stringify(npm ? groups[0] : groups);
 // pnpm links only the top-level package into the global group; the peer
 // is reachable solely as the Shell package's store sibling.
 const links = {[`${nodeModules}/${target}`]:adjacent ? shellRoot : piRoot};
 const roots = [nodeModules, '/global/v11/other/node_modules', shellRoot, piRoot, `${piRoot}/dist/bundle/cli.js`];
 const bootstrap = `import { registerHooks } from 'node:module';
 const original = ${JSON.stringify(new URL('../bin/gentle-shell.mjs', import.meta.url).href)};
 registerHooks({load(url, context, next) {
  if (url === original) {
   let source = next(url, context).source.toString();
   source = source.replace('const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));', ${JSON.stringify(`const packageRoot = '${shellRoot}';`)});
   source = source.replace('const bundled = resolveBundledInstall({ packageRoot, platform: process.platform, fs: bundledFs, verifying });', 'const bundled = undefined;');
   source = source.replace('runtime = resolvePiRuntime({', ${JSON.stringify(`runtime = ({ kind: '${adjacent ? 'bundled' : 'env'}', command: '${adjacent ? 'node' : piRoot + '/dist/bundle/cli.js'}', args: ${JSON.stringify(adjacent ? [piRoot + '/dist/bundle/cli.js'] : [])} }); /*`)}).replace('nodeExecPath: process.execPath,\\n\\t\\t});', 'nodeExecPath: process.execPath, */');
   source = source.replace('const versionProbe = spawnSync(versionProbePlan.command, versionProbePlan.args, {', 'const versionProbe = { stdout: "1.2.0" }; /*').replace('env: bundledEnv ?? process.env,\\n\\t});', 'env: bundledEnv ?? process.env, */');
   source = source.replace('async function packageManagerAdapters() {', 'async function packageManagerAdapters() { return globalThis.fakeAdapters; } async function unusedAdapters() {');
   source = source.replace('let homeHadContentBeforeBootstrap = false;', 'if (passthrough.length === 1) { console.error("error: pi cannot self-update this installation. This installation is not managed by a global pnpm install."); process.exitCode = 1; return; } console.log("FORWARD " + JSON.stringify(passthrough)); return; let homeHadContentBeforeBootstrap = false;');
   return {format:'module', source, shortCircuit:true};
  }
  return next(url,context);
 }});
 const links = ${JSON.stringify(links)}, roots = ${JSON.stringify(roots)};
 globalThis.fakeAdapters = {
  fs: { realpath: async p => { if (links[p]) return links[p]; if (roots.includes(p)) return p; throw new Error('ENOENT ' + p); },
   readFile: async p => { if (p === '${shellRoot}/package.json') return JSON.stringify({name:'gentle-pi',version:'4.1.0'}); if(p === '${piRoot}/package.json') return JSON.stringify({name:'${PI}',version:'1.2.0',bin:{pi:'dist/bundle/cli.js'}}); throw new Error('ENOENT ' + p); } },
  which: async n => n === '${npm ? 'npm' : 'pnpm'}' ? '/fake/' + n : null,
  run: async (cmd, args) => {
   if(args.includes('list') || args.includes('ls')) return {code:0,stdout:${JSON.stringify(listing)}};
   console.log('MUTATION ' + JSON.stringify(args)); return {code:0};
  }
 };
 await import(original);`;
 return spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, 'bin/gentle-shell.mjs', ...args], {encoding:'utf8'});
}

for (const scenario of ['owned','adjacent','separate']) test(`public linked-store update succeeds for ${scenario}`, () => {
 const result = launch(['update'], scenario);
 assert.equal(result.status, 0, result.stderr);
 assert.match(result.stdout, scenario === 'adjacent' ? /MUTATION \["add","-g","gentle-pi@4\.1\.0","--allow-build=gentle-pi"\]/ : /MUTATION \["add","-g","@earendil-works\/pi-coding-agent@latest"\]/);
 assert.doesNotMatch(result.stdout, /FORWARD/);
 // The fake manager changes nothing, so the readback reports the same version and pnpm's release-age rule.
 assert.match(result.stdout, /the selected Pi is still 1\.2\.0\./);
 assert.match(result.stdout, /minimumReleaseAge/);
 assert.equal(result.stderr, '');
});

test('public all updates only its owner and then forwards extension updates', () => {
 const result = launch(['update', '--all']);
 assert.equal(result.status, 0, result.stderr);
 assert.match(result.stdout, /MUTATION .*add.*@earendil-works\/pi-coding-agent@latest/);
 assert.match(result.stdout, /FORWARD \["update","--extensions"\]/);
 assert.equal(result.stderr, '');
});

for (const scenario of ['ambiguous', 'malformed', 'npm-link', 'npm-file', 'shared', 'adjacent-shared']) test(`public update rejects ${scenario} ownership without mutation`, () => {
 const result = launch(['update'], scenario);
 assert.equal(result.status, 1, result.stdout);
 assert.equal(result.stdout, '');
 assert.match(result.stderr, /ownership/);
 assert.doesNotMatch(result.stdout + result.stderr, /MUTATION/);
});

test('public extensions-only update preserves the forwarded command', () => {
 const result = launch(['update', '--extensions-only']);
 assert.equal(result.status, 0, result.stderr);
 assert.equal(result.stdout, 'FORWARD ["update","--extensions-only"]\n');
 assert.equal(result.stderr, '');
});
