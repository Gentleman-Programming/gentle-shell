// Test-only Windows shebang support, restricted to disposable fixture roots.
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');

function invocation(command, args, root, platform = process.platform, env = process.env) {
	if (platform !== 'win32' || !root || typeof command !== 'string') return [command, args];
	try {
		let script = command;
		if (!path.isAbsolute(command) && path.basename(command) === command) {
			// Only the fixture's first PATH directory may supply a bare mock.
			const first = (env.PATH ?? env.Path ?? '').split(path.delimiter)[0];
			if (!first || fs.realpathSync(first) !== fs.realpathSync(root)) return [command, args];
			script = path.join(root, command);
		}
		const target = fs.realpathSync(script);
		const relative = path.relative(fs.realpathSync(root), target);
		if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [command, args];
		if (!fs.statSync(target).isFile()) return [command, args];
		const fd = fs.openSync(target, 'r');
		const header = Buffer.alloc(64);
		try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
		if (!/^#!\/usr\/bin\/env node\r?\n/.test(header.toString())) return [command, args];
		return [process.execPath, [script, ...args]];
	} catch {
		// Missing executables retain the native spawn failure contract.
		return [command, args];
	}
}

module.exports = { invocation };
if (process.platform === 'win32' && process.env.TEST_NODE_EXECUTABLE_ROOT) {
	for (const name of ['spawn', 'spawnSync']) {
		const original = cp[name];
		cp[name] = function (command, args, options) {
			if (!Array.isArray(args) || options?.shell) return original.apply(this, arguments);
			const mapped = invocation(command, args, process.env.TEST_NODE_EXECUTABLE_ROOT, process.platform, options?.env ?? process.env);
			return original.call(this, ...mapped, options);
		};
	}
	syncBuiltinESMExports();
}
