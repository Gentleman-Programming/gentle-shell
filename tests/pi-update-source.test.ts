import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateSelectedPi } from '../scripts/pi-update.mjs';

const PI = '@earendil-works/pi-coding-agent';
const CLI = 'dist/bundle/cli.js';

async function fixture(t: any, options: {manager?: string, locks?: string[], workspace?: boolean, range?: string, mismatch?: boolean, managerVersion?: string, fail?: boolean, unreadable?: boolean, unlink?: boolean, installedSource?: boolean, configOnly?: boolean, multipleProjects?: boolean, latest?: string, excludeOutput?: string, piDependencies?: Record<string, unknown>, manifestView?: {code: number, stdout: string}, siblingDependencies?: Record<string, Record<string, unknown>>} = {}) {
 const temp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pi-source-')));
 t.after(() => fs.rm(temp, {recursive: true, force: true}));
 const root = join(temp, 'checkout');
 const modules = join(temp, 'global', 'node_modules');
 const link = join(modules, 'gentle-pi');
 const peer = join(root, 'node_modules', PI);
 const manager = options.manager ?? 'pnpm';
 const lock = manager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml';
 const manifest = JSON.stringify({name: 'gentle-pi', version: '4.4.0', packageManager: `${manager}@11.1.1`, devDependencies: {[PI]: options.range ?? '^1.0.0'}});
 await fs.mkdir(join(root, '.git'), {recursive: true});
 await fs.mkdir(modules, {recursive: true});
 await fs.mkdir(join(peer, 'dist', 'bundle'), {recursive: true});
 await fs.writeFile(join(root, 'package.json'), manifest);
 for (const name of options.locks ?? [lock]) await fs.writeFile(join(root, name), name === 'package-lock.json' ? '{"lockfileVersion":3}' : "lockfileVersion: '9.0'\nimporters:\n  .: {}\n");
 if (options.workspace || options.configOnly) await fs.writeFile(join(root, 'pnpm-workspace.yaml'), options.workspace ? 'packages: [packages/*]\n' : 'minimumReleaseAge: 4320\nblockExoticSubdeps: true\n');
 await fs.writeFile(join(peer, 'package.json'), JSON.stringify({name: PI, version: '1.0.0', bin: {pi: CLI}}));
 await fs.writeFile(join(peer, CLI), 'old Pi');
 if (options.installedSource) {
  const source = join(temp, 'Pi-source-checkout');
  await fs.rename(peer, source);
  await fs.mkdir(join(source, '.git'));
  await fs.symlink(source, peer, 'junction');
 }
 await fs.writeFile(join(root, 'unrelated.txt'), 'preserve me');
 await fs.symlink(root, link, 'junction');
 const calls: {command: string, args: string[], cwd?: string, env?: Record<string,string>}[] = [];
 const updates: typeof calls = [];
 const output: string[] = [];
 const snapshot = async () => ({pnpmConfig:options.workspace || options.configOnly ? await fs.readFile(join(root,'pnpm-workspace.yaml'),'utf8') : null, installedRoot:await fs.realpath(peer), installedLink:(await fs.lstat(peer)).isSymbolicLink() ? await fs.readlink(peer) : null, manifest: await fs.readFile(join(root, 'package.json'), 'utf8'), link: await fs.realpath(link), peer: await fs.readFile(join(peer, 'package.json'), 'utf8'), unrelated: await fs.readFile(join(root, 'unrelated.txt'), 'utf8'), locks: await Promise.all((options.locks ?? [lock]).map(name => fs.readFile(join(root, name), 'utf8')))});
 const before = await snapshot();
 const input = {runtime: {kind: 'bundled', command: process.execPath, args: [join(peer, CLI)]}, packageRoot: link, cwd: temp, home: temp, env: {}, currentVersion: '1.0.0', out: (s: string) => output.push(s), adapters: {
  fs,
  which: async (name: string) => `/fake/${name}`,
  run: async (command: string, args: string[], {cwd,env}: {cwd?: string,env?: Record<string,string>} = {}) => {
   calls.push({command, args, cwd, ...(env ? {env} : {})});
   if (args.includes('list') && args.includes('--recursive')) return {code:0, stdout:JSON.stringify(options.multipleProjects ? [{path:root},{path:join(temp,'other-project')}] : [{path:root}])};
   if (args.includes('list')) return {code: 0, stdout: JSON.stringify([{path: join(temp, 'pnpm'), dependencies: {}}])};
   if (args.includes('ls')) return {code: 0, stdout: JSON.stringify({path: join(temp, 'global'), dependencies: {'gentle-pi': {path: link, resolved: 'file:../../checkout'}}})};
   if (args.includes('--version')) return {code: 0, stdout: `${options.managerVersion ?? '11.1.1'}\n`};
   // `view <Pi>@<version> --json` reads the selected version's published manifest.
   const spec = args[args.indexOf('view') + 1] ?? '', at = spec.lastIndexOf('@');
   // A Pi-scope sibling resolves only from siblingDependencies; any other lookup fails.
   if (args.includes('view') && args.includes('--json') && spec.slice(0, at) !== PI) return options.siblingDependencies?.[spec] ? {code: 0, stdout: JSON.stringify({name: spec.slice(0, at), version: spec.slice(at + 1), dependencies: options.siblingDependencies[spec]})} : {code: 1, stdout: ''};
   if (args.includes('view') && args.includes('--json')) return options.manifestView ?? {code: 0, stdout: JSON.stringify({name: PI, version: options.latest ?? '1.1.0', bin: {pi: CLI}, dependencies: options.piDependencies ?? {}})};
   if (args.includes('view')) return {code: 0, stdout: `${options.latest ?? '1.1.0'}\n`};
   if (args.includes('config')) return {code:0, stdout:args.includes('minimumReleaseAgeExclude') ? options.excludeOutput ?? '["existing-fixture"]\n' : options.workspace ? '["packages/*"]\n' : ''};
   updates.push({command, args, cwd, ...(env ? {env} : {})});
   if (options.fail) return {code: 1, stdout: '', stderrTail: 'npm error fixture install failed'};
   if (options.unreadable) await fs.rm(join(peer, 'package.json'));
   else await fs.writeFile(join(peer, 'package.json'), JSON.stringify({name: PI, version: options.latest ?? '1.1.0', bin: {pi: CLI}}));
   if (options.unlink) await fs.unlink(link);
   return {code: 0, stdout: ''};
  },
 }};
 if (options.mismatch) {
  const other = join(temp, 'other', CLI);
  await fs.mkdir(join(temp, 'other', 'dist', 'bundle'), {recursive: true});
  await fs.writeFile(other, 'other Pi');
  input.runtime.args = [other];
 }
 return {input, root, peer, link, manager, manifest, output, updates, calls, snapshot, before};
}

for (const manager of ['pnpm', 'npm']) test(`source-linked Shell updates only its local Pi using ${manager}, not the global link owner`, async t => {
 const f = await fixture(t, {manager});
 assert.equal(await updateSelectedPi(f.input), 0);
 const flags = manager === 'pnpm' ? ['--dir', f.root, '--lockfile-dir', f.root, '--recursive=false', '--ignore-pnpmfile'] : ['--prefix', f.root, '--workspaces=false', '--no-audit', '--no-fund'];
 assert.deepEqual(f.updates, [{command: `/fake/${manager}`, args: [manager === 'pnpm' ? 'update' : 'install', `${PI}@1.1.0`, '--no-save', '--ignore-scripts', '--global=false', ...flags, ...(manager === 'pnpm' ? ['--pm-on-fail=ignore', '--config.minimum-release-age-exclude=existing-fixture', `--config.minimum-release-age-exclude=${PI}`] : [])], cwd: f.root, ...(manager === 'pnpm' ? {env:{COREPACK_ENABLE_PROJECT_SPEC:'0',COREPACK_ENABLE_NETWORK:'0'}} : {})}]);
 assert.deepEqual(f.output, [`${manager} updated ${PI} in ${f.root}; the selected Pi is now 1.1.0 (was 1.0.0).`]);
 assert.equal(await fs.realpath(f.link), f.root);
 assert.equal(await fs.readFile(join(f.root, 'package.json'), 'utf8'), f.manifest);
 assert.equal(await fs.readFile(join(f.root, 'unrelated.txt'), 'utf8'), 'preserve me');
 assert.ok(f.calls.filter(c => c.args.includes('list') || c.args.includes('ls') || c.args.includes('--version')).every(c => c.cwd === f.input.cwd));
});

for (const manager of ['pnpm', 'npm']) test(`source ${manager} resolves the latest stable tag before updating, without changing its manifest`, async t => {
 const f = await fixture(t, {manager, range:'^1.0.0', latest:'2.0.0'});
 assert.equal(await updateSelectedPi(f.input), 0);
 const views = f.calls.filter(call => call.args.includes('view') && !call.args.includes('--json'));
 assert.equal(views.length, 1);
 assert.ok(views[0].args.includes(`${PI}@latest`));
 assert.ok(f.calls.indexOf(views[0]) < f.calls.findIndex(call => call.args === f.updates[0].args));
 assert.equal((await f.snapshot()).manifest, f.before.manifest);
 assert.equal(await fs.realpath(f.link), f.root);
});

test('source pnpm retains existing package-specific release-age exclusions while exempting Pi', async t => {
 const f = await fixture(t, {configOnly:true});
 assert.equal(await updateSelectedPi(f.input), 0);
 const exclusions = f.calls.filter(call => call.args.includes('config') && call.args.includes('minimumReleaseAgeExclude'));
 assert.equal(exclusions.length, 1);
 const args = f.updates[0].args;
 assert.ok(args.includes('--config.minimum-release-age-exclude=existing-fixture'));
 assert.ok(args.includes(`--config.minimum-release-age-exclude=${PI}`));
 assert.ok(!args.some(arg => /^--(?:config\.)?minimum-release-age=/.test(arg)));
 assert.equal((await f.snapshot()).pnpmConfig, f.before.pnpmConfig);
});

const DEPENDENCIES = {'@earendil-works/pi-ai':'2.0.0', '@earendil-works/pi-tui':'2.0.0', '@earendil-works/pi-ranged':'^2.0.0',
 '@earendil-works/pi-next':'2.1.0-rc.1', undici:'7.0.0', chalk:'^5.0.0'};

// Pi 1.5.2's pi-ai pins pi-schema and pi-telemetry, which Pi itself does not list.
const SIBLINGS = {'@earendil-works/pi-ai@2.0.0':{'@earendil-works/pi-schema':'2.0.0', '@earendil-works/pi-telemetry':'2.0.0', openai:'7.19.0'},
 '@earendil-works/pi-tui@2.0.0':{'@earendil-works/pi-ai':'2.0.0', marked:'18.0.11'}, '@earendil-works/pi-schema@2.0.0':{}, '@earendil-works/pi-telemetry@2.0.0':{'@earendil-works/pi-ranged':'^2.0.0'}};

test('source pnpm also exempts only the Pi-scope packages the selected Pi pins exactly, transitively', async t => {
 const f = await fixture(t, {configOnly:true, latest:'2.0.0', piDependencies:DEPENDENCIES, siblingDependencies:SIBLINGS});
 assert.equal(await updateSelectedPi(f.input), 0);
 const manifests = f.calls.filter(call => call.args.includes('view') && call.args.includes('--json'));
 assert.deepEqual(manifests, [PI, '@earendil-works/pi-ai', '@earendil-works/pi-tui', '@earendil-works/pi-schema', '@earendil-works/pi-telemetry'].map(name => ({command:'/fake/pnpm', args:['view', `${name}@2.0.0`, '--json', '--dir', f.root, '--pm-on-fail=ignore'], cwd:f.root, env:{COREPACK_ENABLE_PROJECT_SPEC:'0',COREPACK_ENABLE_NETWORK:'0'}})));
 assert.ok(f.calls.indexOf(manifests[manifests.length - 1]) < f.calls.findIndex(call => call.args === f.updates[0].args));
 assert.deepEqual(f.updates[0].args.filter(arg => arg.startsWith('--config.minimum-release-age-exclude=')), ['existing-fixture', PI, ...['pi-ai', 'pi-tui', 'pi-schema', 'pi-telemetry'].map(name => `@earendil-works/${name}@2.0.0`)].map(entry => `--config.minimum-release-age-exclude=${entry}`));
 assert.ok(f.updates[0].args.includes('--no-save'));
 assert.ok(!f.updates[0].args.some(arg => /minimum-release-age-strict|minimumReleaseAgeStrict/i.test(arg)));
 const after = await f.snapshot();
 assert.equal(after.manifest, f.before.manifest);
 assert.equal(after.pnpmConfig, f.before.pnpmConfig);
});

for (const [name, manifestView] of Object.entries({'a failed lookup': {code:1, stdout:''}, 'unparsable output': {code:0, stdout:'not json'},
 'another package': {code:0, stdout:JSON.stringify({name:'other', version:'2.0.0'})}, 'list-shaped dependencies': {code:0, stdout:JSON.stringify({name:PI, version:'2.0.0', dependencies:['@earendil-works/pi-ai']})}})) test(`source pnpm refuses without mutation when the selected Pi manifest has ${name}`, async t => {
 const f = await fixture(t, {configOnly:true, latest:'2.0.0', manifestView});
 await assert.rejects(updateSelectedPi(f.input), {message:'gentle-shell update: the published dependencies of Pi 2.0.0 could not be verified. No installation changed.'});
 assert.deepEqual(f.updates, []);
 assert.deepEqual(f.output, []);
 assert.deepEqual(await f.snapshot(), f.before);
});

test('source pnpm merges siblings into the checkout\'s versioned exclusions and keeps the rest verbatim', async t => {
 const existing = [`${PI}@1.0.0`, '@earendil-works/chord@1.0.0', '@earendil-works/pi-ai@1.0.0', '@earendil-works/pi-telemetry@1.0.0', 'existing-fixture'];
 const f = await fixture(t, {configOnly:true, latest:'2.0.0', piDependencies:DEPENDENCIES, siblingDependencies:SIBLINGS, excludeOutput:JSON.stringify(existing)});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.updates[0].args.filter(arg => arg.startsWith('--config.minimum-release-age-exclude=')).map(arg => arg.slice(arg.indexOf('=') + 1)),
  [PI, '@earendil-works/chord@1.0.0', '@earendil-works/pi-ai@1.0.0 || 2.0.0', '@earendil-works/pi-telemetry@1.0.0 || 2.0.0', 'existing-fixture', '@earendil-works/pi-tui@2.0.0', '@earendil-works/pi-schema@2.0.0']);
 assert.equal((await f.snapshot()).pnpmConfig, f.before.pnpmConfig);
});

test('source pnpm refuses without mutation when a transitively pinned sibling cannot be read', async t => {
 const {'@earendil-works/pi-telemetry@2.0.0': _missing, ...siblings} = SIBLINGS;
 const f = await fixture(t, {configOnly:true, latest:'2.0.0', piDependencies:DEPENDENCIES, siblingDependencies:siblings});
 await assert.rejects(updateSelectedPi(f.input), {message:'gentle-shell update: the published dependencies of @earendil-works/pi-telemetry@2.0.0 could not be verified. No installation changed.'});
 assert.deepEqual(f.updates, []);
 assert.deepEqual(f.output, []);
 assert.deepEqual(await f.snapshot(), f.before);
});

test('source npm keeps its update unchanged and never reads the Pi manifest', async t => {
 const f = await fixture(t, {manager:'npm', latest:'2.0.0', piDependencies:DEPENDENCIES});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.calls.filter(call => call.args.includes('--json') && call.args.includes('view')), []);
 assert.ok(!f.updates[0].args.some(arg => arg.includes('minimum-release-age')));
});

test('source pnpm safely handles an empty release-age exclusion list', async t => {
 const f = await fixture(t, {excludeOutput:''});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.equal(f.updates[0].args.filter(arg => arg === `--config.minimum-release-age-exclude=${PI}`).length, 2);
 assert.equal((await f.snapshot()).manifest, f.before.manifest);
});

test('source pnpm refuses malformed exclusions before any mutation', async t => {
 const f = await fixture(t, {excludeOutput:'["ok", 1]'});
 await assert.rejects(updateSelectedPi(f.input), /pnpm release-age exclusions could not be verified/);
 assert.deepEqual(f.updates, []);
 assert.deepEqual(f.output, []);
 assert.deepEqual(await f.snapshot(), f.before);
});

for (const manager of ['pnpm', 'npm']) test(`source ${manager} rejects a prerelease latest tag without mutation`, async t => {
 const f = await fixture(t, {manager, latest:'2.0.0-rc.1'});
 await assert.rejects(updateSelectedPi(f.input), /latest published Pi.*rejected/);
 assert.deepEqual(f.updates, []);
 assert.deepEqual(f.output, []);
 assert.deepEqual(await f.snapshot(), f.before);
});

test('newer pnpm uses its current version without downloading the older project pin', async t => {
 const f = await fixture(t, {managerVersion:'11.5.0', configOnly:true});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.equal(f.updates.length, 1);
 assert.deepEqual(f.output, [`pnpm updated ${PI} in ${f.root}; the selected Pi is now 1.1.0 (was 1.0.0).`]);
 const projectCalls = f.calls.filter(call => call.args.includes('config') || call.args.includes('--recursive') || call.args[0] === 'update');
 assert.equal(projectCalls.length, 4);
 assert.ok(projectCalls.every(call => call.args.includes('--pm-on-fail=ignore')));
 assert.ok(f.calls.filter(call => call.args.includes('--version') || call.args.includes('view') || projectCalls.includes(call)).every(call => call.env?.COREPACK_ENABLE_PROJECT_SPEC === '0' && call.env?.COREPACK_ENABLE_NETWORK === '0'));
 const after = await f.snapshot();
 assert.equal(after.manifest, f.before.manifest);
 assert.equal(after.pnpmConfig, f.before.pnpmConfig);
 assert.equal(after.unrelated, f.before.unrelated);
 assert.equal(after.link, f.before.link);
});

test('older pnpm refuses before mutation or output', async t => {
 const f = await fixture(t, {managerVersion:'11.1.0'});
 await assert.rejects(updateSelectedPi(f.input), /requires pnpm@11\.1\.1 or newer/);
 assert.deepEqual(f.updates, []);
 assert.deepEqual(f.output, []);
 assert.deepEqual(await f.snapshot(), f.before);
});

for (const [name, options] of Object.entries({
 'conflicting lockfiles': {locks: ['pnpm-lock.yaml', 'package-lock.json']},
 'missing lockfile': {locks: []},
 'workspace checkout': {workspace: true},
 'implicit workspace projects': {configOnly:true, multipleProjects:true},
 'unknown project manager': {manager: 'yarn', locks: ['yarn.lock']},
 'a linked Pi dependency': {range: 'file:../pi'},
 'a different selected Pi': {mismatch: true},
})) test(`source update refuses ${name} without changing files or counters`, async t => {
 const f = await fixture(t, options);
 await assert.rejects(updateSelectedPi(f.input), /ownership/);
 assert.deepEqual(f.updates, []);
 assert.deepEqual(f.output, []);
 assert.deepEqual(await f.snapshot(), f.before);
});

test('source update preserves root-only pnpm security configuration instead of ignoring it', async t => {
 const f = await fixture(t, {configOnly:true});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.equal(f.updates.length, 1);
 assert.ok(f.calls.some(call => call.args.includes('config') && call.args.includes('packages')));
 assert.ok(f.updates[0].args.includes('--workspace-root'));
 assert.ok(f.updates[0].args.includes('--recursive=false'));
 assert.ok(!f.updates[0].args.includes('--ignore-workspace'));
 assert.equal((await f.snapshot()).pnpmConfig, f.before.pnpmConfig);
 assert.equal(await fs.readFile(join(f.root,'package.json'),'utf8'), f.manifest);
 assert.equal(await fs.realpath(f.link), f.root);
});

test('source update refuses an installed Pi source override despite a registry range', async t => {
 const f = await fixture(t, {installedSource:true});
 await assert.rejects(updateSelectedPi(f.input), /source Pi is a linked source checkout/);
 assert.deepEqual(f.updates, []);
 assert.deepEqual(f.output, []);
 assert.deepEqual(await f.snapshot(), f.before);
});

test('source update failure reports the real manager error and never retries', async t => {
 const f = await fixture(t, {manager: 'npm', fail: true});
 await assert.rejects(updateSelectedPi(f.input), /npm error fixture install failed/);
 assert.equal(f.updates.length, 1);
 assert.deepEqual(f.output, []);
 assert.deepEqual(await f.snapshot(), f.before);
});

test('source update reports unavailable readback instead of claiming a version', async t => {
 const f = await fixture(t, {unreadable: true});
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.match(f.output.join('\n'), /version.*could not be read back/);
 assert.doesNotMatch(f.output.join('\n'), /is now/);
});

test('source update cannot claim success when its global Shell link disappeared', async t => {
 const f = await fixture(t, {unlink: true});
 await assert.rejects(updateSelectedPi(f.input), /Shell link.*changed/);
 assert.equal(f.updates.length, 1);
 assert.deepEqual(f.output, []);
});
