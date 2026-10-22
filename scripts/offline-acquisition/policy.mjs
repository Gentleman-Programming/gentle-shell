export const PINS = Object.freeze({
  candidate: 'c1617e90b81bac5a897a10211797bc30169794bf',
  node: '24.21.0', pnpm: '11.1.1',
  pnpmIntegrity: 'sha512-0f319zxhe2T6GlaoHDyN/g6WbjOmAQqiVrUXrne+Idk+Ba/8DeGoOw5PKdVp9otEaujwaM1yR8C7PfD7TXvfmg==',
  inputDirectory: 'C:/ShellFixtureInput',
  localTar: 'C:/ShellFixtureInput/gentle-pi-4.3.0.tgz',
});

// Pure policy only: no filesystem, process, network, or candidate imports.
function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected record');
  requireValue(Object.keys(value).sort().join('|') === [...keys].sort().join('|'), 'Unexpected or missing fields');
}

function windowsPath(value) {
  requireValue(typeof value === 'string' && /^[A-Z]:\\(?:[^\\<>:"/|?*;\x00-\x1f]+\\)*[^\\<>:"/|?*;\x00-\x1f]+$/.test(value), 'Expected absolute Windows path');
  requireValue(!value.split('\\').some(part => part === '.' || part === '..' || /[. ]$/.test(part)), 'Ambiguous path');
  return value;
}

const ENV_KEYS = ['APPDATA', 'CI', 'HOME', 'LOCALAPPDATA', 'PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE'];

// The caller must create these private directories and empty configuration files
// before spawning; this function deliberately never spreads process.env.
export function closedEnvironment(paths) {
  exactKeys(paths, ['root', 'nodeDirectory', 'systemRoot']);
  const root = windowsPath(paths.root);
  const node = windowsPath(paths.nodeDirectory);
  const system = windowsPath(paths.systemRoot);
  return {
    APPDATA: `${root}\\home\\AppData\\Roaming`, CI: 'true',
    HOME: `${root}\\home`, LOCALAPPDATA: `${root}\\home\\AppData\\Local`,
    PATH: `${node};${system}\\System32`, SystemRoot: system,
    TEMP: `${root}\\tmp`, TMP: `${root}\\tmp`, USERPROFILE: `${root}\\home`,
  };
}

// pnpm 11.1.1 reads getConfigDir(process) before applying CLI options.
// Keep the Windows LOCALAPPDATA fallback identical to config.config-dir; no XDG
// or npm/pnpm environment overrides enter the existing closed environment.
export function pnpmConfiguration(paths) {
  const env = closedEnvironment(paths);
  const directory = `${env.LOCALAPPDATA}\\pnpm\\config`;
  const authFile = `${paths.root}\\empty-auth.npmrc`;
  // General config types are NOT per-command CLI options. The pinned parser
  // strips config.* before unknown-option checks; assignments avoid ambiguity.
  return { directory, authFile, flags: [`--config.config-dir=${directory}`, `--config.npmrc-auth-file=${authFile}`] };
}

export function validateConfigurationProbe(record, expected) {
  requireValue(record.exit === 0 && record.stderr === '', 'pnpm configuration probe failed');
  requireValue(record.stdout === `${JSON.stringify(expected)}\n` || record.stdout === `${JSON.stringify(expected)}\r\n`, 'Unexpected pnpm configuration path');
}

export function pairFiles(candidate) {
  requireValue(candidate === PINS.candidate, 'Candidate SHA rejected');
  const project = {
    name: 'gentle-shell-distribution', version: '4.3.0', private: true,
    dependencies: { 'gentle-pi': `file:${PINS.localTar}`, '@earendil-works/pi-coding-agent': '1.2.0' },
  };
  // Mirrors candidate distributionFiles as DATA. Lifecycle flags remain mandatory
  // even though the original workspace admits gentle-pi build scripts.
  return {
    'package.json': `${JSON.stringify(project, null, '\t')}\n`,
    'pnpm-workspace.yaml': 'allowBuilds:\n  gentle-pi: true\nstrictDepBuilds: false\n',
  };
}

// Argument vectors only, never shell text. T1b must supply isolated cwd, store,
// virtual-store and config locations, and enforce admission BETWEEN resolve/fetch.
export function commandPlan() {
  const flags = ['--ignore-scripts', '--ignore-pnpmfile', '--pm-on-fail=error', '--registry=https://registry.npmjs.org/'];
  return {
    probe: ['config', 'get', '--json', '--config.ignore-scripts=true', '--config.ignore-pnpmfile=true'],
    pack: ['pack', '--ignore-scripts', '--offline', '--pack-destination', PINS.inputDirectory],
    resolve: ['install', '--lockfile-only', ...flags],
    fetch: ['fetch', ...flags],
  };
}

// INPUT CONTRACT, not a YAML validator: each record is one actual resolved
// source, including optional/platform packages, after full semantic traversal.
// T1b must parse with a verified trusted parser, reject unsupported lock/config
// fields, validate every importer/snapshot/reference and prohibit omitted nodes.
// No extraction with regular expressions or metadata-only top-level checks.
export function admitSources(sources) {
  requireValue(Array.isArray(sources) && sources.length > 0, 'Sources missing');
  let localCount = 0;
  const result = sources.map(source => {
    requireValue(source !== null && typeof source === 'object', 'Invalid source');
    if (source.kind === 'local') {
      exactKeys(source, ['kind', 'name', 'version', 'path', 'sha256']);
      requireValue(source.name === 'gentle-pi' && source.version === '4.3.0' && source.path === PINS.localTar, 'Unadmitted local source');
      requireValue(typeof source.sha256 === 'string' && /^[a-f0-9]{64}$/.test(source.sha256), 'Local hash missing');
      localCount++;
    } else {
      exactKeys(source, ['kind', 'name', 'version', 'url', 'integrity']);
      requireValue(source.kind === 'registry', 'Unadmitted source protocol');
      requireValue(typeof source.name === 'string' && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(source.name), 'Invalid package name');
      requireValue(typeof source.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(source.version), 'Non-exact version');
      const basename = source.name.split('/').at(-1);
      // Closed canonical registry URL, not a claim of network containment.
      requireValue(source.url === `https://registry.npmjs.org/${source.name}/-/${basename}-${source.version}.tgz`, 'Unadmitted registry origin');
      requireValue(typeof source.integrity === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(source.integrity), 'SHA512 SRI required');
      const encoded = source.integrity.slice(7);
      requireValue(Buffer.from(encoded, 'base64').toString('base64') === encoded, 'Noncanonical SRI');
    }
    return { ...source };
  });
  requireValue(localCount === 1, 'Expected exactly one candidate local tar');
  return result;
}

// Projection is intentionally not a redactor: only closed-env commands and
// non-secret streams may enter it. T1b must retain full streams in owned files;
// this bounded summary records lengths/truncation and never turns failure green.
export function projectEvidence(record, limit = 4096) {
  requireValue(Number.isInteger(limit) && limit > 0 && limit <= 65536, 'Invalid evidence bound');
  requireValue(Array.isArray(record.command) && record.command.length > 0 && record.command.every(x => typeof x === 'string' && x.length <= 4096), 'Invalid argv');
  exactKeys(record.env, ENV_KEYS);
  requireValue(Object.values(record.env).every(x => typeof x === 'string'), 'Invalid environment values');
  requireValue(Number.isInteger(record.exit) || (record.exit === null && typeof record.error === 'string' && record.error.length > 0), 'Missing exit/failure');
  requireValue(typeof record.stdout === 'string' && typeof record.stderr === 'string', 'Missing streams');
  requireValue(record.error === undefined || typeof record.error === 'string', 'Invalid error');
  return {
    command: [...record.command], env: { ...record.env }, exit: record.exit,
    stdout: record.stdout.slice(0, limit), stdoutLength: record.stdout.length, stdoutTruncated: record.stdout.length > limit,
    stderr: record.stderr.slice(0, limit), stderrLength: record.stderr.length, stderrTruncated: record.stderr.length > limit,
    error: (record.error ?? '').slice(0, limit), errorLength: (record.error ?? '').length,
    errorTruncated: (record.error ?? '').length > limit,
  };
}
