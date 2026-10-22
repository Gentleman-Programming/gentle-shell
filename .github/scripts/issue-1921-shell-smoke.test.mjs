import test from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, win32 } from 'node:path';
import * as smoke from './issue-1921-shell-smoke.mjs';
import { CANDIDATE, BRANCH, admitHosted, isolatedEnvironment, shellArguments, memoryProof, validateCoreQuery, captureChild } from './issue-1921-shell-smoke.mjs';

const host = { platform: 'win32', candidate: 'a'.repeat(40), env: {
  GITHUB_SHA: 'a'.repeat(40), GITHUB_SERVER_URL: 'https://github.com', GITHUB_API_URL: 'https://api.github.com',
  GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
  GITHUB_REPOSITORY: 'Gentleman-Programming/gentle-shell', GITHUB_REF: BRANCH, GITHUB_EVENT_NAME: 'push',
} };
const root = 'C:\\runner\\smoke';
test('source: only exact diagnostic blobs and four harness paths', () => {
  const diagnostics = {
    'docs/bundled-install.md': '30b3486e029d8bff437476cab366993e7819bb18',
    'scripts/installer-windows.mjs': '162083e786bb55d53c0d77f217afa563fbffa119',
    'tests/installer-windows-diagnostics.test.ts': '91974c62c4570a1b3e6c444a4d58cd4b34831d45',
  };
  const paths = [...Object.keys(diagnostics), '.github/scripts/issue-1921-shell-smoke.mjs',
    '.github/scripts/issue-1921-shell-smoke.test.mjs', '.github/workflows/issue-1921-shell-smoke.yml',
    'docs/issue-1921-shell-smoke.md'];
  smoke.validateSource(paths, diagnostics);
  for (const bad of [paths.slice(1), [...paths, 'bin/gentle-shell.mjs'], [...paths, paths[0]]])
    assert.throws(() => smoke.validateSource(bad, diagnostics));
  assert.throws(() => smoke.validateSource(paths, { ...diagnostics, 'docs/bundled-install.md': '0'.repeat(40) }));
});
function unchangedRejection(fn, value) {
  const before = structuredClone(value);
  assert.throws(() => fn(value));
  assert.deepEqual(value, before);
}

test('admission: exact hosted candidate and mutation-free refusals', () => {
  admitHosted(host);
  for (const change of [{ platform: 'linux' }, { candidate: '0'.repeat(40) }])
    unchangedRejection(admitHosted, { ...host, ...change });
  for (const key of Object.keys(host.env))
    unchangedRejection(admitHosted, { ...host, env: { ...host.env, [key]: 'untrusted' } });
});

test('admission: actual workflow SHA and public GitHub identity required', () => {
  const candidate = 'a'.repeat(40);
  const value = { ...host, candidate, env: { ...host.env, GITHUB_SHA: candidate,
    GITHUB_SERVER_URL: 'https://github.com', GITHUB_API_URL: 'https://api.github.com' } };
  admitHosted(value);
  unchangedRejection(admitHosted, { ...value, candidate: CANDIDATE });
  for (const key of ['GITHUB_SHA', 'GITHUB_SERVER_URL', 'GITHUB_API_URL'])
    unchangedRejection(admitHosted, { ...value, env: { ...value.env, [key]: 'untrusted' } });
});

test('isolation: closed environment and actual installed Shell argv', () => {
  const env = isolatedEnvironment(root, 'C:\\node\\node.exe', 'C:\\Windows');
  assert.deepEqual(Object.keys(env).sort(), ['APPDATA', 'CI', 'ComSpec', 'HOME', 'LOCALAPPDATA', 'PATH',
    'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR'].sort());
  for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP'])
    assert.ok(env[key].startsWith(`${root}\\`));
  assert.equal(env.HOME, env.USERPROFILE);
  assert.equal(env.PATH, 'C:\\node;C:\\Windows\\System32;C:\\Windows');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.npm_config_userconfig, undefined);
  assert.throws(() => isolatedEnvironment('relative', 'C:\\node\\node.exe', 'C:\\Windows'));
  const launcher = win32.join(root, 'installed', 'bin', 'gentle-shell.mjs');
  assert.deepEqual(shellArguments(launcher, `${root}\\agent`), [launcher, '--home', `${root}\\agent`, 'setup']);
  assert.deepEqual(shellArguments(launcher, `${root}\\agent`, `${root}\\one.jsonl`),
    [launcher, '--home', `${root}\\agent`, '--mode', 'json', '--print', '--session', `${root}\\one.jsonl`,
      '--provider', 'issue1921', '--model', 'smoke', '--thinking', 'off', 'Run the synthetic memory journey.']);
});

const marker = 'synthetic-marker-1921';
// Pinned native HTTP DTO fixtures, not live compatibility evidence:
// companion0.5 gitHead fe897f66e964c58284bdc83e6e5447f9ba8364c0 index.ts:2636-2640;
// Core3.5.2 server.go:716-818,851-929; store.go:162-182,221-224.
const observation = { id: 71, content: marker, project: 'smoke', session_id: 'session-one', scope: 'project' };
const tool = (toolName, data) => ({ type: 'tool_execution_end', toolName, isError: false,
  result: { content: [], details: { data } } });
const events = [tool('mem_current_project', { cwd: root, project: 'smoke', project_source: 'dir_basename' }),
  tool('mem_save', { id: 71, status: 'saved' }), tool('mem_search', [observation]),
  tool('mem_get_observation', observation)];

test('proof: actual tool results, persisted identity and original native attribution', () => {
  const first = memoryProof(events, marker, 'session-one');
  assert.deepEqual(first, { nativeSession: 'session-one', observation });
  const secondEvents = events.filter(event => event.toolName !== 'mem_save');
  assert.deepEqual(memoryProof(secondEvents, marker, 'session-two', first), { nativeSession: 'session-two', observation });
  // Effective companion session attribution is not necessarily Pi's raw ID.
  assert.equal(memoryProof(events, marker, 'different-native-id').observation.session_id, 'session-one');
  for (const [name, data] of [['mem_save', { saved: { id: 71, status: 'saved' } }],
    ['mem_search', { results: [observation] }], ['mem_save', { id: '71', status: 'saved' }],
    ['mem_get_observation', { observation }]]) {
    const wrongWrapper = events.map(event => event.toolName === name ? tool(name, data) : event);
    unchangedRejection(value => memoryProof(value, marker, 'session-one'), wrongWrapper);
  }
  for (const bad of [[], [{ type: 'message_end', message: { content: JSON.stringify(events) } }],
    events.map(event => ({ ...event, isError: true })), events.slice(0, -1)])
    unchangedRejection(value => memoryProof(value, marker, 'session-one'), bad);
  for (const key of ['id', 'content', 'project', 'session_id', 'scope']) {
    const bad = structuredClone(secondEvents);
    delete bad.at(-1).result.details.data[key];
    unchangedRejection(value => memoryProof(value, marker, 'session-two', first), bad);
  }
  assert.throws(() => memoryProof(secondEvents, marker, 'session-one', first));
  const changed = structuredClone(secondEvents);
  changed.at(-1).result.details.data.session_id = 'rewritten-attribution';
  assert.throws(() => memoryProof(changed, marker, 'session-two', first));
});

test('provenance: canonical directory, exact identity/core and restart persistence', () => {
  const observed = { dataDir: `${root}\\.engram`, instanceId: 'b'.repeat(32), coreSha256: 'c'.repeat(64) };
  const record = { schema: 1, ...observed };
  assert.deepEqual(smoke.provenanceProof(record, observed), record);
  assert.deepEqual(smoke.provenanceProof(record, observed, record), record);
  for (const key of ['schema', 'dataDir', 'instanceId', 'coreSha256']) {
    const bad = { ...record, [key]: 'wrong' };
    unchangedRejection(value => smoke.provenanceProof(value, observed), bad);
    assert.throws(() => smoke.provenanceProof(record, observed, bad));
  }
  assert.throws(() => smoke.provenanceProof(null, observed));
  assert.throws(() => smoke.provenanceProof({ ...record, instanceId: '' }, { ...observed, instanceId: '' }));
});

test('B1: only positively completed Core enumeration proves an empty PID set', () => {
  assert.deepEqual(validateCoreQuery({ status: 0, closeConfirmed: true, stdout: '[]\r\n', stderr: '' }), []);
  assert.deepEqual(validateCoreQuery({ status: 0, closeConfirmed: true, stdout: '[41,73]\n', stderr: '' }), [41, 73]);
  for (const change of [{ stderr: 'Get-CimInstance: access denied' }, { stdout: '' }, { status: 1 },
    { stdout: 'null' }, { stdout: '41' }, { stdout: '[0]' }, { stdout: '[41,41]' }, { stdout: '["41"]' }, { stdout: 'garbage' },
    { closeConfirmed: false }, { error: 'timeout' }, { partial: true }, { cleanupFailure: 'unknown child' }])
    unchangedRejection(validateCoreQuery, { status: 0, closeConfirmed: true, stdout: '[]', stderr: '', ...change });
});

function inertChild() {
  const child = new EventEmitter();
  Object.assign(child, { pid: 123, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter() });
  child.stdout.destroy = child.stderr.destroy = () => {};
  child.unref = () => {};
  return child;
}

test('B2: failed termination and held pipes cannot defeat capture or return bounds', { timeout: 2000 }, async () => {
  const child = inertChild(), writes = [];
  const pending = captureChild(child, { timeout: 20, graceMs: 20, maxBytes: 8,
    terminate: () => ({ exit: 1, stderr: 'simulated denied termination' }),
    write: (name, bytes) => writes.push(Buffer.from(bytes)) });
  child.stdout.emit('data', Buffer.from('0123456789'));
  child.stderr.emit('data', Buffer.from('must-not-be-retained'));
  child.emit('error', new Error('later error must not replace overflow'));
  let timer;
  const result = await Promise.race([pending.then(value => ({ bounded: true, value })),
    new Promise(accept => { timer = setTimeout(() => accept({ bounded: false }), 400); })]);
  clearTimeout(timer);
  // Release the deliberately faulty baseline without leaving a timer/process behind.
  if (!result.bounded) child.emit('close', 0, null);
  const value = result.value ?? await pending;
  assert.deepEqual({ bounded: result.bounded, bytes: Buffer.concat(writes).length,
    first: value.error, cleanupReported: Boolean(value.cleanupFailure) },
  { bounded: true, bytes: 8, first: 'Command capture bound', cleanupReported: true });
  assert.equal(value.stdout, '01234567');
  assert.equal(value.stderr, '');

  const hung = inertChild();
  const timedOut = await captureChild(hung, { timeout: 10, graceMs: 20,
    terminate: () => ({ exit: 0 }), write: () => {} });
  assert.equal(timedOut.error, 'Command deadline');
  assert.equal(timedOut.closeConfirmed, false);
  assert.ok(timedOut.cleanupFailure, 'successful kill request alone never proves child close');

  const ordinary = inertChild();
  const completed = captureChild(ordinary, { terminate: () => assert.fail('no kill on ordinary close'), write: () => {} });
  ordinary.stdout.emit('data', Buffer.from('ok'));
  ordinary.exitCode = 0; ordinary.emit('exit', 0, null); ordinary.emit('close', 0, null);
  const success = await completed;
  assert.equal(success.stdout, 'ok');
  assert.equal(success.status, 0);
  assert.equal(success.error, undefined);
  assert.equal(success.cleanupFailure, undefined);
  assert.equal(success.closeConfirmed, true);

  const held = inertChild();
  let kills = 0;
  const heldResult = captureChild(held, { timeout: 20, graceMs: 20,
    terminate: () => { kills++; return { exit: 0 }; }, write: () => {} });
  held.exitCode = 0; held.emit('exit', 0, null);
  const closed = await heldResult;
  assert.equal(kills, 0, 'never target an exited/reusable root PID even with held pipes');
  assert.ok(closed.cleanupFailure);
  assert.equal(closed.status, 0);
  assert.match(closed.error, /Pipe close deadline/);
});

test('workflow: sole exact push, pinned checkouts/actions and owned evidence only', () => {
  const yaml = readFileSync(resolve('.github/workflows/issue-1921-shell-smoke.yml'), 'utf8');
  assert.match(yaml, /branches: \[dnlrsls\/shell-2431-windows-trial\]/);
  assert.match(yaml, /runs-on: windows-latest/);
  assert.match(yaml, /contents: read/);
  assert.equal((yaml.match(/persist-credentials: false/g) ?? []).length, 2);
  assert.equal((yaml.match(/ref: \$\{\{ github.sha \}\}/g) ?? []).length, 2);
  assert.ok(yaml.includes('ref: ${{ github.sha }}'));
  assert.match(yaml, /if: always\(\)/);
  assert.ok(yaml.includes('${{ runner.temp }}/issue-1921-shell-smoke/artifacts'));
  assert.equal((yaml.match(/uses: [^\n]+@[a-f0-9]{40} /g) ?? []).length, 4);
  assert.doesNotMatch(yaml, /workflow_dispatch|pull_request|secrets\.|self-hosted|cache:/);
});

test('CLI: actual local-host refusal makes no owned fixture changes', () => {
  const base = resolve('odd/checks/issue-1921-windows-smoke-ci');
  mkdirSync(base, { recursive: true });
  const scratch = mkdtempSync(`${base}/refusal-`);
  writeFileSync(`${scratch}/counter`, 'unchanged');
  const snapshot = () => readdirSync(scratch).sort().map(name => [name, readFileSync(`${scratch}/${name}`, 'utf8')]);
  const before = snapshot();
  const env = { ...process.env, GITHUB_ACTIONS: 'false', GITHUB_WORKSPACE: scratch, RUNNER_TEMP: scratch };
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_V8_COVERAGE']) delete env[name];
  const result = spawnSync(process.execPath, [resolve('.github/scripts/issue-1921-shell-smoke.mjs')],
    { env, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Only the exact hosted Windows push is admitted/);
  assert.deepEqual(snapshot(), before);
});
