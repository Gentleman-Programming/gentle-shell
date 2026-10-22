import test from 'node:test';
import assert from 'node:assert/strict';
import { closedEnvironment, pairFiles, commandPlan, admitSources, projectEvidence, PINS } from '../scripts/offline-acquisition/policy.mjs';

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
