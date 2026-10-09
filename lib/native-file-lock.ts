import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import native from "fs-native-extensions";

// A permanent writable inode: never unlink or rename this mutex. The kernel
// releases it on descriptor close/process death; file contents and age do not
// confer ownership. Native errors propagate; there is no advisory fallback.
export function tryNativeFileLock(path: string): number | undefined {
	mkdirSync(dirname(path), { recursive: true });
	const fd = openSync(path, "a+", 0o600);
	try {
		if (native.tryLock(fd)) return fd;
	} catch (error) {
		closeSync(fd);
		throw error;
	}
	closeSync(fd);
	return undefined;
}

export function releaseNativeFileLock(fd: number): void {
	try { native.unlock(fd); } finally { closeSync(fd); }
}
