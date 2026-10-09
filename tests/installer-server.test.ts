import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exitCodeFor, openBrowser, openerFor, redirectPage, runnerEnvironment, writeRedirect } from "../bin/gentle-shell-install.mjs";
import { planPreflight, requirements } from "../scripts/installer-preflight.mjs";
import { blockedReasons, failedSteps } from "../scripts/installer-runner.mjs";
import { createInstallerServer, guidance } from "../scripts/installer-server.mjs";

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

test("/api/plan names the found and required version of another older tool", async () => {
	const { host, port, login } = await start({ collect: async () => collected({ pi: { available: true, version: "0.99.0", usable: true } }) });
	try {
		const view = await plan(port, await login());
		const blocker = view.blockers.find((item: { tool: string }) => item.tool === "pi");
		assert.equal(blocker.guidance, "Pi 0.99.0 is installed, but this installer needs 0.99.1 or newer. Nothing was replaced. Update it, then select Check again.");
	} finally {
		await host.close("test");
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

test("/api/plan explains that the main channel needs Go", async () => {
	const { host, port, login } = await start({ collect: async (channel) => collectedFor(channel, { pi: { available: false }, shell: { available: false } }) });
	try {
		const cookie = await login();
		const view = JSON.parse((await send(port, { path: "/api/plan?channel=main", headers: { cookie, ...API } })).body);
		const blocker = view.blockers.find((item: { code: string }) => item.code === "main-requires-go");
		assert.equal(blocker.guidance, `The \`main\` channel builds Gentle AI from source and needs Go ${requirements.go} or newer on your PATH. Install Go, or choose the release channel, then select Check again.`);
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
	const { host, port, login } = await start({ runInstall: async () => ({ outcome: "failed", failedStep: "install-global", completed: [], detail: rateLimited }) });
	try {
		const cookie = await login();
		const { planId } = await plan(port, cookie);
		await post(port, "/api/install", cookie, { planId, consent: true });
		await waitFor(() => host.outcome() !== null);
		const progress = JSON.parse((await send(port, { path: "/api/progress", headers: { cookie, ...API } })).body);
		assert.equal("detail" in progress.outcome, false);
		assert.equal(progress.outcome.guidance, guidance.failed["install-global"]);
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
	// No stale guidance for a reason or step the runner no longer has.
	assert.deepEqual(Object.keys(guidance.blocked).sort(), [...blockedReasons].sort());
	assert.deepEqual(Object.keys(guidance.failed).sort(), [...failedSteps].sort());
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
	// A bootstrap-only pnpm stays reachable only as the last PATH entry; other tool dirs are dropped.
	assert.deepEqual(await runnerEnvironment({ platform: "linux", env: wizardEnv, fs }),
		{ HOME: "/home/u", PATH: `/opt/bin:/bin:${TOOLS}/pnpm/bin` });
	files.add("/opt/bin/pnpm");
	assert.deepEqual(await runnerEnvironment({ platform: "linux", env: wizardEnv, fs }), { HOME: "/home/u", PATH: "/opt/bin:/bin" });
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
