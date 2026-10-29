import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const PI = '@earendil-works/pi-coding-agent';
// A virtual symlink filesystem: listed global links point into a pnpm store.
// The store's adjacent peer is a sibling, not Shell/node_modules/Pi.
function launch(args: string[], scenario = 'owned', piVersion = '1.2.0') {
 const source = scenario === 'source';
 const adjacent = source || scenario.startsWith('adjacent');
 const npm = source || scenario.startsWith('npm-');
 const nodeModules = '/global/v11/selected/node_modules';
 const shellRoot = '/store/shell-peer/node_modules/gentle-pi';
 const piRoot = adjacent ? '/store/shell-peer/node_modules/' + PI : '/store/pi/node_modules/' + PI;
 const target = adjacent ? 'gentle-pi' : PI;
 const dependencies: Record<string, object> = {[target]:{path: `${nodeModules}/${target}`,
  ...(scenario === 'npm-link' ? {link:true} : {}),
  ...(scenario === 'npm-file' || source ? {resolved:'file:/source/pi'} : {})}};
 if (scenario.endsWith('shared')) dependencies['unrelated'] = {path:`${nodeModules}/unrelated`};
 if (scenario === 'separate') dependencies['unrelated'] = {path:'/global/v11/other/node_modules/unrelated'};
 const groups = [{path:'/global/v11',dependencies}, ...(scenario === 'ambiguous' ? [{path:'/global/other',dependencies}] : [])];
 const listing = scenario === 'malformed' ? '{' : JSON.stringify(npm ? groups[0] : groups);
 // pnpm links only the top-level package into the global group; the peer
 // is reachable solely as the Shell package's store sibling.
 const links = {[`${nodeModules}/${target}`]:adjacent ? shellRoot : piRoot};
 if (source) {
  links[`${shellRoot}/node_modules/${PI}`] = piRoot;
  links[`${shellRoot}/node_modules/${PI}/dist/bundle/cli.js`] = `${piRoot}/dist/bundle/cli.js`;
 }
 const roots = [nodeModules, '/global/v11/other/node_modules', shellRoot, piRoot, `${piRoot}/dist/bundle/cli.js`, `${shellRoot}/.git`, `${shellRoot}/package.json`, `${shellRoot}/package-lock.json`];
 const bootstrap = `import { registerHooks } from 'node:module';
 const original = ${JSON.stringify(new URL('../bin/gentle-shell.mjs', import.meta.url).href)};
 registerHooks({load(url, context, next) {
  if (url === original) {
   let source = next(url, context).source.toString();
   source = source.replace('const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));', ${JSON.stringify(`const packageRoot = '${shellRoot}';`)});
   source = source.replace('const bundled = resolveBundledInstall({ packageRoot, platform: process.platform, fs: bundledFs, verifying });', 'const bundled = undefined;');
   source = source.replace('runtime = resolvePiRuntime({', ${JSON.stringify(`runtime = ({ kind: '${adjacent ? 'bundled' : 'env'}', command: '${adjacent ? 'node' : piRoot + '/dist/bundle/cli.js'}', args: ${JSON.stringify(adjacent ? [piRoot + '/dist/bundle/cli.js'] : [])} }); /*`)}).replace('nodeExecPath: process.execPath,\\n\\t\\t});', 'nodeExecPath: process.execPath, */');
   source = source.replace('const versionProbe = spawnSync(versionProbePlan.command, versionProbePlan.args, {', 'const versionProbe = { stdout: "${piVersion}" }; /*').replace('env: bundledEnv ?? process.env,\\n\\t});', 'env: bundledEnv ?? process.env, */');
   source = source.replace('async function packageManagerAdapters() {', 'async function packageManagerAdapters() { return globalThis.fakeAdapters; } async function unusedAdapters() {');
   source = source.replace('let homeHadContentBeforeBootstrap = false;', 'if (passthrough.length === 1) { console.error("error: pi cannot self-update this installation. This installation is not managed by a global pnpm install."); process.exitCode = 1; return; } console.log("FORWARD " + JSON.stringify(passthrough)); return; let homeHadContentBeforeBootstrap = false;');
   return {format:'module', source, shortCircuit:true};
  }
  return next(url,context);
 }});
 const links = ${JSON.stringify(links)}, roots = ${JSON.stringify(roots)};
 globalThis.fakeAdapters = {
  fs: { realpath: async p => { if (links[p]) return links[p]; if (roots.includes(p)) return p; throw Object.assign(new Error('ENOENT ' + p), {code:'ENOENT'}); },
   readFile: async p => { if (p === '${shellRoot}/package.json') return JSON.stringify({name:'gentle-pi',version:'4.1.0', ...(${source} ? {packageManager:'npm@11.1.1',devDependencies:{'${PI}':'^1.2.0'}} : {})}); if(p === '${piRoot}/package.json') return JSON.stringify({name:'${PI}',version:'1.2.0',bin:{pi:'dist/bundle/cli.js'}}); if (${source} && p === '${shellRoot}/package-lock.json') return '{}'; throw Object.assign(new Error('ENOENT ' + p), {code:'ENOENT'}); } },
  which: async n => n === '${npm ? 'npm' : 'pnpm'}' ? '/fake/' + n : null,
  run: async (cmd, args, options) => {
   if(args.includes('list') || args.includes('ls')) return {code:0,stdout:${JSON.stringify(listing)}};
   if(args.includes('--version')) return {code:0,stdout:'11.1.1'};
   console.log('MUTATION ' + JSON.stringify(args)); if (${source}) console.log('CWD ' + options.cwd); return {code:0};
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

for (const all of [false, true]) test(`public source-linked update uses the checkout and preserves extension forwarding (all: ${all})`, () => {
 const result = launch(all ? ['update', '--all'] : ['update'], 'source');
 assert.equal(result.status, 0, result.stderr);
 assert.equal(result.stderr, '');
 assert.match(result.stdout, /MUTATION \["update","@earendil-works\/pi-coding-agent","--no-save","--ignore-scripts","--global=false","--prefix","\/store\/shell-peer\/node_modules\/gentle-pi","--workspaces=false","--no-audit","--no-fund"\]/);
 assert.match(result.stdout, /CWD \/store\/shell-peer\/node_modules\/gentle-pi/);
 assert.doesNotMatch(result.stdout, /"-g"|@latest/);
 assert.equal(result.stdout.includes('FORWARD ["update","--extensions"]'), all);
});

test('source-linked --latest preserves the ordinary local, range-respecting plan', () => {
 const normal = launch(['update'], 'source');
 const latest = launch(['update', '--latest'], 'source');
 assert.equal(latest.status, 0, latest.stderr);
 assert.deepEqual({status:latest.status, stdout:latest.stdout, stderr:latest.stderr}, {status:normal.status, stdout:normal.stdout, stderr:normal.stderr});
 assert.doesNotMatch(latest.stdout, /"--latest"|"-g"|@latest/);
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

// `update` is how an old Pi gets replaced, so the minimum-version gate must not block it.
test('public update replaces a Pi older than the required minimum', () => {
 const result = launch(['update'], 'owned', '1.1.0');
 assert.equal(result.status, 0, result.stderr);
 assert.match(result.stdout, /MUTATION \["add","-g","@earendil-works\/pi-coding-agent@latest"\]/);
 assert.doesNotMatch(result.stdout + result.stderr, /older than the required minimum/);
 assert.equal(result.stderr, '');
});

test('an old Pi still fails the minimum-version gate outside a self update', () => {
 for (const args of [['list'], ['update', '--extensions-only']]) {
  const result = launch(args, 'owned', '1.1.0');
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /pi version 1\.1\.0 is older than the required minimum 1\.2\.0\./);
  assert.doesNotMatch(result.stdout, /MUTATION/);
 }
});

test('public extensions-only update preserves the forwarded command', () => {
 const result = launch(['update', '--extensions-only']);
 assert.equal(result.status, 0, result.stderr);
 assert.equal(result.stdout, 'FORWARD ["update","--extensions-only"]\n');
 assert.equal(result.stderr, '');
});
