import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import native from 'fs-native-extensions';
const [mode, root, lockPath] = process.argv.slice(2);
if (mode === 'hold') {
  const fd = fs.openSync(lockPath, 'a+', 0o600);
  if (!native.tryLock(fd)) throw new Error('failed to hold mutex');
  process.send('held');
  process.on('message', () => { native.unlock(fd); fs.closeSync(fd); process.exit(0); });
} else {
  const { applyModelConfig } = await import('../../extensions/gentle-ai.ts');
  if (mode === 'fault') {
    const original = fs.writeFileSync;
    fs.writeFileSync = function(path, ...args) {
      if (String(path).includes('materialized-model-profiles.json.tmp-')) {
        original(path, '{');
        process.send('partial-temp');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
      return original(path, ...args);
    };
    syncBuiltinESMExports();
  }
  applyModelConfig(root, { helper: { model: 'openai/helper', thinking: 'high' } });
  process.send('applied');
  process.disconnect();
}
