import assert from "node:assert/strict";
import test from "node:test";
import { FLEET_ROLE_ENV, fleetRole } from "../lib/fleet-role.ts";
import { buildPiInvocation, helpText, parseLauncherArgs, type ResolvedHome } from "../lib/gentle-shell-launcher.ts";

// Spec: odd/tasks/fleet-orchestrator.md, T1, S1.

test("orchestrator as argv[0] opens the fleet controller with no launcher command", () => {
	const parsed = parseLauncherArgs(["orchestrator"]);
	assert.equal(parsed.fleet, true);
	assert.equal(parsed.command, undefined);
	assert.equal(parsed.piSubcommand, undefined);
	assert.deepEqual(parsed.passthrough, []);
	assert.equal(parsed.error, undefined);
});

test("orchestrator accepts home selectors before it and forwards later pi flags", () => {
	const parsed = parseLauncherArgs(["--isolated", "orchestrator", "--model", "anthropic/x"]);
	assert.equal(parsed.fleet, true);
	assert.equal(parsed.isolated, true);
	assert.deepEqual(parsed.passthrough, ["--model", "anthropic/x"]);
});

test("orchestrator refuses a pi package subcommand after it", () => {
	const parsed = parseLauncherArgs(["orchestrator", "install", "npm:x"]);
	assert.equal(parsed.error, "orchestrator cannot be combined with the pi subcommand 'install'");
});

test("orchestrator keeps its previous meaning as a prompt word when escaped or not first", () => {
	assert.equal(parseLauncherArgs(["--", "orchestrator"]).fleet, undefined);
	assert.deepEqual(parseLauncherArgs(["--", "orchestrator"]).passthrough, ["orchestrator"]);
	assert.equal(parseLauncherArgs(["hello", "orchestrator"]).fleet, undefined);
	assert.deepEqual(parseLauncherArgs(["hello", "orchestrator"]).passthrough, ["hello", "orchestrator"]);
});

test("a plain launch keeps its previous parse shape", () => {
	assert.equal("fleet" in parseLauncherArgs([]), false);
	assert.equal("fleet" in parseLauncherArgs(["--isolated", "fix the bug"]), false);
});

test("help documents the orchestrator command", () => {
	assert.match(helpText(), /gentle-shell \[home selectors\] orchestrator \[pi-args\.\.\.\]/);
	assert.match(helpText(), /\n {2}orchestrator {5}/);
});

const home: ResolvedHome = { mode: "isolated", dir: "/gentle-shell/agent", source: "default" };
function invocation(fleet: boolean | undefined, baseEnv: Record<string, string | undefined>) {
	return buildPiInvocation({
		runtime: { kind: "path", command: "/usr/bin/pi", args: [] }, home,
		packageRoot: "/pkg", declaration: undefined, takeOver: false,
		otherPackagePaths: [], passthrough: [], baseEnv, homedir: "/home/u", cwd: "/work", fleet,
	});
}

test("the fleet launch marks only its own Pi as the controller", () => {
	const built = invocation(true, { PATH: "/usr/bin" });
	assert.equal(built.env[FLEET_ROLE_ENV], "controller");
	// S3: the controller never codes, so it skips the coding context files.
	assert.deepEqual(built.args, ["-e", "/pkg", "--no-context-files"]);
});

test("a normal launch keeps loading context files", () => {
	assert.deepEqual(invocation(undefined, {}).args, ["-e", "/pkg"]);
});

test("a normal launch never inherits a fleet role from a member's shell", () => {
	for (const inherited of ["controller", "member"]) {
		const built = invocation(undefined, { PATH: "/usr/bin", [FLEET_ROLE_ENV]: inherited });
		assert.equal(FLEET_ROLE_ENV in built.env, false);
	}
});

test("fleetRole reads only the two known roles", () => {
	assert.equal(fleetRole({ [FLEET_ROLE_ENV]: "controller" }), "controller");
	assert.equal(fleetRole({ [FLEET_ROLE_ENV]: "member" }), "member");
	assert.equal(fleetRole({ [FLEET_ROLE_ENV]: "boss" }), undefined);
	assert.equal(fleetRole({}), undefined);
});

test("orchestrator refuses a launcher command after it", () => {
	assert.equal(parseLauncherArgs(["orchestrator", "setup"]).error, "orchestrator cannot be combined with the 'setup' command");
	assert.equal(parseLauncherArgs(["orchestrator", "home", "import-pi"]).error, "orchestrator cannot be combined with the 'home' command");
});

test("a subagent child of the controller never holds a fleet role", () => {
	assert.equal(fleetRole({ [FLEET_ROLE_ENV]: "controller", GENTLE_PI_AGENTS_CHILD: "1" }), undefined);
	assert.equal(fleetRole({ [FLEET_ROLE_ENV]: "member", GENTLE_PI_AGENTS_CHILD: "1" }), undefined);
});
