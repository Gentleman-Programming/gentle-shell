import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { askLine, runBundledSelfUninstall, runSelfUninstall, SHARED_CONFIG_FILES } from "../lib/gentle-shell-uninstall.ts";

const posixOnly = { skip: process.platform === "win32" };
const SHA = "1f9d5e6423e37f7d2316859045f379ba9b5d8c3a";

type Owner = { name: "pnpm" | "npm"; command: string; prefix: string[] };
type Options = {
	ask?: (question: string) => Promise<string>;
	owner?: Owner | Error;
	env?: Record<string, string>;
	interactive?: boolean;
	answers?: string[];
	platform?: string;
	runCode?: number;
};

function write(path: string, text = "{}\n") {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

/** A sandboxed $HOME holding a full Gentle Shell installation; the real home is never touched. */
function world() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "self-uninstall-")));
	const home = join(root, "home");
	const config = join(home, ".pi", "gentle-ai");
	const shell = join(home, ".gentle-shell");
	const isolated = join(shell, "agent");
	const piHome = join(home, ".pi", "agent");
	const paths = {
		main: join(config, "main"),
		channel: join(config, "channel.json"),
		devBinary: join(config, "dev-binary.json"),
		go: join(config, "tools", "go"),
		isolated,
		launcherConfig: join(shell, "config.json"),
	};
	write(join(paths.main, "gentle-ai", SHA, "gentle-ai"), "binary");
	write(paths.channel, JSON.stringify({ schema: "gentle-shell.channel/v1", channel: "main", shellCommit: SHA, gentleAiCommit: SHA }));
	write(paths.devBinary, JSON.stringify({ schema: "gentle-pi.dev-binary/v1", path: join(paths.main, "gentle-ai", SHA, "gentle-ai") }));
	write(join(paths.go, "1.25.10", "go", "bin", "go"), "go");
	write(join(paths.go, "1.25.10", ".gentle-shell-go"), "https://go.dev/dl/go1.25.10.darwin-arm64.tar.gz\n");
	write(join(isolated, "settings.json"));
	write(join(isolated, ".gentle-shell-home"));
	write(paths.launcherConfig, JSON.stringify({ home: "isolated" }));
	for (const name of ["profiles.json", "persona.json"]) write(join(config, name));
	write(join(config, "unknown.json"));
	write(join(piHome, "settings.json"));
	const calls: { command: string; argv: string[]; ownDataLeft: string[]; sharedLeft: boolean; shellLeft: boolean }[] = [];
	const out: string[] = [];
	const err: string[] = [];
	const questions: string[] = [];
	const ownLeft = () => Object.values(paths).filter((path) => existsSync(path));
	const uninstall = (args: string[], options: Options = {}) => {
		const answers = [...(options.answers ?? [])];
		return runSelfUninstall({
			args,
			env: options.env ?? {},
			homedir: home,
			platform: options.platform ?? "darwin",
			interactive: options.interactive ?? false,
			resolveOwner: async () => {
				const owner = options.owner ?? { name: "pnpm", command: "/usr/bin/pnpm", prefix: [] };
				if (owner instanceof Error) throw owner;
				return owner;
			},
			run: async (command: string, argv: string[]) => {
				calls.push({ command, argv, ownDataLeft: ownLeft(), sharedLeft: existsSync(join(config, "profiles.json")), shellLeft: existsSync(shell) });
				return { code: options.runCode ?? 0 };
			},
			ask: options.ask ?? (async (question: string) => {
				questions.push(question);
				return answers.shift() ?? "";
			}),
			out: (line: string) => out.push(line),
			err: (line: string) => err.push(line),
		});
	};
	return { root, home, config, shell, isolated, piHome, paths, calls, out, err, questions, ownLeft, uninstall, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

type World = ReturnType<typeof world>;

function untouched(w: World) {
	assert.deepEqual(w.ownLeft().sort(), Object.values(w.paths).sort());
	assert.equal(existsSync(join(w.config, "profiles.json")), true);
	assert.deepEqual(w.calls, []);
}

/** The indented lines of one plan section, such as "Remove Gentle Shell data:". */
function section(out: string[], heading: string): string[] {
	const start = out.findIndex((line) => line.startsWith(heading));
	if (start < 0) return [];
	const end = out.findIndex((line, index) => index > start && !line.startsWith("  "));
	return out.slice(start + 1, end < 0 ? undefined : end);
}

/** A refusal: exit 1, a named reason, nothing removed and no path both removed and not touched. */
async function refused(w: World, env: Record<string, string>, reason: RegExp) {
	assert.equal(await w.uninstall(["--yes"], { env }), 1, JSON.stringify(env));
	assert.match(w.err.join("\n"), reason, JSON.stringify(env));
	assert.match(w.err.join("\n"), /Nothing was removed\./);
	assert.deepEqual(w.calls, []);
	assert.deepEqual(section(w.out, "Remove Gentle Shell data:"), ["  (refused, see below)"]);
}

test("unknown self-uninstall arguments are a usage error that removes nothing", async () => {
	for (const args of [["--force"], ["now"], ["--yes=1"]]) {
		const w = world();
		try {
			assert.equal(await w.uninstall(args), 2);
			assert.match(w.err.join("\n"), /usage: gentle-shell self-uninstall \[--dry-run\] \[--yes\] \[--include-shared\]/);
			untouched(w);
		} finally { w.cleanup(); }
	}
});

test("--dry-run prints the whole plan and removes nothing", async () => {
	const w = world();
	try {
		assert.equal(await w.uninstall(["--dry-run"]), 0);
		const plan = w.out.join("\n");
		for (const path of Object.values(w.paths)) assert.ok(plan.includes(path), path);
		assert.ok(plan.includes("pnpm remove -g gentle-pi"));
		assert.ok(plan.includes(join(w.config, "profiles.json")));
		assert.ok(plan.includes(w.piHome));
		assert.match(plan, /Dry run: nothing was removed\./);
		untouched(w);
		assert.deepEqual(w.questions, []);
	} finally { w.cleanup(); }
});

test("without a terminal and without --yes it prints the plan and exits 2", async () => {
	const w = world();
	try {
		assert.equal(await w.uninstall([]), 2);
		assert.ok(w.out.join("\n").includes(w.paths.isolated));
		assert.match(w.err.join("\n"), /--yes/);
		untouched(w);
	} finally { w.cleanup(); }
});

test("--yes removes Gentle Shell's own data, then the package, then the empty ~/.gentle-shell, keeping shared configuration", async () => {
	const w = world();
	try {
		assert.equal(await w.uninstall(["--yes"]), 0);
		assert.deepEqual(w.calls.map(({ command, argv }) => `${command} ${argv.join(" ")}`), ["/usr/bin/pnpm remove -g gentle-pi"]);
		assert.deepEqual(w.calls[0].ownDataLeft, [], "own data is removed before the package");
		assert.equal(w.calls[0].shellLeft, true, "~/.gentle-shell is removed only after the package");
		assert.equal(existsSync(w.shell), false);
		assert.deepEqual(w.ownLeft(), []);
		assert.equal(existsSync(join(w.config, "tools")), false);
		for (const name of ["profiles.json", "persona.json", "unknown.json"]) assert.equal(existsSync(join(w.config, name)), true, name);
		assert.equal(existsSync(join(w.piHome, "settings.json")), true);
		assert.deepEqual(w.questions, []);
		assert.match(w.out.join("\n"), /Gentle Shell was removed\./);
	} finally { w.cleanup(); }
});

test("an npm-owned installation is removed with npm uninstall -g", async () => {
	const w = world();
	try {
		assert.equal(await w.uninstall(["--yes"], { owner: { name: "npm", command: "/usr/bin/npm", prefix: [] } }), 0);
		assert.deepEqual(w.calls.map(({ command, argv }) => `${command} ${argv.join(" ")}`), ["/usr/bin/npm uninstall -g gentle-pi"]);
	} finally { w.cleanup(); }
});

test("Windows: the package is removed through the owner's verified invocation, never a .cmd", async () => {
	const node = "C:\\nodejs\\node.exe";
	for (const [owner, expected] of [
		[{ name: "pnpm", command: node, prefix: ["C:\\tools\\pnpm\\package\\bin\\pnpm.mjs"] }, ["C:\\tools\\pnpm\\package\\bin\\pnpm.mjs", "remove", "-g", "gentle-pi"]],
		[{ name: "npm", command: node, prefix: ["C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"] }, ["C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js", "uninstall", "-g", "gentle-pi"]],
	] as const) {
		const w = world();
		try {
			assert.equal(await w.uninstall(["--yes"], { owner: { ...owner, prefix: [...owner.prefix] }, platform: "win32" }), 0);
			assert.deepEqual(w.calls.map(({ command, argv }) => [command, argv]), [[node, expected]]);
			assert.ok(w.out.includes(`  ${owner.name} ${expected.slice(1).join(" ")}`), "the plan shows the command a person would type");
		} finally { w.cleanup(); }
	}
});

test("POSIX: the package manager runs as it was found, with no prefix", async () => {
	const w = world();
	try {
		assert.equal(await w.uninstall(["--yes"], { platform: "linux" }), 0);
		assert.deepEqual(w.calls.map(({ command, argv }) => [command, argv]), [["/usr/bin/pnpm", ["remove", "-g", "gentle-pi"]]]);
	} finally { w.cleanup(); }
});

test("inside a Gentle Shell session the isolated home in PI_CODING_AGENT_DIR is not the user's Pi home", async () => {
	const w = world();
	try {
		assert.equal(await w.uninstall(["--yes"], { env: { PI_CODING_AGENT_DIR: w.isolated, GENTLE_SHELL_USER_PI_HOME: w.piHome } }), 0, w.err.join("\n"));
		assert.equal(existsSync(w.isolated), false);
		assert.equal(existsSync(join(w.piHome, "settings.json")), true);
		assert.ok(section(w.out, "Not touched:").some((line) => line.includes(`${w.piHome}  (your Pi home)`)));
	} finally { w.cleanup(); }
});

test("inside a session the user's Pi home and any other PI_CODING_AGENT_DIR stay protected", async () => {
	const cases = (w: World) => [
		// GENTLE_SHELL_USER_PI_HOME pointing at the isolated home itself.
		{ PI_CODING_AGENT_DIR: w.isolated, GENTLE_SHELL_USER_PI_HOME: w.isolated },
		// A PI_CODING_AGENT_DIR other than the isolated home, inside it.
		{ PI_CODING_AGENT_DIR: join(w.isolated, "pi"), GENTLE_SHELL_USER_PI_HOME: w.piHome },
		// Without GENTLE_SHELL_USER_PI_HOME, PI_CODING_AGENT_DIR is the user's Pi home.
		{ PI_CODING_AGENT_DIR: w.isolated },
		// A GENTLE_SHELL_USER_PI_HOME that is not an existing directory proves no session.
		{ PI_CODING_AGENT_DIR: w.isolated, GENTLE_SHELL_USER_PI_HOME: join(w.root, "missing-pi-home") },
	];
	for (let index = 0; index < 4; index += 1) {
		const w = world();
		try {
			await refused(w, cases(w)[index], /your Pi home/);
			untouched(w);
		} finally { w.cleanup(); }
	}
});

test("--yes --include-shared also removes exactly the shared Gentle AI configuration files", async () => {
	const w = world();
	try {
		for (const name of SHARED_CONFIG_FILES) write(join(w.config, name));
		assert.equal(await w.uninstall(["--yes", "--include-shared"]), 0);
		for (const name of SHARED_CONFIG_FILES) assert.equal(existsSync(join(w.config, name)), false, name);
		assert.equal(w.calls[0].sharedLeft, false, "shared configuration is removed before the package");
		assert.equal(existsSync(join(w.config, "unknown.json")), true);
		assert.equal(existsSync(join(w.piHome, "settings.json")), true);
	} finally { w.cleanup(); }
});

test("the shared files are the Gentle AI configuration Gentle Shell writes", () => {
	assert.deepEqual([...SHARED_CONFIG_FILES].sort(), [
		"background-subagents.json", "banner.json", "builtin-codemode-optout.json", "double-esc-cancel.json",
		"persona.json", "profiles.export.json", "profiles.json", "runtime-guardrails.json",
	]);
});

test("a dev binary the user registered is kept", async () => {
	const w = world();
	try {
		write(w.paths.devBinary, JSON.stringify({ schema: "gentle-pi.dev-binary/v1", path: "/Users/me/src/gentle-ai/gentle-ai" }));
		assert.equal(await w.uninstall(["--yes"]), 0);
		assert.equal(existsSync(w.paths.devBinary), true);
		assert.match(w.out.join("\n"), /dev-binary\.json: points at a binary you registered yourself/);
	} finally { w.cleanup(); }
});

test("in a terminal the default answer cancels and removes nothing", async () => {
	for (const answer of ["", "n", "no", "maybe"]) {
		const w = world();
		try {
			assert.equal(await w.uninstall([], { interactive: true, answers: [answer] }), 1);
			assert.equal(w.questions.length, 1);
			assert.match(w.out.join("\n"), /Cancelled; nothing was removed\./);
			untouched(w);
		} finally { w.cleanup(); }
	}
});

test("in a terminal the shared configuration is asked about separately and kept by default", async () => {
	for (const [answer, removed] of [["", false], ["n", false], ["y", true], ["YES", true]] as const) {
		const w = world();
		try {
			assert.equal(await w.uninstall([], { interactive: true, answers: ["y", answer] }), 0);
			assert.equal(w.questions.length, 2);
			assert.match(w.questions[1], /shared Gentle AI configuration/);
			assert.match(w.questions[1], /\[y\/N\]/);
			assert.equal(existsSync(join(w.config, "profiles.json")), !removed, answer);
			assert.deepEqual(w.ownLeft(), []);
		} finally { w.cleanup(); }
	}
});

test("in a terminal --include-shared skips the separate question", async () => {
	const w = world();
	try {
		assert.equal(await w.uninstall(["--include-shared"], { interactive: true, answers: ["y"] }), 0);
		assert.equal(w.questions.length, 1);
		assert.equal(existsSync(join(w.config, "profiles.json")), false);
	} finally { w.cleanup(); }
});

test("an installation no package manager owns, such as npm link, is refused before anything is removed", async () => {
	const w = world();
	try {
		const owner = new Error("uninstall-owner-unknown: neither pnpm nor npm owns /src/gentle-pi");
		for (const args of [["--yes"], ["--dry-run"]]) {
			assert.equal(await w.uninstall(args, { owner }), 1);
			assert.match(w.err.join("\n"), /neither pnpm nor npm owns \/src\/gentle-pi/);
			untouched(w);
		}
	} finally { w.cleanup(); }
});

test("an isolated home that is or contains the user's Pi home, $HOME or the config home is refused", async () => {
	const cases = (w: World) => [
		{ GENTLE_SHELL_HOME: w.piHome },
		{ GENTLE_SHELL_HOME: join(w.home, ".pi") },
		{ GENTLE_SHELL_HOME: w.home },
		{ GENTLE_SHELL_HOME: w.root },
		{ GENTLE_SHELL_HOME: w.config },
		{ GENTLE_SHELL_HOME: join(w.root, "agent"), PI_CODING_AGENT_DIR: join(w.root, "agent", "pi") },
		{ GENTLE_SHELL_HOME: join(w.root, "agent"), GENTLE_SHELL_USER_PI_HOME: join(w.root, "agent") },
	];
	for (let index = 0; index < 7; index += 1) {
		const w = world();
		try {
			const env = cases(w)[index];
			writeFileSync(join(w.home, "keep.txt"), "x");
			assert.equal(await w.uninstall(["--yes"], { env }), 1, JSON.stringify(env));
			assert.match(w.err.join("\n"), /refusing to remove anything/);
			untouched(w);
			assert.equal(existsSync(join(w.home, "keep.txt")), true);
		} finally { w.cleanup(); }
	}
});

test("a relative GENTLE_SHELL_HOME or GENTLE_PI_CONFIG_HOME is refused", async () => {
	for (const env of [{ GENTLE_SHELL_HOME: "agent" }, { GENTLE_PI_CONFIG_HOME: "gentle-ai" }]) {
		const w = world();
		try {
			assert.equal(await w.uninstall(["--yes"], { env }), 1);
			assert.match(w.err.join("\n"), /is not an absolute path/);
			untouched(w);
		} finally { w.cleanup(); }
	}
});

test("GENTLE_SHELL_HOME and GENTLE_PI_CONFIG_HOME select what is removed", async () => {
	const w = world();
	try {
		const custom = join(w.root, "custom-agent");
		const config = join(w.root, "custom-config");
		write(join(custom, ".gentle-shell-home"));
		write(join(config, "channel.json"));
		write(join(config, "persona.json"));
		assert.equal(await w.uninstall(["--yes"], { env: { GENTLE_SHELL_HOME: custom, GENTLE_PI_CONFIG_HOME: config } }), 0);
		assert.equal(existsSync(custom), false);
		assert.equal(existsSync(join(config, "channel.json")), false);
		assert.equal(existsSync(join(config, "persona.json")), true);
		assert.equal(existsSync(w.isolated), true, "the default isolated home is not the selected one");
		assert.equal(existsSync(w.paths.channel), true, "the default config home is not the selected one");
	} finally { w.cleanup(); }
});

test("a GENTLE_SHELL_HOME without Gentle Shell's ownership evidence is kept", async () => {
	const w = world();
	try {
		const custom = join(w.root, "projects");
		write(join(custom, "notes.txt"), "mine");
		assert.equal(await w.uninstall(["--yes"], { env: { GENTLE_SHELL_HOME: custom } }), 0);
		assert.equal(readFileSync(join(custom, "notes.txt"), "utf8"), "mine");
		assert.match(w.out.join("\n"), /projects: not created by Gentle Shell/);
	} finally { w.cleanup(); }
});

test("a GENTLE_SHELL_HOME recorded as provisioned in ~/.gentle-shell/config.json is removed", async () => {
	const w = world();
	try {
		const custom = join(w.root, "provisioned-agent");
		write(join(custom, "settings.json"));
		write(w.paths.launcherConfig, JSON.stringify({ provisioned: { [custom]: { gentleAi: "4.0.0", gentlePi: "4.0.0", at: "now" } } }));
		assert.equal(await w.uninstall(["--yes"], { env: { GENTLE_SHELL_HOME: custom } }), 0);
		assert.equal(existsSync(custom), false);
	} finally { w.cleanup(); }
});

test("symbolic links are never followed or removed", posixOnly, async () => {
	const w = world();
	try {
		const target = join(w.root, "elsewhere");
		write(join(target, ".gentle-shell-home"));
		write(join(target, "keep.txt"));
		rmSync(w.paths.main, { recursive: true });
		symlinkSync(target, w.paths.main);
		const linkedHome = join(w.root, "linked-agent");
		symlinkSync(target, linkedHome);
		assert.equal(await w.uninstall(["--yes"], { env: { GENTLE_SHELL_HOME: linkedHome } }), 0);
		assert.equal(existsSync(join(target, "keep.txt")), true);
		assert.equal(existsSync(w.paths.main), true);
		assert.equal(existsSync(linkedHome), true);
		assert.match(w.out.join("\n"), /main: a symbolic link, not followed/);
	} finally { w.cleanup(); }
});

test("custom --home homes and the user's Pi home are listed as not touched", async () => {
	const w = world();
	try {
		const persisted = join(w.root, "persisted-home");
		const provisioned = join(w.root, "provisioned-home");
		for (const dir of [persisted, provisioned]) write(join(dir, "settings.json"));
		write(w.paths.launcherConfig, JSON.stringify({ home: persisted, provisioned: { [provisioned]: { gentleAi: "4.0.0", at: "now" } } }));
		assert.equal(await w.uninstall(["--yes"]), 0);
		const plan = w.out.join("\n");
		assert.match(plan, /Not touched:/);
		for (const dir of [persisted, provisioned, w.piHome]) {
			assert.ok(plan.includes(dir), dir);
			assert.equal(existsSync(join(dir, "settings.json")), true, dir);
		}
	} finally { w.cleanup(); }
});

test("tools the installer may have added are listed with how to remove them, never removed", async () => {
	for (const platform of ["darwin", "win32"]) {
		const w = world();
		try {
			assert.equal(await w.uninstall(["--dry-run"], { platform }), 0);
			const plan = w.out.join("\n");
			assert.match(plan, /remove -g @earendil-works\/pi-coding-agent/);
			assert.match(plan, /Engram/);
			assert.match(plan, /pnpm setup/);
			assert.equal(plan.includes("%USERPROFILE%\\.pnpm"), platform === "win32", platform);
		} finally { w.cleanup(); }
	}
});

test("a failed package removal exits 1 and prints the command to run", async () => {
	const w = world();
	try {
		assert.equal(await w.uninstall(["--yes"], { runCode: 1 }), 1);
		assert.match(w.err.join("\n"), /pnpm remove -g gentle-pi/);
		assert.deepEqual(w.ownLeft(), []);
	} finally { w.cleanup(); }
});

test("~/.gentle-shell is kept when it still holds other files", async () => {
	const w = world();
	try {
		write(join(w.shell, "notes.txt"), "mine");
		assert.equal(await w.uninstall(["--yes"]), 0);
		assert.equal(readFileSync(join(w.shell, "notes.txt"), "utf8"), "mine");
	} finally { w.cleanup(); }
});

test("a config home that is, contains or lies inside the user's Pi home is refused", async () => {
	const w = world();
	try {
		write(join(w.piHome, "main", "sessions.txt"), "mine");
		await refused(w, { GENTLE_PI_CONFIG_HOME: w.piHome }, /GENTLE_PI_CONFIG_HOME .*Pi's default home/);
		assert.equal(readFileSync(join(w.piHome, "main", "sessions.txt"), "utf8"), "mine");
		untouched(w);
	} finally { w.cleanup(); }
	const v = world();
	try {
		const piDir = join(v.root, "pi", "agent");
		write(join(piDir, "settings.json"));
		await refused(v, { PI_CODING_AGENT_DIR: piDir, GENTLE_PI_CONFIG_HOME: join(piDir, "cfg") }, /your Pi home/);
		await refused(v, { GENTLE_SHELL_USER_PI_HOME: piDir, GENTLE_PI_CONFIG_HOME: join(v.root, "pi") }, /your Pi home/);
		untouched(v);
	} finally { v.cleanup(); }
});

test("a config home that is $HOME never removes main/, tools/ or channel.json from it", async () => {
	const w = world();
	try {
		write(join(w.home, "main", "myproject", "src.txt"), "code");
		write(join(w.home, "tools", "go", "1.25.10", ".gentle-shell-go"), "x");
		write(join(w.home, "channel.json"), "{}");
		await refused(w, { GENTLE_PI_CONFIG_HOME: w.home }, /GENTLE_PI_CONFIG_HOME .*your home directory/);
		for (const path of [join("main", "myproject", "src.txt"), join("tools", "go"), "channel.json"]) assert.equal(existsSync(join(w.home, path)), true, path);
		untouched(w);
	} finally { w.cleanup(); }
});

test("a config home reached through a symbolic link is checked at its real path", posixOnly, async () => {
	const w = world();
	try {
		write(join(w.home, "main", "gentle-ai", SHA, "gentle-ai"), "binary");
		const link = join(w.home, "cfglink");
		symlinkSync(w.home, link);
		await refused(w, { GENTLE_PI_CONFIG_HOME: link }, /GENTLE_PI_CONFIG_HOME .*your home directory/);
		assert.equal(existsSync(join(w.home, "main", "gentle-ai", SHA, "gentle-ai")), true);
		untouched(w);
	} finally { w.cleanup(); }
});

test("a ~/.gentle-shell reached through a symbolic link to $HOME is refused", posixOnly, async () => {
	const w = world();
	try {
		rmSync(w.shell, { recursive: true });
		symlinkSync(w.home, w.shell);
		write(join(w.home, "agent", ".gentle-shell-home"));
		write(join(w.home, "config.json"), JSON.stringify({ home: "isolated" }));
		assert.equal(await w.uninstall(["--yes"]), 1);
		assert.match(w.err.join("\n"), /your home directory/);
		assert.deepEqual(w.calls, []);
		for (const path of ["agent", "config.json"]) assert.equal(existsSync(join(w.home, path)), true, path);
	} finally { w.cleanup(); }
});

test("Gentle AI's state and any .pi directory are protected for the isolated home and the config home", async () => {
	const cases = (w: World) => {
		const repo = join(w.root, "repo");
		return [
			[{ GENTLE_SHELL_HOME: join(w.home, ".gentle-ai") }, /Gentle AI's state/],
			[{ GENTLE_SHELL_HOME: join(w.home, ".gentle-ai", "agent") }, /Gentle AI's state/],
			[{ GENTLE_SHELL_HOME: join(repo, ".pi") }, /a \.pi directory/],
			[{ GENTLE_SHELL_HOME: join(repo, ".pi", "gentle-ai") }, /a \.pi directory/],
			[{ GENTLE_SHELL_HOME: repo }, /a \.pi directory/],
			[{ GENTLE_PI_CONFIG_HOME: join(w.home, ".gentle-ai") }, /Gentle AI's state/],
			[{ GENTLE_PI_CONFIG_HOME: join(repo, ".pi", "gentle-ai") }, /a \.pi directory/],
			[{ GENTLE_PI_CONFIG_HOME: join(repo, ".pi") }, /a \.pi directory/],
			[{ GENTLE_PI_CONFIG_HOME: repo }, /a \.pi directory/],
		] as const;
	};
	for (let index = 0; index < 9; index += 1) {
		const w = world();
		try {
			const repo = join(w.root, "repo");
			const state = join(w.home, ".gentle-ai", "state.json");
			write(state, "{}");
			write(join(w.home, ".gentle-ai", ".gentle-shell-home"));
			write(join(w.home, ".gentle-ai", "agent", ".gentle-shell-home"));
			for (const dir of [repo, join(repo, ".pi"), join(repo, ".pi", "gentle-ai")]) write(join(dir, ".gentle-shell-home"));
			write(join(repo, ".pi", "gentle-ai", "main", "gentle-ai", SHA, "gentle-ai"), "binary");
			const [env, reason] = cases(w)[index];
			await refused(w, env, reason);
			assert.equal(existsSync(state), true);
			assert.equal(existsSync(join(repo, ".pi", "gentle-ai", "main")), true);
			untouched(w);
		} finally { w.cleanup(); }
	}
});

test("a custom --home home that overlaps what would be removed is refused", async () => {
	const w = world();
	try {
		const custom = join(w.isolated, "work");
		write(join(custom, "settings.json"));
		write(w.paths.launcherConfig, JSON.stringify({ home: custom }));
		await refused(w, {}, /custom --home home/);
		assert.equal(existsSync(join(custom, "settings.json")), true);
	} finally { w.cleanup(); }
});

test("main/ outside Gentle Shell's known layout is listed as not touched", async () => {
	for (const extra of [join("myproject", "src.txt"), join("gentle-ai", "not-a-commit", "gentle-ai"), join("gentle-ai", SHA, "notes.txt"), join("packages", "notes.txt")]) {
		const w = world();
		try {
			write(join(w.paths.main, extra), "mine");
			assert.equal(await w.uninstall(["--yes"]), 0, extra);
			assert.equal(readFileSync(join(w.paths.main, extra), "utf8"), "mine", extra);
			assert.ok(section(w.out, "Kept:").some((line) => line.includes(`${w.paths.main}: not Gentle Shell's main-channel layout`)), extra);
			assert.equal(existsSync(w.paths.channel), false);
		} finally { w.cleanup(); }
	}
});

test("main/ in Gentle Shell's known layout is removed", async () => {
	const w = world();
	try {
		write(join(w.paths.main, "packages", "gentle-pi-4.1.0-main.1f9d5e6423e3.tgz"), "tgz");
		write(join(w.paths.main, ".build", "gocache", "x"), "x");
		write(join(w.paths.main, ".source", "src", "package.json"), "{}");
		assert.equal(await w.uninstall(["--yes"]), 0);
		assert.equal(existsSync(w.paths.main), false);
	} finally { w.cleanup(); }
});

test("tools/go with anything but marked pinned-Go version folders is listed as not touched", async () => {
	for (const extra of [join("1.24.0", "go", "bin", "go"), join(".stage-abc", "go"), "notes.txt"]) {
		const w = world();
		try {
			write(join(w.paths.go, extra), "mine");
			assert.equal(await w.uninstall(["--yes"]), 0, extra);
			assert.equal(existsSync(join(w.paths.go, extra)), true, extra);
			assert.equal(existsSync(join(w.paths.go, "1.25.10")), true, extra);
			assert.ok(section(w.out, "Kept:").some((line) => line.includes(`${w.paths.go}: not only the installer's pinned Go`)), extra);
		} finally { w.cleanup(); }
	}
});

test("end of input at a confirmation prompt cancels and removes nothing", async () => {
	for (const answers of [[], ["y"]]) {
		const w = world();
		try {
			const input = new PassThrough();
			const output = new PassThrough();
			output.resume();
			for (const answer of answers) input.write(`${answer}\n`);
			input.end();
			const ask = (question: string) => askLine(question, { input, output });
			const code = await w.uninstall([], { interactive: true, ask });
			if (answers.length === 0) {
				assert.equal(code, 1);
				assert.match(w.out.join("\n"), /Cancelled; nothing was removed\./);
				untouched(w);
			} else {
				// Confirmed, then end of input at the shared-configuration question keeps it.
				assert.equal(code, 0);
				assert.equal(existsSync(join(w.config, "profiles.json")), true);
			}
		} finally { w.cleanup(); }
	}
});

/** Answers each question in terminal mode by typing `keys` (one entry per question) once it is asked. */
function typing(keys: string[]) {
	const input = new PassThrough();
	const output = new PassThrough();
	output.resume();
	return (question: string) => {
		const answer = askLine(question, { input, output, terminal: true });
		input.write(keys.shift() ?? "");
		return answer;
	};
}

test("Ctrl-C at any confirmation prompt aborts the whole uninstall", async () => {
	for (const keys of [["\x03"], ["y\r", "\x03"]]) {
		const w = world();
		try {
			assert.equal(await w.uninstall([], { interactive: true, ask: typing([...keys]) }), 1, JSON.stringify(keys));
			assert.match(w.err.join("\n"), /Interrupted; nothing was removed\./);
			untouched(w);
		} finally { w.cleanup(); }
	}
});

test("in a terminal, Ctrl-D at the first prompt cancels and at the shared question keeps it", async () => {
	const first = world();
	try {
		assert.equal(await first.uninstall([], { interactive: true, ask: typing(["\x04"]) }), 1);
		assert.match(first.out.join("\n"), /Cancelled; nothing was removed\./);
		untouched(first);
	} finally { first.cleanup(); }
	const second = world();
	try {
		assert.equal(await second.uninstall([], { interactive: true, ask: typing(["y\r", "\x04"]) }), 0);
		assert.equal(existsSync(join(second.config, "profiles.json")), true);
		assert.deepEqual(second.ownLeft(), []);
	} finally { second.cleanup(); }
});

test("askLine returns the typed line", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	output.resume();
	input.write("yes\n");
	assert.equal(await askLine("Remove? ", { input, output }), "yes");
	input.end();
});

test("a failed removal stops before the package is removed", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
	const w = world();
	const locked = join(w.paths.main, "gentle-ai");
	try {
		chmodSync(locked, 0o500);
		assert.equal(await w.uninstall(["--yes"]), 1);
		assert.match(w.err.join("\n"), /could not remove/);
		assert.deepEqual(w.calls, []);
		assert.equal(existsSync(w.isolated), true, "nothing after the failure is removed");
	} finally {
		chmodSync(locked, 0o700);
		w.cleanup();
	}
});

// T6 (S6, S7): self-uninstall run from the bundled launcher removes the prefix's
// own folders and exactly the PATH entry its receipt records; the Gentle Shell
// home is shared data. POSIX fixtures use the real `current` symlink; the
// Windows ones simulate the platform with real temporary paths.
const BUNDLED_ID = "4.1.0-1.1.0";
type BundledOptions = {
	platform?: string;
	env?: Record<string, string>;
	interactive?: boolean;
	answers?: string[];
	ask?: (question: string) => Promise<string>;
	pathEntry?: "recorded" | "none" | "invalid" | "fails" | "edited";
	execPath?: string;
	root?: string;
};

function bundledWorld({ platform = "darwin" } = {}) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "bundled-uninstall-")));
	const home = join(base, "home");
	const windows = platform === "win32";
	const shellHome = join(home, ".gentle-shell");
	const prefix = windows ? join(home, "AppData", "Local", "gentle-shell") : shellHome;
	const node = windows ? join(prefix, "runtime", "node-24.21.0", "node.exe") : join(prefix, "runtime", "node-24.21.0", "bin", "node");
	const launcher = join(prefix, "bin", windows ? "gentle-shell.cmd" : "gentle-shell");
	const own = ["bin", "current", "versions", "versions.history", "runtime", "pnpm", "npm", "gentle-ai", "config", "tmp", "path-entry.json",
		...(windows ? [".gentle-shell-bundle"] : [])].map((name) => join(prefix, name));
	write(launcher, "launcher\n");
	write(join(prefix, "versions", BUNDLED_ID, ".gentle-shell-version"), `${BUNDLED_ID}\n`);
	write(join(prefix, "versions", BUNDLED_ID, "node_modules", "gentle-pi", "package.json"));
	write(join(prefix, "versions.history"), `${BUNDLED_ID}\n`);
	if (windows) write(join(prefix, "current"), `${BUNDLED_ID}\n`);
	else symlinkSync(`versions/${BUNDLED_ID}`, join(prefix, "current"));
	write(node, "node");
	write(join(prefix, "runtime", "pnpm-11.1.1", "package", "package.json"));
	write(join(prefix, "pnpm", "store", "v10", "index"));
	write(join(prefix, "npm", "cache", "index"));
	write(join(prefix, "gentle-ai", "state.json"));
	write(join(prefix, "config", "gentle-ai", "persona.json"));
	mkdirSync(join(prefix, "tmp"));
	write(join(prefix, "path-entry.json"));
	if (windows) write(join(prefix, ".gentle-shell-bundle"), "gentle-shell bundled install");
	const shared = { agent: join(shellHome, "agent"), config: join(shellHome, "config.json") };
	write(join(shared.agent, "auth.json"));
	write(shared.config, JSON.stringify({ home: "isolated" }));
	// The user's own data, never touched: Pi's home, Gentle AI's config and state, Engram's memory.
	const kept = [join(home, ".pi", "agent", "settings.json"), join(home, ".pi", "gentle-ai", "profiles.json"), join(home, ".gentle-ai", "state.json"),
		join(home, ".engram", "engram.db")];
	for (const path of kept) write(path);
	const out: string[] = [];
	const err: string[] = [];
	const questions: string[] = [];
	const pathCalls: { ownLeft: number }[] = [];
	const deferred: { pid: number; files: string[]; last?: string; directories: string[] }[] = [];
	const ownLeft = () => own.filter((path) => { try { lstatSync(path); return true; } catch { return false; } });
	const uninstall = (args: string[], options: BundledOptions = {}) => {
		const answers = [...(options.answers ?? [])];
		const state = options.pathEntry ?? "recorded";
		return runBundledSelfUninstall({
			args,
			env: options.env ?? {},
			homedir: home,
			platform,
			interactive: options.interactive ?? false,
			root: options.root ?? prefix,
			pathEntry: state === "none" ? { status: "none" }
				: state === "invalid" ? { status: "invalid", reason: `${join(prefix, "path-entry.json")} does not describe this install's PATH entry` }
				: {
					status: "recorded",
					description: `the line export PATH="${join(prefix, "bin")}:$PATH" # gentle-shell bundled install in ${join(home, ".zshrc")}`,
					remove: () => {
						pathCalls.push({ ownLeft: ownLeft().length });
						if (state === "fails") throw new Error("EACCES: permission denied");
						return state === "edited" ? { removed: false, note: `${join(home, ".zshrc")} still holds export PATH="$PATH:${join(prefix, "bin")}" # gentle-shell bundled install (edited, so it was kept)` }
							: { removed: true };
					},
				},
			process: { pid: 4242, execPath: options.execPath ?? node },
			deferRemoval: (request: { pid: number; files: string[]; last?: string; directories: string[] }) => { deferred.push(request); },
			ask: options.ask ?? (async (question: string) => {
				questions.push(question);
				return answers.shift() ?? "";
			}),
			out: (line: string) => out.push(line),
			err: (line: string) => err.push(line),
		});
	};
	return { base, home, prefix, shellHome, node, launcher, own, shared, kept, out, err, questions, pathCalls, deferred, ownLeft, uninstall,
		cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

type BundledWorld = ReturnType<typeof bundledWorld>;

function bundledUntouched(w: BundledWorld) {
	assert.deepEqual(w.ownLeft(), w.own);
	for (const path of [...w.kept, w.shared.config, join(w.shared.agent, "auth.json")]) assert.equal(existsSync(path), true, path);
	assert.deepEqual(w.pathCalls, []);
	assert.deepEqual(w.deferred, []);
}

test("bundled: --dry-run lists the PATH entry, the prefix's own folders, the shared home and what is never touched, and removes nothing", posixOnly, async () => {
	const w = bundledWorld();
	try {
		assert.equal(await w.uninstall(["--dry-run"]), 0);
		const plan = w.out.join("\n");
		assert.match(plan, /bundled install/);
		assert.ok(section(w.out, "Remove the PATH entry:")[0]?.includes(join(w.home, ".zshrc")));
		const removed = section(w.out, "Remove the bundled install:").join("\n");
		for (const path of w.own) assert.ok(removed.includes(path), path);
		assert.ok(removed.includes(`${w.prefix} itself`));
		const shared = section(w.out, "Your Gentle Shell home").join("\n");
		for (const path of Object.values(w.shared)) assert.ok(shared.includes(path), path);
		const never = section(w.out, "Not touched:").join("\n");
		for (const name of [join(".pi", "agent"), ".gentle-ai", ".engram"]) assert.ok(never.includes(join(w.home, name)), name);
		assert.match(plan, /Dry run: nothing was removed\./);
		bundledUntouched(w);
	} finally { w.cleanup(); }
});

test("bundled: --yes removes the PATH entry first, then the prefix's own folders, and keeps the shared home and so the prefix", posixOnly, async () => {
	const w = bundledWorld();
	try {
		assert.equal(await w.uninstall(["--yes"]), 0, w.err.join("\n"));
		assert.deepEqual(w.pathCalls, [{ ownLeft: w.own.length }]);
		assert.deepEqual(w.ownLeft(), []);
		for (const path of [...w.kept, w.shared.config, join(w.shared.agent, "auth.json")]) assert.equal(existsSync(path), true, path);
		assert.deepEqual(readdirSync(w.prefix).sort(), ["agent", "config.json"]);
		assert.deepEqual(w.deferred, []);
		assert.match(w.out.join("\n"), /Gentle Shell was removed\./);
	} finally { w.cleanup(); }
});

test("bundled: --yes --include-shared also removes the Gentle Shell home, then the empty prefix, and nothing of the user's", posixOnly, async () => {
	const w = bundledWorld();
	try {
		assert.equal(await w.uninstall(["--yes", "--include-shared"]), 0, w.err.join("\n"));
		assert.equal(existsSync(w.prefix), false);
		for (const path of w.kept) assert.equal(existsSync(path), true, path);
	} finally { w.cleanup(); }
});

test("bundled: anything the install did not write keeps the prefix, and links inside it are never followed", posixOnly, async () => {
	const w = bundledWorld();
	try {
		write(join(w.prefix, "notes.txt"), "mine");
		const outside = join(w.base, "outside");
		write(join(outside, "keep.txt"), "mine");
		rmSync(join(w.prefix, "pnpm"), { recursive: true });
		symlinkSync(outside, join(w.prefix, "pnpm"));
		// A link inside a removed folder (pnpm's node_modules) goes, its target stays.
		symlinkSync(outside, join(w.prefix, "versions", BUNDLED_ID, "node_modules", "linked"));
		assert.equal(await w.uninstall(["--yes", "--include-shared"]), 0, w.err.join("\n"));
		assert.equal(existsSync(join(w.prefix, "versions")), false);
		assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "mine");
		assert.deepEqual(readdirSync(w.prefix).sort(), ["notes.txt", "pnpm"]);
		const kept = section(w.out, "Kept:").join("\n");
		assert.ok(kept.includes(`${join(w.prefix, "pnpm")}: a symbolic link, not followed`));
		assert.ok(kept.includes(`${join(w.prefix, "notes.txt")}: not written by the bundled install`));
	} finally { w.cleanup(); }
});

test("bundled: without a valid receipt the PATH entry is named for the user to remove, never guessed", posixOnly, async () => {
	for (const pathEntry of ["none", "invalid"] as const) {
		const w = bundledWorld();
		try {
			assert.equal(await w.uninstall(["--yes"], { pathEntry }), 0, w.err.join("\n"));
			assert.deepEqual(w.pathCalls, []);
			const plan = w.out.join("\n");
			assert.ok(section(w.out, "Remove the PATH entry:").join("\n").includes("(none recorded"), pathEntry);
			assert.match(plan, /# gentle-shell bundled install/);
			assert.ok(plan.includes(join(w.prefix, "bin")), pathEntry);
			if (pathEntry === "invalid") assert.match(plan, /does not describe this install's PATH entry/);
			// A5: said once, in the plan.
			assert.equal(w.out.filter((line) => line.includes("If a new terminal still finds gentle-shell")).length, 1, pathEntry);
			assert.deepEqual(w.ownLeft(), []);
		} finally { w.cleanup(); }
	}
});

// A2: a PATH line the user edited is kept and named, not silently reported as removed.
test("bundled: a PATH entry the user changed is kept, and the final message names the file and the line it still holds", posixOnly, async () => {
	const w = bundledWorld();
	try {
		assert.equal(await w.uninstall(["--yes"], { pathEntry: "edited" }), 0, w.err.join("\n"));
		const tail = w.out.slice(-2);
		assert.match(tail[0], /The PATH entry was kept: .*\.zshrc still holds export PATH="\$PATH:.*# gentle-shell bundled install/);
		assert.match(tail[1], /Gentle Shell was removed\./);
		assert.deepEqual(w.ownLeft(), []);
	} finally { w.cleanup(); }
});

test("bundled: a prefix that is not the real ~/.gentle-shell, or a Windows prefix without its marker, is refused before anything is removed", async () => {
	if (process.platform !== "win32") {
		const posix = bundledWorld();
		try {
			const elsewhere = join(posix.base, "elsewhere");
			mkdirSync(elsewhere);
			for (const root of [elsewhere, posix.home]) {
				posix.out.length = 0;
				posix.err.length = 0;
				assert.equal(await posix.uninstall(["--yes"], { root }), 1, root);
				assert.match(posix.err.join("\n"), /refusing to remove anything/);
				assert.match(posix.err.join("\n"), /Nothing was removed\./);
			}
			bundledUntouched(posix);
		} finally { posix.cleanup(); }
		const linked = bundledWorld();
		try {
			const moved = join(linked.base, "moved");
			const { renameSync } = await import("node:fs");
			renameSync(linked.prefix, moved);
			symlinkSync(moved, linked.prefix);
			assert.equal(await linked.uninstall(["--yes"], { root: moved }), 1);
			assert.match(linked.err.join("\n"), /refusing to remove anything/);
			assert.equal(readdirSync(moved).includes("runtime"), true);
		} finally { linked.cleanup(); }
	}
	// The Windows prefix is the user's home itself: refused even with the marker.
	const homeRoot = bundledWorld({ platform: "win32" });
	try {
		write(join(homeRoot.home, ".gentle-shell-bundle"), "gentle-shell bundled install");
		assert.equal(await homeRoot.uninstall(["--yes"], { root: homeRoot.home }), 1);
		assert.match(homeRoot.err.join("\n"), /your home directory/);
		bundledUntouched(homeRoot);
	} finally { homeRoot.cleanup(); }
	for (const marker of [undefined, "someone else's folder"]) {
		const w = bundledWorld({ platform: "win32" });
		try {
			const path = join(w.prefix, ".gentle-shell-bundle");
			if (marker === undefined) rmSync(path);
			else writeFileSync(path, marker);
			assert.equal(await w.uninstall(["--yes"]), 1, String(marker));
			assert.match(w.err.join("\n"), /\.gentle-shell-bundle/);
			assert.equal(existsSync(join(w.prefix, "runtime")), true);
			assert.deepEqual([w.pathCalls, w.deferred], [[], []]);
		} finally { w.cleanup(); }
	}
});

test("bundled: a Pi home inside the prefix is protected, except the session's own Gentle Shell home", posixOnly, async () => {
	const w = bundledWorld();
	try {
		assert.equal(await w.uninstall(["--yes", "--include-shared"], { env: { PI_CODING_AGENT_DIR: w.shared.agent } }), 1);
		assert.match(w.err.join("\n"), /your Pi home/);
		bundledUntouched(w);
		const session = { PI_CODING_AGENT_DIR: w.shared.agent, GENTLE_SHELL_USER_PI_HOME: join(w.home, ".pi", "agent") };
		assert.equal(await w.uninstall(["--yes", "--include-shared"], { env: session }), 0, w.err.join("\n"));
		assert.equal(existsSync(w.prefix), false);
		for (const path of w.kept) assert.equal(existsSync(path), true, path);
	} finally { w.cleanup(); }
});

test("bundled: in a terminal one question confirms, the shared home is asked separately and kept by default; EOF cancels and Ctrl-C aborts", posixOnly, async () => {
	const cancelled = bundledWorld();
	try {
		assert.equal(await cancelled.uninstall([], { interactive: true, answers: [""] }), 1);
		assert.match(cancelled.out.join("\n"), /Cancelled; nothing was removed\./);
		bundledUntouched(cancelled);
	} finally { cancelled.cleanup(); }
	const confirmed = bundledWorld();
	try {
		assert.equal(await confirmed.uninstall([], { interactive: true, answers: ["y", ""] }), 0, confirmed.err.join("\n"));
		assert.equal(confirmed.questions.length, 2);
		assert.match(confirmed.questions[1], /\[y\/N\]/);
		assert.deepEqual(confirmed.ownLeft(), []);
		assert.equal(existsSync(join(confirmed.shared.agent, "auth.json")), true);
	} finally { confirmed.cleanup(); }
	for (const keys of [["\x04"], ["\x03"], ["y\r", "\x03"]]) {
		const w = bundledWorld();
		try {
			assert.equal(await w.uninstall([], { interactive: true, ask: typing([...keys]) }), 1, JSON.stringify(keys));
			assert.match([...w.out, ...w.err].join("\n"), keys.includes("\x03") ? /Interrupted; nothing was removed\./ : /Cancelled; nothing was removed\./);
			bundledUntouched(w);
		} finally { w.cleanup(); }
	}
	const script = bundledWorld();
	try {
		assert.equal(await script.uninstall([]), 2);
		assert.match(script.err.join("\n"), /pass --yes/);
		assert.equal(await script.uninstall(["--nope"]), 2);
		bundledUntouched(script);
	} finally { script.cleanup(); }
});

test("bundled: a PATH entry that cannot be removed stops before anything else is removed", posixOnly, async () => {
	const w = bundledWorld();
	try {
		assert.equal(await w.uninstall(["--yes"], { pathEntry: "fails" }), 1);
		assert.match(w.err.join("\n"), /EACCES/);
		assert.deepEqual(w.ownLeft(), w.own);
	} finally { w.cleanup(); }
});

test("bundled on Windows: the user Path entry goes first, the running node.exe, the launcher and the marker after this process exits", async () => {
	const w = bundledWorld({ platform: "win32" });
	try {
		assert.equal(await w.uninstall(["--yes"]), 0, w.err.join("\n"));
		assert.equal(w.pathCalls.length, 1);
		const marker = join(w.prefix, ".gentle-shell-bundle");
		const nodeDir = dirname(w.node);
		// A4: the marker goes last, only once the others are gone, so a failed removal can be retried.
		assert.deepEqual(w.deferred, [{ pid: 4242, files: [w.node, w.launcher], last: marker,
			directories: [nodeDir, join(w.prefix, "runtime"), join(w.prefix, "bin"), w.prefix] }]);
		// Everything else is already gone; those three wait for the detached removal.
		assert.deepEqual(readdirSync(w.prefix).sort(), [".gentle-shell-bundle", "bin", "runtime"]);
		assert.deepEqual(readdirSync(join(w.prefix, "runtime")), ["node-24.21.0"]);
		assert.deepEqual(readdirSync(nodeDir), ["node.exe"]);
		assert.deepEqual(readdirSync(join(w.prefix, "bin")), ["gentle-shell.cmd"]);
		assert.match(w.out.join("\n"), /after this command exits/);
		// The Gentle Shell home lives outside the prefix on Windows and stays.
		assert.equal(existsSync(join(w.shared.agent, "auth.json")), true);
	} finally { w.cleanup(); }
});
