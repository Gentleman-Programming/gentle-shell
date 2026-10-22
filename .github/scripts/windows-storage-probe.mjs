// Diagnostic only. No product module is imported before real host admission.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export function admitHosted(platform, env, sha) {
  if (!(platform === 'win32' && /^[a-f0-9]{40}$/.test(sha ?? '') && sha === env.GITHUB_SHA &&
    env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted' && env.RUNNER_OS === 'Windows' &&
    env.GITHUB_SERVER_URL === 'https://github.com' && env.GITHUB_API_URL === 'https://api.github.com' &&
    env.GITHUB_REPOSITORY === 'Gentleman-Programming/gentle-shell' && env.GITHUB_EVENT_NAME === 'push' &&
    env.GITHUB_REF === 'refs/heads/test/2431-windows-storage-probe')) throw new Error('admission');
}

// Every insertion is a whole marked line; deleting those lines restores the
// byte-identical original predicate, including its safe/unsafe stdout contract.
const clauses = [
  ['identity', '  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value;'],
  ['path', '  $path = [IO.Path]::GetFullPath($env:GENTLE_WINDOWS_CHECK);'],
  ['item', '    $item = Get-Item -LiteralPath $path -Force;'],
  ['reparse', "    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $detail = $path + '|||'; throw ($role + '-reparse') };"],
  ['access', '    if ($item.PSIsContainer) { $acl = [IO.Directory]::GetAccessControl($path) } else { $acl = [IO.File]::GetAccessControl($path) };'],
  ['owner', '    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]);'],
  ['owner_check', "    if ($trusted -notcontains $owner.Value) { $detail = $path + '|' + $owner.Value + '|' + (& $account $owner) + '|'; throw ($role + '-owner') };"],
  ['rules', '    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {'],
  ['parent', '    $parent = [IO.Directory]::GetParent($path);'],
];
const labels = new Set(['startup', 'completed', ...clauses.flatMap(([label]) => [`${label}_begin`, `${label}_end`])]);
const mark = (label, depth = '$depth') => `wspMark '${label}' ${depth}; # WSP_INSERT\n`;
export function instrument(script) {
  if (typeof script !== 'string' || createHash('sha256').update(script).digest('hex') !==
    '867d6c3cae8f0756ca713b819d0a68911a23c82662d7dda3157472e7b0c920b6') throw new Error('anchors');
  for (const [, anchor] of clauses) if (script.split(anchor).length !== 2) throw new Error('anchors');
  let marked = script;
  for (const [label, anchor] of clauses) {
    // rules_end belongs after the complete foreach, immediately before parent.
    const after = label === 'rules' ? '' : mark(`${label}_end`);
    marked = marked.replace(`${anchor}\n`, `${mark(`${label}_begin`, ['identity', 'path'].includes(label) ? '0' : '$depth')}${anchor}\n${after}`);
  }
  marked = marked.replace(mark('parent_begin'), mark('rules_end') + mark('parent_begin'));
  return '$wspWatch = [Diagnostics.Stopwatch]::StartNew(); # WSP_INSERT\n' +
    "function wspMark($phase, $level) { [Console]::Error.WriteLine(('WSP1 {0} {1} {2}' -f $phase, [int]$level, $wspWatch.ElapsedMilliseconds)) }; # WSP_INSERT\n" +
    mark('startup', '0') + marked + mark('completed', '0');
}

// The original helper already bounded/sanitized these diagnostics. Parse as
// DATA, then project only fixed codes and complete recognized protocol lines.
export function projectFailure(error) {
  let data = error?.cause;
  if (typeof data?.stack === 'string' && data.stack.startsWith('Error: Windows prerequisite process diagnostics\n')) {
    try { data = JSON.parse(data.stack.slice(data.stack.indexOf('\n') + 1, 8192)); } catch { data = {}; }
  }
  const markers = [];
  for (const line of (typeof data?.stderr === 'string' ? data.stderr.slice(0, 1024) : '').split(/\r?\n/)) {
    const match = /^WSP1 ([a-z_]+) (\d{1,3}) (\d{1,6})$/.exec(line);
    if (match && labels.has(match[1]) && Number(match[2]) <= 256 && Number(match[3]) <= 120000)
      markers.push({ phase: match[1], depth: Number(match[2]), elapsedMs: Number(match[3]) });
  }
  return { status: Number.isSafeInteger(data?.status) && Math.abs(data.status) <= 65535 ? data.status : null,
    signal: ['SIGKILL', 'SIGTERM', 'SIGABRT'].includes(data?.signal) ? data.signal : null,
    code: ['ETIMEDOUT', 'ENOENT', 'EACCES', 'EPERM', 'ENOBUFS', 'EINVAL'].includes(data?.error?.code) ? data.error.code : null, markers };
}

export function runOnce({ verify, original, target, env, evidence }) {
  Object.assign(evidence, { status: 'FAILED', aclSafe: false, invocations: 0, markersAvailable: false });
  const start = performance.now();
  try {
    verify(target, env, (exe, args, actualEnv) => {
      if (evidence.invocations !== 0 || args.length !== 5 || args.slice(0, 4).join('|') !== '-NoLogo|-NoProfile|-NonInteractive|-Command') throw new Error('adapter');
      const marked = instrument(args[4]);
      evidence.invocations++;
      // Delegate to the original helper: executable, argv prefix, env, shell
      // policy and 15000ms timeout unchanged. Never retry or capture raw streams.
      return original(exe, [...args.slice(0, 4), marked], actualEnv);
    });
    if (evidence.invocations !== 1) throw new Error('invocations');
    Object.assign(evidence, { status: 'NOT_REPRODUCED', aclSafe: true });
  } catch (error) {
    evidence.failure = projectFailure(error);
    evidence.markersAvailable = evidence.failure.markers.length > 0;
  }
  evidence.elapsedMs = Math.min(120000, Math.max(0, Math.round(performance.now() - start)));
}

export function firstAncestor(prefixRoot, env) {
  const stop = new Error('first-only');
  let target;
  try {
    prefixRoot({ platform: 'win32', env, adapters: { storage(path) { target = path; throw stop; } } });
  } catch (error) { if (error !== stop) throw error; }
  if (!target) throw new Error('ancestor');
  return target;
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('Hosted-only one-shot Windows storage timing probe. No Shell installation.'); return;
  }
  // Outside the artifact path deliberately: local refusal must perform NO FS IO.
  admitHosted(process.platform, process.env, process.env.GITHUB_SHA);
  const host = process.env;
  if (!/^[A-Z]:\\/.test(host.RUNNER_TEMP ?? '')) throw new Error('runner');
  const root = join(host.RUNNER_TEMP, 'windows-storage-probe');
  const evidence = { status: 'FAILED', aclSafe: false, phase: 'preconditions', sha: host.GITHUB_SHA };
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  const save = () => writeFileSync(join(root, 'artifacts', 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  save();
  try {
    if (process.argv.length !== 2 || process.versions.node !== '24.21.0' || host.GITHUB_RUN_ATTEMPT !== '1') throw new Error('preconditions');
    admitHosted(process.platform, host, readFileSync(join(host.GITHUB_WORKSPACE, '.git', 'HEAD'), 'utf8').trim());
    // Reuse the old declaration-only constructor, not its journey/main entry.
    const { isolatedEnvironment } = await import('./issue-1921-shell-smoke.mjs');
    const env = isolatedEnvironment(join(root, 'synthetic'), process.execPath, host.SystemRoot);
    if (existsSync(env.HOME)) throw new Error('freshness');
    for (const path of [env.HOME, env.APPDATA, env.LOCALAPPDATA, env.TEMP]) mkdirSync(path, { recursive: true });
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    const { prefixRoot } = await import('../../scripts/bundled-install.mjs');
    const { verifyWindowsStorage, windowsProcessCheck } = await import('../../scripts/installer-windows.mjs');
    evidence.phase = 'first-existing-ancestor';
    // Existing public injection gives precisely the first candidate's ancestor.
    // Always throw a private sentinel without a `check`, so fallback cannot run.
    const target = firstAncestor(prefixRoot, env);
    if (!target || win32.normalize(target) !== win32.normalize(env.LOCALAPPDATA)) throw new Error('ancestor');
    evidence.phase = 'storage';
    runOnce({ verify: verifyWindowsStorage, original: windowsProcessCheck, target, env, evidence });
    evidence.phase = 'finished';
  } catch (error) {
    evidence.failure = projectFailure(error);
  } finally { save(); }
  if (evidence.status !== 'NOT_REPRODUCED') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('WSP_REFUSED'); process.exitCode = 1; });
}
