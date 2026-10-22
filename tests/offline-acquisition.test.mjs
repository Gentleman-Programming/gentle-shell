import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectArchive, normalizeLock, requireHostedWindows, requireSuccess } from '../scripts/offline-acquisition/safety.mjs';
import assert from 'node:assert/strict';
import { closedEnvironment, pairFiles, commandPlan, admitSources, projectEvidence, PINS, pnpmConfiguration, validateConfigurationProbe } from '../scripts/offline-acquisition/policy.mjs';

// Isolated launcher boundary: no acquisition runner or positive Actions context.
for (const multiple of [false, true]) test(`T5 launcher ${multiple ? 'multiple' : 'single'} application matches`, { skip: process.platform !== 'win32' }, () => {
  mkdirSync(resolve('tmp/offline-acquisition-config'), { recursive: true });
  const root = mkdtempSync(resolve('tmp/offline-acquisition-config/case-'));
  const controls = join(root, 'controls');
  const scripts = join(controls, 'scripts/offline-acquisition');
  mkdirSync(scripts, { recursive: true });
  const runner = join(scripts, 'runner.mjs');
  writeFileSync(runner, `console.log(JSON.stringify({ sentinel: 'inert-only', executable: process.execPath, env: process.env })); console.error('fixture-stderr'); process.exitCode = 23;`);
  const preload = join(root, 'preload.cjs');
  writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'unexpected-preload'))}, 'BAD');`);
  const counter = join(root, 'counter');
  writeFileSync(counter, 'unchanged');
  const quote = x => `'${x.replaceAll("'", "''")}'`;
  const wrapper = join(root, 'invoke.ps1');
  writeFileSync(wrapper, `function Get-Command { param($Name, $CommandType)\n[pscustomobject]@{ Source = ${quote(process.execPath)} }\n${multiple ? `[pscustomobject]@{ Source = ${quote(join(root, 'other-node.exe'))} }` : ''}\n}\n& ${quote(resolve('scripts/offline-acquisition/launch.ps1'))}\nexit $LASTEXITCODE\n`);
  const snapshot = () => readdirSync(root, { recursive: true }).sort().map(p => [p, p.endsWith('.mjs') || p.endsWith('.cjs') || p.endsWith('.ps1') || p === 'counter' ? readFileSync(join(root, p), 'utf8') : null]);
  const before = snapshot();
  const env = { ...process.env, SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT, GITHUB_WORKSPACE: root, RUNNER_TEMP: root, RUNNER_OS: 'local-fixture', RUNNER_ENVIRONMENT: 'local-fixture', GITHUB_ACTIONS: 'false', GITHUB_REPOSITORY: 'fixture/only', GITHUB_REF: 'fixture', GITHUB_EVENT_NAME: 'fixture', GITHUB_SHA: 'fixture', FIXTURE_SECRET: 'must-not-forward', NODE_OPTIONS: `--require "${preload}"`, NODE_PATH: root, NODE_V8_COVERAGE: root };
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', wrapper], { env, encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  assert.deepEqual(snapshot(), before, 'no fixture files or counters changed');
  assert.equal(result.status, 23, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(result.stderr, 'fixture-stderr\n');
  const output = JSON.parse(result.stdout);
  assert.equal(output.sentinel, 'inert-only');
  assert.equal(output.executable, process.execPath, 'first setup-node discovery match only');
  const allowed = ['SystemRoot', 'RUNNER_TEMP', 'RUNNER_OS', 'RUNNER_ENVIRONMENT', 'GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_REF', 'GITHUB_EVENT_NAME', 'GITHUB_SHA', 'GITHUB_WORKSPACE'];
  assert.deepEqual(Object.keys(output.env).sort(), allowed.sort());
  for (const name of allowed) assert.equal(output.env[name], env[name]);
});

const paths = { root: 'C:\\acquire', nodeDirectory: 'C:\\tools\\node', systemRoot: 'C:\\Windows' };
const sri = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const registry = { kind: 'registry', name: '@scope/pkg', version: '1.2.0', url: 'https://registry.npmjs.org/@scope/pkg/-/pkg-1.2.0.tgz', integrity: sri };
const local = { kind: 'local', name: 'gentle-pi', version: '4.3.0', path: PINS.localTar, sha256: 'a'.repeat(64) };

// Pure public calls must neither mutate supplied data nor perform I/O on rejection.
function rejectsUnchanged(fn, input) {
  const before = structuredClone(input);
  assert.throws(() => fn(input));
  assert.deepEqual(input, before);
}

test('closed child environment ignores inherited configuration and tokens', () => {
  const env = closedEnvironment(paths);
  assert.deepEqual(Object.keys(env).sort(), ['APPDATA', 'CI', 'HOME', 'LOCALAPPDATA', 'PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE'].sort());
  assert.equal(env.HOME, 'C:\\acquire\\home');
  assert.equal(env.PATH, 'C:\\tools\\node;C:\\Windows\\System32');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.npm_config_userconfig, undefined);
  rejectsUnchanged(closedEnvironment, { ...paths, root: 'relative' });
  rejectsUnchanged(closedEnvironment, { ...paths, token: 'untrusted' });
  rejectsUnchanged(closedEnvironment, { ...paths, nodeDirectory: 'C:\\tools;C:\\other' });
});

test('S7 private pinned-pnpm configuration and bounded probe validation', () => {
  const plan = pnpmConfiguration(paths);
  assert.equal(plan.directory, 'C:\\acquire\\home\\AppData\\Local\\pnpm\\config');
  assert.equal(plan.authFile, 'C:\\acquire\\empty-auth.npmrc');
  assert.deepEqual(plan.flags, [`--config.config-dir=${plan.directory}`, `--config.npmrc-auth-file=${plan.authFile}`]);
  for (const expected of [plan.directory, plan.authFile]) {
    const record = { exit: 0, stdout: `${JSON.stringify(expected)}\n`, stderr: '' };
    validateConfigurationProbe(record, expected);
    for (const change of [{ exit: 1 }, { stderr: 'warning' }, { stdout: 'undefined\n' }, { stdout: '"C:\\\\runner-home"\n' }]) {
      const bad = { ...record, ...change };
      const before = structuredClone(bad);
      assert.throws(() => validateConfigurationProbe(bad, expected));
      assert.deepEqual(bad, before);
    }
  }
  rejectsUnchanged(pnpmConfiguration, { ...paths, root: 'relative' });
  rejectsUnchanged(pnpmConfiguration, { ...paths, XDG_CONFIG_HOME: 'C:\\outside' });
  plan.flags.push('--userconfig');
  assert.equal(pnpmConfiguration(paths).flags.includes('--userconfig'), false);
});

// Bounded fixture MODEL of inspected pnpm11.1.1 command admission, not its CLI.
// Source: GLOBAL_OPTIONS254465; config types197501; install types165205/165474;
// fetch reuses install types165568; config.* normalization253433-253456/253489.
// Only ordinary options used by these public plans are included below.
function modeledOptions(route, args) {
  const common = ['pm-on-fail'];
  const specific = route === 'probe' ? ['global', 'location', 'json'] :
    ['lockfile-only', 'ignore-scripts', 'ignore-pnpmfile', 'registry'];
  const allowed = new Set([...common, ...specific]);
  const unknown = [], normalized = {};
  for (const arg of args.filter(value => value.startsWith('--'))) {
    const [name, ...value] = arg.slice(2).split('=');
    if (name.startsWith('config.')) normalized[name.slice(7)] = value.join('=');
    else if (!allowed.has(name)) unknown.push(name);
  }
  return { unknown, normalized };
}

for (const route of ['probe', 'resolve', 'fetch']) test(`S7 command admission model ${route}`, () => {
  const plan = commandPlan();
  const config = pnpmConfiguration(paths);
  const old = ['--config-dir', config.directory, '--npmrc-auth-file', config.authFile];
  assert.deepEqual(modeledOptions(route, old).unknown, ['config-dir', 'npmrc-auth-file']);
  if (route === 'probe') {
    assert.deepEqual(modeledOptions(route, ['--ignore-scripts', '--ignore-pnpmfile']).unknown,
      ['ignore-scripts', 'ignore-pnpmfile']);
  } else {
    assert.ok(plan[route].includes('--ignore-scripts'));
    assert.ok(plan[route].includes('--ignore-pnpmfile'));
  }
  if (route === 'probe') assert.deepEqual(plan.probe,
    ['config', 'get', '--json', '--config.ignore-scripts=true', '--config.ignore-pnpmfile=true']);
  const args = [...plan[route], ...config.flags];
  const before = structuredClone(args);
  const result = modeledOptions(route, args);
  assert.deepEqual(args, before);
  assert.deepEqual(result.unknown, [], `${route}: command-specific unknown options`);
  assert.equal(result.normalized['config-dir'], config.directory);
  assert.equal(result.normalized['npmrc-auth-file'], config.authFile);
  if (route === 'probe') {
    assert.equal(result.normalized['ignore-scripts'], 'true');
    assert.equal(result.normalized['ignore-pnpmfile'], 'true');
  }
});

test('candidate pair is exact and local source identity is honest', () => {
  const files = pairFiles(PINS.candidate);
  const project = JSON.parse(files['package.json']);
  assert.deepEqual(project.dependencies, { 'gentle-pi': 'file:C:/ShellFixtureInput/gentle-pi-4.3.0.tgz', '@earendil-works/pi-coding-agent': '1.2.0' });
  assert.equal(project.version, '4.3.0');
  assert.equal(files['pnpm-workspace.yaml'], 'allowBuilds:\n  gentle-pi: true\nstrictDepBuilds: false\n');
  assert.throws(() => pairFiles('eebd9'));
});

test('finite plans never enable hooks, online packing, or node_modules installation', () => {
  const plan = commandPlan();
  assert.deepEqual(plan.pack, ['pack', '--ignore-scripts', '--offline', '--pack-destination', PINS.inputDirectory]);
  assert.deepEqual(plan.resolve, ['install', '--lockfile-only', '--ignore-scripts', '--ignore-pnpmfile', '--pm-on-fail=error', '--registry=https://registry.npmjs.org/']);
  assert.deepEqual(plan.fetch, ['fetch', '--ignore-scripts', '--ignore-pnpmfile', '--pm-on-fail=error', '--registry=https://registry.npmjs.org/']);
  plan.fetch.push('untrusted');
  assert.equal(commandPlan().fetch.includes('untrusted'), false);
});

test('semantic source projection admits exact local tar plus registry SRI', () => {
  const sources = [local, registry];
  const before = structuredClone(sources);
  assert.deepEqual(admitSources(sources), sources);
  assert.deepEqual(sources, before);
  assert.notEqual(admitSources(sources)[0], sources[0]);
});

test('semantic source projection rejects unsafe or incomplete origins without mutation', () => {
  for (const change of [
    { kind: 'git' }, { kind: 'file' }, { url: 'https://evil.test/pkg.tgz' },
    { url: 'https://registry.npmjs.org.evil.test/pkg.tgz' },
    { url: `${registry.url}?token=x` }, { url: registry.url.replace('https:', 'http:') },
    { integrity: '' }, { integrity: 'sha512-short' }, { configDependencies: {} },
    { version: 'workspace:*' }, { name: '../pkg' },
  ]) rejectsUnchanged(admitSources, [local, { ...registry, ...change }]);
  rejectsUnchanged(admitSources, [registry]);
  rejectsUnchanged(admitSources, [local, local]);
  rejectsUnchanged(admitSources, [{ ...local, path: 'C:/other.tgz' }]);
  rejectsUnchanged(admitSources, [{ ...local, sha256: '' }]);
});

test('evidence preserves failure and bounded output, not arbitrary runner fields', () => {
  const evidence = projectEvidence({ command: ['node', 'pnpm.cjs', 'fetch'], env: closedEnvironment(paths), exit: 7, stdout: 'x'.repeat(80), stderr: 'original failure', error: 'spawn failed', token: 'excluded' }, 32);
  assert.equal(evidence.exit, 7);
  assert.equal(evidence.stderr, 'original failure');
  assert.equal(evidence.error, 'spawn failed');
  assert.equal(evidence.stdout.length, 32);
  assert.equal(evidence.stdoutTruncated, true);
  assert.equal(evidence.stdoutLength, 80);
  assert.equal(evidence.token, undefined);
  assert.deepEqual(evidence.command, ['node', 'pnpm.cjs', 'fetch']);
  rejectsUnchanged(projectEvidence, { command: ['fetch'], env: { TOKEN: 'secret' }, exit: 1, stdout: '', stderr: '' });
  assert.throws(() => projectEvidence({ command: ['fetch'], env: {}, exit: null, stdout: '', stderr: '' }));
  const spawnFailure = projectEvidence({ command: ['node'], env: closedEnvironment(paths), exit: null, stdout: '', stderr: '', error: 'ENOENT' });
  assert.equal(spawnFailure.exit, null);
  assert.equal(spawnFailure.error, 'ENOENT');
  const success = projectEvidence({ command: ['node'], env: closedEnvironment(paths), exit: 0, stdout: 'ok', stderr: '' });
  assert.equal(success.exit, 0);
  assert.equal(success.stdoutTruncated, false);
  assert.throws(() => projectEvidence({ ...success, exit: null, error: '' }));
});

function archive(name = 'package/index.js', type = '0') {
  const header = Buffer.alloc(512);
  header.write(name, 0); header.write('0000644\0', 100);
  header.write('00000000001\0', 124); header.fill(32, 148, 156);
  header.write(type, 156); header.write('ustar\0', 257);
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return gzipSync(Buffer.concat([header, Buffer.from('x'), Buffer.alloc(511 + 1024)]));
}

function lockFixture() {
  const file = `file:${PINS.localTar}`;
  return {
    lockfileVersion: '9.0', settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
    importers: { '.': { dependencies: { 'gentle-pi': { specifier: file, version: file }, '@earendil-works/pi-coding-agent': { specifier: '1.2.0', version: '1.2.0' } } } },
    packages: { [`gentle-pi@${file}`]: { resolution: { integrity: sri, tarball: file } }, '@earendil-works/pi-coding-agent@1.2.0': { resolution: { integrity: sri } } },
    snapshots: { [`gentle-pi@${file}`]: {}, '@earendil-works/pi-coding-agent@1.2.0': {} },
  };
}

test('T1b archive inspection admits bytes but rejects traversal, links and corruption', () => {
  const entries = inspectArchive(archive());
  assert.equal(entries[0].name, 'package/index.js');
  assert.equal(entries[0].data.toString(), 'x');
  for (const name of ['../escape', '/absolute', 'package/../escape', 'package/a:stream', 'package/CON', 'package/a.']) assert.throws(() => inspectArchive(archive(name)));
  assert.throws(() => inspectArchive(archive('package/link', '2')));
  assert.throws(() => inspectArchive(Buffer.from('bad gzip')));
});

test('T1b semantic traversal admits a complete pair and checks optional references', () => {
  const lock = lockFixture();
  const before = structuredClone(lock);
  const sources = normalizeLock(lock, { sha256: local.sha256, integrity: sri });
  assert.equal(sources.length, 2);
  assert.equal(sources[0].path, PINS.localTar);
  assert.deepEqual(lock, before);
  lock.snapshots[`gentle-pi@file:${PINS.localTar}`].optionalDependencies = { '@earendil-works/pi-coding-agent': '1.2.0', alias: '@earendil-works/pi-coding-agent@1.2.0' };
  assert.equal(normalizeLock(lock, { sha256: local.sha256, integrity: sri }).length, 2);
  assert.throws(() => normalizeLock(lock, { sha256: local.sha256, integrity: 'wrong' }));
  const broken = lockFixture();
  broken.snapshots['@earendil-works/pi-coding-agent@1.2.0'].optionalDependencies = { evil: 'git:main' };
  rejectsUnchanged(x => normalizeLock(x, { sha256: local.sha256, integrity: sri }), broken);
});

test('T1b semantic traversal rejects config, custom protocols, missing and unadmitted nodes', () => {
  for (const mutate of [
    x => { x.configDependencies = {}; },
    x => { x.packages['evil@https://evil.test/a.tgz'] = { resolution: { tarball: 'https://evil.test/a.tgz' } }; },
    x => { x.packages['@earendil-works/pi-coding-agent@1.2.0'].resolution.tarball = 'https://evil.test/a.tgz'; },
    x => { delete x.snapshots['@earendil-works/pi-coding-agent@1.2.0']; },
    x => { x.importers['.'].dependencies['gentle-pi'].specifier = '4.3.0'; },
    x => { x.settings.injectWorkspacePackages = true; },
    x => { x.packages['@earendil-works/pi-coding-agent@1.2.0'].resolution.integrity = ''; },
    x => { x.snapshots['@earendil-works/pi-coding-agent@1.2.0'].dependencies = { missing: '1.0.0' }; },
  ]) {
    const lock = lockFixture(); mutate(lock);
    rejectsUnchanged(x => normalizeLock(x, { sha256: local.sha256, integrity: sri }), lock);
  }
});

test('T1b failure guard retains original failure and host refusal is mandatory', () => {
  const failure = { exit: 17, stderr: 'original', error: '' };
  assert.throws(() => requireSuccess(failure), e => e.result === failure);
  assert.equal(requireSuccess({ exit: 0 }), undefined);
  assert.throws(() => requireHostedWindows({ platform: 'linux', env: {} }), /hosted Windows/);
  assert.throws(() => requireHostedWindows({ platform: 'win32', env: {} }), /hosted Windows/);
});

test('T1b public CLI help is inert and actual non-Actions host refuses before effects', () => {
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.NODE_V8_COVERAGE;
  const help = spawnSync(process.execPath, ['scripts/offline-acquisition/runner.mjs', '--help'], { env, encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /LOCK_AND_NPM_INPUTS_ONLY/);
  assert.equal(help.stderr, '');
  assert.notEqual(process.env.GITHUB_ACTIONS, 'true', 'This local refusal test must not invoke acquisition on Actions');
  const refusal = spawnSync(process.execPath, ['scripts/offline-acquisition/runner.mjs'], { env, encoding: 'utf8' });
  assert.equal(refusal.status, 1); assert.match(refusal.stderr, /hosted Windows/);
});

test('T1b workflow has a sole exact push trigger, immutable candidate and owned upload', () => {
  const text = readFileSync('.github/workflows/1921-offline-acquisition.yml', 'utf8');
  assert.match(text, /branches: \[ci\/2360-offline-acquisition\]/);
  assert.doesNotMatch(text, /workflow_dispatch|pull_request|secrets\.|cache:|pnpm install/);
  assert.match(text, /runs-on: windows-latest/);
  assert.match(text, /contents: read/);
  assert.match(text, /node-version: '24\.21\.0'/);
  assert.match(text, /ref: \$\{\{ github.sha \}\}/);
  assert.match(text, new RegExp(`ref: ${PINS.candidate}`));
  assert.equal((text.match(/persist-credentials: false/g) ?? []).length, 2);
  assert.match(text, /if: always\(\)/);
  const runner = readFileSync('scripts/offline-acquisition/runner.mjs', 'utf8');
  const launcher = readFileSync('scripts/offline-acquisition/launch.ps1', 'utf8');
  assert.match(launcher, /\$start\.Environment\.Clear\(\)/);
  assert.match(runner, /--fetch-retries=0/);
  assert.match(runner, /normalizeLock\(parse\(lockText\)/);
  assert.ok(runner.indexOf('normalizeLock(parse(lockText)') < runner.indexOf('...plans.fetch'));
  assert.match(runner, /maxAliasCount: 0/);
  assert.match(runner, /uniqueKeys: true/);
  assert.doesNotMatch(runner, /ensureRuntime|ensureLauncher|installVersion|build-distribution/);
  assert.match(text, /path: \$\{\{ runner.temp \}\}\/shell-acquisition\/artifacts/);
  for (const action of text.matchAll(/uses: ([^\s]+)/g)) assert.match(action[1], /^actions\/(?:checkout|setup-node|upload-artifact)@[a-f0-9]{40}$/);
});
