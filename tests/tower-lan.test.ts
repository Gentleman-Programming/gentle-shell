// LAN mode of the Gentle Tower server (`gentle-shell tower --lan`): the
// opt-in contract on top of the default loopback-only server, pinned through
// the public interface the other tower tests use (startTowerServer + HTTP).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { type NetworkInterfaceInfo, tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { lanAllowedHosts, lanIpv4Addresses, startTowerServer, type TowerServer } from "../lib/tower-server.ts";

const roots: string[] = [];
const servers: TowerServer[] = [];
after(async () => {
	for (const s of servers) await s.close();
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function scratch() {
	const root = mkdtempSync(join(tmpdir(), "gentle-tower-lan-"));
	roots.push(root);
	const hub = join(root, "sessions");
	const web = join(root, "web");
	mkdirSync(web);
	writeFileSync(join(web, "index.html"), "<!doctype html><title>Gentle Tower</title>");
	return { root, hub, web };
}

/** One HTTP call with full control of the Host header (fetch forbids setting it). */
function call(host: string, port: number, path: string, method: "GET" | "POST" = "GET", headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ host, port, path, method, headers }, (res) => {
			let b = "";
			res.on("data", (c) => (b += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
		});
		req.on("error", reject);
		req.end(body);
	});
}

async function start(hub: string, web: string, lan = false, interfaces?: NodeJS.Dict<readonly NetworkInterfaceInfo[]>) {
	const s = await startTowerServer({ hubDir: hub, webDir: web, token: "tok-123", ...(lan ? { lan: true } : {}), ...(interfaces ? { interfaces } : {}) });
	servers.push(s);
	return s;
}

const nic = (address: string, internal = false): NetworkInterfaceInfo => ({ address, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", internal, cidr: null, family: "IPv4" });
const nic6 = (address: string): NetworkInterfaceInfo => ({ address, netmask: "ffff:ffff:ffff:ffff::", mac: "00:00:00:00:00:00", internal: false, cidr: null, family: "IPv6", scopeid: 1 });

test("the LAN enumeration keeps private ranges first and drops internal, link-local and IPv6 addresses", () => {
	assert.deepEqual(lanIpv4Addresses({
		lo0: [nic("127.0.0.1", true)],
		en0: [nic("203.0.113.7"), nic("192.168.1.5"), nic("192.168.1.5")],
		en1: [nic("169.254.4.2"), nic("10.0.0.9"), nic("172.20.1.3"), nic("172.32.0.1")],
		en2: [nic6("fe80::1"), nic6("2001:db8::3")],
	}), ["10.0.0.9", "172.20.1.3", "192.168.1.5", "172.32.0.1", "203.0.113.7"]);
	assert.deepEqual(lanIpv4Addresses({}), []);
});

test("without lan the server stays loopback-only and urls holds just the loopback URL", async () => {
	const { hub, web } = scratch();
	const s = await start(hub, web);
	assert.equal(s.lan, false);
	assert.equal(s.host, "127.0.0.1");
	assert.deepEqual(s.lanIps, []);
	assert.deepEqual(s.urls, [`http://127.0.0.1:${s.port}/tok-123/`]);
	assert.equal(s.url, s.urls[0]);
	// The default origin rule is unchanged: localhost is not added to it.
	assert.equal((await call("127.0.0.1", s.port, "/tok-123/api/sessions", "GET", { Origin: `http://localhost:${s.port}` })).status, 403);
	assert.equal((await call("127.0.0.1", s.port, "/tok-123/api/sessions", "GET", { Origin: `http://127.0.0.1:${s.port}` })).status, 200);
});

test("the LAN host allowlist uses canonical HTTP authorities", () => {
	// On port 80 a browser serializes http://<host> without the default port, so
	// both spellings are approved; anywhere else the authority carries the port.
	const port80 = lanAllowedHosts(["192.168.1.3"], 80);
	assert.ok(port80.has("192.168.1.3") && port80.has("192.168.1.3:80"));
	assert.ok(port80.has("127.0.0.1") && port80.has("localhost") && port80.has("localhost:80"));
	assert.ok(!port80.has("evil.example") && !port80.has("192.168.1.3:8080"));
	const lanPort = lanAllowedHosts(["192.168.1.3"], 51730);
	assert.ok(lanPort.has("192.168.1.3:51730"));
	assert.ok(!lanPort.has("192.168.1.3") && !lanPort.has("192.168.1.3:80"));
});

test("with lan the server reports one URL per LAN address after the loopback URL", async () => {
	const { hub, web } = scratch();
	// A fixed interface list, given before the server starts: the report must
	// come from exactly these addresses, whatever the OS says by now.
	const s = await start(hub, web, true, { en0: [nic("192.168.0.2")], lo0: [nic("127.0.0.1", true)] });
	assert.equal(s.lan, true);
	assert.equal(s.host, "0.0.0.0");
	assert.deepEqual(s.lanIps, ["192.168.0.2"]);
	assert.deepEqual(s.urls, ["http://127.0.0.1:" + s.port + "/tok-123/", `http://192.168.0.2:${s.port}/tok-123/`]);
	// Loopback keeps working as before.
	assert.equal((await call("127.0.0.1", s.port, "/tok-123/")).status, 200);
});

test("with lan an Origin-less GET names a host this launch must answer to", async () => {
	const { hub, web } = scratch();
	const s = await start(hub, web, true);
	// A navigation GET can omit Origin: the Host allowlist still applies, so a
	// rebinding host cannot fetch the app even with a valid token.
	const denied = await call("127.0.0.1", s.port, "/tok-123/", "GET", { Host: `evil.example:${s.port}` });
	assert.deepEqual([denied.status, denied.body], [403, "Forbidden"]);
	// An approved host without an Origin still serves the app.
	assert.equal((await call("127.0.0.1", s.port, "/tok-123/", "GET", { Host: `127.0.0.1:${s.port}` })).status, 200);
	assert.equal((await call("127.0.0.1", s.port, "/tok-123/", "GET", { Host: `localhost:${s.port}` })).status, 200);
});

test("with lan the token still gates every request as before", async () => {
	const { hub, web } = scratch();
	const s = await start(hub, web, true);
	assert.equal((await call("127.0.0.1", s.port, "/tok-123/")).status, 200);
	for (const path of ["/", "/wrong/"]) {
		const denied = await call("127.0.0.1", s.port, path);
		assert.deepEqual([path, denied.status, denied.body], [path, 403, "Forbidden"]);
	}
});

test("with lan the token-gated app is served through a LAN address", async (t) => {
	const { hub, web } = scratch();
	const s = await start(hub, web, true);
	const ip = s.lanIps[0];
	if (ip === undefined) return t.skip("this machine has no non-internal IPv4 address");
	assert.equal((await call(ip, s.port, "/tok-123/")).status, 200);
	const denied = await call(ip, s.port, "/wrong/");
	assert.deepEqual([denied.status, denied.body], [403, "Forbidden"]);
});

test("with lan an Origin is accepted only on a host this launch serves", async () => {
	const { hub, web } = scratch();
	const s = await start(hub, web, true);
	const p = s.port;
	const path = "/tok-123/api/sessions";
	// The loopback and localhost hosts carry their own origin.
	assert.equal((await call("127.0.0.1", p, path, "GET", { Host: `127.0.0.1:${p}`, Origin: `http://127.0.0.1:${p}` })).status, 200);
	assert.equal((await call("127.0.0.1", p, path, "GET", { Host: `localhost:${p}`, Origin: `http://localhost:${p}` })).status, 200);
	// A foreign origin never passes.
	assert.equal((await call("127.0.0.1", p, path, "GET", { Host: `127.0.0.1:${p}`, Origin: "http://evil.example" })).status, 403);
	// DNS rebinding: the Host spells a matching origin but is not one this launch serves.
	assert.equal((await call("127.0.0.1", p, path, "GET", { Host: `evil.example:${p}`, Origin: `http://evil.example:${p}` })).status, 403);
	// The origin must match the host it arrives on.
	assert.equal((await call("127.0.0.1", p, path, "GET", { Host: `localhost:${p}`, Origin: `http://127.0.0.1:${p}` })).status, 403);
});

test("with lan a LAN host serves its own origin and refuses a loopback origin", async (t) => {
	const { hub, web } = scratch();
	const s = await start(hub, web, true);
	const ip = s.lanIps[0];
	if (ip === undefined) return t.skip("this machine has no non-internal IPv4 address");
	const p = s.port;
	const path = "/tok-123/api/sessions";
	assert.equal((await call("127.0.0.1", p, path, "GET", { Host: `${ip}:${p}`, Origin: `http://${ip}:${p}` })).status, 200);
	assert.equal((await call("127.0.0.1", p, path, "GET", { Host: `${ip}:${p}`, Origin: `http://127.0.0.1:${p}` })).status, 403);
});

test("with lan POST keeps the browser rules: own origin in, missing origin out", async () => {
	const { hub, web } = scratch();
	const s = await start(hub, web, true);
	const p = s.port;
	const denied = await call("127.0.0.1", p, "/tok-123/api/action", "POST", { "Content-Type": "application/json" }, "{}");
	assert.deepEqual([denied.status, denied.body], [403, "Forbidden"]);
	// With the page's own origin the request reaches the action parser, which
	// refuses this body with 400 — proof the origin gate let it through.
	const parsed = await call("127.0.0.1", p, "/tok-123/api/action", "POST", { Host: `127.0.0.1:${p}`, Origin: `http://127.0.0.1:${p}`, "Content-Type": "application/json" }, "{nope");
	assert.deepEqual([parsed.status, parsed.body], [400, "Bad request"]);
});
