// Hosted-only real candidate smoke. Imports below are Node built-ins, never SDK/product.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { StringDecoder } from 'node:string_decoder';

export const CANDIDATE = 'c1617e90b81bac5a897a10211797bc30169794bf';
export const BRANCH = 'refs/heads/test/1921-real-shell-smoke-c161';
const requireValue = (value, message) => { if (!value) throw new Error(message); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(accept => setTimeout(accept, ms));

export function admitHosted({ platform, candidate, env }) {
  requireValue(platform === 'win32' && candidate === CANDIDATE && env.GITHUB_ACTIONS === 'true' &&
    env.RUNNER_ENVIRONMENT === 'github-hosted' && env.RUNNER_OS === 'Windows' &&
    env.GITHUB_REPOSITORY === 'Gentleman-Programming/gentle-shell' && env.GITHUB_REF === BRANCH &&
    env.GITHUB_EVENT_NAME === 'push', 'Only the exact hosted Windows push is admitted');
}

export function isolatedEnvironment(root, node, system) {
  for (const path of [root, node, system]) requireValue(/^[A-Z]:\\[^;\r\n]+$/.test(path) &&
    !path.split('\\').some(part => part === '..' || part === '.'), 'Absolute private Windows paths required');
  const profile = win32.join(root, 'profile');
  return { HOME: profile, USERPROFILE: profile, APPDATA: win32.join(profile, 'AppData', 'Roaming'),
    LOCALAPPDATA: win32.join(profile, 'AppData', 'Local'), TEMP: win32.join(root, 'tmp'), TMP: win32.join(root, 'tmp'),
    SystemRoot: system, WINDIR: system, ComSpec: win32.join(system, 'System32', 'cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD', PATH: [win32.dirname(node), win32.join(system, 'System32'), system].join(';'), CI: 'true' };
}

export function shellArguments(launcher, home, session) {
  return [launcher, '--home', home, ...(session ? ['--mode', 'json', '--print', '--session', session,
    '--provider', 'issue1921', '--model', 'smoke', '--thinking', 'off', 'Run the synthetic memory journey.'] : ['setup'])];
}

// Native companion success data is RPC/JSON result.details.data, not MCP text.
function toolData(events, name) {
  const matches = events.filter(event => event.type === 'tool_execution_end' && event.toolName === name);
  requireValue(matches.length === 1 && matches[0].isError === false && matches[0].result?.details?.data,
    `Missing or failed native tool result: ${name}`);
  return matches[0].result.details.data;
}

export function memoryProof(events, marker, session, previous) {
  requireValue(typeof session === 'string' && session.length > 0, 'Native session identity absent');
  const current = toolData(events, 'mem_current_project');
  requireValue(typeof current.project === 'string' && current.project &&
    ['dir_basename', 'git_remote'].includes(current.project_source), 'Invalid native project');
  const saved = previous ? undefined : toolData(events, 'mem_save');
  if (saved) requireValue(saved.status === 'saved' && Number.isSafeInteger(saved.id) && saved.id > 0, 'Native save not confirmed');
  const search = toolData(events, 'mem_search');
  requireValue(Array.isArray(search), 'Native noncompact search must return an array');
  const matches = search.filter(item => item.id === (previous?.observation.id ?? saved.id));
  requireValue(matches.length === 1, 'Saved observation not uniquely present in actual search');
  const observation = toolData(events, 'mem_get_observation');
  for (const value of [matches[0], observation]) {
    requireValue(value.id === (previous?.observation.id ?? saved.id) && value.content === marker &&
      value.project === current.project && value.scope === 'project' &&
      typeof value.session_id === 'string' && value.session_id.length > 0, 'Invalid memory identity/content/attribution');
  }
  const selected = Object.fromEntries(['id', 'content', 'project', 'session_id', 'scope'].map(key => [key, observation[key]]));
  requireValue(matches[0].session_id === selected.session_id, 'Search/get attribution mismatch');
  if (previous) requireValue(session !== previous.nativeSession &&
    JSON.stringify(selected) === JSON.stringify(previous.observation), 'Restart changed original attribution or reused native session');
  // Companion owns effective attribution; do NOT equate it to Pi's raw session ID.
  return { nativeSession: session, observation: selected };
}

export function validateCoreQuery(result) {
  requireValue(result.status === 0 && result.closeConfirmed === true && !result.error && !result.cleanupFailure &&
    !result.partial && result.stderr === '' && typeof result.stdout === 'string' && result.stdout.trim().length > 0, 'Core enumeration did not complete cleanly');
  const pids = JSON.parse(result.stdout);
  requireValue(Array.isArray(pids) && pids.every(pid => Number.isSafeInteger(pid) && pid > 0) &&
    new Set(pids).size === pids.length, 'Invalid owned Core PID evidence');
  return pids;
}

// One command's capture/lifetime seam, shared with inert controls. terminate is
// synchronous and independently bounded (production taskkill has a 15s timeout).
export function captureChild(child, { timeout = 15000, graceMs = 2000, maxBytes = 32 * 1024 * 1024,
  terminate, write, onLine, signal } = {}) {
  return new Promise(accept => {
    const chunks = { stdout: [], stderr: [] }, decoder = new StringDecoder('utf8');
    let bytes = 0, pending = '', error, cleanupFailure, sealed = false, settled = false;
    let status = null, exitSignal = null, exitObserved = false, requested = false, grace;
    const latch = message => { error ??= message; };
    const detach = () => { child.stdout.destroy(); child.stderr.destroy(); child.unref(); };
    function finish(closeConfirmed) {
      if (settled) return;
      settled = true; clearTimeout(deadline); clearTimeout(grace);
      signal?.removeEventListener('abort', aborted);
      if (!closeConfirmed) {
        latch(exitObserved ? 'Pipe close deadline' : 'Command close deadline');
        cleanupFailure ??= 'Child exit/descendant pipe closure unconfirmed; shutdown is unknown';
        detach();
      }
      if (onLine && !sealed && pending.trim()) {
        try { onLine(JSON.parse(pending + decoder.end())); }
        catch (failure) { latch(`Shell event failure: ${failure.message}`); }
      }
      accept({ status, signal: exitSignal, error, cleanupFailure, exitObserved, closeConfirmed, capturedBytes: bytes,
        partial: sealed || !closeConfirmed, stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8') });
    }
    function waitForClose() { grace ??= setTimeout(() => finish(false), graceMs); }
    function stop(message) {
      if (settled) return;
      latch(message); sealed = true; waitForClose();
      // Never target an exited root: descendants holding its pipes do not make
      // its old PID safe to kill. A successful kill is not proof of close either.
      if (!requested && !exitObserved && child.exitCode === null && child.signalCode === null && Number.isInteger(child.pid)) {
        requested = true;
        try {
          const result = terminate(child);
          if (result?.exit !== 0 || result?.error) cleanupFailure ??= `Owned termination failed: ${result?.error ?? result?.stderr ?? 'unconfirmed'}`;
        } catch (failure) { cleanupFailure ??= `Owned termination failed: ${failure.message}`; }
      }
      child.stdout.destroy(); child.stderr.destroy();
    }
    const aborted = () => stop(signal.reason?.message ?? 'Journey aborted');
    const deadline = setTimeout(() => stop('Command deadline'), timeout);
    for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.on('data', data => {
        if (settled || sealed) return;
        // Copy only the accepted prefix: subarray alone could retain a huge
        // backing buffer. Disk writes and in-memory retention share this cap.
        const part = Buffer.from(data.subarray(0, maxBytes - bytes));
        bytes += part.length;
        try {
          if (part.length) { chunks[name].push(part); write(name, part); }
          if (part.length < data.length) { stop('Command capture bound'); return; }
          if (name === 'stdout' && onLine) {
            pending += decoder.write(part);
            const lines = pending.split('\n'); pending = lines.pop();
            for (const line of lines) if (line.trim()) onLine(JSON.parse(line));
          }
        } catch (failure) { stop(`Shell capture/event failure: ${failure.message}`); }
      });
    }
    child.on('error', failure => stop(failure.message));
    child.once('exit', (code, sig) => {
      if (settled) return;
      clearTimeout(deadline);
      exitObserved = true; status = code; exitSignal = sig;
      if (code !== 0) latch(`Command exit: ${code ?? sig}`);
      // Root exit does not imply inherited stdout/stderr pipes will close.
      waitForClose();
    });
    child.once('close', (code, sig) => {
      if (settled) return;
      status = code; exitSignal = sig; exitObserved ||= Number.isInteger(code) || sig !== null;
      if (code !== 0) latch(`Command exit: ${code ?? sig}`);
      finish(true);
    });
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

export async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('Usage: node .github/scripts/issue-1921-shell-smoke.mjs\nExact hosted Windows test-branch push only; no local runtime.');
    return;
  }
  // Refuse the real local host BEFORE filesystem changes or product imports.
  admitHosted({ platform: process.platform, candidate: CANDIDATE, env: process.env });
  requireValue(process.argv.length === 2 && process.versions.node === '24.21.0', 'Pinned Node and no arguments required');
  const candidate = join(process.env.GITHUB_WORKSPACE, 'candidate');
  const controls = join(process.env.GITHUB_WORKSPACE, 'controls');
  const workflow = process.env.GITHUB_SHA;
  const actual = readFileSync(join(candidate, '.git', 'HEAD'), 'utf8').trim();
  admitHosted({ platform: process.platform, candidate: actual, env: process.env });
  requireValue(readFileSync(join(controls, '.git', 'HEAD'), 'utf8').trim() === workflow, 'Controls checkout mismatch');
  const root = join(process.env.RUNNER_TEMP, 'issue-1921-shell-smoke');
  requireValue(!existsSync(root), 'Fresh smoke root required; never resume an attempt');
  const env = isolatedEnvironment(root, process.execPath, process.env.SystemRoot);
  // Helpers sometimes consult process.env internally. Close it as well as every child env.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  const artifacts = join(root, 'artifacts');
  for (const path of [artifacts, env.HOME, env.APPDATA, env.LOCALAPPDATA, env.TEMP]) mkdirSync(path, { recursive: true });
  const evidence = { status: 'FAILED', candidate: actual, workflow, sourceKind: 'local-candidate-not-published',
    claims: { installed: false, provisioned: false, memoryEnabled: false, persisted: false, ownedShutdown: false, publicUpgrade: false },
    commands: [], stages: [], limitations: ['One candidate smoke, not public upgrade or offline closure',
      'Normal installer controls including pinned Gentle AI Go/SumDB build are unchanged',
      'Product-internal commands are captured through their enclosing installer command, not independently instrumented'] };
  const save = () => writeFileSync(join(artifacts, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  save();
  let sequence = 0, server, active, layout;
  const children = new Set(), abort = new AbortController();
  function cleanupFailed(message) {
    evidence.cleanupFailure ??= message;
    evidence.status = 'FAILED'; evidence.claims.ownedShutdown = false; save();
  }
  // Only a still-owned spawned PID is eligible; never kill by process name or port.
  function terminate(child) {
    if (!children.has(child) || !Number.isInteger(child.pid) || child.exitCode !== null || child.signalCode !== null)
      return { exit: null, skipped: true, error: 'No live owned root handle' };
    const result = spawnSync(join(env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
      { env, encoding: 'utf8', timeout: 15000, maxBuffer: 65536, windowsHide: true, shell: false });
    const receipt = { name: 'owned-tree-cleanup', pid: child.pid, exit: result.status,
      stdout: result.stdout, stderr: result.stderr, error: result.error?.message };
    evidence.stages.push(receipt);
    if (result.status !== 0 || result.error) cleanupFailed(`Owned tree termination failed for PID ${child.pid}`);
    save(); return receipt;
  }
  async function command(file, args, { cwd, env: childEnv = env, timeout = 15000, onLine } = {}) {
    requireValue(!abort.signal.aborted, 'Journey already failed; no further command');
    const id = String(++sequence).padStart(2, '0');
    const out = join(artifacts, `${id}.stdout`), err = join(artifacts, `${id}.stderr`);
    writeFileSync(out, ''); writeFileSync(err, '');
    const record = { command: [file, ...args], cwd, env: childEnv, exit: null, timeoutMs: timeout,
      captureBound: 32 * 1024 * 1024, closeGraceMs: 2000, terminationTimeoutMs: 15000, stdoutFile: `${id}.stdout`, stderrFile: `${id}.stderr` };
    evidence.commands.push(record); save();
    const child = spawn(file, args, { cwd, env: childEnv, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    record.pid = child.pid; save();
    const result = await captureChild(child, { timeout, terminate, onLine, signal: abort.signal,
      write: (name, bytes) => appendFileSync(name === 'stdout' ? out : err, bytes) });
    if (result.exitObserved || result.closeConfirmed) children.delete(child);
    Object.assign(record, { exit: result.status, signal: result.signal, error: result.error,
      cleanupFailure: result.cleanupFailure, capturedBytes: result.capturedBytes, partial: result.partial,
      exitObserved: result.exitObserved, closeConfirmed: result.closeConfirmed });
    if (result.cleanupFailure) cleanupFailed(result.cleanupFailure);
    save();
    requireValue(record.exit === 0 && !result.error && !result.cleanupFailure, `Command ${id} failed: ${result.error ?? result.cleanupFailure ?? record.exit}`);
    return result;
  }
  async function stage(name, operation) {
    const record = { name, status: 'STARTED' }; evidence.stages.push(record); save();
    try { const value = await operation(); record.status = 'PASSED'; save(); return value; }
    catch (error) { record.status = 'FAILED'; record.error = error.stack; save(); throw error; }
  }
  async function ownedCorePids() {
    const escaped = layout.engram.replaceAll("'", "''").replaceAll('\\', '\\\\');
    const result = await command(join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference = 'Stop'; try { ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -ErrorAction Stop -Filter "ExecutablePath='${escaped}'" | ForEach-Object { [int]$_.ProcessId }) -Compress; exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`],
      { cwd: root, timeout: 15000 });
    return validateCoreQuery(result);
  }
  try {
    // Product modules are imported only after hosted/candidate admission and env closure.
    const installer = await import(pathToFileURL(join(candidate, 'scripts', 'bundled-install.mjs')).href);
    layout = await stage('claim-private-prefix', () => installer.claimPrefix({ platform: 'win32', env, home: env.HOME }));
    const adapters = { run: command };
    const runtime = await stage('verified-runtime-and-pinned-go', () => installer.ensureRuntime({ layout,
      platform: 'win32', arch: process.arch, go: true, engram: true, env, adapters }));
    const installEnv = installer.pnpmEnvironment(layout, { env, go: runtime.go });
    const project = join(root, 'project'), input = join(root, 'input');
    mkdirSync(project); mkdirSync(input);
    const packed = await command(layout.node, [layout.npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', input],
      { cwd: candidate, timeout: 120000, env: { ...installEnv, npm_config_userconfig: layout.npmrc, npm_config_globalconfig: layout.npmGlobalConfig,
        npm_config_cache: layout.npmCache, npm_config_prefix: layout.npmPrefix } });
    const packData = JSON.parse(packed.stdout);
    requireValue(packData.length === 1 && packData[0].filename === 'gentle-pi-4.3.0.tgz', 'Unexpected candidate pack');
    const tar = join(input, packData[0].filename);
    evidence.tar = { path: tar, sha256: sha256(readFileSync(tar)), candidate: actual }; save();
    const manifest = { shell: '4.3.0', pi: '1.2.0' };
    const files = installer.distributionFiles(manifest);
    const pair = JSON.parse(files['package.json']);
    pair.dependencies['gentle-pi'] = `file:${tar.replaceAll('\\', '/')}`;
    files['package.json'] = `${JSON.stringify(pair, null, 2)}\n`;
    for (const [name, text] of Object.entries(files)) writeFileSync(join(project, name), text, { flag: 'wx' });
    await command(layout.node, [layout.pnpm, 'install', '--lockfile-only'], { cwd: project, env: installEnv, timeout: 600000 });
    const lockfile = readFileSync(join(project, 'pnpm-lock.yaml'), 'utf8');
    writeFileSync(join(artifacts, 'candidate-lock.yaml'), lockfile);
    writeFileSync(join(artifacts, 'candidate-pair.json'), files['package.json']);
    const installed = await stage('normal-frozen-candidate-install', () => installer.installVersion({ layout, manifest, lockfile,
      platform: 'win32', env, go: runtime.go, adapters: { ...adapters, distribution: () => ({ ...files }) } }));
    const installedRoot = realpathSync(join(installed.path, 'node_modules', 'gentle-pi'));
    const launcher = join(installedRoot, 'bin', 'gentle-shell.mjs');
    requireValue(sha256(readFileSync(launcher)) === sha256(readFileSync(join(candidate, 'bin', 'gentle-shell.mjs'))), 'Installed launcher differs from candidate');
    installer.activateVersion(layout, installed.id); installer.ensureLauncher(layout);
    evidence.claims.installed = true; save();
    const launchEnv = installer.setupEnvironment(layout, { env, id: installed.id });
    await command(layout.node, shellArguments(launcher, layout.agent), { cwd: project, env: launchEnv, timeout: 1200000 });
    const settings = JSON.parse(readFileSync(join(layout.agent, 'settings.json'), 'utf8'));
    const companion = JSON.parse(readFileSync(join(layout.agent, 'npm', 'node_modules', 'gentle-engram', 'package.json'), 'utf8'));
    requireValue(settings.packages?.some(entry => (typeof entry === 'string' ? entry : entry.source) === 'npm:gentle-engram@0.5.0') &&
      companion.version === '0.5.0' && companion.engram?.sessionOwned === 1, 'Real setup did not establish pinned session-owned companion');
    const config = JSON.parse(readFileSync(join(env.HOME, '.gentle-shell', 'config.json'), 'utf8'));
    const provisioned = config.provisioned?.[realpathSync(layout.agent)];
    requireValue(provisioned?.gentleAi === '4.2.0' && provisioned.gentlePi === '4.3.0', 'Real setup did not record provisioning; do not auto-retry');
    evidence.claims.provisioned = true; save();
    const marker = `shell-smoke-${randomUUID()}`;
    // Only the LLM is mocked. Tool declarations and results must come from installed Shell.
    server = createServer(async (request, response) => {
      try {
        requireValue(request.method === 'POST' && request.url === '/v1/chat/completions' && active, 'Unexpected LLM request');
        let body = '';
        for await (const bytes of request) { body += bytes; requireValue(body.length <= 4 * 1024 * 1024, 'LLM request bound'); }
        const payload = JSON.parse(body);
        requireValue(++active.requests <= 8, 'Unexpected extra model turns');
        const step = active.steps.shift();
        const data = step ? await step() : null;
        if (data) requireValue(payload.tools?.some(tool => tool.function?.name === data.name), `Native tool unavailable: ${data.name}`);
        const delta = data ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${active.requests}`, type: 'function',
          function: { name: data.name, arguments: JSON.stringify(data.args) } }] } : { role: 'assistant', content: 'done' };
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const chunk = (part, finish_reason) => `data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk',
          created: 1, model: 'smoke', choices: [{ index: 0, delta: part, finish_reason }] })}\n\n`;
        response.end(chunk(delta, null) + chunk({}, data ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
      } catch (error) {
        evidence.llmFailure ??= error.message; save();
        abort.abort(error);
        if (!response.destroyed) { response.writeHead(500); response.end('Synthetic LLM contract failed'); }
      }
    });
    server.requestTimeout = 15000;
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    const port = server.address().port;
    requireValue(port !== 7437, 'LLM must not use the shared Core port');
    writeFileSync(join(layout.agent, 'models.json'), JSON.stringify({ providers: { issue1921: {
      baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'synthetic-not-a-secret',
      models: [{ id: 'smoke', name: 'Synthetic loopback', reasoning: false, input: ['text'], contextWindow: 200000,
        maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }, null, 2));
    let previous;
    for (const number of [1, 2]) {
      const events = [], sessionPath = join(root, `session-${number}.jsonl`);
      async function result(name) {
        const deadline = Date.now() + 10000;
        while (!abort.signal.aborted && !events.some(event => event.type === 'tool_execution_end' && event.toolName === name) && Date.now() < deadline) await sleep(20);
        requireValue(!abort.signal.aborted, 'Journey aborted');
        return toolData(events, name);
      }
      active = { requests: 0, steps: [async () => ({ name: 'mem_current_project', args: { cwd: project } })] };
      if (number === 1) active.steps.push(async () => {
        const current = await result('mem_current_project');
        requireValue(current.cwd === project && current.project && ['dir_basename', 'git_remote'].includes(current.project_source), 'Invalid native project resolution');
        return { name: 'mem_save', args: { cwd: project, project: current.project, title: marker, content: marker,
          type: 'discovery', scope: 'project', capture_prompt: false } };
      });
      active.steps.push(async () => ({ name: 'mem_search', args: { query: marker, scope: 'project' } }));
      active.steps.push(async () => {
        const search = await result('mem_search');
        // Core3.5.2 native HTTP noncompact search is a raw SearchResult array.
        requireValue(Array.isArray(search), 'Native noncompact search is not an array');
        const found = search.find(item => item.content === marker);
        requireValue(found?.id, 'Synthetic observation absent from real search');
        const pids = await ownedCorePids();
        requireValue(pids.length === 1, 'Expected exactly one private owned Core');
        evidence.stages.push({ name: `session-${number}-owned-core`, pids }); save();
        return { name: 'mem_get_observation', args: { id: found.id } };
      });
      await command(layout.node, shellArguments(launcher, layout.agent, sessionPath),
        { cwd: project, env: launchEnv, timeout: 180000, onLine: event => {
          events.push(event);
          requireValue(!(event.type === 'tool_execution_end' && event.isError) &&
            !['error', 'extension_error'].includes(event.type), 'Real Shell/tool reported failure');
        } });
      requireValue(!evidence.llmFailure && active.steps.length === 0, 'Incomplete scripted tool journey');
      const header = JSON.parse(readFileSync(sessionPath, 'utf8').split('\n')[0]);
      requireValue(header.type === 'session' && typeof header.id === 'string' && header.id, 'Native session header absent');
      requireValue(toolData(events, 'mem_current_project').cwd === project, 'Native project cwd mismatch');
      const proof = memoryProof(events, marker, header.id, previous);
      requireValue((await ownedCorePids()).length === 0, 'Owned Core survived Shell shutdown');
      evidence.stages.push({ name: `session-${number}-proof`, nativeSession: header.id, observation: proof });
      evidence.claims.memoryEnabled = true;
      if (previous) evidence.claims.persisted = true;
      previous = proof; save();
    }
    evidence.claims.ownedShutdown = true;
    evidence.status = 'REAL_CANDIDATE_MEMORY_SMOKE_PASSED'; save();
  } catch (error) {
    evidence.failure ??= error.stack;
    evidence.cause = error.cause?.stack;
    evidence.status = 'FAILED'; evidence.claims.ownedShutdown = false;
    abort.abort(error); save(); throw error;
  } finally {
    for (const child of children) {
      // A failed first attempt does not suppress this final bounded cleanup.
      // Exited roots remain ineligible even if descendants still hold pipes.
      try { terminate(child); } catch (error) { cleanupFailed(error.message); }
      child.stdout.destroy(); child.stderr.destroy(); child.unref(); children.delete(child);
    }
    if (server) {
      server.closeAllConnections(); server.unref();
      await new Promise(accept => {
        const timer = setTimeout(() => { cleanupFailed('LLM listener close unconfirmed'); accept(); }, 2000);
        server.close(error => {
          clearTimeout(timer);
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') cleanupFailed(error.message);
          accept();
        });
      });
    }
    // Unkillable processes are reported, detached and left to runner disposal;
    // no shutdown claim or indefinitely awaited close is substituted for proof.
    save();
    if (evidence.cleanupFailure && !evidence.failure) throw new Error(evidence.cleanupFailure);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
