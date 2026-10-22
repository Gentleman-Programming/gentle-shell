// Independent diagnostic entry: builtins only until strict hosted admission.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync, statSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

export function admitHosted(platform, env, sha, node) {
  if (!(platform === 'win32' && node === '24.21.0' && /^[a-f0-9]{40}$/.test(sha ?? '') && sha === env.GITHUB_SHA &&
    env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted' && env.RUNNER_OS === 'Windows' &&
    env.GITHUB_SERVER_URL === 'https://github.com' && env.GITHUB_API_URL === 'https://api.github.com' &&
    env.GITHUB_REPOSITORY === 'Gentleman-Programming/gentle-shell' && env.GITHUB_EVENT_NAME === 'push' &&
    env.GITHUB_REF === 'refs/heads/test/2431-windows-module-ab' && env.GITHUB_RUN_ATTEMPT === '1')) throw new Error('admission');
}

// Inert injectable control; no retries. Unknown failures must not authorize B.
export function compare({ base, target, evidence, save, checkModules, runOnce, verify, original, projectFailure }) {
  Object.assign(evidence, { status: 'PARTIAL', order: ['A', 'B'], changedKey: 'PSModulePath',
    moduleCondition: 'SystemRoot system modules only', variants: {}, invocations: 0, failed: true });
  const modules = win32.join(base.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  try {
    for (const variant of ['A', 'B']) {
      if (variant === 'B' && !checkModules(modules)) throw new Error('modules');
      const env = variant === 'A' ? { ...base } : { ...base, PSModulePath: modules };
      const result = evidence.variants[variant] = { status: 'PENDING', invocations: 0 };
      save();
      let known = false, unsafe;
      runOnce({ target, env, evidence: result, verify, original: (exe, args, actualEnv) => {
        // runOnce has validated/instrumented before reaching this delegation.
        evidence.invocations++;
        save();
        try {
          const output = original(exe, args, actualEnv);
          unsafe = /^unsafe:(policy|(?:target|parent|ancestor)-(?:reparse|owner|acl-mask))(?:\|[A-Za-z0-9+/]+={0,2})?$/.exec(output)?.[1];
          known = Boolean(unsafe);
          return output;
        } catch (error) {
          known = projectFailure(error).code === 'ETIMEDOUT';
          throw error;
        }
      } });
      if (unsafe) result.check = unsafe;
      // Reconcile the helper's pre-call count with actual delegated attempts.
      const delegated = evidence.invocations - (variant === 'B' ? evidence.variants.A.invocations : 0);
      result.invocations = delegated;
      if (delegated !== 1) { save(); throw new Error('invocations'); }
      save();
      if (result.status === 'FAILED' && !known) throw new Error('unknown');
    }
    evidence.status = 'COMPARE_COMPLETE';
    evidence.failed = Object.values(evidence.variants).some(result => result.status !== 'NOT_REPRODUCED');
    evidence.interpretation = evidence.failed ? 'ASSOCIATION_ONLY_OR_INCONCLUSIVE' : 'NOT_REPRODUCED';
  } catch { evidence.failed = true; }
  finally { save(); }
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('Hosted-only A/B module-path comparison; two bounded storage invocations, no installation.'); return;
  }
  const host = process.env;
  admitHosted(process.platform, host, host.GITHUB_SHA, process.versions.node);
  if (process.argv.length !== 2 || !/^[A-Z]:\\[^;\r\n]+$/.test(host.RUNNER_TEMP ?? '')) throw new Error('preconditions');
  admitHosted(process.platform, host, readFileSync(join(host.GITHUB_WORKSPACE, '.git', 'HEAD'), 'utf8').trim(), process.versions.node);
  const artifacts = join(host.RUNNER_TEMP, 'windows-storage-module-ab', 'artifacts');
  mkdirSync(artifacts, { recursive: true });
  const evidence = { status: 'PARTIAL', failed: true, sha: host.GITHUB_SHA, invocations: 0 };
  const save = () => writeFileSync(join(artifacts, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  save();
  try {
    const { runOnce, firstAncestor, projectFailure } = await import('./windows-storage-probe.mjs');
    const { isolatedEnvironment } = await import('./issue-1921-shell-smoke.mjs');
    const root = mkdtempSync(join(host.RUNNER_TEMP, 'windows-storage-module-ab-synthetic-'));
    const base = isolatedEnvironment(root, process.execPath, host.SystemRoot);
    for (const path of [base.HOME, base.APPDATA, base.LOCALAPPDATA, base.TEMP]) mkdirSync(path, { recursive: true });
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, base);
    const { prefixRoot } = await import('../../scripts/bundled-install.mjs');
    const { verifyWindowsStorage, windowsProcessCheck } = await import('../../scripts/installer-windows.mjs');
    const target = firstAncestor(prefixRoot, base);
    if (win32.normalize(target) !== win32.normalize(base.LOCALAPPDATA)) throw new Error('ancestor');
    const checkModules = path => {
      const relative = win32.relative(realpathSync(base.SystemRoot), realpathSync(path));
      return statSync(path).isDirectory() && relative !== '' && !relative.startsWith('..') && !win32.isAbsolute(relative);
    };
    compare({ base, target, evidence, save, checkModules, runOnce, verify: verifyWindowsStorage,
      original: windowsProcessCheck, projectFailure });
  } catch { evidence.failed = true; }
  finally { save(); }
  if (evidence.failed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('WSAB_REFUSED'); process.exitCode = 1; });
}
