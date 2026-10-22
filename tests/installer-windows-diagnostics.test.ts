import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { getSystemErrorName } from 'node:util';
import { windowsProcessCheck, windowsBootstrapReason } from '../scripts/installer-windows.mjs';

// Only owned inert Node children. Never invoke PowerShell, ACL/storage or setup.
const base = resolve('odd/checks/issue-1921-windows-prerequisite-diagnostics');
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, 'inert-'));
const fixture = join(root, 'child.mjs');
writeFileSync(fixture, `import { writeSync } from 'node:fs';
const mode = process.argv[2];
if (mode === 'cap') { writeSync(2, 'overflow fixture\\n'); writeSync(1, 'x'.repeat(2*1024*1024)); }
else if (mode === 'success') { writeSync(1, '  ' + JSON.stringify({cwd:process.cwd()}) + ' \\n'); }
else { writeSync(1, process.argv[3]); writeSync(2, process.argv[4] ?? ''); process.exit(7); }
`);
const env = { SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows',
  PATH: dirname(process.execPath), DIAGNOSTIC_SECRET: 'must-not-retain-env' };
function failure(command: string, args: string[]): any {
  let caught: any;
  try { windowsProcessCheck(command, args, env); } catch (error) { caught = error; }
  assert.equal(caught?.message, 'Windows prerequisite process failed');
  assert.equal(windowsBootstrapReason(caught, 'tools-storage'), 'process-failed (tools-storage)');
  return caught;
}
function causeOf(error: any): any {
  assert.ok(error.cause instanceof Error, 'standard cause Error must survive existing cause.stack observer');
  const cause = error.cause;
  assert.deepEqual(Object.keys(cause).sort(), ['error', 'signal', 'status', 'stderr', 'stdout']);
  assert.ok(cause.stack.length <= 8192);
  assert.ok(cause.stdout.length <= 1024 && cause.stderr.length <= 1024);
  assert.ok(!cause.stack.includes(root) && !cause.stack.includes('installer-windows.mjs'));
  assert.ok(!cause.error?.message?.includes(root));
  assert.ok(!JSON.stringify(cause).includes(env.DIAGNOSTIC_SECRET));
  return cause;
}

test('metadata: nonzero exit keeps bounded streams and usable cause.stack', () => {
  const args = [fixture, 'text', 'controlled stdout\n', 'controlled stderr\n', 'private-argv-sentinel'];
  const before = structuredClone({ args, env });
  const error = failure(process.execPath, args), cause = causeOf(error);
  assert.equal(cause.status, 7); assert.equal(cause.signal, null); assert.equal(cause.error, null);
  assert.equal(cause.stdout, 'controlled stdout\n'); assert.equal(cause.stderr, 'controlled stderr\n');
  assert.match(error.cause?.stack, /"status":7/);
  assert.match(error.cause?.stack, /controlled stderr/);
  assert.ok(!JSON.stringify(cause).includes('private-argv-sentinel'));
  assert.deepEqual({ args, env }, before);
});

test('metadata: missing synthetic executable preserves ENOENT without raw spawn error', () => {
  const cause = causeOf(failure(join(root, 'missing.exe'), ['private-argv-sentinel']));
  assert.equal(cause.status, null); assert.equal(cause.signal, null);
  assert.deepEqual(Object.keys(cause.error).sort(), ['code', 'errno', 'message', 'name']);
  assert.equal(cause.error.code, 'ENOENT'); assert.equal(cause.error.name, 'Error');
  assert.equal(getSystemErrorName(cause.error.errno), 'ENOENT');
  assert.ok(cause.error.message.length <= 256);
  assert.equal(cause.stdout, ''); assert.equal(cause.stderr, '');
  assert.match(cause.stack, /ENOENT/);
});

test('metadata: output overflow preserves ENOBUFS and actual kill signal without waiting15s', () => {
  const cause = causeOf(failure(process.execPath, [fixture, 'cap']));
  assert.equal(cause.status, null); assert.equal(cause.signal, 'SIGKILL');
  assert.equal(cause.error.code, 'ENOBUFS'); assert.equal(cause.error.name, 'Error');
  assert.equal(getSystemErrorName(cause.error.errno), 'ENOBUFS');
  assert.equal(cause.stderr, 'overflow fixture\n');
  assert.match(cause.stack, /ENOBUFS/);
});

test('privacy: private paths, SID/encoded ACL detail and sensitive output are suppressed; caps hold', () => {
  const privateLines = ['visible', 'C:\\Users\\Synthetic Person\\private.txt', '/home/synthetic/private.txt',
    'S-1-5-21-111-222-333-1001', 'DOMAIN\\synthetic', 'unsafe:target-owner|YWJjZA=='];
  const cause = causeOf(failure(process.execPath, [fixture, 'text', privateLines.join('\n'),
    'Authorization: Bearer synthetic-secret\ncontinuation-must-not-survive']));
  assert.match(cause.stdout, /visible/);
  for (const value of privateLines.slice(1)) assert.ok(!cause.stdout.includes(value));
  assert.ok(!cause.stack.includes('synthetic-secret') && !cause.stack.includes('continuation-must-not-survive'));
  const bounded = causeOf(failure(process.execPath, [fixture, 'text', 'safe line\n'.repeat(300), 'safe error\n'.repeat(300)]));
  assert.equal(bounded.stdout.length, 1024); assert.equal(bounded.stderr.length, 1024);
});

test('PR privacy: credential markers recognize underscore separators without changing API_KEY handling', () => {
  for (const marker of ['GITHUB_TOKEN', 'PREFIX_API_KEY_SUFFIX', 'AWS_ACCESS_KEY_ID', 'API_KEY', 'access_key']) {
    const payload = `${marker}=synthetic-value-1921\ncontinuation-value-1921`;
    assert.equal(payload.includes('\\'), false, 'actual argv bytes must not trigger the path filter');
    const cause = causeOf(failure(process.execPath,
      ['-e', 'process.stderr.write(process.argv[1]);process.exit(7)', payload]));
    assert.equal(cause.status, 7);
    assert.equal(cause.stderr, '[redacted]');
    assert.ok(!cause.stack.includes('synthetic-value-1921') && !cause.stack.includes('continuation-value-1921'));
  }
});

test('PR privacy: missing bare executable identity never enters cause message or stack', () => {
  const command = `fixture-private-executable-1921-${basename(root)}`;
  assert.equal(parse(command).root, '', 'a path-based probe would miss the bare-name leak');
  const cause = causeOf(failure(command, ['private-argv-sentinel']));
  assert.equal(cause.status, null); assert.equal(cause.signal, null);
  assert.equal(cause.error.code, 'ENOENT'); assert.equal(cause.error.name, 'Error');
  assert.equal(getSystemErrorName(cause.error.errno), 'ENOENT');
  assert.ok(!JSON.stringify(cause).includes(command) && !cause.stack.includes(command));
  assert.match(cause.error.message, /ENOENT/);
});

test('legacy: neutral cwd, trimmed success and pre-spawn CMD/BAT rejection stay exact', () => {
  assert.equal(windowsProcessCheck(process.execPath, [fixture, 'success'], env), JSON.stringify({ cwd: parse(process.execPath).root }));
  for (const suffix of ['.CMD', '.bat']) assert.throws(() => windowsProcessCheck(join(root, `absent${suffix}`), [], env),
    error => error instanceof Error && error.message === 'Unproven command interpreter target' && error.cause === undefined);
});
