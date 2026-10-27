// Narrow update ownership proof. Deliberately independent of Shell upgrade/uninstall.
import { posix, win32 } from 'node:path';
import { bundledUpdatePlan } from '../runtime/gentle-shell-bundled.mjs';
import { setupErrorDetail } from './installer-runner.mjs';

const PI = '@earendil-works/pi-coding-agent';
const SHELL = 'gentle-pi';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const succeeded = result => result?.code === 0 && !result.timedOut && result.signal == null;
const refusal = detail => new Error(`gentle-shell update: ownership ${detail}; update Pi with the package manager or source checkout that supplies the selected runtime. No installation changed.`);
const LINKED = /^(?:file|link|workspace):/i;
// A main-channel Shell (`<version>-main.<sha12>`, scripts/main-channel.mjs
// mainVersion) is never published; it exists only as the packed tarball.
const MAIN_BUILD = /^[0-9A-Za-z.+-]+-main\.[0-9a-f]{12}$/;
const CLI_TAIL = /[\\/]dist[\\/]bundle[\\/]cli\.js$/i;
// A quoted cli.js target inside a package-manager shim: pnpm's POSIX shim
// (`"$basedir/../global/.../cli.js"`), its `.CMD`/npm's `.cmd` shim
// (`"%~dp0\\...\\cli.js"`, `"%dp0%\\...\\cli.js"`) or an absolute path.
const SHIM_TARGET = /"((?:\$basedir[\\/]|%~?dp0%?[\\/])?[^"]*?[\\/]dist[\\/]bundle[\\/]cli\.js)"/g;

export function managedUpdatePlan(args) {
 // The legacy extension-only alias must never trigger self-update.
 if (args.includes('--extensions-only')) return {self:false, piArgs:args};
 // Its self update already installs the latest Pi, so --latest changes nothing here.
 const {latest: _latest, ...plan} = bundledUpdatePlan(args);
 return plan;
}

function pathsFor(platform) {
 const path = platform === 'win32' ? win32 : posix;
 const key = value => platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
 return {path, key};
}

function canonicalWith(adapters, path) {
 return async value => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw refusal('has no absolute package path');
  const result = await adapters.fs.realpath(value);
  if (typeof result !== 'string' || !path.isAbsolute(result)) throw refusal('has an invalid canonical path');
  return result;
 };
}

/** The cli.js a selected PATH or GENTLE_SHELL_PI executable runs: itself when
 * it is the entry (npm's bin symlink resolves there), otherwise the single
 * target its shim names, relative to the shim's directory. Anything else
 * cannot be matched against a listed package and is refused.
 */
async function selectedCliOf(runtime, {adapters, path, canonical}) {
 if (runtime.kind === 'bundled') return canonical(runtime.args[0]);
 const file = await canonical(runtime.args.length ? runtime.args[0] : runtime.command);
 if (CLI_TAIL.test(file)) return file;
 let text;
 try { text = String(await adapters.fs.readFile(file, 'utf8')); } catch { throw refusal('cannot read the selected executable'); }
 const targets = new Set();
 for (const [, quoted] of text.matchAll(SHIM_TARGET)) {
  const relative = /^(?:\$basedir|%~?dp0%?)[\\/]/.exec(quoted);
  const target = relative ? path.join(path.dirname(file), quoted.slice(relative[0].length)) : quoted;
  if (!path.isAbsolute(target)) throw refusal('selected shim names a relative target');
  targets.add(path.normalize(target));
 }
 if (targets.size !== 1) throw refusal(targets.size === 0 ? 'selected executable is not a Pi entry or shim' : 'selected shim names several targets');
 return canonical([...targets][0]);
}

async function manifestOf(adapters, path, root) {
 return JSON.parse(await adapters.fs.readFile(path.join(root, 'package.json'), 'utf8'));
}

/** The Pi package a canonical Shell root runs as its adjacent peer, as
 * { root, manifest, cli }, or null when none resolves. pnpm's linked store
 * places the peer beside the Shell package (`<...>/node_modules/<PI>`), npm
 * nests it (`<shell>/node_modules/<PI>`); the global group's own
 * `node_modules` is the last place a peer link can live.
 */
async function adjacentPeer({shellRoot, groupRoot, adapters, path, key, canonical}) {
 const places = [path.join(shellRoot, 'node_modules', PI), path.join(path.dirname(shellRoot), PI)];
 if (groupRoot) places.push(path.join(groupRoot, PI));
 for (const place of places) {
  let root;
  try { root = await canonical(place); } catch { continue; }
  const manifest = await manifestOf(adapters, path, root);
  if (manifest.name !== PI || manifest.bin?.pi !== 'dist/bundle/cli.js') throw refusal('adjacent Pi identity differs');
  const cli = await canonical(path.join(root, manifest.bin.pi));
  // The canonical package root must supply its own CLI file, not a link elsewhere.
  if (key(cli) !== key(path.join(root, manifest.bin.pi))) throw refusal('adjacent Pi package root does not supply its CLI');
  return {root, manifest, cli};
 }
 return null;
}

// Package managers run from a neutral directory: inside a project, pnpm
// honors that project's `packageManager` pin and may download another pnpm
// before answering, and the global installation does not depend on the cwd.
async function globalListing(name, invocation, adapters, cwd) {
 const argv = name === 'pnpm' ? ['list', '-g', '--depth', '0', '--json'] : ['ls', '-g', '--depth=0', '--json', '--long'];
 const result = await adapters.run(invocation.command, [...invocation.prefix, ...argv], {deadlineMs:30_000, cwd});
 if (!succeeded(result)) throw refusal('listing failed');
 const json = JSON.parse(result.stdout);
 const groups = name === 'pnpm' ? json : [json];
 if (!Array.isArray(groups) || groups.length === 0) throw refusal('listing is malformed');
 return groups;
}

async function invocationFor(name, adapters, platform) {
 const invocation = adapters.invocation ? await adapters.invocation(name) : await adapters.which(name).then(command => command ? {command, prefix:[]} : null);
 if (!invocation) return null;
 if (platform === 'win32' && /\.(cmd|bat)$/i.test(invocation.command)) throw refusal(`cannot run ${name} without its shell shim`);
 return invocation;
}

/** Every listed top-level Pi or Shell package of one manager, with the
 * canonical global group it links from and that group's member names.
 */
async function listedEntries(groups, {adapters, path, key, canonical}) {
 const entries = [];
 const members = new Map();
 for (const group of groups) {
  if (!object(group) || typeof group.path !== 'string' || !object(group.dependencies)) throw refusal('listing is malformed');
  for (const [pkg, dependency] of Object.entries(group.dependencies)) {
   if (!object(dependency) || !/^(?:@[^/\\]+\/)?[^/\\]+$/.test(pkg)) throw refusal('listing is malformed');
   // pnpm's JSON may aggregate several global groups. The dependency's
   // listed link location, not the aggregate group.path or canonical store
   // package root, identifies which old group `add -g` would replace.
   const listed = dependency.path;
   if (typeof listed !== 'string' || !path.isAbsolute(listed)) throw refusal('listed package path is missing');
   const modules = pkg.startsWith('@') ? path.dirname(path.dirname(listed)) : path.dirname(listed);
   if (path.basename(modules) !== 'node_modules' || key(path.join(modules, pkg)) !== key(listed)) throw refusal('listed top-level group is unknown');
   const groupRoot = await canonical(modules);
   const set = members.get(key(groupRoot)) ?? new Set();
   set.add(pkg);
   members.set(key(groupRoot), set);
   if (pkg === PI || pkg === SHELL) entries.push({pkg, dependency, groupRoot});
  }
 }
 return {entries, members};
}

/** A single listed package must supply the exact selected executable.
 * pnpm v11 lists separate global groups whose packages resolve into a linked
 * store outside PNPM_HOME. Neither containment nor a package name proves
 * ownership. An adjacent runtime is owned by the Shell group that resolved
 * it: updating a separate global Pi never changes what that Shell runs.
 */
/** Where `gentle-shell upgrade --channel main` packed this Shell version: the
 * same config home as scripts/main-channel.mjs configHome. A relative config
 * home is refused, not resolved: `upgrade` resolved it from its own working
 * directory, so it names no single folder, and the package manager runs from
 * the neutral cwd.
 */
function mainBuildTarball(version, {env, home, path}) {
 const config = env?.GENTLE_PI_CONFIG_HOME || (typeof home === 'string' ? path.join(home, '.pi', 'gentle-ai') : null);
 if (!config || !path.isAbsolute(config)) throw refusal('cannot locate the main-channel build without an absolute config home');
 return path.join(config, 'main', 'packages', `${SHELL}-${version}.tgz`);
}

export async function resolveUpdateOwner({runtime, packageRoot, platform = process.platform, adapters, cwd, env, home}) {
 const {path, key} = pathsFor(platform);
 const canonical = canonicalWith(adapters, path);
 const selected = await selectedCliOf(runtime, {adapters, path, canonical});
 const shellRoot = await canonical(packageRoot);
 const adjacent = runtime.kind === 'bundled';
 const candidates = [];
 for (const name of ['pnpm', 'npm']) {
  const invocation = await invocationFor(name, adapters, platform);
  if (!invocation) continue;
  const groups = await globalListing(name, invocation, adapters, cwd);
  const {entries, members} = await listedEntries(groups, {adapters, path, key, canonical});
  for (const {pkg, dependency, groupRoot} of entries) {
   if ((pkg === SHELL) !== adjacent) continue;
   if (dependency.link === true || [dependency.resolved, dependency.version].some(value => typeof value === 'string' && LINKED.test(value))) throw refusal('listed supplier is a source or linked package');
   const root = await canonical(dependency.path);
   const manifest = await manifestOf(adapters, path, root);
   if (manifest.name !== pkg) throw refusal('listed package identity differs');
   let cli, spec, artifact = false;
   if (pkg === PI) {
    if (manifest.bin?.pi !== 'dist/bundle/cli.js') throw refusal('listed Pi bin is unsupported');
    cli = await canonical(path.join(root, manifest.bin.pi));
    if (key(cli) !== key(path.join(root, manifest.bin.pi))) throw refusal('listed Pi package root does not supply its CLI');
    spec = `${PI}@latest`;
   } else {
    // Only the Shell package this launcher runs from can own its peer.
    if (key(root) !== key(shellRoot)) continue;
    const peer = await adjacentPeer({shellRoot: root, groupRoot, adapters, path, key, canonical});
    if (!peer) continue;
    cli = peer.cli;
    // Reinstalling the same Shell version re-resolves its peer; `update`
    // never upgrades Shell itself (that is `gentle-shell upgrade`).
    if (typeof manifest.version !== 'string') throw refusal('listed Shell version is missing');
    artifact = MAIN_BUILD.test(manifest.version);
    spec = artifact ? mainBuildTarball(manifest.version, {env, home, path}) : `${SHELL}@${manifest.version}`;
   }
   if (key(cli) !== key(selected)) continue;
   if (name === 'pnpm' && members.get(key(groupRoot)).size !== 1) throw refusal('selected supplier shares its global install group');
   candidates.push({name, ...invocation, package:pkg, spec, artifact});
  }
 }
 if (candidates.length !== 1) throw refusal(candidates.length > 1 ? 'is ambiguous' : 'could not be verified from global listings');
 return candidates[0];
}

/** The Pi version the owner's package now supplies, read back from a fresh
 * listing after the install; null when it cannot be read.
 */
async function suppliedPiVersion(owner, {platform, adapters, cwd}) {
 const {path, key} = pathsFor(platform);
 const canonical = canonicalWith(adapters, path);
 try {
  const groups = await globalListing(owner.name, owner, adapters, cwd);
  const {entries} = await listedEntries(groups, {adapters, path, key, canonical});
  for (const {pkg, dependency, groupRoot} of entries) {
   if (pkg !== owner.package) continue;
   const root = await canonical(dependency.path);
   if (pkg === PI) return (await manifestOf(adapters, path, root)).version ?? null;
   if ((await manifestOf(adapters, path, root)).name !== SHELL) continue;
   const peer = await adjacentPeer({shellRoot: root, groupRoot, adapters, path, key, canonical});
   if (peer) return peer.manifest.version ?? null;
  }
 } catch {
  return null;
 }
 return null;
}

export async function updateSelectedPi(input) {
 let owner;
 try { owner = await resolveUpdateOwner(input); }
 catch (error) { throw error.message?.includes('ownership') ? error : refusal('could not be resolved'); }
 if (owner.artifact) {
  try { await input.adapters.fs.realpath(owner.spec); }
  catch { throw new Error(`gentle-shell update: the main-channel build ${owner.spec} is missing, and this unpublished build cannot be reinstalled from the registry; run 'gentle-shell upgrade --channel release' and then 'gentle-shell upgrade --channel main' to rebuild it. No installation changed.`); }
 }
 // Exactly one approved package per command; never create a comma group or
 // reinstall arbitrary dependencies merely because they share a store.
 const args = owner.name === 'pnpm' ? ['add', '-g', owner.spec, ...(owner.package === SHELL ? ['--allow-build=gentle-pi'] : [])] : ['install', '-g', owner.spec, ...(owner.package === PI ? ['--ignore-scripts'] : [])];
 const result = await input.adapters.run(owner.command, [...owner.prefix, ...args], {deadlineMs:20 * 60_000, cwd: input.cwd, stderrTail:4096});
 if (!succeeded(result)) {
  // One sanitized line of the manager's own error: npm prints it on stderr,
  // pnpm 11 prints ERR_PNPM_* on stdout. Read as one text, stderr last, an
  // error line in either stream wins over a stderr warning, stderr's on a tie.
  const output = [result?.stdout, result?.stderrTail].filter(text => typeof text === 'string').join('\n');
  const detail = setupErrorDetail(output, input.home, input.platform);
  throw new Error(`gentle-shell update: ${owner.name} (${[owner.command, ...owner.prefix].join(' ')}) could not install ${owner.spec}${detail ? `\n${detail}` : ''}`);
 }
 const after = await suppliedPiVersion(owner, input);
 const before = input.currentVersion;
 if (after === null) input.out?.(`${owner.name} installed ${owner.spec}. The Pi version it now supplies could not be read back; run 'gentle-shell --version' to check it.`);
 else if (before !== undefined && after === before) {
  input.out?.(`${owner.name} installed ${owner.spec}, and the selected Pi is still ${after}.`);
  if (owner.name === 'pnpm') input.out?.('pnpm installs only releases older than its minimumReleaseAge setting (pnpm 11 defaults to 4320 minutes); a newer Pi release is picked up once it is old enough.');
 } else input.out?.(`${owner.name} installed ${owner.spec}; the selected Pi is now ${after}${before !== undefined ? ` (was ${before})` : ''}.`);
 return 0;
}
