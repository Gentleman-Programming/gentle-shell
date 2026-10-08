import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {tryLock,unlock} from 'fs-native-extensions';
const dir=path.dirname(fileURLToPath(import.meta.url));
const lockFile=path.join(dir,'probe.lock');
if(process.argv.includes('--holder')) {
  const fd=fs.openSync(lockFile,'a+',0o600);
  assert.equal(tryLock(fd),true);
  process.send({held:true});
  process.on('message',()=>{});
} else {
  const report={platform:process.platform,arch:process.arch,node:process.version,bindingLoaded:true};
  const a=fs.openSync(lockFile,'a+',0o600),b=fs.openSync(lockFile,'a+',0o600);
  try {
    assert.equal(tryLock(a),true);
    assert.equal(tryLock(b),false,'independent descriptors cannot overlap');
    unlock(a);
    assert.equal(tryLock(b),true);
    unlock(b);
    report.sameProcessExclusion=true;
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--holder'],{cwd:dir,env:process.env,stdio:['ignore','pipe','pipe','ipc']});
    let stdout='',stderr='';
    child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    const exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));});
    const watchdog=setTimeout(()=>child.kill('SIGKILL'),10000);
    try {
      await new Promise((resolve,reject)=>{child.once('message',m=>m.held?resolve():reject(new Error('holder not locked')));child.once('exit',code=>reject(new Error('holder exited before ready: '+code)));});
      assert.equal(tryLock(a),false,'live child excludes parent');
      report.crossProcessExclusion=true;
      child.kill('SIGKILL');
      const terminated=await exit;
      assert.equal(terminated.stdout,'');assert.equal(terminated.stderr,'');
      assert.equal(fs.existsSync(lockFile),true,'lock file is permanent, not reclaimed by pathname');
      assert.equal(tryLock(a),true,'kernel releases lock after forced process death');
      unlock(a);
      report.processDeathRelease=true;report.child=terminated;report.pass=true;
    } finally {clearTimeout(watchdog);child.kill('SIGKILL');}
  } finally {fs.closeSync(a);fs.closeSync(b);}
  fs.writeFileSync(path.join(dir,'result-'+process.platform+'.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
