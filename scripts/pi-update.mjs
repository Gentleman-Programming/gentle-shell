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
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
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
   if (pkg === PI || pkg === SHELL) entries.push({pkg, dependency, groupRoot, listingRoot: path.isAbsolute(group.path) ? key(group.path) : null});
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

function managerVersionAtLeast(actual, minimum) {
 if (!/^\d+\.\d+\.\d+$/.test(actual)) return false;
 const current = actual.split('.').map(Number), required = minimum.split('.').map(Number);
 for (let i = 0; i < current.length; i++) {
  if (current[i] !== required[i]) return current[i] > required[i];
 }
 return true;
}

async function optionalFile(fs, file) {
 try { return String(await fs.readFile(file, 'utf8')); }
 catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined; throw error; }
}

// Source updates are deliberately standalone: never infer a workspace owner or
// replace a global Shell link with a registry package.
async function sourceOwner({root, linkPath, manifest, selected, adapters, path, key, canonical, platform, cwd, env}) {
 await canonical(path.join(root, '.git'));
 if (key(await canonical(path.join(root, 'package.json'))) !== key(path.join(root, 'package.json'))) throw refusal('source manifest is linked outside the checkout');
 const pin = /^(npm|pnpm)@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? '');
 if (!pin) throw refusal('source checkout needs an exact npm or pnpm packageManager pin');
 const ranges = ['dependencies', 'devDependencies', 'optionalDependencies'].map(field => manifest[field]?.[PI]).filter(value => value !== undefined);
 if (!ranges.length || ranges.some(value => typeof value !== 'string' || !/^[~^<>=*0-9][0-9A-Za-z.*~^<>=|+\s-]*$/.test(value)) || new Set(ranges).size !== 1) throw refusal('source Pi must be a direct registry dependency with one declared range');
 let sourceConfig;
 for (let dir = root; ; dir = path.dirname(dir)) {
  const pkg = dir === root ? manifest : JSON.parse(await optionalFile(adapters.fs, path.join(dir, 'package.json')) ?? '{}');
  const config = await optionalFile(adapters.fs, path.join(dir, 'pnpm-workspace.yaml'));
  if (pkg.workspaces !== undefined || (config !== undefined && (dir !== root || pin[1] !== 'pnpm'))) throw refusal('source workspaces are unsupported; update Pi from the workspace owner');
  if (dir === root) sourceConfig = config;
  if (path.dirname(dir) === dir) break;
 }
 const locks = [];
 for (const name of ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
  if (await optionalFile(adapters.fs, path.join(root, name)) !== undefined) locks.push(name);
 }
 const lock = pin[1] === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json';
 if (locks.length !== 1 || locks[0] !== lock) throw refusal(`source checkout needs only ${lock}; conflicting or missing lockfiles require manual resolution`);
 if (key(await canonical(path.join(root, lock))) !== key(path.join(root, lock))) throw refusal('source lockfile is linked outside the checkout');
 const peerRoot = await canonical(path.join(root, 'node_modules', PI));
 let packaged = false;
 for (let dir = peerRoot; ; dir = path.dirname(dir)) {
  if (path.basename(dir) === 'node_modules') { packaged = true; break; }
  let source = false;
  try { await adapters.fs.realpath(path.join(dir, '.git')); source = true; }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  if (source) throw refusal('source Pi is a linked source checkout; update that checkout separately');
  if (path.dirname(dir) === dir) break;
 }
 if (!packaged) throw refusal('source Pi has an unsupported installed override outside node_modules');
 const peerCli = await canonical(path.join(root, 'node_modules', PI, 'dist/bundle/cli.js'));
 if (key(peerCli) !== key(selected)) throw refusal('source checkout does not supply the selected adjacent Pi');
 const invocation = await invocationFor(pin[1], adapters, platform);
 if (!invocation) throw refusal(`source checkout requires ${pin[0]}`);
 const sourceEnv = pin[1] === 'pnpm' ? {...(env ?? process.env), COREPACK_ENABLE_PROJECT_SPEC:'0', COREPACK_ENABLE_NETWORK:'0'} : undefined;
 const probeOptions = {deadlineMs:30_000, cwd, ...(sourceEnv ? {env:sourceEnv} : {})};
 const version = await adapters.run(invocation.command, [...invocation.prefix, '--version'], probeOptions);
 const actual = typeof version.stdout === 'string' ? version.stdout.trim() : '';
 const compatible = pin[1] === 'pnpm' ? managerVersionAtLeast(actual, pin[2]) : actual === pin[2];
 if (!succeeded(version) || !compatible) throw refusal(`source checkout requires ${pin[0]}${pin[1] === 'pnpm' ? ' or newer' : ''}; the available manager version differs`);
 // Keep the compatible manager just checked; --dir must not acquire the older project pin.
 const sourceOptions = pin[1] === 'pnpm' ? ['--pm-on-fail=ignore'] : [];
 if (sourceConfig !== undefined) {
  const selectors = await adapters.run(invocation.command, [...invocation.prefix, 'config', 'get', 'packages', '--json', '--dir', root, ...sourceOptions], probeOptions);
  let packages;
  try {
   if (typeof selectors.stdout !== 'string') throw new Error('missing selector output');
   const text = selectors.stdout.trim();
   packages = text === '' || text === 'undefined' ? undefined : JSON.parse(text);
  }
  catch { throw refusal('source workspace package selectors could not be verified'); }
  if (!succeeded(selectors) || (packages != null && (!Array.isArray(packages) || packages.length !== 0))) throw refusal('source workspace package selectors are unsupported; update Pi from the workspace owner');
  const listing = await adapters.run(invocation.command, [...invocation.prefix, 'list', '--recursive', '--config.include-workspace-root=true', '--depth', '-1', '--json', '--dir', root, ...sourceOptions], probeOptions);
  let projects;
  try { projects = JSON.parse(listing.stdout); } catch { throw refusal('source workspace projects could not be verified'); }
  if (!succeeded(listing) || !Array.isArray(projects) || projects.length !== 1 || key(await canonical(projects[0]?.path)) !== key(root)) throw refusal('source workspace has other or unknown projects; update Pi from the workspace owner');
 }
 const flags = pin[1] === 'pnpm' ? ['--dir', root, '--lockfile-dir', root, '--recursive=false', '--ignore-pnpmfile', ...(sourceConfig === undefined ? [] : ['--workspace-root'])] : ['--prefix', root, '--workspaces=false', '--no-audit', '--no-fund'];
 return {name:pin[1], ...invocation, package:SHELL, spec:PI, sourceRoot:root, sourceConfig, sourceEnv, sourceOptions, linkPath,
  manifest:await adapters.fs.readFile(path.join(root, 'package.json'), 'utf8'),
  args:[pin[1] === 'pnpm' ? 'update' : 'install', PI, '--no-save', '--ignore-scripts', '--global=false', ...flags, ...sourceOptions]};
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
  for (const {pkg, dependency, groupRoot, listingRoot} of entries) {
   if ((pkg === SHELL) !== adjacent) continue;
   const linked = dependency.link === true || [dependency.resolved, dependency.version].some(value => typeof value === 'string' && LINKED.test(value));
   const root = await canonical(dependency.path);
   if (pkg === SHELL && key(root) !== key(shellRoot)) continue;
   if (linked && pkg === PI) throw refusal('listed supplier is a source or linked package');
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
    if (linked) {
     if (key(cli) === key(selected)) candidates.push(await sourceOwner({root, linkPath:dependency.path, manifest, selected, adapters, path, key, canonical, platform, cwd, env}));
     continue;
    }
    // Reinstalling the same Shell version re-resolves its peer; `update`
    // never upgrades Shell itself (that is `gentle-shell upgrade`).
    if (typeof manifest.version !== 'string') throw refusal('listed Shell version is missing');
    artifact = MAIN_BUILD.test(manifest.version);
    spec = artifact ? mainBuildTarball(manifest.version, {env, home, path}) : `${SHELL}@${manifest.version}`;
   }
   if (key(cli) !== key(selected)) continue;
   if (name === 'pnpm' && members.get(key(groupRoot)).size !== 1) throw refusal('selected supplier shares its global install group');
   // Keep the listing snapshot and selected identity: pnpm may replace both
   // this group and the versioned store root during the same installation.
   candidates.push({name, ...invocation, package:pkg, spec, artifact, groupRoot, listingRoot, members,
    from:dependency.from, shellVersion:pkg === SHELL ? manifest.version : undefined});
  }
 }
 if (candidates.length !== 1) throw refusal(candidates.length > 1 ? 'is ambiguous' : 'could not be verified from global listings');
 return candidates[0];
}

// Registry queries run in the same manager/config context as the install.
function viewIn(owner, input, args) {
 const scope = owner.sourceRoot
  ? owner.name === 'pnpm' ? ['--dir', owner.sourceRoot, ...owner.sourceOptions] : ['--prefix', owner.sourceRoot, '--workspaces=false']
  : owner.name === 'pnpm' ? ['--config.global=true'] : [];
 return input.adapters.run(owner.command, [...owner.prefix, 'view', ...args, ...scope],
  {deadlineMs:60_000, cwd:owner.sourceRoot ?? input.cwd, ...(owner.sourceEnv ? {env:owner.sourceEnv} : {})});
}

// Only a stable registry tag may become an install argument; never trust arbitrary output.
async function latestPublishedPi(owner, input) {
 const result = await viewIn(owner, input, [`${PI}@latest`, 'version']);
 if (!succeeded(result) || result.truncated) throw new Error(`gentle-shell update: the latest published Pi could not be resolved (${owner.name} view failed). No installation changed.`);
 const version = String(result.stdout ?? '').trim();
 if (!STABLE.test(version)) throw new Error(`gentle-shell update: the latest published Pi version ${JSON.stringify(version)} was rejected. No installation changed.`);
 return version;
}

const SIBLING = /^@earendil-works\/[a-z0-9][a-z0-9._-]*$/;
const MAX_SIBLINGS = 32;
// An exact version as pnpm accepts it in a minimumReleaseAgeExclude union.
const EXACT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// The published dependencies of one exact version, checked against its identity.
async function publishedDependencies(owner, input, name, version) {
 const result = await viewIn(owner, input, [`${name}@${version}`, '--json']);
 try {
  const manifest = JSON.parse(String(result.stdout ?? ''));
  const dependencies = manifest?.dependencies ?? {};
  if (!succeeded(result) || result.truncated || !object(manifest) || manifest.name !== name || manifest.version !== version ||
   !object(dependencies) || Object.values(dependencies).some(range => typeof range !== 'string')) throw new Error('invalid');
  return Object.entries(dependencies).filter(([dependency, range]) => SIBLING.test(dependency) && dependency !== PI && STABLE.test(range));
 } catch { throw new Error(`gentle-shell update: the published dependencies of ${name === PI ? 'Pi ' : `${name}@`}${version} could not be verified. No installation changed.`); }
}

/** Every Pi-scope package, as [name, version], that the selected Pi pins to an
 * exact stable version directly or through such a pinned package (pi-ai pins
 * pi-schema). They are published with Pi, so no older version can satisfy
 * them, and pnpm's strict release-age mode cannot approve them under
 * --no-save. Ranges, prereleases and other scopes stay age-filtered. The walk
 * visits each package version once and is bounded.
 */
async function piSiblings(owner, input, version) {
 const found = new Map();
 let pending = await publishedDependencies(owner, input, PI, version);
 while (pending.length) {
  const level = [];
  for (const [name, exact] of pending) {
   if (found.has(`${name}@${exact}`)) continue;
   if (found.size >= MAX_SIBLINGS) throw new Error(`gentle-shell update: Pi ${version} pins more than ${MAX_SIBLINGS} @earendil-works packages; their release age could not be verified. No installation changed.`);
   found.set(`${name}@${exact}`, [name, exact]);
   level.push([name, exact]);
  }
  pending = (await Promise.all(level.map(([name, exact]) => publishedDependencies(owner, input, name, exact)))).flat();
 }
 return [...found.values()];
}

// pnpm's matcher (parseVersionPolicyRule) splits a rule at the `@` after a scope.
function exclusionName(entry) {
 const at = entry.startsWith('@') ? entry.indexOf('@', 1) : entry.indexOf('@');
 return at === -1 ? {name:entry, versions:null} : {name:entry.slice(0, at), versions:entry.slice(at + 1)};
}

// CLI values replace pnpm's configured list, so read the effective list in the
// install context and pass it back intact with Pi and its exact siblings added.
// pnpm applies only the first rule naming a package, so a new version joins
// that name's existing rule as one `name@a || b` union (a bare name already
// covers every version); a rule it cannot merge safely is refused. pnpm
// represents a single CLI value as a string, not an array; repeat it when the
// list has one entry.
async function piAgeExclusion(owner, input, siblings) {
 const scope = owner.sourceRoot ? ['--dir', owner.sourceRoot, ...owner.sourceOptions] : ['--global'];
 const result = await input.adapters.run(owner.command, [...owner.prefix, 'config', 'get', 'minimumReleaseAgeExclude', '--json', ...scope],
  {deadlineMs:30_000, cwd:owner.sourceRoot ?? input.cwd, ...(owner.sourceEnv ? {env:owner.sourceEnv} : {})});
 const invalid = () => new Error('gentle-shell update: pnpm release-age exclusions could not be verified. No installation changed.');
 let entries;
 try {
  const text = String(result.stdout ?? '').trim();
  entries = text === '' || text === 'undefined' ? [] : JSON.parse(text);
  if (typeof entries === 'string') entries = [entries];
  if (!succeeded(result) || result.truncated || !Array.isArray(entries) || entries.some(entry => typeof entry !== 'string' || !entry)) throw new Error('invalid');
 } catch { throw invalid(); }
 // Wanted versions per name, in order; null means every version (Pi itself).
 const wanted = new Map([[PI, null]]);
 for (const [name, version] of siblings) if (wanted.get(name) !== null) wanted.set(name, [...(wanted.get(name) ?? []), version]);
 const merged = new Map();
 for (const entry of entries) {
  const {name, versions} = exclusionName(entry);
  if (!wanted.has(name)) continue;
  const listed = versions === null ? null : versions.split('||').map(version => version.trim());
  if (listed?.some(version => !EXACT.test(version))) throw invalid();
  const before = merged.has(name) ? merged.get(name) : [];
  merged.set(name, before === null || listed === null ? null : [...before, ...listed]);
 }
 const rule = name => {
  const versions = merged.has(name) && merged.get(name) === null || wanted.get(name) === null ? null : [...new Set([...(merged.get(name) ?? []), ...wanted.get(name)])];
  return versions === null ? name : `${name}@${versions.join(' || ')}`;
 };
 const placed = new Set();
 const list = [];
 for (const entry of entries) {
  const {name} = exclusionName(entry);
  if (!wanted.has(name)) list.push(entry);
  else if (!placed.has(name)) { placed.add(name); list.push(rule(name)); }
 }
 for (const name of wanted.keys()) if (!placed.has(name)) list.push(rule(name));
 if (list.length === 1) list.push(list[0]);
 return list.map(entry => `--config.minimum-release-age-exclude=${entry}`);
}

/** The Pi version the owner's package now supplies, read back from a fresh
 * listing after the install; null when continuity or identity is uncertain.
 */
async function suppliedPiVersion(owner, {platform, adapters, cwd}) {
 const {path, key} = pathsFor(platform);
 const canonical = canonicalWith(adapters, path);
 try {
  const groups = await globalListing(owner.name, owner, adapters, cwd);
  const {entries, members} = await listedEntries(groups, {adapters, path, key, canonical});
  const removed = [...owner.members.keys()].filter(group => !members.has(group));
  const added = [...members.keys()].filter(group => !owner.members.has(group));
  // An unchanged group must keep its complete membership. A replacement can
  // be attributed only when the selected group alone disappeared and exactly
  // one group appeared; never select a package just because it is first/latest.
  for (const [group, before] of owner.members) {
   const after = members.get(group);
   if (after && (before.size !== after.size || [...before].some(pkg => !after.has(pkg)))) return null;
  }
  let target;
  if (removed.length === 0 && added.length === 0) target = key(owner.groupRoot);
  else if (owner.name === 'pnpm' && owner.listingRoot && removed.length === 1 && removed[0] === key(owner.groupRoot) && added.length === 1) target = added[0];
  else return null;
  const matches = entries.filter(entry => entry.pkg === owner.package && key(entry.groupRoot) === target);
  if (matches.length !== 1 || (owner.name === 'pnpm' && members.get(target)?.size !== 1)) return null;
  const {pkg, dependency, groupRoot, listingRoot} = matches[0];
  if (listingRoot !== owner.listingRoot || (owner.from !== undefined && typeof owner.from !== 'string') || dependency.from !== owner.from ||
   dependency.link === true || [dependency.resolved, dependency.version].some(value => typeof value === 'string' && LINKED.test(value))) return null;
  const root = await canonical(dependency.path);
  const manifest = await manifestOf(adapters, path, root);
  if (manifest.name !== pkg || typeof manifest.version !== 'string' || !manifest.version ||
   (dependency.version !== undefined && dependency.version !== manifest.version)) return null;
  if (pkg === PI) {
   if (manifest.bin?.pi !== 'dist/bundle/cli.js') return null;
   const cli = await canonical(path.join(root, manifest.bin.pi));
   return key(cli) === key(path.join(root, manifest.bin.pi)) ? manifest.version : null;
  }
  if (manifest.version !== owner.shellVersion) return null;
  const peer = await adjacentPeer({shellRoot: root, groupRoot, adapters, path, key, canonical});
  return typeof peer?.manifest.version === 'string' && peer.manifest.version ? peer.manifest.version : null;
 } catch {
  return null;
 }
}

export async function updateSelectedPi(input) {
 let owner;
 try { owner = await resolveUpdateOwner(input); }
 catch (error) { throw error.message?.includes('ownership') ? error : refusal('could not be resolved'); }
 if (owner.artifact) {
  try { await input.adapters.fs.realpath(owner.spec); }
  catch { throw new Error(`gentle-shell update: the main-channel build ${owner.spec} is missing, and this unpublished build cannot be reinstalled from the registry; run 'gentle-shell upgrade --channel release' and then 'gentle-shell upgrade --channel main' to rebuild it. No installation changed.`); }
 }
 const latest = await latestPublishedPi(owner, input);
 const ageExclusion = owner.name === 'pnpm' ? await piAgeExclusion(owner, input, await piSiblings(owner, input, latest)) : [];
 // Exactly one approved package per command; never create a comma group or
 // reinstall arbitrary dependencies merely because they share a store. The
 // exact global Pi version is transient, not a source manifest pin.
 const spec = owner.package === PI ? `${PI}@${latest}` : owner.spec;
 const args = owner.args ? owner.args.map(arg => arg === PI ? `${PI}@${latest}` : arg)
  : (owner.name === 'pnpm' ? ['add', '-g', spec, ...(owner.package === SHELL ? ['--allow-build=gentle-pi'] : [])] : ['install', '-g', spec, ...(owner.package === PI ? ['--ignore-scripts'] : [])]);
 args.push(...ageExclusion);
 const result = await input.adapters.run(owner.command, [...owner.prefix, ...args], {deadlineMs:20 * 60_000, cwd: owner.sourceRoot ?? input.cwd, stderrTail:4096, ...(owner.sourceEnv ? {env:owner.sourceEnv} : {})});
 if (!succeeded(result)) {
  // One sanitized line of the manager's own error: npm prints it on stderr,
  // pnpm 11 prints ERR_PNPM_* on stdout. Read as one text, stderr last, an
  // error line in either stream wins over a stderr warning, stderr's on a tie.
  const output = [result?.stdout, result?.stderrTail].filter(text => typeof text === 'string').join('\n');
  const detail = setupErrorDetail(output, input.home, input.platform);
  throw new Error(`gentle-shell update: ${owner.name} (${[owner.command, ...owner.prefix].join(' ')}) could not install ${owner.sourceRoot ? `${PI}@${latest}` : spec}${detail ? `\n${detail}` : ''}`);
 }
 if (owner.sourceRoot) {
  const {path, key} = pathsFor(input.platform ?? process.platform);
  const canonical = canonicalWith(input.adapters, path);
  let sameLink = false;
  try { sameLink = key(await canonical(owner.linkPath)) === key(owner.sourceRoot); } catch { /* checked below */ }
  if (!sameLink) throw new Error('gentle-shell update: the Shell link changed during the source update; inspect the installation before retrying.');
  if (await input.adapters.fs.readFile(path.join(owner.sourceRoot, 'package.json'), 'utf8') !== owner.manifest) throw new Error('gentle-shell update: the source manifest changed during the update; inspect the checkout before retrying.');
  if (owner.sourceConfig !== undefined && await input.adapters.fs.readFile(path.join(owner.sourceRoot, 'pnpm-workspace.yaml'), 'utf8') !== owner.sourceConfig) throw new Error('gentle-shell update: the source pnpm configuration changed during the update; inspect the checkout before retrying.');
  let after = null;
  try {
   const peer = await adjacentPeer({shellRoot:owner.sourceRoot, adapters:input.adapters, path, key, canonical});
   const nested = await canonical(path.join(owner.sourceRoot, 'node_modules', PI, 'dist/bundle/cli.js'));
   if (peer && key(peer.cli) === key(nested)) after = peer.manifest.version ?? null;
  } catch { /* Never invent readback after a successful manager invocation. */ }
  const location = `${owner.name} updated ${PI} in ${owner.sourceRoot}`;
  if (after !== null && after !== latest) throw new Error(`gentle-shell update: ${owner.name} supplied Pi ${after}, not the latest published Pi ${latest}; inspect the source checkout before retrying.`);
  if (after === null) input.out?.(`${location}. The Pi version could not be read back; run 'gentle-shell --version' to check it.`);
  else input.out?.(`${location}; the selected Pi is ${after === input.currentVersion ? 'still' : 'now'} ${after}${after !== input.currentVersion && input.currentVersion !== undefined ? ` (was ${input.currentVersion})` : ''}.`);
  return 0;
 }
 const after = await suppliedPiVersion(owner, input);
 const before = input.currentVersion;
 if (after !== null && after !== latest) throw new Error(`gentle-shell update: ${owner.name} supplied Pi ${after}, not the latest published Pi ${latest}; inspect the installation before retrying.`);
 if (after === null) input.out?.(`${owner.name} installed ${spec}. The Pi version it now supplies could not be read back; run 'gentle-shell --version' to check it.`);
 else if (before !== undefined && after === before) input.out?.(`${owner.name} installed ${spec}, and the selected Pi is still ${after}.`);
 else input.out?.(`${owner.name} installed ${spec}; the selected Pi is now ${after}${before !== undefined ? ` (was ${before})` : ''}.`);
 return 0;
}
