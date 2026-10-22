import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { admitHosted, instrument, projectFailure, runOnce, firstAncestor } from './windows-storage-probe.mjs';

const hosted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
  GITHUB_SERVER_URL: 'https://github.com', GITHUB_API_URL: 'https://api.github.com',
  GITHUB_REPOSITORY: 'Gentleman-Programming/gentle-shell', GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/heads/test/2431-windows-storage-probe', GITHUB_SHA: 'a'.repeat(40) };
const source = readFileSync(new URL('../../scripts/installer-windows.mjs', import.meta.url), 'utf8');
const script = source.split('const aclCheck = String.raw`')[1].split('`;')[0];

test('exact admission and actual local refusal/help without filesystem or product import', () => {
  assert.doesNotThrow(() => admitHosted('win32', hosted, hosted.GITHUB_SHA));
  for (const key of Object.keys(hosted)) assert.throws(() => admitHosted('win32', { ...hosted, [key]: 'wrong' }, hosted.GITHUB_SHA));
  assert.throws(() => admitHosted('linux', hosted, hosted.GITHUB_SHA));
  assert.throws(() => admitHosted('win32', hosted, 'b'.repeat(40)));
  for (const [args, status] of [[['--help'], 0], [[], 1]]) {
    const child = spawnSync(process.execPath, ['.github/scripts/windows-storage-probe.mjs', ...args], { encoding: 'utf8' });
    assert.equal(child.status, status);
    assert.equal(child.stderr, status ? 'WSP_REFUSED\n' : '');
    assert.doesNotMatch(child.stdout + child.stderr, /[A-Z]:\\|Error:| at /);
  }
});

test('insertion-only instrumentation, fixed anchors and original delegation bound', () => {
  const marked = instrument(script);
  assert.equal(marked.replace(/^.*# WSP_INSERT\n/gm, ''), script);
  for (const label of ['startup', 'identity_begin', 'item_begin', 'access_begin', 'owner_begin', 'rules_begin', 'parent_begin', 'completed'])
    assert.ok(marked.includes(`'${label}'`));
  assert.throws(() => instrument(script.replace('$item = Get-Item', '$item = Unknown')), /anchors/);
  assert.throws(() => instrument(script + script), /anchors/);
  assert.match(source, /timeout: 15000, killSignal: "SIGKILL"/);
  assert.match(source, /shell: false, encoding: "utf8"/);
  assert.match(source, /return result.stdout.trim\(\)/);
});

test('failure projection treats bounded diagnostics as data and excludes private values', () => {
  const cause = { status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT' },
    stderr: 'WSP1 startup 0 1\nprivate C:\\user S-1-5-21-123\nWSP1 access_begin 2 14\nWSP1 evil 0 1\nWSP1 item_begin 999999999 1', stdout: 'private' };
  const expected = { status: null, signal: 'SIGKILL', code: 'ETIMEDOUT',
    markers: [{ phase: 'startup', depth: 0, elapsedMs: 1 }, { phase: 'access_begin', depth: 2, elapsedMs: 14 }] };
  assert.deepEqual(projectFailure({ cause }), expected);
  assert.deepEqual(projectFailure({ cause: { stack: `Error: Windows prerequisite process diagnostics\n${JSON.stringify(cause)}` } }), expected);
  assert.deepEqual(projectFailure({ cause: { stack: 'not JSON private' } }).markers, []);
  assert.doesNotMatch(JSON.stringify(projectFailure({ cause })), /private|user|S-1-/);
});

test('first candidate interception cannot trigger owner/ACL fallback', () => {
  let candidates = 0;
  const env = {};
  const prefix = ({ platform, env: actual, adapters }) => {
    assert.equal(platform, 'win32'); assert.equal(actual, env);
    for (const path of ['first', 'fallback']) {
      candidates++;
      try { adapters.storage(path, actual); }
      catch (error) { if (/owner|acl-mask/.test(error.check ?? '')) continue; throw error; }
    }
  };
  assert.equal(firstAncestor(prefix, env), 'first');
  assert.equal(candidates, 1);
  assert.throws(() => firstAncestor(() => {}, env));
  const failure = new Error('unrelated');
  assert.throws(() => firstAncestor(() => { throw failure; }, env), error => error === failure);
});

test('one original adapter call; safe only after verified output; failures retain partial evidence', () => {
  for (const mode of ['safe', 'unsafe', 'timeout', 'anchors']) {
    let calls = 0;
    const env = { SystemRoot: 'C:\\Windows' };
    const evidence = {};
    const verify = (path, actualEnv, adapter) => {
      assert.equal(path, 'C:\\synthetic'); assert.equal(actualEnv, env);
      const output = adapter('original-executable', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', mode === 'anchors' ? 'unknown' : script], env);
      if (output !== 'safe') throw new Error('rejected private output');
    };
    const original = (exe, args, actualEnv) => {
      calls++;
      assert.equal(exe, 'original-executable'); assert.equal(actualEnv, env);
      assert.deepEqual(args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
      if (mode === 'timeout') throw { cause: { status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT' }, stderr: 'WSP1 item_begin 0 1' } };
      return mode;
    };
    runOnce({ verify, original, target: 'C:\\synthetic', env, evidence });
    assert.equal(calls, mode === 'anchors' ? 0 : 1);
    assert.equal(evidence.status, mode === 'safe' ? 'NOT_REPRODUCED' : 'FAILED');
    assert.equal(evidence.aclSafe, mode === 'safe');
    if (mode === 'safe') assert.equal(evidence.markersAvailable, false);
    if (mode === 'timeout') assert.equal(evidence.failure.markers[0].phase, 'item_begin');
  }
});
