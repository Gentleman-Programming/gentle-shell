import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launch } from './pi-update-launcher.test.ts';

const diagnostic = (command: string) => `gentle-shell ${command}: this private installation is managed by its supervisor. No installation changed.\nRun ${String.raw`'/private/user'\''s install/supervisor'`} with no arguments, then choose Install Gentle-Shell → Manage this installation → Check for updates.\nThe supervisor's update/upgrade commands update other tools, not Gentle Shell or Pi.\n`;

for (const args of [['upgrade'], ['upgrade', '--channel', 'main'], ['upgrade', '--channel=release'], ['update'], ['update', '--latest'], ['update', '--all']]) {
 test(`private supervisor ${args.join(' ')} refuses without side effects`, () => {
  const result = launch(args, 'supervisor');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, ''); // Includes every fake mutation and network call.
  assert.equal(result.stderr, diagnostic(args[0]));
 });
}

for (const scenario of ['supervisor-missing', 'supervisor-invalid', 'supervisor-mismatch', 'supervisor-symlink', 'supervisor-schema', 'supervisor-destination', 'supervisor-file-symlink', 'supervisor-not-file', 'supervisor-package-mismatch']) {
 test(`${scenario} retains the prior update ownership refusal`, () => {
  const result = launch(['update'], scenario);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'gentle-shell update: ownership could not be verified from global listings; update Pi with the package manager or source checkout that supplies the selected runtime. No installation changed.\n');
 });
}

test('shared agent home with the same private prefix also receives supervisor guidance', () => {
 const result = launch(['update'], 'supervisor-shared');
 assert.equal(result.status, 1);
 assert.equal(result.stdout, '');
 assert.equal(result.stderr, diagnostic('update'));
});

for (const args of [['update', '--extensions-only'], ['update', 'my-package'], ['update', '--unknown']]) {
 test(`private supervisor preserves forwarding ${args.join(' ')}`, () => {
  const result = launch(args, 'supervisor');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `FORWARD ${JSON.stringify(args)}\n`);
  assert.equal(result.stderr, '');
 });
}

test('private supervisor preserves invalid upgrade option validation', () => {
 for (const args of [['upgrade', '--channel'], ['upgrade', '--channel', 'nightly'], ['upgrade', '--force']]) {
  const prior = launch(args);
  const result = launch(args, 'supervisor');
  assert.equal(result.status, 2);
  assert.deepEqual({code: result.status, stdout: result.stdout, stderr: result.stderr},
   {code: prior.status, stdout: prior.stdout, stderr: prior.stderr});
 }
});
