import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MAX_SAVED_SOUNDS, SAVED_SOUNDS_SCHEMA, addSavedSound, hasSavedSound, isSavedSound,
	parseSavedSoundsFile, resolveSavedSounds, savedSoundKey, writeSavedSounds,
} from "../lib/notification-sounds.ts";
import { join } from "node:path";
import type { NotificationIO } from "../lib/notification-policy.ts";

/** Same shape as the policy tests: no test may touch the real filesystem. */
function memoryIO() {
	const files = new Map<string, string>();
	const calls: Array<{ operation: string; path: string; options?: unknown }> = [];
	let readFailure: string | undefined;
	let renameFailure = false;
	const io: NotificationIO = {
		readFile(path) {
			calls.push({ operation: "read", path });
			if (readFailure || !files.has(path)) throw Object.assign(new Error("read"), { code: readFailure ?? "ENOENT" });
			return files.get(path)!;
		},
		mkdir(path) { calls.push({ operation: "mkdir", path }); },
		writeFile(path, content, options) {
			calls.push({ operation: "write", path, options });
			if (files.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
			files.set(path, content);
		},
		rename(from, to) {
			calls.push({ operation: "rename", path: from });
			if (renameFailure) throw new Error("rename failed");
			files.set(to, files.get(from)!); files.delete(from);
		},
		unlink(path) { calls.push({ operation: "unlink", path }); files.delete(path); },
	};
	return { files, calls, io, setReadFailure: (code: string) => { readFailure = code; }, failRename: () => { renameFailure = true; } };
}
/** The flavor is an explicit input, never the host platform: these tests must behave identically on Linux CI. */
const options = (io: NotificationIO, home = HOME) => ({ gentlePiConfigHome: home, io, pathFlavor: "win32" as const });
/** Built with `join` so the assertion holds on both path flavors; the production code uses the same join. */
const HOME = "/config";
const ENTRY = join(HOME, "notifications-sounds.json");
const document = (sounds: unknown, schema: unknown = SAVED_SOUNDS_SCHEMA) => JSON.stringify({ schema, sounds });

const WIN_A = "C:\\Users\\HP\\Downloads\\a.wav";
const WIN_B = "C:\\Users\\HP\\Downloads\\b.wav";

test("an absent saved-sounds file is an empty library that creates nothing and warns about nothing", () => {
	const fs = memoryIO();
	const resolution = resolveSavedSounds(options(fs.io));
	assert.deepEqual(resolution, { sounds: [], malformed: false, readError: false, file: ENTRY });
	assert.deepEqual(fs.calls.map(call => call.operation), ["read"], "an absent library is only read, never created");
});

test("only the strict saved-sounds shape is accepted", () => {
	assert.deepEqual(parseSavedSoundsFile(document([{ path: WIN_A }]), "win32"), [{ path: WIN_A }]);
	for (const rejected of [
		document([{ path: WIN_A }], "gentle-shell.notifications/v1"),
		document([{ path: WIN_A, volume: 50 }]),
		document([{ path: WIN_A, label: "a" }]),
		document([{ path: WIN_A.slice(2) }]),
		document([{ path: "" }]),
		document([{ path: 42 }]),
		document(["C:\\a.wav"]),
		document([{ path: "file:C:\\a.wav" }]),
		document({ path: WIN_A }),
		JSON.stringify({ schema: SAVED_SOUNDS_SCHEMA }),
		JSON.stringify({ sounds: [{ path: WIN_A }] }),
		"[]", "null", "{", "",
	]) assert.equal(parseSavedSoundsFile(rejected, "win32"), undefined, `must reject ${rejected}`);
});

test("the same library resolves and round-trips under the POSIX flavor", () => {
	const posix = "/home/you/sounds/a.ogg";
	assert.deepEqual(parseSavedSoundsFile(document([{ path: posix }]), "posix"), [{ path: posix }]);
	assert.equal(parseSavedSoundsFile(document([{ path: posix }]), "win32"), undefined, "a POSIX path is not a Windows entry");
	const fs = memoryIO();
	writeSavedSounds([{ path: posix }], { gentlePiConfigHome: HOME, io: fs.io, pathFlavor: "posix" });
	fs.files.set(ENTRY, fs.files.get(ENTRY)!);
	assert.deepEqual(resolveSavedSounds({ gentlePiConfigHome: HOME, io: fs.io, pathFlavor: "posix" }).sounds, [{ path: posix }]);
});

test("the same file is one entry under Windows casing and separators, and two under POSIX", () => {
	assert.equal(savedSoundKey(WIN_A, "win32"), savedSoundKey(WIN_A.toLowerCase(), "win32"));
	assert.equal(savedSoundKey("C:\\Users\\HP\\a.wav", "win32"), savedSoundKey("c:/users/hp/A.WAV", "win32"));
	assert.notEqual(savedSoundKey("/home/hp/a.wav", "posix"), savedSoundKey("/home/hp/A.wav", "posix"));
});

test("insert appends once, is idempotent for a file already saved and never mutates the input", () => {
	const empty: Array<{ path: string }> = [];
	const first = addSavedSound(empty, WIN_A, "win32")!;
	assert.deepEqual(first, [{ path: WIN_A }]);
	assert.deepEqual(empty, [], "the input list is never mutated");
	const second = addSavedSound(first, WIN_A.toLowerCase(), "win32")!;
	assert.deepEqual(second, [{ path: WIN_A }], "a duplicate is not stored twice");
	assert.equal(hasSavedSound(first, WIN_A, "win32"), true);
	assert.equal(hasSavedSound(first, "C:\\Users\\HP\\Downloads\\c.wav", "win32"), false);
	assert.equal(hasSavedSound(first, "/home/hp/a.wav", "posix"), false, "a POSIX path is never a Windows entry");
});

test("the library is bounded and refuses a new sound instead of dropping a saved one", () => {
	const full = Array.from({ length: MAX_SAVED_SOUNDS }, (_unused, index) => ({ path: `C:\\sounds\\${index}.wav` }));
	assert.equal(addSavedSound(full, "C:\\sounds\\extra.wav", "win32"), undefined, "a full library refuses the insert");
	assert.equal(full.length, MAX_SAVED_SOUNDS, "the saved sounds are never dropped");
	assert.deepEqual(addSavedSound(full, full[0]!.path, "win32"), full, "a duplicate of a stored sound still succeeds");
});

test("the writer is an atomic same-directory 0600 write and validates before any IO", () => {
	const fs = memoryIO();
	writeSavedSounds([{ path: WIN_A }], options(fs.io));
	const write = fs.calls.find(call => call.operation === "write")!;
	assert.ok(write.path.startsWith(`${ENTRY}.`) && write.path.endsWith(".tmp"), `temporary beside the target, got ${write.path}`);
	assert.deepEqual(write.options, { flag: "wx", mode: 0o600 });
	assert.deepEqual(fs.calls.map(call => call.operation), ["mkdir", "write", "rename", "unlink"], "the temporary is always released after a successful write");
	assert.equal(fs.files.get(ENTRY), `${JSON.stringify({ schema: SAVED_SOUNDS_SCHEMA, sounds: [{ path: WIN_A }] })}\n`);

	const untouched = memoryIO();
	assert.throws(() => writeSavedSounds([{ path: "relative.wav" }], options(untouched.io)), TypeError);
	assert.throws(() => writeSavedSounds([{ path: WIN_A, extra: true }] as never, options(untouched.io)), TypeError);
	assert.deepEqual(untouched.calls, [], "an invalid library never reaches the filesystem");
});

test("a failed rename preserves the previous bytes, propagates and cleans its temporary", () => {
	const fs = memoryIO();
	fs.files.set(ENTRY, document([{ path: WIN_A }]));
	fs.failRename();
	assert.throws(() => writeSavedSounds([{ path: WIN_B }], options(fs.io)), /rename failed/);
	assert.equal(fs.files.get(ENTRY), document([{ path: WIN_A }]), "the previous library is untouched");
	assert.equal(fs.calls.at(-1)?.operation, "unlink", "the temporary is cleaned up");
	assert.equal([...fs.files.keys()].some(path => path.endsWith(".tmp")), false);
});

test("a malformed or unreadable library is reported so a caller can refuse to overwrite it", () => {
	const broken = memoryIO();
	broken.files.set(ENTRY, document([{ path: "relative.wav" }]));
	assert.deepEqual(resolveSavedSounds(options(broken.io)), { sounds: [], malformed: true, readError: false, file: ENTRY });

	const denied = memoryIO();
	denied.setReadFailure("EACCES");
	assert.deepEqual(resolveSavedSounds(options(denied.io)), { sounds: [], malformed: false, readError: true, file: ENTRY });

	const valid = memoryIO();
	valid.files.set(ENTRY, document([{ path: WIN_A }, { path: WIN_B }], SAVED_SOUNDS_SCHEMA));
	assert.deepEqual(resolveSavedSounds(options(valid.io)).sounds, [{ path: WIN_A }, { path: WIN_B }]);
});

test("a saved entry carries nothing but its validated absolute path", () => {
	assert.equal(isSavedSound({ path: WIN_A }, "win32"), true);
	assert.equal(isSavedSound({ path: "C:\\a.wav", label: "x" }, "win32"), false);
	assert.equal(isSavedSound({ path: "https://example.test/a.wav" }, "win32"), false);
	assert.equal(isSavedSound({ path: "C:\\a.wav" }, "posix"), false, "a Windows path is not a POSIX entry");
});
