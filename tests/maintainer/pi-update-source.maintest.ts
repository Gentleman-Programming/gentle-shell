// Real managers, private HOME/cache and a loopback-only registry; no live installation is touched.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { updateSelectedPi } from '../../scripts/pi-update.mjs';

const exec = promisify(execFile);
const PI = '@earendil-works/pi-coding-agent';
for (const manager of ['npm', 'pnpm']) test(`real ${manager} source update preserves ranges, unrelated pins, Shell link and lifecycle safety`, {skip: process.platform === 'win32'}, async t => {
 const temp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pi-real-')));
 t.after(() => fs.rm(temp, {recursive:true, force:true}));
 const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(npm_config_|pnpm_config_|git_)/i.test(key)));
 Object.assign(env, {HOME:temp, USERPROFILE:temp, XDG_CONFIG_HOME:temp, XDG_CACHE_HOME:join(temp,'cache'), npm_config_cache:join(temp,'cache'), npm_config_userconfig:join(temp,'user.npmrc'), npm_config_globalconfig:join(temp,'global.npmrc'), npm_config_update_notifier:'false', COREPACK_ENABLE_PROJECT_SPEC:'0', COREPACK_ENABLE_NETWORK:'0', COREPACK_HOME:join(temp,'corepack'), PNPM_HOME:join(temp,'pnpm-home')});
 await fs.writeFile(env.npm_config_userconfig!, '');
 await fs.writeFile(env.npm_config_globalconfig!, '');
 const command = (await exec('which', [manager], {env})).stdout.trim();
 const version = (await exec(command, ['--version'], {cwd:temp, env})).stdout.trim();
 const files = new Map<string, Buffer>();
 const manifests: Record<string, any> = {};
 let updated = false;
 let registry = '';
 const registryRequests: {path: string, phase: string}[] = [];
 const managerRuns: {args: string[], stdout: string, stderr: string}[] = [];
 const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url!.split('?')[0]);
  registryRequests.push({path, phase:updated ? 'update' : 'install'});
  const tar = files.get(path);
  if (tar) {res.end(tar); return;}
  const name = path.slice(1);
  if (!manifests[name]) {res.statusCode = 404; res.end('{}'); return;}
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({name, 'dist-tags':{latest:updated ? '1.1.0' : '1.0.0'}, time:{'1.0.0':'2020-01-01T00:00:00Z','1.1.0':'2020-01-02T00:00:00Z'}, versions:updated ? manifests[name] : {'1.0.0':manifests[name]['1.0.0']}}));
 });
 await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
 t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
 registry = `http://127.0.0.1:${(server.address() as any).port}`;
 env.npm_config_registry = registry;
 env.npm_config_store_dir = join(temp, 'store');
 Object.assign(env, {HTTP_PROXY:'http://127.0.0.1:9', HTTPS_PROXY:'http://127.0.0.1:9', NO_PROXY:'127.0.0.1,localhost'});
 // pnpm 11 does not honor npm's registry environment variable. Bind both
 // install and update explicitly to the fixture registry and private store.
 const registryFlags = ['--registry', registry, ...(manager === 'pnpm' ? ['--store-dir', join(temp,'store'), '--config.update-notifier=false'] : [])];
 for (const name of [PI, 'unrelated-fixture']) {
  manifests[name] = {};
  for (const version of ['1.0.0', '1.1.0']) {
   const pack = join(temp, `pack-${name === PI ? 'pi' : 'other'}-${version}`);
   await fs.mkdir(join(pack, 'package', 'dist', 'bundle'), {recursive:true});
   const manifest = {name, version, bin:name === PI ? {pi:'dist/bundle/cli.js'} : undefined, scripts:{postinstall:'node -e "require(\'fs\').writeFileSync(\'LIFECYCLE_RAN\', \'bad\')"'}};
   await fs.writeFile(join(pack, 'package', 'package.json'), JSON.stringify(manifest));
   await fs.writeFile(join(pack, 'package', 'dist', 'bundle', 'cli.js'), `console.log('${version}');`);
   const archive = join(pack, 'p.tgz');
   await exec('tar', ['-czf', archive, '-C', pack, 'package'], {env});
   const bytes = await fs.readFile(archive);
   const path = `/tar/${name === PI ? 'pi' : 'other'}-${version}.tgz`;
   files.set(path, bytes);
   manifests[name][version] = {...manifest, dist:{tarball:registry + path, shasum:createHash('sha1').update(bytes).digest('hex')}};
  }
 }
 const root = join(temp, 'checkout');
 await fs.mkdir(join(root, '.git'), {recursive:true});
 const declaredVersion = manager === 'pnpm' ? '11.1.1' : version;
 t.diagnostic(`${manager} runtime ${version}; project declaration ${declaredVersion}`);
 const manifest = JSON.stringify({name:'gentle-pi', version:'4.4.0', packageManager:`${manager}@${declaredVersion}`, devDependencies:{[PI]:'^1.0.0', 'unrelated-fixture':'^1.0.0'}});
 await fs.writeFile(join(root, 'package.json'), manifest);
 const policy = 'minimumReleaseAge: 4320\n';
 if (manager === 'pnpm') await fs.writeFile(join(root,'pnpm-workspace.yaml'), policy);
 const common = ['--ignore-scripts', '--global=false', ...(manager === 'pnpm' ? ['--ignore-pnpmfile', '--pm-on-fail=ignore'] : ['--no-audit', '--no-fund'])];
 await exec(command, ['install', ...common, ...registryFlags], {cwd:root, env, maxBuffer:1024*1024});
 const lockPath = join(root, manager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json');
 const oldLock = await fs.readFile(lockPath, 'utf8');
 const link = join(temp, 'global', 'node_modules', 'gentle-pi');
 await fs.mkdir(join(temp, 'global', 'node_modules'), {recursive:true});
 await fs.symlink(root, link, 'junction');
 const selected = await fs.realpath(join(root, 'node_modules', PI, 'dist', 'bundle', 'cli.js'));
 updated = true;
 const output: string[] = [];
 const mutations: string[][] = [];
 assert.equal(await updateSelectedPi({runtime:{kind:'bundled', command:process.execPath, args:[selected]}, packageRoot:link, cwd:temp, home:temp, env, currentVersion:'1.0.0', out:(s: string) => output.push(s), adapters:{
  fs,
  which:async (name: string) => name === manager || name === 'npm' ? command : null,
  run:async (_cmd: string, args: string[], options: {cwd?: string,env?: Record<string,string>}) => {
   if (args.includes('list') && args.includes('-g')) return {code:0, stdout:JSON.stringify([{path:temp, dependencies:{}}])};
   if (args.includes('ls') && args.includes('-g')) return {code:0, stdout:JSON.stringify({path:temp, dependencies:{'gentle-pi':{path:link, resolved:'file:../../checkout'}}})};
   if (args[0] === 'update') mutations.push(args);
   // The second phase models an already-published release, not a newly
   // backdated version hidden behind install's fresh metadata-age cache.
   const selectedEnv = options.env ?? env;
   const runEnv = manager === 'pnpm' && args[0] === 'update' ? {...selectedEnv, XDG_CACHE_HOME:join(temp,'update-cache')} : selectedEnv;
   try {const result = await exec(command, args[0] === 'update' ? [...args, ...registryFlags] : args, {cwd:options.cwd, env:runEnv, maxBuffer:1024*1024}); managerRuns.push({args, stdout:result.stdout, stderr:result.stderr}); return {code:0, stdout:result.stdout, stderrTail:result.stderr};}
   catch (error: any) {return {code:error.code, stdout:error.stdout, stderrTail:error.stderr};}
  },
 }}), 0);
 assert.equal(mutations.length, 1);
 assert.ok(mutations[0].includes(PI));
 assert.ok(registryRequests.some(request => request.phase === 'update' && request.path === `/${PI}`), JSON.stringify(registryRequests));
 assert.ok(!mutations[0].includes('-g'));
 assert.equal(await fs.realpath(link), root);
 assert.equal(await fs.readFile(join(root, 'package.json'), 'utf8'), manifest);
 if (manager === 'pnpm') {
  assert.equal(await fs.readFile(join(root,'pnpm-workspace.yaml'),'utf8'), policy);
  assert.ok(managerRuns.filter(run => run.args.includes('config') || run.args.includes('--recursive') || run.args[0] === 'update').every(run => run.args.includes('--pm-on-fail=ignore')));
  assert.ok(!registryRequests.some(request => request.path === '/pnpm' || request.path.startsWith('/@pnpm/')), 'no project-pinned manager acquired');
 }
 assert.notEqual(await fs.readFile(lockPath, 'utf8'), oldLock, JSON.stringify({output, installed:JSON.parse(await fs.readFile(join(root,'node_modules',PI,'package.json'),'utf8')).version, managerRuns, registryRequests}));
 assert.equal(JSON.parse(await fs.readFile(join(root,'node_modules',PI,'package.json'),'utf8')).version, '1.1.0');
 assert.equal(JSON.parse(await fs.readFile(join(root,'node_modules','unrelated-fixture','package.json'),'utf8')).version, '1.0.0');
 await assert.rejects(fs.access(join(root,'node_modules',PI,'LIFECYCLE_RAN')));
 assert.equal(output.length, 1);
 assert.match(output[0], /the selected Pi is now 1\.1\.0 \(was 1\.0\.0\)/);
});
