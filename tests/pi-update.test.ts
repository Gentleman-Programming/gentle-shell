import { test } from 'node:test';
import assert from 'node:assert/strict';
import { managedUpdatePlan, updateSelectedPi } from '../scripts/pi-update.mjs';
import { bundledUpdatePlan, bundledUpdateNext } from '../runtime/gentle-shell-bundled.mjs';

const PI = '@earendil-works/pi-coding-agent';
const CLI = 'dist/bundle/cli.js';
const AGE = ['--config.minimum-release-age-exclude=existing-fixture', `--config.minimum-release-age-exclude=${PI}`];

// The layouts pnpm v11 and npm really produce. pnpm links each top-level
// package from its own global group into the linked store, where Shell's
// peer is a sibling of the Shell package; a separate global Pi links to the
// same store entry. npm nests the peer under the Shell package.
function fixture({windows = false, npm = false, runtime = 'adjacent', groups = 'both', peerAfter = '1.2.0', shellVersion = '4.1.0',
 badManifest = false, failed = false, mismatch = false, linked = false, readback = true, unrelatedPeer = false, shim = '',
 artifact = true, configHome = '', latest = '1.2.0', installFailure = undefined as undefined | {stdout?: string, stderrTail?: string},
 piDependencies = {} as Record<string, unknown>, manifestView = undefined as undefined | {code: number, stdout: string},
 siblingDependencies = {} as Record<string, Record<string, unknown> | null>, excludeOutput = '["existing-fixture"]\n'} = {}) {
 const base = windows ? 'C:/pnpm' : '/pnpm';
 const home = windows ? 'C:/Users/u' : '/home/u';
 // The tarball `gentle-shell upgrade --channel main` packs, named after its version.
 const tarball = `${configHome || `${home}/.pi/gentle-ai`}/main/packages/gentle-pi-${shellVersion}.tgz`;
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
 const probes: string[][] = [];
 const out: string[] = [];
 const cwds: unknown[] = [];
 const runOptions: unknown[] = [];
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
  .some(root => n === root || n.startsWith(root + '/')) || (artifact && n === tarball);
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
  const version = n.startsWith(nestedPeer) ? state.peer : npm && n === `${g2}/${PI}/package.json` ? state.group : /pi-coding-agent\/([\d.]+)\/h\//.exec(n)?.[1];
  if (badManifest || unrelatedPeer) return JSON.stringify({name: unrelatedPeer ? 'other' : PI, version});
  return JSON.stringify({name: PI, version, bin: {pi: CLI}});
 };
 const run = async (_command: string, args: string[], options?: {cwd?: unknown}) => {
  cwds.push(options?.cwd);
  if (args.includes('list') || args.includes('ls')) return {code: failed ? 1 : 0, stdout: readback || mutations.length === 0 ? JSON.stringify(listing()) : '{'};
  if (args.includes('view')) {
   probes.push(args);
   // `view <Pi>@<version> --json` reads the selected version's published manifest.
   // A Pi-scope sibling resolves from siblingDependencies (null: the lookup fails).
   const spec = args[args.indexOf('view') + 1], at = spec.lastIndexOf('@');
   if (args.includes('--json') && spec.slice(0, at) !== PI) return siblingDependencies[spec] === null ? {code: 1, stdout: ''}
    : {code: 0, stdout: JSON.stringify({name: spec.slice(0, at), version: spec.slice(at + 1), dependencies: siblingDependencies[spec] ?? {}})};
   if (args.includes('--json')) return manifestView ?? {code: 0, stdout: JSON.stringify({name: PI, version: latest, dependencies: piDependencies})};
   return {code: 0, stdout: `${latest}\n`};
  }
  if (args.includes('config')) { probes.push(args); return {code: 0, stdout: excludeOutput}; }
  mutations.push(args);
  runOptions.push(options);
  if (installFailure) return {code: 1, stdout: installFailure.stdout ?? '', ...('stderrTail' in installFailure ? {stderrTail: installFailure.stderrTail} : {})};
  if (args.some(arg => arg.startsWith('gentle-pi@') || arg.endsWith('.tgz'))) state.peer = peerAfter;
  if (args.some(arg => arg.startsWith(PI + '@'))) state.group = peerAfter;
  return {code: 0};
 };
 return {mutations, probes, out, cwds, runOptions, state, shell, selectedCli, tarball, input: {platform: windows ? 'win32' : 'linux', packageRoot: `${g1}/gentle-pi`, currentVersion: '1.1.0', cwd: '/neutral',
  home, env: configHome ? {GENTLE_PI_CONFIG_HOME: configHome} : {},
  runtime: runtime === 'adjacent' ? {kind: 'bundled', command: 'node', args: [selectedCli]} : {kind: runtime, command: shim ? shimFile : selectedCli, args: []},
  out: (line: string) => out.push(line),
  adapters: {which: async (name: string) => name === (npm ? 'npm' : 'pnpm') ? `/fake/${name}` : null, fs: {realpath, readFile}, run}}};
}

// pnpm's listing has a stable aggregate path, while each dependency's global
// group and linked store root may both change. A second row models a decoy.
function supplierFixture({shell = false, decoyVersion = '1.0.0', selectedAfter = '2.0.0', shellVersion = '4.1.0',
 replaceGroup = false, withDecoy = true, post = 'normal'} = {}) {
 const pkg = shell ? 'gentle-pi' : PI;
 const state = {decoy:decoyVersion, selected:'1.0.0'};
 type Side = keyof typeof state;
 let updated = false;
 const group = (side: Side) => `/global/v11/${side}${side === 'selected' && updated && replaceGroup ? '-new' : ''}/node_modules`;
 const link = (side: Side) => `${group(side)}/${pkg}`;
 const shellModules = (side: Side) => `/store/${side}/shell/${shellVersion}/peer-${state[side]}/node_modules`;
 const shellRoot = (side: Side) => `${shellModules(side)}/gentle-pi`;
 const piRoot = (side: Side) => shell ? `${shellModules(side)}/${PI}` : `/store/${side}/pi/${state[side]}/node_modules/${PI}`;
 const sides: Side[] = withDecoy ? ['decoy', 'selected'] : ['selected'];
 const tarball = `/home/u/.pi/gentle-ai/main/packages/gentle-pi-${shellVersion}.tgz`;
 const data = {policy:'minimumReleaseAge: 4320', unrelated:'do not change', artifact:'original tarball bytes'};
 const listing = () => {
  const rows = sides.map(side => ({path:updated && side === 'selected' && post === 'foreign-listing' ? '/foreign/v11' : '/global/v11', private:true,
   dependencies:{[pkg]:{from:updated && side === 'selected' && post === 'wrong-from' ? 'other' : pkg,
    version:shell ? updated && side === 'selected' && post === 'wrong-shell' ? '9.0.0' : shellVersion : state[side], path:link(side)}}}));
  if (updated && post === 'multiple') rows.push({path:'/global/v11', private:true,
   dependencies:{[pkg]:{from:pkg, version:shell ? shellVersion : '2.0.0', path:`/global/v11/extra/node_modules/${pkg}`}}});
  if (updated && post === 'duplicate') rows.push(rows[rows.length - 1]);
  if (updated && post === 'membership') Object.assign(rows[0].dependencies, {'other-tool':{path:`${group('decoy')}/other-tool`}});
  if (updated && post === 'listed-version') rows[rows.length - 1].dependencies[pkg].version = '9.0.0';
  return rows;
 };
 const mutations: string[][] = [];
 const out: string[] = [];
 const realpath = async (value: string) => {
  for (const side of sides) {
   if (value === link(side)) return shell ? shellRoot(side) : piRoot(side);
   if ([group(side), shellRoot(side), piRoot(side), `${piRoot(side)}/${CLI}`].includes(value)) return value;
  }
  if (value === '/launcher' || value === tarball || (updated && value === '/global/v11/extra/node_modules')) return value;
  throw Object.assign(new Error(`ENOENT ${value}`), {code:'ENOENT'});
 };
 const readFile = async (value: string) => {
  if (value === tarball) return data.artifact;
  for (const side of sides) {
   if (value === `${shellRoot(side)}/package.json`) return JSON.stringify({name:'gentle-pi', version:updated && side === 'selected' && post === 'wrong-shell' ? '9.0.0' : shellVersion});
   if (value === `${piRoot(side)}/package.json`) return JSON.stringify({name:updated && side === 'selected' && post === 'wrong-pi' ? 'other' : PI, version:state[side], bin:{pi:updated && side === 'selected' && post === 'wrong-bin' ? 'other.js' : CLI}});
  }
  throw Object.assign(new Error(`ENOENT ${value}`), {code:'ENOENT'});
 };
 const run = async (_command: string, args: string[]) => {
  if (args.includes('list')) return {code:0, stdout:JSON.stringify(listing())};
  if (args.includes('view')) return {code:0, stdout:args.includes('--json') ? JSON.stringify({name:PI, version:'2.0.0'}) : '2.0.0\n'};
  if (args.includes('config')) return {code:0, stdout:'["existing-fixture"]\n'};
  mutations.push(args);
  state.selected = selectedAfter;
  updated = true;
  return {code:0};
 };
 return {state, data, mutations, out, group, piRoot, shellRoot, tarball, input:{platform:'linux', packageRoot:shell ? link('selected') : '/launcher', currentVersion:'1.0.0', cwd:'/neutral', home:'/home/u', env:{},
  runtime:shell ? {kind:'bundled', command:'node', args:[`${piRoot('selected')}/${CLI}`]} : {kind:'path', command:`${piRoot('selected')}/${CLI}`, args:[]},
  out:(line: string) => out.push(line), adapters:{which:async (name: string) => name === 'pnpm' ? '/fake/pnpm' : null, fs:{realpath, readFile}, run}}};
}

// Match the launcher's success/throw handling while exercising updateSelectedPi.
async function captureUpdate(input: Parameters<typeof updateSelectedPi>[0], out: string[]) {
 let exitCode, stderr = '';
 try { exitCode = await updateSelectedPi(input); }
 catch (error) { exitCode = 1; stderr = `${error instanceof Error ? error.message : String(error)}\n`; }
 return {exitCode, stdout:out.map(line => `${line}\n`).join(''), stderr};
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

test('a non-bundled install ignores --latest: its managed self update already installs the latest Pi', () => {
 assert.deepEqual(managedUpdatePlan(['update', '--latest']), {self: true});
 assert.deepEqual(managedUpdatePlan(['update', '--all', '--latest']), {self: true, piArgs: ['update', '--extensions']});
});

test('all strips only self update before forwarding extension flags', () => {
 assert.deepEqual(managedUpdatePlan(['update', '--all', '--approve']), {self: true, piArgs: ['update', '--extensions', '--approve']});
});

for (const [name, options] of Object.entries({'pnpm global Pi': {runtime:'path'}, 'pnpm adjacent peer': {}, 'npm global Pi': {npm:true, runtime:'path'}, 'npm adjacent peer': {npm:true}})) test(`${name} resolves the stable latest tag before its owned update`, async () => {
 const f = fixture(options);
 assert.equal(await updateSelectedPi(f.input), 0);
 const view = f.probes.find(args => args.includes('view'));
 assert.ok(view?.includes(`${PI}@latest`));
 if (!options.npm) assert.ok(view?.includes('--config.global=true'));
 assert.equal(f.mutations.length, 1);
 assert.equal(f.out.length, 1);
 assert.match(f.out[0], /the selected Pi is now 1\.2\.0/);
});

test('global pnpm keeps existing release-age exclusions and excludes only Pi additionally', async () => {
 const f = fixture({runtime:'path'});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.ok(f.probes.some(args => args.includes('config') && args.includes('minimumReleaseAgeExclude')));
 assert.ok(f.mutations[0].includes('--config.minimum-release-age-exclude=existing-fixture'));
 assert.ok(f.mutations[0].includes(`--config.minimum-release-age-exclude=${PI}`));
 assert.ok(!f.mutations[0].some(arg => /^--(?:config\.)?minimum-release-age=/.test(arg)));
});

for (const npm of [false, true]) test(`global ${npm ? 'npm' : 'pnpm'} refuses a nonstable latest tag without mutation`, async () => {
 const f = fixture({npm, latest:'1.3.0-rc.1'});
 await assert.rejects(updateSelectedPi(f.input), /latest published Pi.*rejected/);
 assert.deepEqual(f.mutations, []);
 assert.deepEqual(f.out, []);
});

for (const windows of [false, true]) test(`an adjacent peer is refreshed by reinstalling its Shell package at the same version, never the separate global Pi (windows: ${windows})`, async () => {
 const f = fixture({windows});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.mutations, [['add', '-g', 'gentle-pi@4.1.0', '--allow-build=gentle-pi', ...AGE]]);
 assert.deepEqual(f.out, ['pnpm installed gentle-pi@4.1.0; the selected Pi is now 1.2.0 (was 1.1.0).']);
 assert.equal(f.state.group, '1.1.0');
});

for (const runtime of ['path', 'env']) test(`a ${runtime} runtime sharing the store entry is updated through its own global Pi package`, async () => {
 const f = fixture({runtime});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.mutations, [['add', '-g', `${PI}@1.2.0`, ...AGE]]);
 assert.deepEqual(f.out, [`pnpm installed ${PI}@1.2.0; the selected Pi is now 1.2.0 (was 1.1.0).`]);
 assert.equal(f.state.peer, '1.1.0');
});

for (const shell of [false, true]) test(`same global supplier is read back after updating ${shell ? 'a Shell peer' : 'Pi directly'}`, async () => {
 const f = supplierFixture({shell});
 const decoyBefore = await f.input.adapters.fs.readFile(`${f.piRoot('decoy')}/package.json`);
 const selectedRoot = shell ? f.shellRoot('selected') : f.piRoot('selected');
 const result = await captureUpdate(f.input, f.out);
 const spec = shell ? 'gentle-pi@4.1.0' : `${PI}@2.0.0`;
 assert.deepEqual(f.mutations, [['add', '-g', spec, ...(shell ? ['--allow-build=gentle-pi'] : []), ...AGE]]);
 assert.deepEqual(f.state, {decoy:'1.0.0', selected:'2.0.0'});
 assert.equal(await f.input.adapters.fs.readFile(`${f.piRoot('decoy')}/package.json`), decoyBefore);
 assert.notEqual(shell ? f.shellRoot('selected') : f.piRoot('selected'), selectedRoot);
 assert.deepEqual(result, {exitCode:0, stdout:`pnpm installed ${spec}; the selected Pi is now 2.0.0 (was 1.0.0).\n`, stderr:''});
});

test('same global supplier still rejects a stale selected Pi when the decoy already has latest', async () => {
 const f = supplierFixture({decoyVersion:'2.0.0', selectedAfter:'1.0.0'});
 const decoyBefore = await f.input.adapters.fs.readFile(`${f.piRoot('decoy')}/package.json`);
 const result = await captureUpdate(f.input, f.out);
 assert.deepEqual(f.mutations, [['add', '-g', `${PI}@2.0.0`, ...AGE]]);
 assert.deepEqual(f.state, {decoy:'2.0.0', selected:'1.0.0'});
 assert.equal(await f.input.adapters.fs.readFile(`${f.piRoot('decoy')}/package.json`), decoyBefore);
 assert.deepEqual(result, {exitCode:1, stdout:'', stderr:'gentle-shell update: pnpm supplied Pi 1.0.0, not the latest published Pi 2.0.0; inspect the installation before retrying.\n'});
});

test('a single global Pi supplier still reports its new version after its store path changes', async () => {
 const f = fixture({runtime:'path'});
 const link = `/pnpm/global/v11/g2/node_modules/${PI}`;
 const oldRoot = await f.input.adapters.fs.realpath(link);
 const result = await captureUpdate(f.input, f.out);
 assert.deepEqual(f.mutations, [['add', '-g', `${PI}@1.2.0`, ...AGE]]);
 assert.notEqual(await f.input.adapters.fs.realpath(link), oldRoot);
 assert.deepEqual(result, {exitCode:0, stdout:`pnpm installed ${PI}@1.2.0; the selected Pi is now 1.2.0 (was 1.1.0).\n`, stderr:''});
});

test('npm nests the peer under Shell and reinstalls Shell for it', async () => {
 const f = fixture({npm: true});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.mutations, [['install', '-g', 'gentle-pi@4.1.0']]);
 assert.deepEqual(f.out, ['npm installed gentle-pi@4.1.0; the selected Pi is now 1.2.0 (was 1.1.0).']);
});

// #2324: main-channel Shell versions are never published; only the tarball
// `gentle-shell upgrade --channel main` packed can reinstall that exact build.
const MAIN = '4.2.0-main.fb5e731119a7';
const native = (path: string, windows: boolean) => windows ? path.replaceAll('/', '\\') : path;

for (const main of [false, true]) test(`pnpm reads a replaced ${main ? 'main artifact' : 'release Shell'} group through its optional Pi peer`, async () => {
 const f = supplierFixture({shell:true, shellVersion:main ? MAIN : '4.1.0', replaceGroup:true, withDecoy:false});
 const beforeGroup = f.group('selected');
 const data = {...f.data};
 const artifact = await f.input.adapters.fs.readFile(f.tarball);
 const result = await captureUpdate(f.input, f.out);
 const spec = main ? f.tarball : 'gentle-pi@4.1.0';
 assert.notEqual(f.group('selected'), beforeGroup);
 assert.deepEqual(f.mutations, [['add', '-g', spec, '--allow-build=gentle-pi', ...AGE]]);
 assert.deepEqual(f.state, {decoy:'1.0.0', selected:'2.0.0'});
 assert.deepEqual(f.data, data);
 assert.equal(await f.input.adapters.fs.readFile(f.tarball), artifact);
 assert.deepEqual(result, {exitCode:0, stdout:`pnpm installed ${spec}; the selected Pi is now 2.0.0 (was 1.0.0).\n`, stderr:''});
});

for (const shell of [false, true]) test(`a replaced ${shell ? 'Shell peer' : 'Pi'} group follows the selected second supplier, not a decoy`, async () => {
 const f = supplierFixture({shell, replaceGroup:true});
 const beforeGroup = f.group('selected');
 const decoy = await f.input.adapters.fs.readFile(`${f.piRoot('decoy')}/package.json`);
 const data = {...f.data};
 const result = await captureUpdate(f.input, f.out);
 const spec = shell ? 'gentle-pi@4.1.0' : `${PI}@2.0.0`;
 assert.notEqual(f.group('selected'), beforeGroup);
 assert.deepEqual(f.mutations, [['add', '-g', spec, ...(shell ? ['--allow-build=gentle-pi'] : []), ...AGE]]);
 assert.deepEqual(f.state, {decoy:'1.0.0', selected:'2.0.0'});
 assert.equal(await f.input.adapters.fs.readFile(`${f.piRoot('decoy')}/package.json`), decoy);
 assert.deepEqual(f.data, data);
 assert.deepEqual(result, {exitCode:0, stdout:`pnpm installed ${spec}; the selected Pi is now 2.0.0 (was 1.0.0).\n`, stderr:''});
});

for (const shell of [false, true]) test(`a replaced ${shell ? 'Shell peer' : 'Pi'} group rejects a stale selected supplier even when a decoy is latest`, async () => {
 const f = supplierFixture({shell, replaceGroup:true, decoyVersion:'2.0.0', selectedAfter:'1.0.0'});
 const decoy = await f.input.adapters.fs.readFile(`${f.piRoot('decoy')}/package.json`);
 const data = {...f.data};
 const result = await captureUpdate(f.input, f.out);
 const spec = shell ? 'gentle-pi@4.1.0' : `${PI}@2.0.0`;
 assert.deepEqual(f.mutations, [['add', '-g', spec, ...(shell ? ['--allow-build=gentle-pi'] : []), ...AGE]]);
 assert.deepEqual(f.state, {decoy:'2.0.0', selected:'1.0.0'});
 assert.equal(await f.input.adapters.fs.readFile(`${f.piRoot('decoy')}/package.json`), decoy);
 assert.deepEqual(f.data, data);
 assert.deepEqual(result, {exitCode:1, stdout:'', stderr:'gentle-shell update: pnpm supplied Pi 1.0.0, not the latest published Pi 2.0.0; inspect the installation before retrying.\n'});
});

for (const [post, shell, replaceGroup] of [
 ['multiple', true, true], ['foreign-listing', true, true], ['wrong-from', true, true],
 ['wrong-shell', true, true], ['membership', true, true], ['listed-version', true, true],
 ['duplicate', true, false], ['wrong-pi', false, false], ['wrong-bin', false, false],
] as const) test(`readback remains unknown when supplier continuity is unverified: ${post}`, async () => {
 const f = supplierFixture({shell, replaceGroup, post});
 const decoy = await f.input.adapters.fs.readFile(`${f.piRoot('decoy')}/package.json`);
 const data = {...f.data};
 const result = await captureUpdate(f.input, f.out);
 const spec = shell ? 'gentle-pi@4.1.0' : `${PI}@2.0.0`;
 assert.deepEqual(f.mutations, [['add', '-g', spec, ...(shell ? ['--allow-build=gentle-pi'] : []), ...AGE]]);
 assert.deepEqual(f.state, {decoy:'1.0.0', selected:'2.0.0'});
 assert.equal(await f.input.adapters.fs.readFile(`${f.piRoot('decoy')}/package.json`), decoy);
 assert.deepEqual(f.data, data);
 assert.deepEqual(result, {exitCode:0, stdout:`pnpm installed ${spec}. The Pi version it now supplies could not be read back; run 'gentle-shell --version' to check it.\n`, stderr:''});
});

for (const windows of [false, true]) test(`a main-channel Shell is reinstalled from its recorded tarball, never from the registry (windows: ${windows})`, async () => {
 const f = fixture({windows, shellVersion: MAIN});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.mutations, [['add', '-g', native(f.tarball, windows), '--allow-build=gentle-pi', ...AGE]]);
 assert.deepEqual(f.out, [`pnpm installed ${native(f.tarball, windows)}; the selected Pi is now 1.2.0 (was 1.1.0).`]);
 assert.equal(f.state.group, '1.1.0');
});

test('npm reinstalls a main-channel Shell from its recorded tarball', async () => {
 const f = fixture({npm: true, shellVersion: MAIN});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.mutations, [['install', '-g', f.tarball]]);
});

test('a main-channel tarball is found under GENTLE_PI_CONFIG_HOME', async () => {
 const f = fixture({shellVersion: MAIN, configHome: '/custom/config'});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.mutations, [['add', '-g', '/custom/config/main/packages/gentle-pi-4.2.0-main.fb5e731119a7.tgz', '--allow-build=gentle-pi', ...AGE]]);
});

// Pi 1.5.2 pins its co-published @earendil-works packages exactly; pnpm's
// strict release-age mode cannot approve them under --no-save.
const DEPENDENCIES = {'@earendil-works/pi-ai':'1.2.0', '@earendil-works/pi-tui':'1.2.0', '@earendil-works/pi-ranged':'^1.2.0',
 '@earendil-works/pi-next':'1.3.0-rc.1', undici:'7.0.0', chalk:'^5.0.0'};
// pi-ai pins pi-schema, which pins pi-ai back: the closure follows each once.
const SIBLINGS = {'@earendil-works/pi-ai@1.2.0':{'@earendil-works/pi-schema':'1.2.0', openai:'7.19.0'}, '@earendil-works/pi-schema@1.2.0':{'@earendil-works/pi-ai':'1.2.0'}};
const SIBLING_AGE = [...AGE, ...['pi-ai@1.2.0', 'pi-tui@1.2.0', 'pi-schema@1.2.0'].map(entry => `--config.minimum-release-age-exclude=@earendil-works/${entry}`)];

for (const [name, options] of Object.entries({'global Pi': {runtime:'path'}, 'Shell peer': {}, 'main artifact': {shellVersion:MAIN}} as Record<string, {runtime?: string, shellVersion?: string}>)) test(`pnpm ${name} also exempts only the Pi-scope packages the selected Pi pins exactly`, async () => {
 const f = fixture({...options, piDependencies:DEPENDENCIES, siblingDependencies:SIBLINGS});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.probes.filter(args => args.includes('view') && args.includes('--json')),
  [PI, '@earendil-works/pi-ai', '@earendil-works/pi-tui', '@earendil-works/pi-schema'].map(name => ['view', `${name}@1.2.0`, '--json', '--config.global=true']));
 const spec = options.runtime ? `${PI}@1.2.0` : options.shellVersion ? f.tarball : 'gentle-pi@4.1.0';
 assert.deepEqual(f.mutations, [['add', '-g', spec, ...(options.runtime ? [] : ['--allow-build=gentle-pi']), ...SIBLING_AGE]]);
});

test('global pnpm merges each sibling into its configured exclusion instead of being shadowed by it', async () => {
 // pnpm applies only the first rule naming a package, so a later CLI entry
 // for an already listed name would be ignored.
 const existing = ['existing-fixture', '@earendil-works/pi-ai@1.0.0', `${PI}@1.0.0`, '@earendil-works/pi-tui', '@earendil-works/*', '@earendil-works/pi-ai@0.9.0 || 1.1.0'];
 const f = fixture({runtime:'path', piDependencies:DEPENDENCIES, siblingDependencies:SIBLINGS, excludeOutput:JSON.stringify(existing)});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.mutations[0].filter(arg => arg.startsWith('--config.minimum-release-age-exclude=')).map(arg => arg.slice(arg.indexOf('=') + 1)),
  ['existing-fixture', '@earendil-works/pi-ai@1.0.0 || 0.9.0 || 1.1.0 || 1.2.0', PI, '@earendil-works/pi-tui', '@earendil-works/*', '@earendil-works/pi-schema@1.2.0']);
});

for (const existing of ['@earendil-works/pi-ai@^1.0.0', '@earendil-works/pi-ai@1.0.0 || latest', `${PI}@`]) test(`global pnpm refuses an exclusion it cannot merge safely: ${existing}`, async () => {
 const f = fixture({runtime:'path', piDependencies:DEPENDENCIES, siblingDependencies:SIBLINGS, excludeOutput:JSON.stringify(['existing-fixture', existing])});
 const result = await captureUpdate(f.input, f.out);
 assert.deepEqual(f.mutations, []);
 assert.deepEqual(result, {exitCode:1, stdout:'', stderr:'gentle-shell update: pnpm release-age exclusions could not be verified. No installation changed.\n'});
});

test('global pnpm refuses before installing when a pinned sibling manifest cannot be read', async () => {
 const f = fixture({runtime:'path', piDependencies:DEPENDENCIES, siblingDependencies:{...SIBLINGS, '@earendil-works/pi-schema@1.2.0':null}});
 const result = await captureUpdate(f.input, f.out);
 assert.deepEqual(f.mutations, []);
 assert.deepEqual(f.state, {peer:'1.1.0', group:'1.1.0'});
 assert.deepEqual(result, {exitCode:1, stdout:'', stderr:'gentle-shell update: the published dependencies of @earendil-works/pi-schema@1.2.0 could not be verified. No installation changed.\n'});
});

test('global pnpm refuses an unbounded chain of pinned siblings without installing', async () => {
 const chain = Object.fromEntries(Array.from({length:40}, (_, i) => [`@earendil-works/pi-chain-${i}@1.2.0`, {[`@earendil-works/pi-chain-${i + 1}`]:'1.2.0'}]));
 const f = fixture({runtime:'path', piDependencies:{'@earendil-works/pi-chain-0':'1.2.0'}, siblingDependencies:chain});
 const result = await captureUpdate(f.input, f.out);
 assert.deepEqual(f.mutations, []);
 assert.equal(f.probes.filter(args => args.includes('--json')).length, 33);
 assert.deepEqual(result, {exitCode:1, stdout:'', stderr:'gentle-shell update: Pi 1.2.0 pins more than 32 @earendil-works packages; their release age could not be verified. No installation changed.\n'});
});

test('npm never reads the Pi manifest or passes pnpm release-age exclusions', async () => {
 const f = fixture({npm:true, runtime:'path', piDependencies:DEPENDENCIES});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.probes.filter(args => args.includes('--json')), []);
 assert.deepEqual(f.mutations, [['install', '-g', `${PI}@1.2.0`, '--ignore-scripts']]);
});

for (const [name, manifestView] of Object.entries({'a failed lookup': {code:1, stdout:''}, 'unparsable output': {code:0, stdout:'{'},
 'another package version': {code:0, stdout:JSON.stringify({name:PI, version:'1.1.0'})},
 'malformed dependencies': {code:0, stdout:JSON.stringify({name:PI, version:'1.2.0', dependencies:{'@earendil-works/pi-ai':1}})}})) test(`pnpm refuses before installing when the selected Pi manifest has ${name}`, async () => {
 const f = fixture({runtime:'path', manifestView});
 const result = await captureUpdate(f.input, f.out);
 assert.deepEqual(f.mutations, []);
 assert.deepEqual(f.state, {peer:'1.1.0', group:'1.1.0'});
 assert.deepEqual(result, {exitCode:1, stdout:'', stderr:'gentle-shell update: the published dependencies of Pi 1.2.0 could not be verified. No installation changed.\n'});
});

test('a missing main-channel tarball names the rebuild command and installs nothing', async () => {
 const f = fixture({shellVersion: MAIN, artifact: false});
 await assert.rejects(updateSelectedPi(f.input), {message: `gentle-shell update: the main-channel build ${f.tarball} is missing, and this unpublished build cannot be reinstalled from the registry; run 'gentle-shell upgrade --channel release' and then 'gentle-shell upgrade --channel main' to rebuild it. No installation changed.`});
 assert.deepEqual(f.mutations, []);
 assert.deepEqual(f.out, []);
});

// A relative config home names different folders for `upgrade` and `update`
// run from different directories, and npm/pnpm resolve it from the neutral cwd.
test('a relative GENTLE_PI_CONFIG_HOME is refused for a main-channel Shell without mutation', async () => {
 const f = fixture({shellVersion: MAIN, configHome: 'relative/config'});
 await assert.rejects(updateSelectedPi(f.input), /ownership cannot locate the main-channel build without an absolute config home/);
 assert.deepEqual(f.mutations, []);
 assert.deepEqual(f.out, []);
});

test('a main-channel Shell without a home directory is refused without mutation', async () => {
 const f = fixture({shellVersion: MAIN});
 delete (f.input as {home?: string}).home;
 await assert.rejects(updateSelectedPi(f.input), /ownership cannot locate the main-channel build without an absolute config home/);
 assert.deepEqual(f.mutations, []);
});

for (const runtime of ['path', 'env']) test(`a main-channel Shell never redirects the update of a selected ${runtime} Pi`, async () => {
 const f = fixture({runtime, shellVersion: MAIN, artifact: false});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.mutations, [['add', '-g', `${PI}@1.2.0`, ...AGE]]);
});

test('an npm PATH runtime updates the global Pi without its scripts', async () => {
 const f = fixture({npm: true, runtime: 'path'});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.mutations, [['install', '-g', `${PI}@1.2.0`, '--ignore-scripts']]);
});

test('an unchanged pnpm result reports the selected Pi without an obsolete release-age warning', async () => {
 const f = fixture({peerAfter: '1.1.0', latest: '1.1.0'});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.out, ['pnpm installed gentle-pi@4.1.0, and the selected Pi is still 1.1.0.']);
});

test('a manager that supplies a different Pi does not silently claim the latest update succeeded', async () => {
 const f = fixture({peerAfter:'1.1.0'});
 await assert.rejects(updateSelectedPi(f.input), /supplied Pi 1\.1\.0, not the latest published Pi 1\.2\.0/);
 assert.equal(f.mutations.length, 1);
 assert.deepEqual(f.out, []);
});

test('every package manager call runs from the neutral directory, never the project cwd', async () => {
 const f = fixture();
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.cwds, ['/neutral', '/neutral', '/neutral', '/neutral', '/neutral', '/neutral']);
});

test('an unreadable readback is reported, not invented', async () => {
 const f = fixture({readback: false});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.out, ['pnpm installed gentle-pi@4.1.0. The Pi version it now supplies could not be read back; run \'gentle-shell --version\' to check it.']);
});

test('separate aggregated groups do not block the Shell reinstall', async () => {
 const f = fixture({groups: 'separate'});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.mutations, [['add', '-g', 'gentle-pi@4.1.0', '--allow-build=gentle-pi', ...AGE]]);
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
 assert.deepEqual(f.mutations, [['add', '-g', `${PI}@1.2.0`, ...AGE]]);
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

// #2371: a failed install shows the package manager it ran and one sanitized
// line of its own output; pnpm 11 prints ERR_PNPM_* on stdout, npm on stderr.
test('a failed pnpm install names the pnpm it ran and its ERR_PNPM line from stdout', async () => {
 const f = fixture({shellVersion: MAIN, installFailure: {stderrTail: '',
  stdout: `Progress: resolved 1\n\u001b[31m[ERR_PNPM_INVALID_VERSION_UNION]\u001b[39m Invalid versions union. Found: "gentle-pi@file:/home/u/x.tgz". Use exact versions only.\nDone\n`}});
 await assert.rejects(updateSelectedPi(f.input), {message: `gentle-shell update: pnpm (/fake/pnpm) could not install ${f.tarball}\n[ERR_PNPM_INVALID_VERSION_UNION] Invalid versions union. Found: "gentle-pi@file:~/x.tgz". Use exact versions only.`});
 assert.deepEqual(f.runOptions, [{deadlineMs: 20 * 60_000, cwd: '/neutral', stderrTail: 4096}]);
 assert.deepEqual(f.out, []);
});

test('a failed npm install shows its stderr error line before stdout', async () => {
 const f = fixture({npm: true, installFailure: {stdout: 'unrelated', stderrTail: 'npm error code EACCES\nnpm error Error: EACCES: permission denied\nnpm error A complete log is in /home/u/.npm/x.log\n'}});
 await assert.rejects(updateSelectedPi(f.input), {message: 'gentle-shell update: npm (/fake/npm) could not install gentle-pi@4.1.0\nnpm error Error: EACCES: permission denied'});
 assert.deepEqual(f.out, []);
});

test('a failed install without output keeps the single line, naming the command it ran', async () => {
 const f = fixture({installFailure: {}});
 await assert.rejects(updateSelectedPi(f.input), {message: 'gentle-shell update: pnpm (/fake/pnpm) could not install gentle-pi@4.1.0'});
 assert.deepEqual(f.mutations, [['add', '-g', 'gentle-pi@4.1.0', '--allow-build=gentle-pi', ...AGE]]);
});

test('a stderr warning never hides the ERR_PNPM line pnpm printed on stdout', async () => {
 const f = fixture({installFailure: {stderrTail: '(node:1) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.\n',
  stdout: '[ERR_PNPM_INVALID_VERSION_UNION] Invalid versions union.\n'}});
 await assert.rejects(updateSelectedPi(f.input), {message: 'gentle-shell update: pnpm (/fake/pnpm) could not install gentle-pi@4.1.0\n[ERR_PNPM_INVALID_VERSION_UNION] Invalid versions union.'});
});

test('without any error line the last stderr line is shown', async () => {
 const f = fixture({installFailure: {stderrTail: 'killed\n', stdout: 'Progress: resolved 1\n'}});
 await assert.rejects(updateSelectedPi(f.input), {message: 'gentle-shell update: pnpm (/fake/pnpm) could not install gentle-pi@4.1.0\nkilled'});
});
