import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exitCodeFor, openBrowser, openerFor, redirectPage, runnerEnvironment, upgradeEnvironment, wizardHandlers, writeRedirect } from "../bin/gentle-shell-install.mjs";
import { planPreflight, requirements } from "../scripts/installer-preflight.mjs";
import { PI_INSTALL_VERSION, blockedReasons, failedSteps } from "../scripts/installer-runner.mjs";
import { createInstallerServer, guidance } from "../scripts/installer-server.mjs";
import { distributionAsset, prefixLayout } from "../scripts/bundled-install.mjs";
import { bundledBlockedReasons, bundledFailedSteps, bundledPlan } from "../scripts/bundled-wizard.mjs";

type Response = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
type Plan = ReturnType<typeof planPreflight>;
type Collected = { inventory: Record<string, unknown>; plan: Plan };
type Log = (entry: Record<string, unknown>) => void;
type RunInstall = (request: { plan: Plan; consent: boolean }, log: Log) => Promise<Record<string, unknown>>;

const BIN = "/home/u/.local/share/pnpm/bin";
// Every /api/* request carries the custom header, so cross-origin fetches need a preflight.
const API = { "x-gentle-install": "1" };
const cleanInventory = {
	platform: "linux",
	arch: "x64",
	node: { available: true, version: "24.18.0", usable: true, persistent: false, npm: false },
	pnpm: { available: true, version: "11.1.1", usable: true, compatible: true, persistent: false },
	pi: { available: false },
	shell: { available: false },
	gentleAi: { available: false },
	go: { available: false },
	globalBin: { available: true, path: BIN, writable: true, onPath: false },
	setup: false,
};
function collected(changes: Record<string, unknown> = {}): Collected {
	const inventory = { ...cleanInventory, ...changes };
	return { inventory, plan: planPreflight(inventory) };
}

const assetsDir = mkdtempSync(join(tmpdir(), "gentle-install-server-"));
writeFileSync(join(assetsDir, "index.html"), "<!doctype html><title>fixture</title>\n");
writeFileSync(join(assetsDir, "wizard.js"), "// fixture\n");
test.after(() => rmSync(assetsDir, { recursive: true, force: true }));

function send(port: number, { method = "GET", path = "/", headers = {} as Record<string, string>, body = undefined as string | undefined,
	host = `127.0.0.1:${port}` as string | null } = {}): Promise<Response> {
	return new Promise((resolve, reject) => {
		const all: Record<string, string | number> = { ...headers };
		if (host !== null) all.host = host;
		if (body !== undefined) all["content-length"] = Buffer.byteLength(body);
		const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: all, setHost: false, agent: false }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
		});
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

async function start({ collect = (async () => collected()) as (channel: string) => Promise<Collected>, runInstall = (async () => ({ outcome: "ready", completed: [] })) as RunInstall,
	limits = {}, clock = { value: 1_000_000 } } = {}) {
	let collects = 0;
	const channels: string[] = [];
	const runs: Array<{ request: { plan: Plan; consent: boolean } }> = [];
	const host = createInstallerServer({
		assetsDir,
		collectPlan: async (channel: string) => {
			collects += 1;
			channels.push(channel);
			return collect(channel);
		},
		runInstall: async (request: { plan: Plan; consent: boolean }, log: Log) => {
			runs.push({ request });
			return runInstall(request, log);
		},
		now: () => clock.value,
		limits,
	});
	const { port, url, address } = await host.listen();
	const origin = `http://127.0.0.1:${port}`;
	const code = new URL(url).searchParams.get("code") ?? "";
	const login = async () => {
		const response = await send(port, { path: `/session?code=${code}` });
		assert.equal(response.status, 200);
		const cookie = String(response.headers["set-cookie"]).split(";")[0];
		return cookie;
	};
	return { host, port, url, address, origin, code, login, runs, clock, collects: () => collects, channels };
}

function post(port: number, path: string, cookie: string, body: unknown, headers: Record<string, string> = {}) {
	return send(port, {
		method: "POST",
		path,
		body: typeof body === "string" ? body : JSON.stringify(body),
		headers: { cookie, origin: `http://127.0.0.1:${port}`, "x-gentle-install": "1", "content-type": "application/json", ...headers },
	});
}
async function plan(port: number, cookie: string) {
	const response = await send(port, { path: "/api/plan", headers: { cookie, ...API } });
	assert.equal(response.status, 200);
	return JSON.parse(response.body);
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
async function waitFor(check: () => Promise<boolean> | boolean) {
	for (let i = 0; i < 200; i += 1) {
		if (await check()) return;
		await new Promise((done) => setTimeout(done, 5));
	}
	throw new Error("condition not reached");
}

test("binds only 127.0.0.1 on an ephemeral port and prints a one-time session URL", async () => {
	const { host, port, url, address } = await start();
	try {
		assert.equal(address, "127.0.0.1");
		assert.ok(port > 0);
		assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/session\\?code=[A-Za-z0-9_-]{43}$`));
		const ipv6 = await new Promise((resolve) => {
			const socket = connect({ host: "::1", port });
			socket.once("connect", () => { socket.destroy(); resolve("connected"); });
			socket.once("error", () => resolve("refused"));
		});
		assert.equal(ipv6, "refused");
	} finally {
		await host.close("test");
	}
});

test("Host must be exactly 127.0.0.1:<port> before any authorization", async () => {
	const { host, port, login } = await start();
	try {
		const cookie = await login();
		for (const value of [`localhost:${port}`, `evil:${port}`, "127.0.0.1", `127.0.0.1:${port + 1}`, `[::1]:${port}`, null]) {
			const response = await send(port, { path: "/api/plan", headers: { cookie, ...API }, host: value });
			assert.equal(response.status, 421, String(value));
			assert.doesNotMatch(response.body, /actions|planId/);
		}
	} finally {
		await host.close("test");
	}
});

test("session code is single-use, expires, and sets a strict HttpOnly cookie", async () => {
	const fresh = await start();
	try {
		const response = await send(fresh.port, { path: `/session?code=${fresh.code}` });
		// 200 with a same-origin refresh, not a 303: a redirect chain started from the
		// file: redirect page is cross-site, so the Strict cookie could be withheld on `/`.
		assert.equal(response.status, 200);
		assert.equal(response.headers.location, undefined);
		assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
		assert.equal(response.headers["content-security-policy"],
			"default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
		assert.ok(response.body.includes('<meta http-equiv="refresh" content="0; url=/">'));
		assert.ok(!/<script|<style|\sstyle=/i.test(response.body));
		const cookie = String(response.headers["set-cookie"]);
		assert.match(cookie, /^gentle_install_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/);
		assert.doesNotMatch(cookie, /Domain=/i);
		const reused = await send(fresh.port, { path: `/session?code=${fresh.code}` });
		assert.equal(reused.status, 401);
		assert.equal(reused.headers["set-cookie"], undefined);
		const wrong = await send(fresh.port, { path: "/session?code=nope" });
		assert.equal(wrong.status, 401);
	} finally {
		await fresh.host.close("test");
	}
	const late = await start({ limits: { codeTtlMs: 120_000 } });
	try {
		late.clock.value += 120_001;
		const expired = await send(late.port, { path: `/session?code=${late.code}` });
		assert.equal(expired.status, 401);
		assert.equal(expired.headers["set-cookie"], undefined);
	} finally {
		await late.host.close("test");
	}
});

test("API and asset requests need the session cookie", async () => {
	const { host, port, login } = await start();
	try {
		for (const path of ["/", "/wizard.js", "/api/plan", "/api/progress"]) {
			assert.equal((await send(port, { path })).status, 401, path);
			assert.equal((await send(port, { path, headers: { cookie: "gentle_install_session=forged" } })).status, 401, path);
		}
		const cookie = await login();
		const page = await send(port, { path: "/", headers: { cookie } });
		assert.equal(page.status, 200);
		assert.match(String(page.headers["content-type"]), /^text\/html/);
		assert.equal(page.body, readFileSync(join(assetsDir, "index.html"), "utf8"));
		const script = await send(port, { path: "/wizard.js", headers: { cookie } });
		assert.equal(script.status, 200);
		assert.match(String(script.headers["content-type"]), /^text\/javascript/);
		assert.equal((await send(port, { path: "/wizard.css", headers: { cookie } })).status, 404);
	} finally {
		await host.close("test");
	}
});

test("POST needs the exact Origin and custom header; GET rejects a foreign Origin", async () => {
	const { host, port, login, runs } = await start();
	try {
		const cookie = await login();
		const { planId } = await plan(port, cookie);
		const body = { planId, consent: true };
		assert.equal((await post(port, "/api/install", cookie, body, { origin: "http://evil.test" })).status, 403);
		assert.equal((await post(port, "/api/install", cookie, body, { origin: `http://localhost:${port}` })).status, 403);
		assert.equal((await post(port, "/api/install", cookie, body, { origin: "null" })).status, 403);
		const noOrigin = await send(port, { method: "POST", path: "/api/install", body: JSON.stringify(body),
			headers: { cookie, "x-gentle-install": "1", "content-type": "application/json" } });
		assert.equal(noOrigin.status, 403);
		const noHeader = await send(port, { method: "POST", path: "/api/install", body: JSON.stringify(body),
			headers: { cookie, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" } });
		assert.equal(noHeader.status, 403);
		assert.equal((await post(port, "/api/install", cookie, body, { "x-gentle-install": "true" })).status, 403);
		assert.equal((await post(port, "/api/install", cookie, body, { "content-type": "text/plain" })).status, 415);
		assert.equal((await send(port, { path: "/api/plan", headers: { cookie, ...API, origin: "http://evil.test" } })).status, 403);
		assert.equal(runs.length, 0);
	} finally {
		await host.close("test");
	}
});

test("/api/plan is built server-side and explains profile and runtime persistence", async () => {
	const { host, port, login, collects } = await start();
	try {
		const cookie = await login();
		const view = await plan(port, cookie);
		assert.equal(collects(), 1);
		assert.match(view.planId, /^[A-Za-z0-9_-]{16,}$/);
		assert.deepEqual(view.actions.map((action: { id: string }) => action.id), collected().plan.actions.map((action) => action.id));
		for (const action of view.actions) {
			assert.deepEqual(Object.keys(action).sort(), ["description", "id"]);
			assert.ok(action.description.length > 10);
		}
		assert.equal(view.profileChange.changesProfile, true);
		assert.equal(view.profileChange.binDir, BIN);
		assert.equal(view.profileChange.command, "pnpm setup");
		assert.match(view.profileChange.description, /pnpm setup/);
		assert.deepEqual(view.persistence.tools, ["node", "npm", "pnpm"]);
		assert.equal(view.persistence.pnpmHome, "/home/u/.local/share/pnpm");
		assert.match(view.persistence.description, /PNPM_HOME/);
		assert.deepEqual(view.blockers, []);
		// The plan endpoint accepts no client input.
		assert.equal((await post(port, "/api/plan", cookie, { plan: collected().plan })).status, 405);
		assert.equal((await send(port, { path: "/api/plan?plan=x", headers: { cookie, ...API } })).status, 400);
	} finally {
		await host.close("test");
	}
});

test("/api/plan lists only Node.js and npm for persistence when a newer pnpm 11 is already in $PNPM_HOME/bin", async () => {
	const { host, port, login, runs } = await start({ collect: async () => collected({
		pnpm: { available: true, version: "11.5.0", usable: true, compatible: true, persistent: true, inGlobalBin: true },
	}) });
	try {
		const view = await plan(port, await login());
		assert.deepEqual(view.blockers, []);
		assert.deepEqual(view.actions.map((action: { id: string }) => action.id).filter((id: string) => /^(persist-|configure-npm)/.test(id)),
			["persist-node", "persist-npm", "configure-npm-prefix"]);
		assert.deepEqual(view.persistence.tools, ["node", "npm"]);
		assert.ok(view.persistence.description.startsWith("node, npm will be installed under $PNPM_HOME"), view.persistence.description);
		assert.deepEqual(runs, []);
	} finally {
		await host.close("test");
	}
});

test("/api/plan reports blockers with guidance and no profile change when already on PATH", async () => {
	const { host, port, login } = await start({ collect: async () => collected({
		node: { available: true, version: "24.18.0", usable: true, persistent: true, npm: true },
		pnpm: { available: true, version: "11.1.1", usable: true, compatible: true, persistent: true },
		globalBin: { available: true, path: BIN, writable: true, onPath: true },
		pi: { available: null },
	}) });
	try {
		const view = await plan(port, await login());
		assert.deepEqual(view.actions, []);
		assert.equal(view.blockers.length, 1);
		assert.equal(view.blockers[0].code, "unknown-tool");
		assert.equal(view.blockers[0].tool, "pi");
		assert.ok(view.blockers[0].guidance.length > 20);
		assert.equal(view.profileChange.changesProfile, false);
		assert.deepEqual(view.persistence.tools, []);
	} finally {
		await host.close("test");
	}
});

test("/api/plan names the found and required version of an older Gentle Shell and how to resolve it", async () => {
	const { host, port, login } = await start({ collect: async () => collected({
		pi: { available: true, version: "1.0.4", usable: true },
		shell: { available: true, version: "3.4.0", usable: false, global: true },
		gentleAi: { available: null }, setup: { available: null },
	}) });
	try {
		const view = await plan(port, await login());
		assert.deepEqual(view.blockers.map((blocker: { code: string; tool: string }) => [blocker.code, blocker.tool]), [["incompatible-tool", "shell"]]);
		assert.equal(view.blockers[0].guidance,
			"Gentle Shell 3.4.0 is installed globally with pnpm, but this installer needs 4.0.0 or newer. Nothing was replaced. " +
			"Update it with `pnpm add -g gentle-pi@4.0.0`, or remove it with `pnpm remove -g gentle-pi`, then select Check again.");
		assert.deepEqual(view.actions, []);
	} finally {
		await host.close("test");
	}
});

test("/api/plan installs the installer's Pi alongside an older Pi that neither pnpm nor npm manages, and says so before consent", async () => {
	const { host, port, login, runs } = await start({ collect: async () => collected({ pi: { available: true, version: "0.99.0", usable: true, external: true } }) });
	try {
		const view = await plan(port, await login());
		assert.deepEqual(view.blockers, []);
		const install = view.actions.find((action: { id: string }) => action.id === "install-pi");
		assert.equal(install.description, `Install Pi ${PI_INSTALL_VERSION} globally with pnpm for Gentle Shell. The Pi 0.99.0 already on this computer ` +
			"was not installed with pnpm or npm, so it is left unchanged. Gentle Shell uses the installer's Pi; the `pi` command in a terminal may still run the older one.");
		assert.deepEqual(runs, []);
	} finally {
		await host.close("test");
	}
});

test("/api/plan shows an older Pi's update with its found and target versions and package manager, before consent", async () => {
	for (const owner of ["pnpm", "npm"]) {
		const { host, port, login, runs } = await start({ collect: async () => collected({ pi: { available: true, version: "0.87.1", usable: true, owner } }) });
		try {
			const view = await plan(port, await login());
			assert.deepEqual(view.blockers, []);
			const update = view.actions.find((action: { id: string }) => action.id === "update-pi");
			assert.equal(update.description, `Update Pi 0.87.1 to ${PI_INSTALL_VERSION} with ${owner}, the package manager that installed it. ` +
				`Gentle Shell needs Pi ${requirements.pi} or newer.`);
			assert.ok(view.actions.findIndex((action: { id: string }) => action.id === "update-pi") <
				view.actions.findIndex((action: { id: string }) => action.id === "install-shell"));
			assert.deepEqual(runs, []);
		} finally {
			await host.close("test");
		}
	}
});

test("/api/plan says, before consent, that an older Node and an incompatible pnpm stay unchanged next to the pinned copies", async () => {
	const { host, port, login, runs } = await start({ collect: async () => collected({
		node: { available: true, version: "24.21.0", usable: true, persistent: false, npm: false, found: "22.18.0" },
		pnpm: { available: true, version: "11.1.1", usable: true, compatible: true, persistent: false, found: "10.27.0" },
	}) });
	try {
		const view = await plan(port, await login());
		assert.deepEqual(view.blockers, []);
		assert.deepEqual(view.persistence.tools, ["node", "npm", "pnpm"]);
		const text = view.persistence.description;
		assert.ok(text.includes(`Node.js 22.18.0 on this computer is older than ${requirements.node}, so the installer uses its pinned Node.js 24.21.0 ` +
			"and installs it under $PNPM_HOME. Your Node.js 22.18.0 is left unchanged."), text);
		assert.ok(text.includes(`pnpm 10.27.0 on this computer is not a pnpm ${requirements.pnpm.split(".")[0]} release this installer can use, ` +
			`so the installer uses its pinned pnpm ${requirements.pnpm} and installs it under $PNPM_HOME. Your pnpm 10.27.0 is left unchanged.`), text);
		// No PATH precedence is promised: a version manager may put its own copy first again.
		assert.ok(text.includes("A version manager such as `mise activate` may still put your own versions first on PATH in new terminals."), text);
		assert.deepEqual(runs, []);
	} finally {
		await host.close("test");
	}
	// Without a found version the description is unchanged.
	const plain = await start();
	try {
		assert.doesNotMatch((await plan(plain.port, await plain.login())).persistence.description, /left unchanged|version manager/);
	} finally {
		await plain.host.close("test");
	}
});

test("/api/plan says before consent which Go is downloaded, only to build, with the Go found and the system unchanged", async () => {
	for (const [go, found] of [[{ available: true, version: "1.24.0", usable: true }, "Go 1.24.0 on this computer is older than 1.25.10"],
		[{ available: false }, "Go is missing on this computer"]] as const) {
		const { host, port, login } = await start({ collect: async () => collectedFor("main", { ...mainReady, go }) });
		try {
			const view = await plan(port, await login());
			assert.deepEqual(view.blockers, []);
			const acquire = view.actions.find((action: { id: string }) => action.id === "acquire-go");
			assert.equal(acquire.description, `${found}, so the installer downloads Go 1.25.14 from go.dev, verifies its pinned SHA-256 checksum ` +
				"and uses it only to build Gentle AI. It is kept in the installer's own folder (~/.pi/gentle-ai/tools/go); your Go, PATH and shell profile are not changed.");
			assert.equal(view.actions.find((action: { id: string }) => action.id === "verify-go").description,
				"Check that the downloaded Go runs and reports the pinned version.");
		} finally {
			await host.close("test");
		}
	}
});

test("/api/plan says before consent that a pnpm in $PNPM_HOME/bin that could not be checked is left as it is", async () => {
	const note = "The pnpm in the pnpm global bin directory could not be checked, so it was left as it is, and the installer uses its own verified pnpm for this installation.";
	const pnpm = { available: true, version: requirements.pnpm, usable: true, compatible: true, persistent: true, inGlobalBin: true, unchecked: true };
	const cases = [
		[{ available: true, version: "24.18.0", usable: true, persistent: true, npm: true }, [], `No runtime needs to be installed under $PNPM_HOME. ${note}`],
		[{ available: true, version: "24.21.0", usable: true, persistent: false, npm: false }, ["node", "npm"], null],
	] as const;
	for (const [node, tools, exact] of cases) {
		const { host, port, login, runs } = await start({ collect: async () => collected({ node, pnpm }) });
		try {
			const view = await plan(port, await login());
			assert.deepEqual(view.blockers, []);
			assert.equal(view.ready, false);
			assert.deepEqual(view.persistence.tools, tools);
			if (exact) assert.equal(view.persistence.description, exact);
			else assert.ok(view.persistence.description.endsWith(` ${note}`), view.persistence.description);
			assert.deepEqual(runs, []);
		} finally {
			await host.close("test");
		}
	}
	// A checked pnpm there adds nothing.
	const checked = await start({ collect: async () => collected({ pnpm: { ...pnpm, unchecked: undefined } }) });
	try {
		assert.doesNotMatch((await plan(checked.port, await checked.login())).persistence.description, /could not be checked/);
	} finally {
		await checked.host.close("test");
	}
});

test("/api/plan explains a pnpm in $PNPM_HOME/bin that the installer will not replace, with how to update it", async () => {
	const inGlobalBin = (pnpm: object) => ({ pnpm: { ...pnpm, inGlobalBin: true } });
	const cases = [
		[inGlobalBin({ available: true, version: "11.0.5", usable: true, compatible: false, persistent: true }), "incompatible-tool",
			`pnpm 11.0.5 is installed in the pnpm global bin directory, where this installer would put its own pnpm, but this installer needs pnpm ${requirements.pnpm} or a newer 11.x. ` +
			`Nothing was replaced. Update it with \`pnpm self-update ${requirements.pnpm}\`, then select Check again.`],
		[inGlobalBin({ available: true, version: "12.0.0", usable: true, compatible: false, persistent: true }), "incompatible-tool",
			`pnpm 12.0.0 is installed in the pnpm global bin directory, where this installer would put its own pnpm, but this installer only runs pnpm 11 (${requirements.pnpm} or a newer 11.x). ` +
			"Nothing was replaced, and this installer never downgrades pnpm. To use it, make a pnpm 11 release your global pnpm the way you prefer, then select Check again."],
		[inGlobalBin({ available: null }), "unknown-tool",
			"A pnpm is installed in the pnpm global bin directory, where this installer would put its own pnpm, but its version could not be checked. " +
			`Nothing was replaced. If \`pnpm --version\` reports a version older than ${requirements.pnpm}, update it with \`pnpm self-update ${requirements.pnpm}\`, then select Check again.`],
	] as const;
	for (const [change, code, text] of cases) {
		const { host, port, login } = await start({ collect: async () => collected({ ...change, node: { available: true, version: "24.18.0", usable: true, persistent: true, npm: true } }) });
		try {
			const view = await plan(port, await login());
			assert.deepEqual(view.actions, []);
			const blocker = view.blockers.find((item: { tool: string }) => item.tool === "pnpm");
			assert.equal(blocker.code, code);
			assert.equal(blocker.guidance, text);
		} finally {
			await host.close("test");
		}
	}
});

test("/api/plan explains a Gentle Shell that neither pnpm nor npm manages", async () => {
	const { host, port, login } = await start({ collect: async () => collected({
		pi: { available: true, version: "1.0.4", usable: true },
		shell: { available: null, outsidePnpm: true }, gentleAi: { available: null }, setup: { available: null },
	}) });
	try {
		const view = await plan(port, await login());
		assert.deepEqual(view.blockers.map((blocker: { code: string; tool: string }) => [blocker.code, blocker.tool]), [["unknown-tool", "shell"]]);
		assert.equal(view.blockers[0].guidance,
			"Gentle Shell is already installed, but neither pnpm nor npm manages it (a linked source checkout, for example), " +
			"so this installer cannot update it. Nothing was replaced. Update it the way you installed it, then select Check again.");
	} finally {
		await host.close("test");
	}
});

test("/api/plan explains a Pi whose version cannot be read", async () => {
	const { host, port, login } = await start({ collect: async () => collected({ pi: { available: null, outsidePnpm: true } }) });
	try {
		const view = await plan(port, await login());
		assert.equal(view.blockers.find((item: { tool: string }) => item.tool === "pi").guidance,
			"Pi is already installed, but `pi --version` did not report a version this installer can check. Make sure `pi --version` works in a terminal, then select Check again.");
	} finally {
		await host.close("test");
	}
});

test("/api/plan says that pnpm may put a newer Pi next to Gentle Shell, at least the minimum", async () => {
	// A newer Pi installed with pnpm never blocks: it is kept as it is.
	const { host, port, login } = await start({ collect: async () => collected({ pi: { available: true, version: "1.1.0", usable: true } }) });
	try {
		const view = await plan(port, await login());
		assert.deepEqual(view.blockers, []);
		assert.equal(view.actions.find((action: { id: string }) => action.id === "install-shell").description,
			`Install Gentle Shell (gentle-pi) globally with pnpm. pnpm may put a newer Pi than ${PI_INSTALL_VERSION} next to it ` +
			`(at least Pi ${requirements.pi}), and Gentle Shell runs that Pi.`);
	} finally {
		await host.close("test");
	}
});

test("the outcome says which Pi Gentle Shell runs only when it is not the installer's Pi", async () => {
	const cases: [object, string][] = [
		[{ outcome: "ready", completed: [], piVersion: "1.1.0" }, `${guidance.outcomes.ready} Gentle Shell runs Pi 1.1.0, which pnpm installed next to it.`],
		[{ outcome: "terminal-action-required", action: "open-new-terminal", completed: [], piVersion: "1.1.0" },
			`${guidance.outcomes["terminal-action-required"]} Gentle Shell runs Pi 1.1.0, which pnpm installed next to it.`],
		[{ outcome: "ready", completed: [] }, guidance.outcomes.ready],
		[{ outcome: "ready", completed: [], piVersion: PI_INSTALL_VERSION }, guidance.outcomes.ready],
		[{ outcome: "ready", completed: [], piVersion: "1.1.0 <script>" }, guidance.outcomes.ready],
	];
	for (const [result, expected] of cases) {
		const { host, port, login } = await start({ runInstall: async () => result as never });
		try {
			const cookie = await login();
			const { planId } = await plan(port, cookie);
			assert.equal((await post(port, "/api/install", cookie, { planId, consent: true })).status, 202);
			await waitFor(() => host.outcome() !== null);
			assert.equal(host.outcome()?.guidance, expected, JSON.stringify(result));
			assert.equal("piVersion" in (host.outcome() ?? {}), false);
		} finally {
			await host.close("test");
		}
	}
});

test("/api/plan describes updating an existing Gentle Shell on either channel", async () => {
	const shell = { available: true, version: "3.9.0", usable: true, global: true, owner: "npm" };
	const { host, port, login } = await start({ collect: async (channel) => collectedFor(channel, { pi: { available: true, version: "1.0.4", usable: true },
		shell, go: { available: true, version: "1.26.0", usable: true }, gentleAi: { available: null }, setup: { available: null } }) });
	try {
		const cookie = await login();
		const release = await plan(port, cookie);
		assert.deepEqual(release.actions.map((action: { id: string; description: string }) => [action.id, action.description]), [
			["update-shell-release", "Update Gentle Shell to the latest release with the package manager that installed it (pnpm or npm)."],
			["setup-shell", release.actions[1].description],
			["verify-readiness", "Verify that the installed stack is ready."]]);
		const main = JSON.parse((await send(port, { path: "/api/plan?channel=main", headers: { cookie, ...API } })).body);
		assert.equal(main.actions[0].description,
			"Update Gentle Shell and Gentle AI to the latest commits of `main`, built on this computer, with the package manager that installed Gentle Shell.");
	} finally {
		await host.close("test");
	}
});

test("/api/plan keeps the generic guidance for an unknown tool without more evidence", async () => {
	const { host, port, login } = await start({ collect: async () => collected({ shell: { available: null } }) });
	try {
		const view = await plan(port, await login());
		const blocker = view.blockers.find((item: { tool: string }) => item.tool === "shell");
		assert.equal(blocker.guidance, guidance.blockers["unknown-tool"]);
	} finally {
		await host.close("test");
	}
});

test("/api/plan keeps the generic guidance when no older version is known", async () => {
	const { host, port, login } = await start({ collect: async () => collected({
		gentleAi: { available: true, version: "1.0.0", usable: true, compatible: false } }) });
	try {
		const view = await plan(port, await login());
		const blocker = view.blockers.find((item: { tool: string }) => item.tool === "gentleAi");
		assert.equal(blocker.guidance, guidance.blockers["incompatible-tool"]);
	} finally {
		await host.close("test");
	}
});

const mainReady = { pi: { available: false }, shell: { available: false }, go: { available: true, version: "1.26.0", usable: true } };
function collectedFor(channel: string, changes: Record<string, unknown> = mainReady): Collected {
	const inventory = { ...cleanInventory, ...changes };
	return { inventory, plan: planPreflight(inventory, { channel }) };
}

test("/api/plan plans the release channel by default and the main channel on request", async () => {
	const { host, port, login, channels } = await start({ collect: async (channel) => collectedFor(channel) });
	try {
		const cookie = await login();
		const release = await plan(port, cookie);
		assert.equal(release.channel, "release");
		const response = await send(port, { path: "/api/plan?channel=main", headers: { cookie, ...API } });
		assert.equal(response.status, 200);
		const main = JSON.parse(response.body);
		assert.equal(main.channel, "main");
		const described = Object.fromEntries(main.actions.map((action: { id: string; description: string }) => [action.id, action.description]));
		assert.equal(described["build-gentle-ai-main"], "Build Gentle AI from the latest commit of its `main` branch with Go, verified by Go's checksum database, and use it instead of the pinned release binary.");
		assert.equal(described["install-shell-main"], "Install Gentle Shell from the latest commit of its `main` branch with pnpm, replacing the release package.");
		assert.equal(described["record-channel"], "Remember the `main` channel, so `gentle-shell upgrade` keeps following `main`.");
		assert.deepEqual(channels, ["release", "main"]);
	} finally {
		await host.close("test");
	}
});

test("/api/plan rejects any other channel or query", async () => {
	const { host, port, login, collects } = await start({ collect: async (channel) => collectedFor(channel) });
	try {
		const cookie = await login();
		for (const query of ["channel=nightly", "channel=main&x=1", "x=main", "channel=main&channel=release", "channel="]) {
			assert.equal((await send(port, { path: `/api/plan?${query}`, headers: { cookie, ...API } })).status, 400, query);
		}
		assert.equal(collects(), 0);
	} finally {
		await host.close("test");
	}
});

test("installing a main plan re-checks the computer on the main channel", async () => {
	const { host, port, login, channels, runs } = await start({ collect: async (channel) => collectedFor(channel) });
	try {
		const cookie = await login();
		const response = await send(port, { path: "/api/plan?channel=main", headers: { cookie, ...API } });
		const view = JSON.parse(response.body);
		assert.equal((await post(port, "/api/install", cookie, { consent: true, planId: view.planId })).status, 202);
		assert.deepEqual(channels, ["main", "main"]);
		assert.ok(runs[0].request.plan.actions.some((action: { id: string }) => action.id === "install-shell-main"));
	} finally {
		await host.close("test");
	}
});

test("/api/plan explains that the main channel cannot use a Go it cannot check", async () => {
	const { host, port, login } = await start({ collect: async (channel) => collectedFor(channel, { pi: { available: false }, shell: { available: false }, go: { available: null } }) });
	try {
		const cookie = await login();
		const view = JSON.parse((await send(port, { path: "/api/plan?channel=main", headers: { cookie, ...API } })).body);
		const blocker = view.blockers.find((item: { code: string }) => item.code === "main-requires-go");
		assert.equal(blocker.guidance, "The `main` channel builds Gentle AI with Go, but `go version` did not report a version this installer can check. " +
			"Make sure `go version` works in a terminal, or choose the release channel, then select Check again.");
		assert.deepEqual(view.actions, []);
	} finally {
		await host.close("test");
	}
});

test("/api/plan keeps the preflight's camelCase tool names, but no other tool text", async () => {
	const { host, port, login } = await start({ collect: async () => {
		const result = collected({ gentleAi: { available: true, version: "1.0.0", usable: true, compatible: false },
			globalBin: { available: true, path: BIN, writable: false, onPath: true } });
		result.plan.blockers.push({ code: "unknown-tool", tool: "Evil<tool>" }, { code: "unknown-tool", tool: "x".repeat(65) });
		return result;
	} });
	try {
		const view = await plan(port, await login());
		assert.deepEqual(view.blockers.map((blocker: { tool: string }) => blocker.tool), ["gentleAi", "globalBin", "unknown", "unknown"]);
	} finally {
		await host.close("test");
	}
});

test("install body must be exactly { planId, consent: true }; the runner is not called otherwise", async () => {
	const { host, port, login, runs } = await start();
	try {
		const cookie = await login();
		const { planId } = await plan(port, cookie);
		for (const body of [
			{ planId },
			{ planId, consent: false },
			{ planId, consent: "true" },
			{ planId, consent: true, extra: 1 },
			{ planId, consent: true, plan: { actions: [] } },
			{ consent: true },
			[planId, true],
			"not json",
			"null",
		]) {
			const response = await post(port, "/api/install", cookie, body);
			assert.equal(response.status, 400, JSON.stringify(body));
		}
		const oversized = await post(port, "/api/install", cookie, JSON.stringify({ planId, consent: true, pad: "x".repeat(2048) }));
		assert.equal(oversized.status, 413);
		// Without Content-Length, the streamed body is bounded too.
		const chunked = await new Promise<number>((resolve, reject) => {
			const req = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/api/install", agent: false, headers: {
				cookie, origin: `http://127.0.0.1:${port}`, "x-gentle-install": "1", "content-type": "application/json",
				"transfer-encoding": "chunked" } }, (res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			});
			req.on("error", reject);
			req.write(`{"planId":"${planId}","pad":"${"x".repeat(700)}`);
			req.end(`${"y".repeat(700)}","consent":true}`);
		});
		assert.equal(chunked, 413);
		// A whole client plan never fits the 1 KiB body bound.
		assert.equal((await post(port, "/api/install", cookie, { planId, consent: true, plan: collected().plan })).status, 413);
		assert.equal(runs.length, 0);
	} finally {
		await host.close("test");
	}
});

test("stale planId or a changed re-inventory returns 409 plan-changed without running", async () => {
	let current = collected();
	const { host, port, login, runs } = await start({ collect: async () => current });
	try {
		const cookie = await login();
		const first = await plan(port, cookie);
		const second = await plan(port, cookie);
		assert.notEqual(first.planId, second.planId);
		const stale = await post(port, "/api/install", cookie, { planId: first.planId, consent: true });
		assert.equal(stale.status, 409);
		assert.equal(JSON.parse(stale.body).error, "plan-changed");
		current = collected({ globalBin: { available: true, path: BIN, writable: true, onPath: true } });
		const changed = await post(port, "/api/install", cookie, { planId: second.planId, consent: true });
		assert.equal(changed.status, 409);
		assert.equal(JSON.parse(changed.body).error, "plan-changed");
		assert.equal(runs.length, 0);
	} finally {
		await host.close("test");
	}
});

// A2: the reused-folder notice is advisory. A re-inventory whose walk timed out (no
// notice), or found another one, still installs the consented plan: no 409 loop.
test("a re-inventory that differs only in the reused-folder notice still installs the consented plan", async () => {
	const weak = { check: "parent-acl-mask", at: "C:\\Users\\m\\AppData\\Roaming" };
	const windows = { platform: "win32", node: { available: true, version: "24.18.0", usable: true, persistent: true, npm: true },
		pnpm: { available: true, version: "11.1.1", usable: true, compatible: true, persistent: true }, go: { available: true, version: "1.26.0", usable: true } };
	for (const later of [{}, { folders: { node: { check: "unchecked", at: "C:\\nodejs\\node.exe" } } }]) {
		let current = collected({ ...windows, folders: { node: weak } });
		const { host, port, login, runs } = await start({ collect: async () => current });
		try {
			const cookie = await login();
			const { planId } = await plan(port, cookie);
			current = collected({ ...windows, ...later });
			const response = await post(port, "/api/install", cookie, { planId, consent: true });
			assert.equal(response.status, 202, response.body);
			assert.equal(runs.length, 1);
			assert.deepEqual(runs[0].request.plan.tools.folders?.reused.map((entry: { tool: string }) => entry.tool), ["node"], "the consented plan runs");
		} finally {
			await host.close("test");
		}
	}
	// Any other change still stops it.
	let current = collected({ ...windows, folders: { node: weak } });
	const { host, port, login, runs } = await start({ collect: async () => current });
	try {
		const cookie = await login();
		const { planId } = await plan(port, cookie);
		current = collected({ ...windows, folders: { node: weak }, globalBin: { available: true, path: BIN, writable: true, onPath: true } });
		assert.equal((await post(port, "/api/install", cookie, { planId, consent: true })).status, 409);
		assert.equal(runs.length, 0);
	} finally {
		await host.close("test");
	}
});

test("install runs the server-stored plan once, single-flight, and reports progress with guidance", async () => {
	const gate = deferred<void>();
	const runInstall: RunInstall = async (_request, log) => {
		log({ step: "check-npm", status: "done" });
		await gate.promise;
		log({ step: "install-global", status: "failed" });
		return { outcome: "failed", failedStep: "install-global", completed: ["check-npm"] };
	};
	const { host, port, login, runs } = await start({ runInstall });
	try {
		const cookie = await login();
		const { planId } = await plan(port, cookie);
		const started = await post(port, "/api/install", cookie, { planId, consent: true });
		assert.equal(started.status, 202);
		assert.equal(runs.length, 1);
		assert.deepEqual(runs[0].request, { plan: collected().plan, consent: true });
		const again = await post(port, "/api/install", cookie, { planId, consent: true });
		assert.equal(again.status, 409);
		assert.equal(JSON.parse(again.body).error, "install-running");
		assert.equal((await send(port, { path: "/api/plan", headers: { cookie, ...API } })).status, 409);
		const shutdown = await post(port, "/api/shutdown", cookie, {});
		assert.equal(shutdown.status, 409);
		gate.resolve();
		let progress: { entries: Array<Record<string, unknown>>; running: boolean; outcome: Record<string, unknown> | null } = {
			entries: [], running: true, outcome: null };
		await waitFor(async () => {
			progress = JSON.parse((await send(port, { path: "/api/progress?after=0", headers: { cookie, ...API } })).body);
			return progress.running === false;
		});
		assert.deepEqual(progress.entries, [
			{ seq: 1, step: "check-npm", status: "done", reason: null },
			{ seq: 2, step: "install-global", status: "failed", reason: null },
		]);
		assert.equal(progress.outcome?.outcome, "failed");
		assert.equal(progress.outcome?.failedStep, "install-global");
		assert.equal(progress.outcome?.guidance, guidance.failed["install-global"]);
		const later = JSON.parse((await send(port, { path: "/api/progress?after=1", headers: { cookie, ...API } })).body);
		assert.deepEqual(later.entries.map((entry: { seq: number }) => entry.seq), [2]);
		assert.equal((await send(port, { path: "/api/progress?after=-1", headers: { cookie, ...API } })).status, 400);
		assert.equal((await send(port, { path: "/api/progress?after=1&x=2", headers: { cookie, ...API } })).status, 400);
		assert.equal(host.outcome()?.outcome, "failed");
	} finally {
		gate.resolve();
		await host.close("test");
	}
});

test("progress log is a bounded ring buffer with restricted fields", async () => {
	const runInstall: RunInstall = async (_request, log) => {
		for (let i = 0; i < 300; i += 1) log({ step: `step-${i}`, status: "done", stdout: "secret /home/u/.npmrc", reason: undefined });
		log({ step: "Bad Step; rm -rf", status: "done\n", reason: "x".repeat(500) });
		return { outcome: "blocked", reason: "existing-stack", completed: [], stdout: "secret" };
	};
	const { host, port, login } = await start({ runInstall });
	try {
		const cookie = await login();
		const { planId } = await plan(port, cookie);
		assert.equal((await post(port, "/api/install", cookie, { planId, consent: true })).status, 202);
		let progress: { entries: Array<Record<string, unknown>>; running: boolean; outcome: Record<string, unknown> } | null = null;
		await waitFor(async () => {
			progress = JSON.parse((await send(port, { path: "/api/progress", headers: { cookie, ...API } })).body);
			return progress?.running === false;
		});
		const { entries, outcome } = progress!;
		assert.equal(entries.length, 200);
		assert.equal(entries[0].seq, 102);
		for (const entry of entries) assert.deepEqual(Object.keys(entry).sort(), ["reason", "seq", "status", "step"]);
		assert.deepEqual(entries.at(-1), { seq: 301, step: "unknown", status: "unknown", reason: "unknown" });
		assert.doesNotMatch(JSON.stringify(progress), /secret|npmrc/);
		assert.equal(outcome.outcome, "blocked");
		assert.equal(outcome.reason, "existing-stack");
		assert.equal(outcome.guidance, guidance.blocked["existing-stack"]);
	} finally {
		await host.close("test");
	}
});

test("a throwing runner becomes a failed outcome with generic guidance", async () => {
	const { host, port, login } = await start({ runInstall: async () => { throw new Error("/home/u/secret path"); } });
	try {
		const cookie = await login();
		const { planId } = await plan(port, cookie);
		assert.equal((await post(port, "/api/install", cookie, { planId, consent: true })).status, 202);
		await waitFor(() => host.outcome() !== null);
		const progress = JSON.parse((await send(port, { path: "/api/progress", headers: { cookie, ...API } })).body);
		assert.equal(progress.outcome.outcome, "failed");
		assert.equal(progress.outcome.guidance, guidance.fallback);
		assert.doesNotMatch(JSON.stringify(progress), /secret/);
	} finally {
		await host.close("test");
	}
});

test("a runner result that throws while being viewed still ends the installation as failed", async () => {
	const clock = { value: 5_000 };
	const hostile = { outcome: "failed", completed: [], get failedStep(): string { throw new Error("/home/u/secret getter"); } };
	const { host, port, login } = await start({ clock, limits: { idleMs: 60_000 }, runInstall: async () => hostile });
	try {
		const cookie = await login();
		const { planId } = await plan(port, cookie);
		assert.equal((await post(port, "/api/install", cookie, { planId, consent: true })).status, 202);
		await waitFor(() => host.outcome() !== null);
		const progress = JSON.parse((await send(port, { path: "/api/progress", headers: { cookie, ...API } })).body);
		assert.equal(progress.running, false);
		assert.deepEqual(progress.outcome, { outcome: "failed", failedStep: null, completed: [], guidance: guidance.fallback });
		assert.doesNotMatch(JSON.stringify(progress), /secret/);
		// installing was reset, so the idle timeout can close the wizard again.
		clock.value += 60_000;
		assert.equal(host.checkIdle(), true);
	} finally {
		await host.close("test");
	}
});

test("a failed setup passes only its bounded detail through, with rate-limit guidance when it matches", async () => {
	const rateLimited = "Error: execute install pipeline: download engram binary: fetch latest engram version: GitHub API returned HTTP 403";
	const cases = [
		{ detail: rateLimited, guidance: guidance.setupRateLimit, shown: rateLimited },
		{ detail: "Error: API rate limit exceeded for 203.0.113.7", guidance: guidance.setupRateLimit, shown: "Error: API rate limit exceeded for 203.0.113.7" },
		{ detail: "Error: disk full", guidance: guidance.failed["shell-setup"], shown: "Error: disk full" },
		// GitHub alone or 403 alone is not a rate limit.
		{ detail: "Error: GitHub API returned HTTP 500", guidance: guidance.failed["shell-setup"], shown: "Error: GitHub API returned HTTP 500" },
		// The host bounds the text again: control characters out, at most 300 characters.
		{ detail: `bad\u0000\u001b[31m${"x".repeat(400)}`, guidance: guidance.failed["shell-setup"], shown: `bad[31m${"x".repeat(293)}` },
		{ detail: "  \n ", guidance: guidance.failed["shell-setup"], shown: undefined },
		{ detail: 42, guidance: guidance.failed["shell-setup"], shown: undefined },
	];
	for (const item of cases) {
		const { host, port, login } = await start({ runInstall: async () => ({ outcome: "failed", failedStep: "shell-setup", completed: [], detail: item.detail, stderrTail: "secret raw output" }) });
		try {
			const cookie = await login();
			const { planId } = await plan(port, cookie);
			assert.equal((await post(port, "/api/install", cookie, { planId, consent: true })).status, 202);
			await waitFor(() => host.outcome() !== null);
			const progress = JSON.parse((await send(port, { path: "/api/progress", headers: { cookie, ...API } })).body);
			assert.equal(progress.outcome.failedStep, "shell-setup");
			assert.equal(progress.outcome.guidance, item.guidance, String(item.detail));
			assert.equal(progress.outcome.detail, item.shown);
			assert.doesNotMatch(JSON.stringify(progress), /secret raw output/);
		} finally {
			await host.close("test");
		}
	}
	// A detail on any other step never reaches the browser.
	const { host, port, login } = await start({ runInstall: async () => ({ outcome: "failed", failedStep: "record-channel", completed: [], detail: rateLimited }) });
	try {
		const cookie = await login();
		const { planId } = await plan(port, cookie);
		await post(port, "/api/install", cookie, { planId, consent: true });
		await waitFor(() => host.outcome() !== null);
		const progress = JSON.parse((await send(port, { path: "/api/progress", headers: { cookie, ...API } })).body);
		assert.equal("detail" in progress.outcome, false);
		assert.equal(progress.outcome.guidance, guidance.failed["record-channel"]);
	} finally {
		await host.close("test");
	}
	// pnpm setup's detail passes through too; an unknown or unsupported SHELL gets its own guidance.
	for (const [detail, expected] of [
		["[ERR_PNPM_UNKNOWN_SHELL] Could not infer shell type.", guidance.persistPathShell],
		['[ERR_PNPM_UNSUPPORTED_SHELL] Can\'t setup configuration for "tcsh" shell', guidance.persistPathShell],
		["Error: EACCES: permission denied, open '~/.bashrc'", guidance.failed["persist-path"]],
		[rateLimited, guidance.failed["persist-path"]],
	]) {
		const run = await start({ runInstall: async () => ({ outcome: "failed", failedStep: "persist-path", completed: [], detail }) });
		try {
			const cookie = await run.login();
			const { planId } = await plan(run.port, cookie);
			await post(run.port, "/api/install", cookie, { planId, consent: true });
			await waitFor(() => run.host.outcome() !== null);
			const progress = JSON.parse((await send(run.port, { path: "/api/progress", headers: { cookie, ...API } })).body);
			assert.equal(progress.outcome.detail, detail);
			assert.equal(progress.outcome.guidance, expected, detail);
		} finally {
			await run.host.close("test");
		}
	}
	// A failed Go download passes its folder conflict through, with guidance to remove that folder.
	const conflict = "Conflicting Go destination: ~/.pi/gentle-ai/tools/go/1.25.14";
	for (const [detail, expected] of [[conflict, guidance.goDestinationConflict], ["Error: size", guidance.failed["acquire-go"]]]) {
		const run = await start({ runInstall: async () => ({ outcome: "failed", failedStep: "acquire-go", completed: [], detail }) });
		try {
			const cookie = await run.login();
			const { planId } = await plan(run.port, cookie);
			await post(run.port, "/api/install", cookie, { planId, consent: true });
			await waitFor(() => run.host.outcome() !== null);
			const progress = JSON.parse((await send(run.port, { path: "/api/progress", headers: { cookie, ...API } })).body);
			assert.equal(progress.outcome.detail, detail);
			assert.equal(progress.outcome.guidance, expected, detail);
		} finally {
			await run.host.close("test");
		}
	}
	// The install, main-channel and update steps pass their detail through; GitHub's anonymous
	// API limit (a main commit GitHub refused with HTTP 403) gets the rate-limit guidance.
	const mainLimited = "main-commit-unavailable: GitHub did not return the latest main commit of Gentleman-Programming/gentle-shell (HTTP 403)";
	for (const [step, detail, expected] of [
		["install-global", ".../gentle-pi postinstall:   root cause Error: go: open ~/x: The directory name is invalid.", guidance.failed["install-global"]],
		["install-global", rateLimited, guidance.githubRateLimit],
		["install-shell-main", mainLimited, guidance.githubRateLimit],
		["install-shell-main", "main-commit-unavailable: GitHub did not return the latest main commit of Gentleman-Programming/gentle-shell (HTTP 500)", guidance.failed["install-shell-main"]],
		["build-gentle-ai-main", "main-commit-unavailable: GitHub did not return the latest main commit of Gentleman-Programming/gentle-ai (HTTP 403)", guidance.githubRateLimit],
		["build-gentle-ai-main", "golang.org/x/sys/cpu: fork/exec ~/asm.exe: The directory name is invalid.", guidance.failed["build-gentle-ai-main"]],
		["update-shell", mainLimited, guidance.githubRateLimit],
		["update-shell", "tar: Error is not recoverable: exiting now", guidance.failed["update-shell"]],
	]) {
		const run = await start({ runInstall: async () => ({ outcome: "failed", failedStep: step, completed: [], detail }) });
		try {
			const cookie = await run.login();
			const { planId } = await plan(run.port, cookie);
			await post(run.port, "/api/install", cookie, { planId, consent: true });
			await waitFor(() => run.host.outcome() !== null);
			const progress = JSON.parse((await send(run.port, { path: "/api/progress", headers: { cookie, ...API } })).body);
			assert.equal(progress.outcome.detail, detail, step);
			assert.equal(progress.outcome.guidance, expected, `${step}: ${detail}`);
		} finally {
			await run.host.close("test");
		}
	}
	assert.match(guidance.githubRateLimit, /GitHub/);
	assert.match(guidance.githubRateLimit, /hour/);
	assert.doesNotMatch(guidance.githubRateLimit, /gentle-shell setup|token|credential|password|log in|sign in/i);
	assert.match(guidance.goDestinationConflict, /earlier/);
	assert.match(guidance.goDestinationConflict, /Remove that folder/);
	assert.doesNotMatch(guidance.goDestinationConflict, /network/);
	assert.match(guidance.persistPathShell, /SHELL/);
	assert.match(guidance.persistPathShell, /regular terminal/);
	assert.match(guidance.persistPathShell, /\$PNPM_HOME\/bin/);
	assert.match(guidance.setupRateLimit, /GitHub/);
	assert.match(guidance.setupRateLimit, /hour/);
	assert.doesNotMatch(guidance.setupRateLimit, /token|credential|password|log in|sign in/i);
});

test("only the fixed allowlist is routed: traversal and unknown paths 404, wrong methods 405", async () => {
	const { host, port, login } = await start();
	try {
		const cookie = await login();
		for (const path of ["/../package.json", "/%2e%2e/package.json", "/..%2fpackage.json", "/api%2fplan", "/api/run", "/index.html/..",
			"/wizard.js/../../package.json", "//wizard.js", "/api/plan/", "/favicon.ico", "/assets/index.html"]) {
			const response = await send(port, { path, headers: { cookie } });
			assert.equal(response.status, 404, path);
			assert.doesNotMatch(response.body, /gentle-pi|"version"/);
		}
		assert.equal((await post(port, "/api/run", cookie, {})).status, 404);
		assert.equal((await send(port, { method: "DELETE", path: "/api/plan", headers: { cookie, ...API } })).status, 405);
		assert.equal((await send(port, { method: "GET", path: "/api/install", headers: { cookie } })).status, 405);
		assert.equal((await send(port, { method: "GET", path: "/api/shutdown", headers: { cookie } })).status, 405);
		assert.equal((await post(port, "/", cookie, {})).status, 405);
		assert.equal((await send(port, { method: "PUT", path: "/session?code=x" })).status, 405);
	} finally {
		await host.close("test");
	}
});

test("every response carries strict headers and never CORS headers", async () => {
	const { host, port, login } = await start();
	try {
		const cookie = await login();
		const responses = [
			await send(port, { path: "/", headers: { cookie } }),
			await send(port, { path: "/api/plan", headers: { cookie, ...API } }),
			await send(port, { path: "/api/plan" }),
			await send(port, { path: "/nope", headers: { cookie } }),
			await send(port, { path: "/", host: "evil:1" }),
			await send(port, { method: "OPTIONS", path: "/api/install",
				headers: { cookie, origin: "http://evil.test", "access-control-request-method": "POST" } }),
			await send(port, { path: "/session?code=bad" }),
		];
		for (const response of responses) {
			assert.equal(response.headers["content-security-policy"],
				"default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
			assert.equal(response.headers["x-content-type-options"], "nosniff");
			assert.equal(response.headers["cache-control"], "no-store");
			assert.equal(response.headers["referrer-policy"], "no-referrer");
			assert.equal(response.headers["x-frame-options"], "DENY");
			assert.equal(response.headers["cross-origin-resource-policy"], "same-origin");
			assert.equal(response.headers["cross-origin-opener-policy"], "same-origin");
			assert.deepEqual(Object.keys(response.headers).filter((name) => name.startsWith("access-control-")), []);
		}
		assert.equal(responses[5].status, 405);
	} finally {
		await host.close("test");
	}
});

test("shutdown closes the server; closed reports the last outcome", async () => {
	const { host, port, login } = await start();
	const cookie = await login();
	const { planId } = await plan(port, cookie);
	assert.equal((await post(port, "/api/install", cookie, { planId, consent: true })).status, 202);
	await waitFor(() => host.outcome() !== null);
	const response = await post(port, "/api/shutdown", cookie, {});
	assert.equal(response.status, 200);
	const closed = await host.closed;
	assert.equal(closed.reason, "shutdown");
	assert.equal(closed.outcome?.outcome, "ready");
	await assert.rejects(send(port, { path: "/api/plan", headers: { cookie, ...API } }));
});

test("idle timeout closes the server, but never while installing", async () => {
	const gate = deferred<void>();
	const clock = { value: 5_000 };
	const { host, port, login } = await start({ clock, limits: { idleMs: 60_000 }, runInstall: async () => {
		await gate.promise;
		return { outcome: "ready", completed: [] };
	} });
	try {
		const cookie = await login();
		const { planId } = await plan(port, cookie);
		clock.value += 59_000;
		assert.equal(host.checkIdle(), false);
		assert.equal((await post(port, "/api/install", cookie, { planId, consent: true })).status, 202);
		clock.value += 120_000;
		assert.equal(host.checkIdle(), false);
		gate.resolve();
		await waitFor(() => host.outcome() !== null);
		clock.value += 60_000;
		assert.equal(host.checkIdle(), true);
		const closed = await host.closed;
		assert.equal(closed.reason, "idle");
	} finally {
		gate.resolve();
		await host.close("test");
	}
});

test("guidance covers every runner blocked reason and failed step", () => {
	assert.ok(blockedReasons.length >= 13 && failedSteps.length >= 14);
	for (const reason of blockedReasons) assert.ok(typeof guidance.blocked[reason] === "string" && guidance.blocked[reason].length > 20, reason);
	for (const step of failedSteps) assert.ok(typeof guidance.failed[step] === "string" && guidance.failed[step].length > 20, step);
	// No stale guidance for a reason or step the runners (standard and bundled) no longer have.
	assert.deepEqual(Object.keys(guidance.blocked).sort(), [...new Set([...blockedReasons, ...bundledBlockedReasons])].sort());
	assert.deepEqual(Object.keys(guidance.failed).sort(), [...new Set([...failedSteps, ...bundledFailedSteps])].sort());
	for (const code of ["unsupported-target", "unknown-tool", "incompatible-tool"]) assert.ok(guidance.blockers[code].length > 20, code);
	assert.ok(guidance.fallback.length > 20);
	assert.ok(Object.isFrozen(guidance) && Object.isFrozen(guidance.blocked) && Object.isFrozen(guidance.failed));
});

test("entry helpers: fixed per-platform opener, exit codes and runner environment", async () => {
	// The opener receives the private redirect file, never the session URL.
	const file = "/tmp/gentle-shell-install-Ab12/open.html";
	assert.deepEqual(openerFor("darwin", file, {}), { command: "/usr/bin/open", args: [file] });
	assert.deepEqual(openerFor("linux", file, {}), { command: "xdg-open", args: [file] });
	const winFile = "C:\\Users\\u\\AppData\\Local\\Temp\\gentle-shell-install-Ab12\\open.html";
	assert.deepEqual(openerFor("win32", winFile, { SystemRoot: "C:\\Windows" }),
		{ command: "C:\\Windows\\System32\\rundll32.exe", args: ["url.dll,FileProtocolHandler", winFile] });
	assert.equal(openerFor("win32", winFile, { SystemRoot: "relative" }), null);
	assert.equal(openerFor("freebsd", file, {}), null);

	assert.equal(exitCodeFor({ outcome: "ready" }), 0);
	assert.equal(exitCodeFor({ outcome: "terminal-action-required" }), 0);
	for (const outcome of [{ outcome: "blocked" }, { outcome: "failed" }, null]) assert.equal(exitCodeFor(outcome), 1);

	const TOOLS = "/home/u/.gentle-shell-bootstrap-tools.Ab12";
	const files = new Set([`${TOOLS}/pnpm/bin/pnpm`, "/usr/bin/pnpm"]);
	const fs = { isFile: async (path: string) => files.has(path) };
	const wizardEnv = { HOME: "/home/u", PATH: `${TOOLS}/node/bin:${TOOLS}/pnpm/bin:/opt/bin:/bin` };
	// The bootstrap's pnpm comes first; other tool dirs are dropped.
	assert.deepEqual(await runnerEnvironment({ platform: "linux", env: wizardEnv, fs }),
		{ HOME: "/home/u", PATH: `${TOOLS}/pnpm/bin:/opt/bin:/bin` });
	// The bootstrap acquired its pnpm because the user's is incompatible: the runner never runs the user's.
	files.add("/opt/bin/pnpm");
	assert.deepEqual(await runnerEnvironment({ platform: "linux", env: wizardEnv, fs }),
		{ HOME: "/home/u", PATH: `${TOOLS}/pnpm/bin:/opt/bin:/bin` });
	// The user's own pnpm, reused by the bootstrap, stays the one on PATH.
	const reused = { HOME: "/home/u", PATH: `${TOOLS}/node/bin:/opt/bin:/bin` };
	assert.deepEqual(await runnerEnvironment({ platform: "linux", env: reused, fs }), { HOME: "/home/u", PATH: "/opt/bin:/bin" });
	const windowsEnv = { USERPROFILE: "C:\\Users\\u", Path: `C:\\Users\\u\\AppData\\Local\\.gentle-shell-bootstrap-tools.1\\node;C:\\Windows`,
		GENTLE_INSTALL_PNPM_NODE: "C:\\t\\node.exe", GENTLE_INSTALL_PNPM_ENTRY: "C:\\t\\pnpm.mjs" };
	assert.deepEqual(await runnerEnvironment({ platform: "win32", env: windowsEnv, fs }),
		{ ...windowsEnv, Path: "C:\\Windows" });
});

test("every /api/* request needs X-Gentle-Install: 1 before any state change", async () => {
	const { host, port, login, collects } = await start();
	try {
		const cookie = await login();
		for (const value of [undefined, "0", "true"]) {
			const headers: Record<string, string> = { cookie };
			if (value !== undefined) headers["x-gentle-install"] = value;
			assert.equal((await send(port, { path: "/api/plan", headers })).status, 403, String(value));
			assert.equal((await send(port, { path: "/api/progress", headers })).status, 403, String(value));
		}
		assert.equal(collects(), 0);
		const { planId } = await plan(port, cookie);
		assert.equal(collects(), 1);
		// A rejected plan request neither probes nor rotates the stored plan.
		assert.equal((await send(port, { path: "/api/plan", headers: { cookie } })).status, 403);
		assert.equal(collects(), 1);
		assert.equal((await post(port, "/api/install", cookie, { planId, consent: true })).status, 202);
		// Assets are page navigations and need no custom header.
		assert.equal((await send(port, { path: "/", headers: { cookie } })).status, 200);
	} finally {
		await host.close("test");
	}
});

test("only authenticated traffic extends the idle timeout", async () => {
	const clock = { value: 10_000 };
	const { host, port } = await start({ clock, limits: { idleMs: 60_000 } });
	try {
		clock.value += 59_000;
		// Wrong Host, missing cookie, bad codes and forged cookies do not count as activity.
		await send(port, { path: "/api/plan", host: `localhost:${port}` });
		await send(port, { path: "/api/plan", headers: API });
		await send(port, { path: "/session?code=wrong" });
		await send(port, { path: "/", headers: { cookie: "gentle_install_session=forged" } });
		await send(port, { path: "/nope" });
		clock.value += 1_000;
		assert.equal(host.checkIdle(), true);
		assert.equal((await host.closed).reason, "idle");
	} finally {
		await host.close("test");
	}
	const active = await start({ clock, limits: { idleMs: 60_000 } });
	try {
		clock.value += 59_000;
		// Redeeming the code is activity, and so is an authenticated request.
		const cookie = await active.login();
		clock.value += 59_000;
		assert.equal(active.host.checkIdle(), false);
		assert.equal((await send(active.port, { path: "/api/progress", headers: { cookie, ...API } })).status, 200);
		clock.value += 59_000;
		assert.equal(active.host.checkIdle(), false);
		clock.value += 1_000;
		assert.equal(active.host.checkIdle(), true);
	} finally {
		await active.host.close("test");
	}
});

test("a completed installation is final: later installs get 409 already-completed", async () => {
	for (const result of [{ outcome: "ready", completed: [] }, { outcome: "failed", failedStep: "install-global", completed: [] },
		{ outcome: "blocked", reason: "existing-stack", completed: [] }]) {
		const { host, port, login, runs } = await start({ runInstall: async () => result });
		try {
			const cookie = await login();
			const first = await plan(port, cookie);
			assert.equal((await post(port, "/api/install", cookie, { planId: first.planId, consent: true })).status, 202);
			await waitFor(() => host.outcome() !== null);
			const second = await plan(port, cookie);
			const again = await post(port, "/api/install", cookie, { planId: second.planId, consent: true });
			assert.equal(again.status, 409, result.outcome);
			assert.equal(JSON.parse(again.body).error, "already-completed");
			assert.equal(runs.length, 1);
			assert.equal(host.outcome()?.outcome, result.outcome);
			const progress = JSON.parse((await send(port, { path: "/api/progress", headers: { cookie, ...API } })).body);
			assert.equal(progress.outcome.outcome, result.outcome);
		} finally {
			await host.close("test");
		}
	}
});

// The one-time code reaches the browser through a private redirect file, so it
// never appears in the opener's argv (visible to local process listings).
const redirectRoot = mkdtempSync(join(tmpdir(), "gentle-install-redirect-test-"));
test.after(() => rmSync(redirectRoot, { recursive: true, force: true }));
const SESSION_URL = "http://127.0.0.1:4000/session?code=Abc_123-xyz";

type Spawned = { command: string; args: string[]; options: Record<string, unknown> };
function fakeSpawn({ throws = false } = {}) {
	const calls: Spawned[] = [];
	const children: EventEmitter[] = [];
	const spawn = (command: string, args: string[], options: Record<string, unknown>) => {
		calls.push({ command, args, options });
		if (throws) throw new Error("spawn failed");
		const child = Object.assign(new EventEmitter(), { unref() {} });
		children.push(child);
		return child;
	};
	return { spawn, calls, children };
}

test("redirect page escapes the URL and only refreshes to it", () => {
	const page = redirectPage(SESSION_URL);
	assert.ok(page.includes(`<meta http-equiv="refresh" content="0;url=${SESSION_URL}">`));
	assert.ok(!page.includes("<script"));
	const hostile = redirectPage(`http://127.0.0.1:1/session?code=a"><script>&'`);
	assert.ok(!hostile.includes("<script>") && !hostile.includes(`a">`));
	assert.ok(hostile.includes("a&quot;&gt;&lt;script&gt;&amp;&#39;"));
});

test("writeRedirect creates a private directory and file, and remove() deletes both", async () => {
	const tempDir = mkdtempSync(join(redirectRoot, "write-"));
	const redirect = await writeRedirect(SESSION_URL, { tempDir, files: fsPromises });
	assert.equal(redirect.file, join(redirect.dir, "open.html"));
	assert.ok(redirect.dir.startsWith(join(tempDir, "gentle-shell-install-")));
	assert.equal(readFileSync(redirect.file, "utf8"), redirectPage(SESSION_URL));
	if (process.platform !== "win32") {
		assert.equal(statSync(redirect.dir).mode & 0o777, 0o700);
		assert.equal(statSync(redirect.file).mode & 0o777, 0o600);
	}
	await redirect.remove();
	await redirect.remove();
	assert.deepEqual(readdirSync(tempDir), []);
});

test("openBrowser passes only the redirect file to the fixed detached opener", async () => {
	const tempDir = mkdtempSync(join(redirectRoot, "open-"));
	const fake = fakeSpawn();
	const opened = await openBrowser(SESSION_URL, { platform: "linux", env: {}, tempDir, files: fsPromises, spawn: fake.spawn });
	assert.ok(opened !== null);
	assert.equal(fake.calls.length, 1);
	const [call] = fake.calls;
	assert.equal(call.command, "xdg-open");
	assert.deepEqual(call.args, [opened.file]);
	assert.ok(!call.args.join(" ").includes("Abc_123-xyz"));
	assert.deepEqual(call.options, { shell: false, detached: true, stdio: "ignore", windowsHide: true });
	assert.ok(readFileSync(opened.file, "utf8").includes(SESSION_URL));
	await opened.remove();
	assert.deepEqual(readdirSync(tempDir), []);
});

test("openBrowser leaves no redirect file when there is no opener or it cannot start", async () => {
	const tempDir = mkdtempSync(join(redirectRoot, "fail-"));
	const none = fakeSpawn();
	assert.equal(await openBrowser(SESSION_URL, { platform: "freebsd", env: {}, tempDir, files: fsPromises, spawn: none.spawn }), null);
	assert.equal(none.calls.length, 0);
	assert.deepEqual(readdirSync(tempDir), []);

	const throwing = fakeSpawn({ throws: true });
	assert.equal(await openBrowser(SESSION_URL, { platform: "linux", env: {}, tempDir, files: fsPromises, spawn: throwing.spawn }), null);
	assert.equal(throwing.calls.length, 1);
	assert.deepEqual(readdirSync(tempDir), []);

	// A missing xdg-open fails asynchronously: the file is removed then.
	const missing = fakeSpawn();
	const opened = await openBrowser(SESSION_URL, { platform: "linux", env: {}, tempDir, files: fsPromises, spawn: missing.spawn });
	assert.ok(opened !== null && existsSync(opened.file));
	missing.children[0].emit("error", new Error("ENOENT"));
	await waitFor(() => readdirSync(tempDir).length === 0);

	// A failed write never opens anything and leaves no directory behind.
	const unwritable = fakeSpawn();
	const files = { ...fsPromises, writeFile: async () => { throw new Error("EACCES"); } };
	assert.equal(await openBrowser(SESSION_URL, { platform: "linux", env: {}, tempDir, files, spawn: unwritable.spawn }), null);
	assert.equal(unwritable.calls.length, 0);
	assert.deepEqual(readdirSync(tempDir), []);
});

test("onRedeemed runs once, only for a valid code, and a throwing hook never breaks the session", async () => {
	let redeemed = 0;
	const host = createInstallerServer({
		assetsDir,
		collectPlan: async () => collected(),
		runInstall: async () => ({ outcome: "ready", completed: [] }),
		onRedeemed: () => {
			redeemed += 1;
			throw new Error("cleanup failed");
		},
	});
	const { port, url } = await host.listen();
	try {
		assert.equal((await send(port, { path: "/session?code=wrong" })).status, 401);
		assert.equal(redeemed, 0);
		const path = new URL(url).pathname + new URL(url).search;
		assert.equal((await send(port, { path })).status, 200);
		assert.equal((await send(port, { path })).status, 401);
		assert.equal(redeemed, 1);
	} finally {
		await host.close("test");
	}
});

// S6: the Windows PNPM_HOME decision reaches the plan copy before consent.
const W_DEFAULT = "C:\\Users\\m\\AppData\\Local\\pnpm";
const W_PRIVATE = "C:\\Users\\m\\.pnpm";
const weak = { check: "target-acl-mask", at: "C:\\Users\\m\\AppData\\Local", sid: "S-1-5-21-1-2-3-1002", account: "PC\\other", rights: "0x001301BF" };
async function windowsView(pnpmHome: object, changes: Record<string, unknown> = {}) {
	const { host, port, login } = await start({ collect: async () => collected({ platform: "win32", go: { available: true, version: "1.26.0", usable: true },
		globalBin: { available: true, path: `${W_PRIVATE}\\bin`, writable: true, onPath: false }, pnpmHome, ...changes }) });
	try {
		return await plan(port, await login());
	} finally {
		await host.close("test");
	}
}
const names = (text: string, parts: string[]) => { for (const part of parts) assert.ok(text.includes(part), `${part} in: ${text}`); };

test("/api/plan says before consent that a private PNPM_HOME replaces a default another account can change", async () => {
	const view = await windowsView({ available: true, path: W_PRIVATE, source: "private", rejected: { path: W_DEFAULT, ...weak } });
	assert.deepEqual(view.blockers, []);
	assert.equal(view.profileChange.changesProfile, true);
	names(view.profileChange.description, [W_DEFAULT, weak.at, "S-1-5-21-1-2-3-1002 (PC\\other)", "0x001301BF", W_PRIVATE, "`pnpm setup`",
		`PNPM_HOME=${W_PRIVATE}`, `${W_PRIVATE}\\bin`, "new terminals", "only you, SYSTEM and Administrators"]);
	assert.equal(view.persistence.pnpmHome, W_PRIVATE);
	// S13: the accepted residual risk of later pnpm commands, stated before consent.
	names(view.profileChange.description, ["pnpm commands you run later", "configuration, cache and state", "%LOCALAPPDATA%", W_DEFAULT]);
	// A passing default keeps the existing copy.
	const plain = await windowsView({ available: true, path: W_DEFAULT, source: "default" });
	assert.doesNotMatch(plain.profileChange.description, /private|%LOCALAPPDATA%/);
});

// S6 notice: reused tools in folders another account can change, before consent.
test("/api/plan notes reused tools in folders another account can change, without blocking or changing the plan", async () => {
	const roaming = { check: "parent-acl-mask", at: "C:\\Users\\m\\AppData\\Roaming", sid: "S-1-5-21-1-2-3-1002", account: "PC\\other", rights: "0x001301BF" };
	const reused = { node: { available: true, version: "24.18.0", usable: true, persistent: true, npm: true }, pi: { available: true, version: "1.2.0", usable: true, external: true },
		pnpm: { available: true, version: "11.1.1", usable: true, compatible: true, persistent: true } };
	const view = await windowsView({ available: true, path: W_DEFAULT, source: "default" }, { ...reused,
		folders: { node: roaming, npm: roaming, pi: { check: "target-owner", at: "C:\\Users\\m\\AppData\\Roaming\\npm\\pi.cmd", sid: "S-1-5-21-9" } } });
	assert.deepEqual(view.blockers, []);
	assert.ok(view.actions.length > 0);
	names(view.sharedFolders.description, ["Node.js", "npm", "Pi", "S-1-5-21-1-2-3-1002 (PC\\other) can change C:\\Users\\m\\AppData\\Roaming", "0x001301BF",
		"C:\\Users\\m\\AppData\\Roaming\\npm\\pi.cmd is owned by S-1-5-21-9", "never creates or runs its own programs there", "accepted risk", "not a blocker"]);
	assert.deepEqual(view.sharedFolders.tools, ["node", "npm", "pi"]);
	// A1: a path the walk could not check says so, and still does not block.
	const unchecked = await windowsView({ available: true, path: W_DEFAULT, source: "default" }, { ...reused, folders: { node: { check: "unchecked", at: "C:\\nodejs\\node.exe" } } });
	assert.deepEqual(unchecked.blockers, []);
	names(unchecked.sharedFolders.description, ["Node.js: the permissions of C:\\nodejs\\node.exe could not be checked", "could not be checked", "not a blocker",
		"make sure your account can read the permissions of the paths that could not be checked"]);
	assert.doesNotMatch(unchecked.sharedFolders.description, /write access/, "nothing says an account can write there");
	assert.match(view.sharedFolders.description, /remove that account's write access/);
	assert.doesNotMatch(view.sharedFolders.description, /could not be checked/);
	// Nothing to note: no record.
	assert.equal((await windowsView({ available: true, path: W_DEFAULT, source: "default" }, reused)).sharedFolders, null);
});

test("/api/plan names the folder, principal, rights and remedy when PNPM_HOME is not private", async () => {
	const cases = [
		[{ available: true, path: W_DEFAULT, source: "default", untrusted: weak, installed: true }, [W_DEFAULT, "already holds files", "never moves or deletes", "%USERPROFILE%\\.pnpm"]],
		[{ available: true, path: "D:\\pnpm", source: "user", untrusted: { ...weak, at: "D:\\pnpm" } }, ["PNPM_HOME is set to D:\\pnpm", "%USERPROFILE%\\.pnpm"]],
		[{ available: true, path: W_DEFAULT, source: "default", untrusted: weak, private: { path: W_PRIVATE, foreign: true } }, [W_PRIVATE, "did not create"]],
		[{ available: true, path: W_DEFAULT, source: "default", untrusted: weak, private: { path: W_PRIVATE, untrusted: { check: "target-owner", at: "C:\\Users\\m", sid: "S-1-5-21-9" } } },
			[W_PRIVATE, "C:\\Users\\m is owned by S-1-5-21-9"]],
	] as const;
	for (const [pnpmHome, parts] of cases) {
		const view = await windowsView(pnpmHome);
		assert.deepEqual(view.actions, []);
		assert.deepEqual(view.blockers.map((blocker: { code: string; tool: string }) => [blocker.code, blocker.tool]), [["untrusted-pnpm-home", "pnpmHome"]]);
		names(view.blockers[0].guidance, [...parts, "S-1-5-21-1-2-3-1002 (PC\\other)", "0x001301BF"]);
	}
	const failed = await windowsView({ available: null, failed: true });
	assert.deepEqual(failed.blockers.map((blocker: { code: string; tool: string }) => [blocker.code, blocker.tool]), [["unknown-tool", "pnpmHome"]]);
	assert.match(failed.blockers[0].guidance, /PNPM_HOME/);
	assert.ok(guidance.blocked["pnpm-home-changed"].length > 20);
	assert.ok(guidance.failed["prepare-pnpm-home"].includes("%USERPROFILE%\\.pnpm"));
});

// R2: an update's children (gentle-shell upgrade, its pnpm and postinstall) get the
// same private-mode environment as the runner's children; otherwise it is unchanged.
test("upgradeEnvironment isolates TEMP, TMP and pnpm's folders in a private Windows PNPM_HOME only", () => {
	const env = { USERPROFILE: "C:\\Users\\m", PNPM_HOME: W_PRIVATE, Path: "C:\\Windows", TEMP: "C:\\Users\\m\\AppData\\Local\\Temp" };
	const privateHome = { available: true, path: W_PRIVATE, source: "private", rejected: { path: W_DEFAULT, check: "target-acl-mask" } };
	const isolated = upgradeEnvironment({ platform: "win32", env, pnpmHome: privateHome, goPath: "C:\\go\\bin\\go.exe" });
	assert.deepEqual([isolated.TEMP, isolated.TMP, isolated.XDG_CACHE_HOME, isolated.PNPM_HOME], [`${W_PRIVATE}\\tmp`, `${W_PRIVATE}\\tmp`, `${W_PRIVATE}\\.cache`, W_PRIVATE]);
	assert.equal(isolated.Path.split(";")[0], "C:\\go\\bin");
	assert.deepEqual(upgradeEnvironment({ platform: "win32", env, pnpmHome: { available: true, path: W_PRIVATE, source: "user" } }), env);
	assert.deepEqual(upgradeEnvironment({ platform: "linux", env: { PATH: "/usr/bin" }, pnpmHome: null }), { PATH: "/usr/bin" });
});

// T1c: the bundled plan's copy, before consent.
const bundledDistribution = { status: "published", manifest: { shell: "4.1.0", pi: "1.0.2" }, lockfile: "lock" };
const bundledLine = 'export PATH="/home/u/.gentle-shell/bin:$PATH" # gentle-shell bundled install';
function bundledCollected(path: Record<string, unknown>, platform = "linux"): Collected {
	const layout = platform === "win32" ? prefixLayout({ platform, env: { LOCALAPPDATA: "C:\\L" }, home: "C:\\U" }) : prefixLayout({ platform, env: {}, home: "/home/u" });
	return { inventory: { ...cleanInventory, platform }, plan: bundledPlan({ platform, distribution: bundledDistribution, layout, path }) as never };
}
test("/api/plan describes the bundled install: its own pinned runtimes, the user's tools untouched and npm's network settings respected", async () => {
	const { host, port, login } = await start({ collect: async () => bundledCollected({ kind: "profile", path: "/home/u/.bashrc", line: bundledLine, create: false }) });
	try {
		const view = await plan(port, await login());
		assert.equal(view.bundled, true);
		assert.deepEqual(view.actions.map((action: { id: string }) => action.id),
			["bundled-prefix", "bundled-runtime", "bundled-version", "bundled-activate", "bundled-path", "bundled-setup"]);
		const text = view.actions.map((action: { description: string }) => action.description).join("\n");
		assert.match(text, /\/home\/u\/\.gentle-shell/);
		assert.match(text, /Node\.js 24\.21\.0 with its npm and pnpm 11\.1\.1/);
		assert.match(text, /Gentle Shell 4\.1\.0 with Pi 1\.0\.2/);
		assert.match(text, /--frozen-lockfile/);
		assert.match(text, /\/home\/u\/\.bashrc/);
		assert.match(text, /gentle-shell setup/);
		assert.deepEqual(view.persistence.tools, ["node", "npm", "pnpm"]);
		assert.equal(view.persistence.pnpmHome, "/home/u/.gentle-shell");
		assert.match(view.persistence.description, /Your own Node\.js, npm, pnpm, Go and Pi are not used or changed/);
		assert.match(view.persistence.description, /npm registry, authentication and proxy settings/);
		assert.equal(view.profileChange.changesProfile, true);
		assert.equal(view.profileChange.command, null);
		assert.equal(view.profileChange.binDir, "/home/u/.gentle-shell/bin");
		assert.match(view.profileChange.description, /\/home\/u\/\.bashrc/);
	} finally {
		await host.close("test");
	}
	const cases: [Record<string, unknown>, RegExp, boolean, string?][] = [
		[{ kind: "none" }, /already finds/, false],
		[{ kind: "symlink", path: "/home/u/.local/bin/gentle-shell", target: "/home/u/.gentle-shell/bin/gentle-shell" }, /\/home\/u\/\.local\/bin\/gentle-shell/, true],
		[{ kind: "manual", path: "/home/u/.zshrc", line: bundledLine, reason: "symlink" }, /add this line to \/home\/u\/\.zshrc yourself/, false],
		[{ kind: "registry", key: "HKCU\\Environment", name: "Path", entry: "C:\\L\\gentle-shell\\bin" }, /user PATH/, true, "win32"],
	];
	for (const [path, description, changes, platform] of cases) {
		const server = await start({ collect: async () => bundledCollected(path, platform) });
		try {
			const view = await plan(server.port, await server.login());
			assert.match(view.profileChange.description, description, String(path.kind));
			assert.equal(view.profileChange.changesProfile, changes, String(path.kind));
			if (path.kind === "manual") assert.ok(view.profileChange.description.includes(bundledLine));
			if (platform === "win32") {
				assert.deepEqual(view.persistence.tools, ["node", "npm", "pnpm", "go"]);
				assert.match(view.actions[1].description, /Go 1\.25\.14/);
			}
		} finally {
			await server.host.close("test");
		}
	}
});

test("bundled outcomes: every bundled step has guidance, pnpm's error line is shown, and a manual PATH line is returned to copy", async () => {
	for (const step of bundledFailedSteps) assert.equal(typeof guidance.failed[step], "string", step);
	const cases: [Record<string, unknown>, (view: Record<string, unknown>) => void][] = [
		[{ outcome: "failed", failedStep: "install-version", completed: ["claim-prefix"], detail: "ERR_PNPM_FETCH_401 GET https://npm.acme.dev/x: Unauthorized" },
			(view) => { assert.equal(view.detail, "ERR_PNPM_FETCH_401 GET https://npm.acme.dev/x: Unauthorized"); assert.equal(view.guidance, guidance.failed["install-version"]); }],
		[{ outcome: "terminal-action-required", action: "add-path-line", pathLine: { file: "/home/u/.zshrc", line: bundledLine }, completed: [] },
			(view) => {
				assert.equal(view.action, "add-path-line");
				assert.deepEqual(view.pathLine, { file: "/home/u/.zshrc", line: bundledLine });
				assert.equal(view.guidance, guidance.outcomes["add-path-line"]);
			}],
		[{ outcome: "terminal-action-required", action: "add-path-line", pathLine: { file: "/home/u/.zshrc\u001b[2J", line: 7 }, completed: [] },
			(view) => { assert.equal("pathLine" in view, false); }],
	];
	for (const [result, check] of cases) {
		const { host, port, login } = await start({ runInstall: async () => result as never });
		try {
			const cookie = await login();
			const { planId } = await plan(port, cookie);
			assert.equal((await post(port, "/api/install", cookie, { planId, consent: true })).status, 202);
			await waitFor(() => host.outcome() !== null);
			check(host.outcome() as Record<string, unknown>);
		} finally {
			await host.close("test");
		}
	}
});

// Simulates Linux against the real filesystem (profile files), so it runs on the POSIX runners only.
test("wizardHandlers plans the bundled install only when the gate says so, and routes its plan to the bundled runner",
	{ skip: process.platform === "win32" ? "simulated Linux paths need a POSIX filesystem" : false }, async () => {
	const home = mkdtempSync(join(tmpdir(), "gentle-wizard-handlers-"));
	try {
		const asset = distributionAsset({ shell: requirements.shell, pi: "1.0.2" }, "lock");
		const urls: string[] = [];
		const download = (published: boolean) => async ({ url }: { url: string }) => {
			urls.push(url);
			if (!published) throw Object.assign(new Error("Download responded 404"), { status: 404 });
			return Buffer.from(url.endsWith(".json") ? asset : "lock");
		};
		const env = { HOME: home, PATH: "/usr/bin", SHELL: "/bin/bash" };
		const handlers = (published: boolean, inventory = cleanInventory) => wizardHandlers({ platform: "linux", arch: "x64", env, run: async () => ({}), fs: {},
			download: download(published), inventory: async () => structuredClone(inventory) });
		const bundled = await handlers(true).collectPlan("release");
		assert.equal(bundled.plan.bundled.shell, requirements.shell);
		assert.equal(bundled.plan.bundled.root, join(home, ".gentle-shell"));
		assert.equal(bundled.plan.bundled.path.kind, "profile");
		assert.deepEqual(urls, [`https://github.com/Gentleman-Programming/gentle-shell/releases/download/v${requirements.shell}/gentle-shell-distribution.json`,
			`https://github.com/Gentleman-Programming/gentle-shell/releases/download/v${requirements.shell}/gentle-shell-distribution-lock.yaml`]);
		// Without the assets (v4.0.0 today), on main, or with an existing Gentle Shell: the standard plan, unchanged.
		urls.length = 0;
		assert.deepEqual((await handlers(false).collectPlan("release")).plan, planPreflight(cleanInventory));
		assert.deepEqual((await handlers(true).collectPlan("main")).plan, planPreflight(cleanInventory, { channel: "main" }));
		const existing = { ...cleanInventory, shell: { available: true, version: requirements.shell, usable: true, global: true, owner: "pnpm" } };
		assert.deepEqual((await handlers(true, existing).collectPlan("release")).plan, planPreflight(existing));
		assert.equal(urls.length, 1, "only the release check of a new installation asks for the assets");
		// The bundled plan goes to the bundled runner, which needs consent like the standard one.
		const routed = handlers(true);
		const { plan: consented } = await routed.collectPlan("release");
		assert.deepEqual(await routed.runInstall({ plan: consented, consent: false }, () => {}), { outcome: "blocked", reason: "consent-required", completed: [] });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
