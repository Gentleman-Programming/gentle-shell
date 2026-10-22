import { gunzipSync } from 'node:zlib';
import { PINS, admitSources, pairFiles } from './policy.mjs';

function check(ok, message) { if (!ok) throw new Error(message); }
function record(value) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Expected mapping');
  return value;
}
function keys(value, allowed) {
  for (const key of Object.keys(record(value))) check(allowed.includes(key), `Unsupported field: ${key}`);
}

// Deliberately narrow ustar reader: no links, devices, PAX or GNU extensions.
// Unsupported pinned archives fail before extraction; no tar command is trusted
// to decide containment. All entries are inspected before the caller writes any.
export function inspectArchive(compressed) {
  check(compressed.length <= 64 * 1024 * 1024, 'Archive too large');
  const tar = gunzipSync(compressed, { maxOutputLength: 256 * 1024 * 1024 });
  const entries = [], seen = new Set();
  const text = (header, start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
  const octal = value => { check(/^[0-7]+$/.test(value.trim()), 'Invalid tar number'); return parseInt(value.trim(), 8); };
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(x => x === 0)) {
      check(tar.length - offset >= 1024 && tar.subarray(offset).every(x => x === 0), 'Invalid tar trailer');
      return entries;
    }
    const checksum = octal(text(header, 148, 8));
    check(header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0) === checksum, 'Tar checksum mismatch');
    check(text(header, 257, 6) === 'ustar', 'Unsupported tar format');
    const prefix = text(header, 345, 155);
    const name = `${prefix ? `${prefix}/` : ''}${text(header, 0, 100)}`.replace(/\/$/, '');
    check(name.startsWith('package/') || name === 'package', 'Archive root rejected');
    check(name.split('/').every(part => part && !/^\.{1,2}$/.test(part) && !/[\\:\x00-\x1f<>"|?*]/.test(part) && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)), 'Unsafe archive path');
    const lower = name.toLowerCase();
    check(!seen.has(lower), 'Duplicate archive entry'); seen.add(lower);
    const type = text(header, 156, 1);
    check(type === '0' || type === '' || type === '5', 'Archive links/extensions rejected');
    const size = octal(text(header, 124, 12));
    check(type !== '5' || size === 0, 'Directory payload rejected');
    const end = offset + 512 + size;
    check(end <= tar.length && entries.length < 50000, 'Truncated or excessive archive');
    entries.push({ name, directory: type === '5', data: tar.subarray(offset + 512, end) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('Missing tar trailer');
}

export function requireHostedWindows({ platform, env }) {
  check(platform === 'win32' && env.GITHUB_ACTIONS === 'true' && env.RUNNER_OS === 'Windows' && env.RUNNER_ENVIRONMENT === 'github-hosted' && env.GITHUB_REPOSITORY === 'Gentleman-Programming/gentle-shell' && env.GITHUB_REF === 'refs/heads/ci/2360-offline-acquisition' && env.GITHUB_EVENT_NAME === 'push' && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') && env.RUNNER_TEMP && env.GITHUB_WORKSPACE, 'Requires canonical GitHub-hosted Windows push context');
}

export function requireSuccess(result) {
  if (result.exit !== 0 || result.error) throw Object.assign(new Error('Acquisition command failed'), { result });
}

// This operates on a complete YAML document's plain-data projection. Schema
// whitelists fail closed; package IDs are never harvested from YAML with regex.
export function normalizeLock(lock, tar) {
  keys(lock, ['lockfileVersion', 'settings', 'importers', 'packages', 'snapshots']);
  check(lock.lockfileVersion === '9.0', 'Unsupported lock version');
  keys(lock.settings, ['autoInstallPeers', 'excludeLinksFromLockfile']);
  check(lock.settings.autoInstallPeers === true && lock.settings.excludeLinksFromLockfile === false, 'Unsupported lock settings');
  keys(lock.importers, ['.']); keys(lock.importers['.'], ['dependencies']);
  const wanted = JSON.parse(pairFiles(PINS.candidate)['package.json']).dependencies;
  const deps = record(lock.importers['.'].dependencies);
  check(Object.keys(deps).sort().join() === Object.keys(wanted).sort().join(), 'Pair importer mismatch');
  const packages = record(lock.packages), snapshots = record(lock.snapshots);
  check(Object.keys(packages).length > 0 && Object.keys(packages).length <= 10000 && Object.keys(snapshots).length <= 20000, 'Invalid lock size');
  const localId = `gentle-pi@file:${PINS.localTar}`;
  const registryId = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
  const sources = [], covered = new Set();
  for (const [id, pkg] of Object.entries(packages)) {
    keys(pkg, ['resolution', 'engines', 'os', 'cpu', 'libc', 'deprecated', 'hasBin', 'requiresBuild', 'peerDependencies', 'peerDependenciesMeta', 'optional', 'bundledDependencies']);
    // Metadata can describe peers/platforms but must never introduce config or
    // executable resolution. References that fetch are checked in snapshots.
    for (const flag of ['hasBin', 'requiresBuild', 'optional']) if (flag in pkg) check(typeof pkg[flag] === 'boolean', 'Invalid package flag');
    for (const field of ['os', 'cpu', 'libc', 'bundledDependencies']) if (field in pkg) check(Array.isArray(pkg[field]) && pkg[field].every(x => typeof x === 'string'), 'Invalid package list');
    for (const field of ['engines', 'peerDependencies']) if (field in pkg) check(Object.values(record(pkg[field])).every(x => typeof x === 'string'), 'Invalid package metadata');
    if ('peerDependenciesMeta' in pkg) for (const meta of Object.values(record(pkg.peerDependenciesMeta))) { keys(meta, ['optional']); check(typeof meta.optional === 'boolean', 'Invalid peer metadata'); }
    const resolution = record(pkg.resolution);
    keys(resolution, ['integrity', 'tarball']);
    if (id === localId) {
      check(resolution.tarball === `file:${PINS.localTar}` && resolution.integrity === tar.integrity, 'Candidate tar integrity/origin mismatch');
      sources.push({ kind: 'local', name: 'gentle-pi', version: '4.3.0', path: PINS.localTar, sha256: tar.sha256 });
    } else {
      const match = registryId.exec(id); check(match, `Unsupported package ID: ${id}`);
      const [, name, version] = match;
      const url = `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`;
      check(!('tarball' in resolution) || resolution.tarball === url, 'Unadmitted explicit tarball');
      sources.push({ kind: 'registry', name, version, url, integrity: resolution.integrity });
    }
  }
  function reference(name, version) {
    // pnpm aliases may reference the target's full package ID instead of a
    // bare version. Either way, only an already-admitted snapshot can resolve.
    check(typeof version === 'string' && (Object.hasOwn(snapshots, `${name}@${version}`) || Object.hasOwn(snapshots, version)), `Missing/unsupported dependency reference: ${name}`);
  }
  for (const [name, dep] of Object.entries(deps)) {
    keys(dep, ['specifier', 'version']); check(dep.specifier === wanted[name], 'Pair specifier mismatch');
    reference(name, dep.version);
    check(dep.version.split('(')[0] === (name === 'gentle-pi' ? wanted[name] : '1.2.0'), 'Pair resolved version mismatch');
  }
  for (const [id, snapshot] of Object.entries(snapshots)) {
    const base = id.split('(')[0];
    check(Object.hasOwn(packages, base), 'Snapshot without admitted package'); covered.add(base);
    const suffix = id.slice(base.length);
    check(!suffix || /^\([@a-zA-Z0-9_./+()=-]+\)$/.test(suffix), 'Unsupported snapshot peer suffix');
    let depth = 0;
    for (const char of suffix) { if (char === '(') depth++; if (char === ')') depth--; check(depth >= 0, 'Invalid peer suffix'); }
    check(depth === 0, 'Unbalanced peer suffix');
    keys(snapshot, ['dependencies', 'optionalDependencies', 'transitivePeerDependencies', 'optional']);
    if ('optional' in snapshot) check(typeof snapshot.optional === 'boolean', 'Invalid snapshot optional');
    if ('transitivePeerDependencies' in snapshot) check(Array.isArray(snapshot.transitivePeerDependencies) && snapshot.transitivePeerDependencies.every(x => typeof x === 'string'), 'Invalid transitive peers');
    for (const field of ['dependencies', 'optionalDependencies']) if (field in snapshot) for (const [name, version] of Object.entries(record(snapshot[field]))) reference(name, version);
  }
  check(covered.size === Object.keys(packages).length, 'Package without snapshot');
  return admitSources(sources);
}
