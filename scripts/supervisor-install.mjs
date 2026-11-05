// Read-only evidence for a diagnostic, never authority to execute or write.
import { dirname, join } from 'node:path';

export async function supervisorInstall({ packageRoot, platform, fs }) {
 if (platform !== 'linux') return undefined;
 try {
  const canonicalPackage = await fs.realpath(packageRoot);
  const root = dirname(dirname(dirname(dirname(canonicalPackage))));
  const prefix = join(root, 'prefix');
  if (canonicalPackage !== join(prefix, 'lib', 'node_modules', 'gentle-pi')) return undefined;
  if (await fs.realpath(root) !== root || await fs.realpath(prefix) !== prefix) return undefined;
  const manifestPath = join(root, 'installation.json');
  const supervisor = join(root, 'supervisor');
  for (const file of [manifestPath, supervisor]) {
   const stat = await fs.lstat(file);
   if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(file) !== file) return undefined;
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest?.Schema !== 'gentle-shell-user-install/v1' || manifest.Destination !== root || manifest.Prefix !== prefix) return undefined;
  return supervisor;
 } catch {
  // Missing, unreadable, malformed or redirected evidence keeps the old route.
  return undefined;
 }
}
