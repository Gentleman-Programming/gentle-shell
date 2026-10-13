import { test } from 'node:test';
import assert from 'node:assert/strict';
import { managedUpdatePlan, updateSelectedPi } from '../scripts/pi-update.mjs';
import { bundledUpdatePlan, bundledUpdateNext } from '../runtime/gentle-shell-bundled.mjs';

const PI = '@earendil-works/pi-coding-agent';
const CLI = 'dist/bundle/cli.js';

// The layouts pnpm v11 and npm really produce. pnpm links each top-level
// package from its own global group into the linked store, where Shell's
// peer is a sibling of the Shell package; a separate global Pi links to the
// same store entry. npm nests the peer under the Shell package.
function fixture({windows = false, npm = false, runtime = 'adjacent', groups = 'both', peerAfter = '1.2.0', shellVersion = '4.1.0',
 badManifest = false, failed = false, mismatch = false, linked = false, readback = true, unrelatedPeer = false, shim = ''} = {}) {
 const base = windows ? 'C:/pnpm' : '/pnpm';
 const storePi = (version: string) => `${base}/store/links/@earendil-works/pi-coding-agent/${version}/h/node_modules/${PI}`;
 const shellModules = npm ? `${base}/npm/lib/node_modules` : `${base}/store/links/@/gentle-pi/4.1.0/h1/node_modules`;
 const shell = `${shellModules}/gentle-pi`;
 const nestedPeer = `${shell}/node_modules/${PI}`;
 const g1 = npm ? shellModules : `${base}/global/v11/g1/node_modules`;
 const g2 = npm ? shellModules : `${base}/global/v11/g2/node_modules`;
 const g3 = `${base}/global/v11/g3/node_modules`;
 const state = {peer: '1.1.0', group: '1.1.0'};
 const peerRoot = () => npm ? nestedPeer : storePi(state.peer);
 const selectedCli = `${npm ? (runtime === 'adjacent' ? nestedPeer : `${shellModules}/${PI}`) : storePi('1.1.0')}/${CLI}`;
 // A package-manager shim on PATH: its text names the global Pi group's cli.js.
 const shimFile = `${base}/bin/pi${windows ? '.CMD' : ''}`;
 const shimText = shim === 'posix' ? `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node  "$basedir/../global/v11/g2/node_modules/${PI}/${CLI}" "$@"\n`
  : shim === 'windows' ? `@"%~dp0\\..\\global\\v11\\g2\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r\n`
  : shim === 'two' ? `"$basedir/../a/dist/bundle/cli.js" "$basedir/../b/dist/bundle/cli.js"` : shim === 'none' ? '#!/bin/sh\nexec something\n' : '';
 const mutations: string[][] = [];
 const out: string[] = [];
 const cwds: unknown[] = [];
 const entry = (pkg: string, modules: string, extra = {}) => ({[pkg]: {path: `${modules}/${pkg}`, ...extra}});
 const shellEntry = entry('gentle-pi', g1, linked ? {link: true} : {});
 const piEntry = entry(PI, g2, linked ? {resolved: 'file:/src/pi'} : {});
 const listing = () => {
  const deps = {...(groups !== 'pi' ? shellEntry : {}), ...(groups !== 'shell' ? piEntry : {}),
   ...(groups === 'shared' ? entry('unrelated-tool', g1) : {}), ...(groups === 'separate' ? entry('unrelated-tool', g3) : {})};
  const group = {path: npm ? shellModules : `${base}/global/v11`, dependencies: deps};
  return npm ? group : [group];
 };
 const exists = (n: string) => [g1, g2, g3, shellModules, shell, storePi(state.peer), storePi(state.group), storePi('1.1.0'), nestedPeer]
  .some(root => n === root || n.startsWith(root + '/'));
 const realpath = async (value: string) => {
  const n = value.replaceAll('\\', '/');
  if (n === shimFile) return n;
  // Symlinked components inside a longer path resolve like the real filesystem does.
  if (n.startsWith(`${g2}/${PI}/`)) return (npm ? `${g2}/${PI}` : storePi(state.group)) + n.slice(`${g2}/${PI}`.length);
  if (n === `${g1}/gentle-pi` || n === `${g1}/unrelated-tool` || n === `${g3}/unrelated-tool`) return n === `${g1}/gentle-pi` ? shell : n;
  if (n === `${g2}/${PI}`) return npm ? n : storePi(state.group);
  if (!npm && n === `${shellModules}/${PI}`) return storePi(state.peer);
  if (!npm && n === nestedPeer) throw new Error('ENOENT nested peer');
  // Only joined (backslash) paths mismatch: the selected CLI itself stays canonical.
  if (mismatch && n.endsWith(CLI) && value.includes('\\')) return `${base}/other/cli.js`;
  if (exists(n)) return n;
  throw new Error(`ENOENT ${n}`);
 };
 const readFile = async (value: string) => {
  const n = value.replaceAll('\\', '/');
  if (n === shimFile) return shimText;
  if (n === `${shell}/package.json`) return JSON.stringify({name: 'gentle-pi', ...(shellVersion ? {version: shellVersion} : {})});
  if (n === `${g1}/unrelated-tool/package.json`) return JSON.stringify({name: 'unrelated-tool'});
  const version = n.startsWith(nestedPeer) ? state.peer : /pi-coding-agent\/([\d.]+)\/h\//.exec(n)?.[1];
  if (badManifest || unrelatedPeer) return JSON.stringify({name: unrelatedPeer ? 'other' : PI, version});
  return JSON.stringify({name: PI, version, bin: {pi: CLI}});
 };
 const run = async (_command: string, args: string[], options?: {cwd?: unknown}) => {
  cwds.push(options?.cwd);
  if (args.includes('list') || args.includes('ls')) return {code: failed ? 1 : 0, stdout: readback || mutations.length === 0 ? JSON.stringify(listing()) : '{'};
  mutations.push(args);
  if (args.some(arg => arg.startsWith('gentle-pi@'))) state.peer = peerAfter;
  if (args.some(arg => arg.startsWith(PI + '@'))) state.group = peerAfter;
  return {code: 0};
 };
 return {mutations, out, cwds, state, shell, selectedCli, input: {platform: windows ? 'win32' : 'linux', packageRoot: `${g1}/gentle-pi`, currentVersion: '1.1.0', cwd: '/neutral',
  runtime: runtime === 'adjacent' ? {kind: 'bundled', command: 'node', args: [selectedCli]} : {kind: runtime, command: shim ? shimFile : selectedCli, args: []},
  out: (line: string) => out.push(line),
  adapters: {which: async (name: string) => name === (npm ? 'npm' : 'pnpm') ? `/fake/${name}` : null, fs: {realpath, readFile}, run}}};
}

test('prefix distribution still redirects self update and forwards only extensions for all', () => {
 assert.deepEqual(bundledUpdatePlan(['update']), {self: true});
 assert.deepEqual(bundledUpdateNext(bundledUpdatePlan(['update']), 0), {exitCode: 0});
 assert.deepEqual(bundledUpdatePlan(['update', '--all']), {self: true, piArgs: ['update', '--extensions']});
 assert.deepEqual(bundledUpdatePlan(['update', '--extensions-only']), {self: false, piArgs: ['update', '--extensions-only']});
});

for (const args of [['update', '--extensions-only'], ['update', '--extensions'], ['update', 'npm:custom'], ['update', '--models'], ['update', '--help'], ['update', '--unknown']]) test(`no ownership interception for ${args.join(' ')}`, () => {
 assert.deepEqual(managedUpdatePlan(args), {self: false, piArgs: args});
});

test('all strips only self update before forwarding extension flags', () => {
 assert.deepEqual(managedUpdatePlan(['update', '--all', '--approve']), {self: true, piArgs: ['update', '--extensions', '--approve']});
});

for (const windows of [false, true]) test(`an adjacent peer is refreshed by reinstalling its Shell package at the same version, never the separate global Pi (windows: ${windows})`, async () => {
 const f = fixture({windows});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.mutations, [['add', '-g', 'gentle-pi@4.1.0', '--allow-build=gentle-pi']]);
 assert.deepEqual(f.out, ['pnpm installed gentle-pi@4.1.0; the selected Pi is now 1.2.0 (was 1.1.0).']);
 assert.equal(f.state.group, '1.1.0');
});

for (const runtime of ['path', 'env']) test(`a ${runtime} runtime sharing the store entry is updated through its own global Pi package`, async () => {
 const f = fixture({runtime});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.mutations, [['add', '-g', `${PI}@latest`]]);
 assert.deepEqual(f.out, [`pnpm installed ${PI}@latest; the selected Pi is now 1.2.0 (was 1.1.0).`]);
 assert.equal(f.state.peer, '1.1.0');
});

test('npm nests the peer under Shell and reinstalls Shell for it', async () => {
 const f = fixture({npm: true});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.mutations, [['install', '-g', 'gentle-pi@4.1.0']]);
 assert.deepEqual(f.out, ['npm installed gentle-pi@4.1.0; the selected Pi is now 1.2.0 (was 1.1.0).']);
});

test('an npm PATH runtime updates the global Pi without its scripts', async () => {
 const f = fixture({npm: true, runtime: 'path'});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.mutations, [['install', '-g', `${PI}@latest`, '--ignore-scripts']]);
});

test('an unchanged pnpm result names the minimum-release-age rule instead of claiming latest', async () => {
 const f = fixture({peerAfter: '1.1.0'});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.equal(f.out[0], 'pnpm installed gentle-pi@4.1.0, and the selected Pi is still 1.1.0.');
 assert.match(f.out[1], /minimumReleaseAge/);
 assert.equal(f.out.length, 2);
});

test('every package manager call runs from the neutral directory, never the project cwd', async () => {
 const f = fixture();
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.cwds, ['/neutral', '/neutral', '/neutral']);
});

test('an unreadable readback is reported, not invented', async () => {
 const f = fixture({readback: false});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.out, ['pnpm installed gentle-pi@4.1.0. The Pi version it now supplies could not be read back; run \'gentle-shell --version\' to check it.']);
});

test('separate aggregated groups do not block the Shell reinstall', async () => {
 const f = fixture({groups: 'separate'});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.mutations, [['add', '-g', 'gentle-pi@4.1.0', '--allow-build=gentle-pi']]);
});

for (const [name, options] of Object.entries({
 'listing failed': {failed: true},
 'peer identity differs': {badManifest: true},
 'peer package is not Pi': {unrelatedPeer: true},
 'selected CLI mismatches on Windows': {windows: true, mismatch: true},
 'linked or file suppliers': {linked: true},
 'Shell shares its global group': {groups: 'shared'},
 'Shell version is missing': {shellVersion: ''},
 'only a separate global Pi is listed for an adjacent runtime': {groups: 'pi'},
 'only Shell is listed for a PATH runtime': {runtime: 'path', groups: 'shell'},
})) test(`ownership rejects without mutation when ${name}`, async () => {
 const f = fixture(options);
 await assert.rejects(updateSelectedPi(f.input), /ownership/);
 assert.deepEqual(f.mutations, []);
 assert.deepEqual(f.out, []);
});

for (const [name, options] of Object.entries({'pnpm POSIX shim': {shim: 'posix', runtime: 'path'}, 'Windows .CMD shim': {shim: 'windows', runtime: 'path', windows: true}, 'GENTLE_SHELL_PI shim override': {shim: 'posix', runtime: 'env'}})) test(`a ${name} resolves to the global Pi it runs`, async () => {
 const f = fixture(options);
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.mutations, [['add', '-g', `${PI}@latest`]]);
});

for (const [name, shim] of Object.entries({'names several targets': 'two', 'is not a Pi entry': 'none'})) test(`a shim that ${name} is refused without mutation`, async () => {
 const f = fixture({shim, runtime: 'path'});
 await assert.rejects(updateSelectedPi(f.input), /ownership/);
 assert.deepEqual(f.mutations, []);
});

test('an unrelated selected override cannot authorize the adjacent Shell group', async () => {
 const f = fixture();
 f.input.runtime = {kind: 'env', command: '/unrelated/pi', args: []};
 await assert.rejects(updateSelectedPi(f.input), /ownership/);
 assert.deepEqual(f.mutations, []);
});
