import assert from "node:assert/strict";
import test from "node:test";
import { FLEET_ROLE_ENV, fleetRole } from "../lib/fleet-role.ts";
import { buildPiInvocation, helpText, parseLauncherArgs, type ResolvedHome } from "../lib/gentle-shell-launcher.ts";

// Spec: odd/tasks/fleet-orchestrator.md, T1, S1.

test("fleet as argv[0] opens the fleet controller with no launcher command", () => {
	const parsed = parseLauncherArgs(["fleet"]);
	assert.equal(parsed.fleet, true);
	assert.equal(parsed.command, undefined);
	assert.equal(parsed.piSubcommand, undefined);
	assert.deepEqual(parsed.passthrough, []);
	assert.equal(parsed.error, undefined);
});

test("fleet accepts home selectors before it and forwards later pi flags", () => {
	const parsed = parseLauncherArgs(["--isolated", "fleet", "--model", "anthropic/x"]);
	assert.equal(parsed.fleet, true);
	assert.equal(parsed.isolated, true);
	assert.deepEqual(parsed.passthrough, ["--model", "anthropic/x"]);
});

test("fleet refuses a pi package subcommand after it", () => {
	const parsed = parseLauncherArgs(["fleet", "install", "npm:x"]);
	assert.equal(parsed.error, "fleet cannot be combined with the pi subcommand 'install'");
});

test("fleet keeps its previous meaning as a prompt word when escaped or not first", () => {
	assert.equal(parseLauncherArgs(["--", "fleet"]).fleet, undefined);
	assert.deepEqual(parseLauncherArgs(["--", "fleet"]).passthrough, ["fleet"]);
	assert.equal(parseLauncherArgs(["hello", "fleet"]).fleet, undefined);
	assert.deepEqual(parseLauncherArgs(["hello", "fleet"]).passthrough, ["hello", "fleet"]);
});

test("a plain launch keeps its previous parse shape", () => {
	assert.equal("fleet" in parseLauncherArgs([]), false);
	assert.equal("fleet" in parseLauncherArgs(["--isolated", "fix the bug"]), false);
});

test("help documents the fleet command", () => {
	assert.match(helpText(), /gentle-shell \[home selectors\] fleet \[pi-args\.\.\.\]/);
	assert.match(helpText(), /\n {2}fleet {12}/);
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
	// The skills catalog was ~56% of the controller's instructions (L27).
	assert.deepEqual(built.args, ["-e", "/pkg", "--no-context-files", "--no-skills"]);
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

test("fleet refuses a launcher command after it", () => {
	assert.equal(parseLauncherArgs(["fleet", "setup"]).error, "fleet cannot be combined with the 'setup' command");
	assert.equal(parseLauncherArgs(["fleet", "home", "import-pi"]).error, "fleet cannot be combined with the 'home' command");
});

test("a subagent child of the controller never holds a fleet role", () => {
	assert.equal(fleetRole({ [FLEET_ROLE_ENV]: "controller", GENTLE_PI_AGENTS_CHILD: "1" }), undefined);
	assert.equal(fleetRole({ [FLEET_ROLE_ENV]: "member", GENTLE_PI_AGENTS_CHILD: "1" }), undefined);
});
