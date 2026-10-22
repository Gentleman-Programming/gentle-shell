import test from 'node:test';
import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import { spawnSync } from 'node:child_process';
import { admitHosted, compare } from './windows-storage-module-ab.mjs';
import { projectFailure } from './windows-storage-probe.mjs';
import { isolatedEnvironment } from './issue-1921-shell-smoke.mjs';

const sha = 'a'.repeat(40);
const host = { GITHUB_SHA: sha, GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
  RUNNER_OS: 'Windows', GITHUB_SERVER_URL: 'https://github.com', GITHUB_API_URL: 'https://api.github.com',
  GITHUB_REPOSITORY: 'Gentleman-Programming/gentle-shell', GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/heads/test/2431-windows-module-ab', GITHUB_RUN_ATTEMPT: '1' };
const base = () => isolatedEnvironment('C:\\synthetic', 'C:\\node\\node.exe', 'C:\\Windows');
function fixture(outcomes = ['NOT_REPRODUCED', 'NOT_REPRODUCED']) {
  const calls = [], saves = [], evidence = {};
  return { calls, saves, evidence, options: { base: base(), target: 'synthetic', evidence,
    save: () => saves.push(structuredClone(evidence)), checkModules: () => true,
    original: () => { if (outcomes[calls.length - 1] === 'FAILED') throw new Error('fake timeout'); return 'safe'; },
    projectFailure: () => ({ code: 'ETIMEDOUT' }),
    runOnce: ({ env, evidence: result, original }) => {
      calls.push(env);
      try { original('fake', [], env); } catch { /* fake helper records failure below */ }
      Object.assign(result, { status: outcomes[calls.length - 1], invocations: 1, elapsedMs: 3 });
    } } };
}
test('single variable: closed environments, A then B, same target', () => {
  const f = fixture(); compare(f.options);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0], base());
  const { PSModulePath, ...rest } = f.calls[1];
  assert.deepEqual(rest, f.calls[0]);
  assert.equal(PSModulePath, win32.join(base().SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'));
  assert.equal(f.evidence.status, 'COMPARE_COMPLETE');
  assert.equal(f.evidence.invocations, 2);
  assert.equal(f.evidence.interpretation, 'NOT_REPRODUCED');
  assert.ok(f.saves.some(s => s.variants?.A?.invocations === 1 && !s.variants.B));
});
test('recognized A failure continues B; partial B precondition preserves A', () => {
  const f = fixture(['FAILED', 'NOT_REPRODUCED']); compare(f.options);
  assert.equal(f.calls.length, 2); assert.equal(f.evidence.failed, true);
  const p = fixture(); p.options.checkModules = () => false; compare(p.options);
  assert.equal(p.calls.length, 1); assert.equal(p.evidence.variants.A.invocations, 1);
  assert.equal(p.evidence.status, 'PARTIAL');
});
test('unknown failure stops before B; no unbounded second or third call', () => {
  const f = fixture(['FAILED']);
  f.options.runOnce = ({ evidence }) => { f.calls.push(1); Object.assign(evidence, { status: 'FAILED', invocations: 0 }); };
  compare(f.options); assert.equal(f.calls.length, 1); assert.equal(f.evidence.status, 'PARTIAL');
  const u = fixture(['FAILED']); u.options.projectFailure = () => ({ code: null });
  compare(u.options); assert.equal(u.calls.length, 1); assert.equal(u.evidence.invocations, 1);
  assert.equal(u.evidence.status, 'PARTIAL');
  const programmer = fixture(['FAILED']); programmer.options.original = () => 'safe';
  compare(programmer.options); assert.equal(programmer.calls.length, 1);
  assert.equal(programmer.evidence.status, 'PARTIAL');
});
test('admission is exact including node, SHA, branch and attempt', () => {
  assert.doesNotThrow(() => admitHosted('win32', host, sha, '24.21.0'));
  for (const key of Object.keys(host)) assert.throws(() => admitHosted('win32', { ...host, [key]: 'wrong' }, sha, '24.21.0'));
  assert.throws(() => admitHosted('linux', host, sha, '24.21.0'));
  assert.throws(() => admitHosted('win32', host, 'b'.repeat(40), '24.21.0'));
  assert.throws(() => admitHosted('win32', host, sha, '24.0.0'));
});
test('privacy projection retains only recognized bounded diagnostics', () => {
  const projected = projectFailure({ cause: { status: 1, signal: 'SECRET', error: { code: 'ETIMEDOUT' },
    stderr: 'secret C:\\private S-1-5-18\nWSP1 item_begin 0 51\nWSP1 unknown 0 1', stdout: 'secret' } });
  assert.deepEqual(projected, { status: 1, signal: null, code: 'ETIMEDOUT', markers: [{ phase: 'item_begin', depth: 0, elapsedMs: 51 }] });
});
test('actual local refusal and help never enter hosted entry', () => {
  if (process.env.GITHUB_ACTIONS === 'true') return;
  const file = '.github/scripts/windows-storage-module-ab.mjs';
  const refused = spawnSync(process.execPath, [file], { encoding: 'utf8' });
  assert.equal(refused.status, 1); assert.equal(refused.stderr.trim(), 'WSAB_REFUSED');
  const help = spawnSync(process.execPath, [file, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
});
