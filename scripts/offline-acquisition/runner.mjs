import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { get } from 'node:https';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PINS, closedEnvironment, pairFiles, commandPlan, projectEvidence, pnpmConfiguration, validateConfigurationProbe } from './policy.mjs';
import { inspectArchive, normalizeLock, requireHostedWindows, requireSuccess } from './safety.mjs';

const HELP = 'Usage: node scripts/offline-acquisition/runner.mjs [--help]\nGitHub-hosted Windows push only; LOCK_AND_NPM_INPUTS_ONLY, never runtime validation.\n';
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const integrity = bytes => `sha512-${hash(bytes, 'sha512', 'base64')}`;
const PARSER = { name: 'yaml', version: '2.9.0', integrity: 'sha512-2AvhNX3mb8zd6Zy7INTtSpl1F15HW6Wnqj0srWlkKLcpYl/gMIMJiyuGq2KeI2YFxUPjdlB+3Lc10seMLtL4cA==' };

// Direct HTTPS, no redirect/retry/proxy handling, one bounded response per tool.
function download(url, destination) {
  writeFileSync(destination, Buffer.alloc(0), { flag: 'wx' });
  return new Promise((accept, reject) => {
    const deadline = setTimeout(() => request.destroy(new Error('Download wall-clock deadline')), 60000);
    const request = get(url, { agent: false, timeout: 60000 }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`HTTP ${response.statusCode}`)); return; }
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 64 * 1024 * 1024) response.destroy(new Error('Download size limit')); else { chunks.push(chunk); appendFileSync(destination, chunk); } });
      response.on('end', () => accept(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Download timeout')));
    request.on('close', () => clearTimeout(deadline));
    request.on('error', reject);
  });
}

async function acquire() {
  requireHostedWindows({ platform: process.platform, env: process.env });
  if (process.argv.length !== 2) throw new Error('Only --help or no arguments admitted');
  const root = join(process.env.RUNNER_TEMP, 'shell-acquisition');
  const artifacts = join(root, 'artifacts');
  // Never resume a previous attempt or overwrite someone else's artifact tree.
  if (existsSync(root) || existsSync(PINS.inputDirectory)) throw new Error('Fresh acquisition paths required');
  mkdirSync(artifacts, { recursive: true });
  const evidence = { status: 'FAILED', host: { platform: process.platform, runner: process.env.RUNNER_ENVIRONMENT, repository: process.env.GITHUB_REPOSITORY, ref: process.env.GITHUB_REF, event: process.env.GITHUB_EVENT_NAME }, pins: { ...PINS, parser: PARSER }, candidate: PINS.candidate, workflow: process.env.GITHUB_SHA, commands: [], tools: [], limitations: ['No lifecycle/runtime execution', 'Companion npm/Go/native inputs unknown', 'Not complete offline closure', 'New source tar is not historical or registry bytes'] };
  const save = () => writeFileSync(join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2));
  const inventory = () => {
    const files = readdirSync(artifacts).filter(name => !['evidence.json', 'integrity-inventory.json'].includes(name));
    const entries = files.map(name => {
      const path = join(artifacts, name);
      if (!lstatSync(path).isFile()) throw new Error('Unexpected artifact type');
      return { name, sha256: hash(readFileSync(path)) };
    });
    writeFileSync(join(artifacts, 'integrity-inventory.json'), JSON.stringify(entries, null, 2));
  };
  save();
  let archivePartial;
  try {
    const nodeDirectory = dirname(process.execPath);
    if (process.versions.node !== PINS.node) throw new Error('Pinned Node required');
    const paths = { root, nodeDirectory, systemRoot: process.env.SystemRoot };
    const env = closedEnvironment(paths);
    const configuration = pnpmConfiguration(paths);
    evidence.childEnvironment = env; save();
    const project = join(root, 'project');
    const store = join(root, 'store'), virtual = join(root, 'virtual-store');
    for (const path of [env.HOME, env.APPDATA, env.LOCALAPPDATA, env.TEMP, project, store, virtual, PINS.inputDirectory]) mkdirSync(path, { recursive: true });
    const userconfig = join(root, 'empty-user.npmrc'), globalconfig = join(root, 'empty-global.npmrc');
    writeFileSync(userconfig, ''); writeFileSync(globalconfig, '');
    mkdirSync(configuration.directory, { recursive: true });
    writeFileSync(configuration.authFile, '', { flag: 'wx' });
    writeFileSync(join(configuration.directory, 'auth.ini'), '', { flag: 'wx' });
    writeFileSync(join(configuration.directory, 'config.yaml'), '{}\n', { flag: 'wx' });
    // No ancestor project configuration may leak into pnpm's fresh pair.
    for (let parent = project; ; parent = dirname(parent)) {
      for (const config of ['.npmrc', '.pnpmfile.cjs', 'pnpmfile.cjs', 'pnpm-workspace.yaml']) if (existsSync(join(parent, config))) throw new Error('Unexpected ancestor configuration');
      if (dirname(parent) === parent) break;
    }
    const candidate = join(process.env.GITHUB_WORKSPACE, 'candidate');
    const controls = join(process.env.GITHUB_WORKSPACE, 'controls');
    if (readFileSync(join(candidate, '.git', 'HEAD'), 'utf8').trim() !== PINS.candidate || readFileSync(join(controls, '.git', 'HEAD'), 'utf8').trim() !== process.env.GITHUB_SHA) throw new Error('Checkout identity mismatch');
    for (const config of ['.npmrc', '.pnpmfile.cjs', '.pnpmfile.mjs', 'pnpmfile.cjs', 'node_modules']) if (existsSync(join(candidate, config))) throw new Error('Candidate executable/config state rejected');
    const manifest = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
    if (manifest.name !== 'gentle-pi' || manifest.version !== '4.3.0' || 'configDependencies' in manifest || 'pnpm' in manifest || !Array.isArray(manifest.files) || manifest.files.includes('odd/') || manifest.files.includes('tmp/')) throw new Error('Candidate package shape rejected');

    let index = 0;
    function command(executable, args, cwd) {
      const id = String(++index).padStart(2, '0');
      const result = spawnSync(executable, args, { cwd, env, shell: false, windowsHide: true, timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
      const record = { command: [executable, ...args], cwd, env, exit: result.status, stdout: (result.stdout ?? Buffer.alloc(0)).toString('utf8'), stderr: (result.stderr ?? Buffer.alloc(0)).toString('utf8'), error: result.error?.message };
      writeFileSync(join(artifacts, `${id}.stdout`), result.stdout ?? Buffer.alloc(0));
      writeFileSync(join(artifacts, `${id}.stderr`), result.stderr ?? Buffer.alloc(0));
      const summary = projectEvidence(record);
      evidence.commands.push({ ...summary, cwd, signal: result.signal, timeoutMs: 300000, maxBuffer: 32 * 1024 * 1024, stdoutFile: `${id}.stdout`, stderrFile: `${id}.stderr` }); save();
      requireSuccess(record);
      return record;
    }
    let archived = false;
    archivePartial = () => {
      if (archived) return;
      archived = true; // evidence-only finalization, never retry acquisition
      command(join(env.SystemRoot, 'System32', 'tar.exe'), ['-czf', join(artifacts, 'store.tgz'), '-C', root, 'store', 'virtual-store'], root);
    };
    async function tool(pin) {
      const url = `https://registry.npmjs.org/${pin.name}/-/${pin.name}-${pin.version}.tgz`;
      const item = { ...pin, url, method: 'GET', redirects: false, retries: 0, timeoutMs: 60000, maxBytes: 64 * 1024 * 1024, status: 'STARTED' }; evidence.tools.push(item); save();
      const bytes = await download(url, join(artifacts, `${pin.name}-${pin.version}.tgz`));
      if (integrity(bytes) !== pin.integrity) throw new Error('Tool SRI mismatch');
      const entries = inspectArchive(bytes);
      const destination = join(root, pin.name);
      mkdirSync(destination);
      for (const entry of entries) {
        const target = join(destination, entry.name);
        if (entry.directory) mkdirSync(target, { recursive: true });
        else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, entry.data, { flag: 'wx' }); }
      }
      const pkg = JSON.parse(readFileSync(join(destination, 'package', 'package.json'), 'utf8'));
      if (pkg.name !== pin.name || pkg.version !== pin.version || (pin.name === 'yaml' && Object.keys(pkg.dependencies ?? {}).length)) throw new Error('Unsupported tool closure');
      item.sha256 = hash(bytes); item.status = 'VERIFIED'; save();
      return join(destination, 'package');
    }
    const parserRoot = await tool(PARSER);
    const yaml = createRequire(import.meta.url)(join(parserRoot, 'dist', 'index.js'));
    function parse(text) {
      const doc = yaml.parseDocument(text, { version: '1.2', uniqueKeys: true, strict: true, customTags: [] });
      if (doc.errors.length || doc.warnings.length) throw new Error('YAML diagnostics rejected');
      return doc.toJS({ maxAliasCount: 0 });
    }
    // Candidate workspace is read as data, never used to install. Unknown
    // configuration is rejected even though npm pack does not consume it.
    const workspace = parse(readFileSync(join(candidate, 'pnpm-workspace.yaml'), 'utf8'));
    const allowedWorkspace = ['nodeLinker', 'minimumReleaseAge', 'minimumReleaseAgeExclude', 'trustPolicy', 'blockExoticSubdeps', 'allowBuilds'];
    if (!workspace || Object.keys(workspace).some(key => !allowedWorkspace.includes(key))) throw new Error('Unadmitted candidate workspace configuration');
    const pnpmRoot = await tool({ name: 'pnpm', version: PINS.pnpm, integrity: PINS.pnpmIntegrity });
    const pnpm = join(pnpmRoot, 'bin', 'pnpm.cjs');
    // Read-only, real pinned CLI compatibility checks, not offline closure.
    // Empty project/config roots exist before any pnpm process can load them.
    for (const [key, expected] of [['config-dir', configuration.directory], ['npmrc-auth-file', configuration.authFile]]) {
      const result = command(process.execPath, [pnpm, ...commandPlan().probe, key, ...configuration.flags], project);
      validateConfigurationProbe(result, expected);
    }
    const npm = join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const plans = commandPlan();
    command(process.execPath, [npm, ...plans.pack, '--cache', join(root, 'npm-cache'), '--userconfig', userconfig, '--globalconfig', globalconfig], candidate);
    const tar = readFileSync(PINS.localTar);
    const packed = inspectArchive(tar);
    if (packed.some(entry => /^package\/(?:odd|tmp|\.git)(?:\/|$)/.test(entry.name))) throw new Error('Pack exclusions violated');
    writeFileSync(join(artifacts, 'gentle-pi-4.3.0.tgz'), tar);
    evidence.localTar = { path: PINS.localTar, source: PINS.candidate, sha256: hash(tar), integrity: integrity(tar) }; save();
    for (const [name, contents] of Object.entries(pairFiles(PINS.candidate))) writeFileSync(join(project, name), contents);
    const isolation = ['--store-dir', store, '--virtual-store-dir', virtual, ...configuration.flags, '--fetch-retries=0'];
    command(process.execPath, [pnpm, ...plans.resolve, ...isolation], project);
    const lockText = readFileSync(join(project, 'pnpm-lock.yaml'), 'utf8');
    writeFileSync(join(artifacts, 'pnpm-lock.yaml'), lockText);
    const sources = normalizeLock(parse(lockText), evidence.localTar);
    writeFileSync(join(artifacts, 'origins.json'), JSON.stringify(sources, null, 2));
    for (const name of ['package.json', 'pnpm-workspace.yaml']) writeFileSync(join(artifacts, name), readFileSync(join(project, name)));
    command(process.execPath, [pnpm, ...plans.fetch, ...isolation], project);
    // fetch materializes a virtual store. No installed dependency is imported.
    archivePartial();
    inventory();
    evidence.status = 'LOCK_AND_NPM_INPUTS_ONLY'; save();
  } catch (error) {
    evidence.failure = error.message; save();
    try { archivePartial?.(); } catch (archiveError) { evidence.archiveFailure = archiveError.message; }
    try { inventory(); } catch (inventoryError) { evidence.inventoryFailure = inventoryError.message; }
    save(); throw error;
  }
}

if (process.argv.length === 3 && process.argv[2] === '--help') process.stdout.write(HELP);
else acquire().catch(error => { console.error(error.message); process.exitCode = 1; });
