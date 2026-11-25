import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { normalizePairingCode, parseScopes, readDevicesFile, sameSecret, SERVE_SCOPES, ServeAuth } from "../lib/serve-auth.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function setup(now?: () => number) {
	const root = mkdtempSync(join(tmpdir(), "gentle-serve-auth-"));
	roots.push(root);
	const devicesFile = join(root, "serve", "devices.json");
	return { devicesFile, auth: new ServeAuth({ devicesFile, adminToken: "gsa_local-admin", ...(now ? { now } : {}) }) };
}

test("a pairing code is single use and yields a device token stored only as a hash", () => {
	const { auth, devicesFile } = setup();
	const { code, scopes } = auth.mintPairingCode();
	assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
	assert.deepEqual(scopes, ["sessions:read", "sessions:operate", "terminal"]);
	const paired = auth.redeem(code.toLowerCase(), "  phone\u0007 ");
	assert.ok("token" in paired);
	assert.match(paired.token, /^gss_[A-Za-z0-9_-]{43}$/);
	assert.equal(paired.device.name, "phone");
	assert.deepEqual(auth.redeem(code, "again"), { error: "invalid_code" });

	const text = readFileSync(devicesFile, "utf8");
	assert.ok(!text.includes(paired.token), "the token never reaches the file");
	assert.ok(!text.includes(code), "nor does the code");
	if (process.platform !== "win32") {
		assert.equal(statSync(devicesFile).mode & 0o777, 0o600);
		assert.equal(statSync(join(devicesFile, "..")).mode & 0o777, 0o700);
	}
	const principal = auth.authenticate(paired.token);
	assert.deepEqual(principal, { deviceId: paired.device.id, name: "phone", scopes: ["sessions:read", "sessions:operate", "terminal"] });
	assert.equal(auth.authenticate(`${paired.token}x`), undefined);
	assert.equal(auth.authenticate(undefined), undefined);

	// A new process reads the same devices back.
	const reloaded = new ServeAuth({ devicesFile, adminToken: "other" });
	assert.equal(reloaded.authenticate(paired.token)?.deviceId, paired.device.id);
	assert.equal(reloaded.authenticate("gsa_local-admin"), undefined, "the admin token belongs to one server run");
});

test("the local admin token carries every scope", () => {
	const { auth } = setup();
	assert.deepEqual(auth.authenticate("gsa_local-admin"), { deviceId: "local", name: "local", scopes: SERVE_SCOPES });
});

test("a pairing code expires after five minutes", () => {
	let clock = 0;
	const { auth } = setup(() => clock);
	const fresh = auth.mintPairingCode(["sessions:read"]);
	const stale = auth.mintPairingCode();
	clock = 5 * 60_000 - 1;
	assert.ok("token" in auth.redeem(fresh.code, "ok"));
	clock = 5 * 60_000;
	assert.deepEqual(auth.redeem(stale.code, "late"), { error: "invalid_code" });
});

test("failed pairing attempts are rate limited", () => {
	let clock = 0;
	const { auth } = setup(() => clock);
	const { code } = auth.mintPairingCode();
	for (let i = 0; i < 10; i += 1) assert.deepEqual(auth.redeem(`WRONG-${i}`, "x"), { error: "invalid_code" });
	assert.deepEqual(auth.redeem(code, "x"), { error: "rate_limited" }, "even the right code waits");
	clock += 60_000;
	assert.ok("token" in auth.redeem(code, "x"));
});

test("revoking a device stops its token, kills its tickets and notifies listeners at once", () => {
	const { auth, devicesFile } = setup();
	const paired = auth.redeem(auth.mintPairingCode().code, "laptop");
	assert.ok("token" in paired);
	const principal = auth.authenticate(paired.token)!;
	const ticket = auth.mintTicket(principal, "ses_1");
	const revoked: string[] = [];
	auth.onRevoke((id) => revoked.push(id));
	assert.equal(auth.revoke(paired.device.id), true);
	assert.deepEqual(revoked, [paired.device.id]);
	assert.equal(auth.authenticate(paired.token), undefined);
	assert.equal(auth.redeemTicket(ticket.ticket, "ses_1"), undefined);
	assert.deepEqual(readDevicesFile(devicesFile), []);
	assert.equal(auth.revoke(paired.device.id), false);
});

test("stream tickets are single use, bound to one session and short lived", () => {
	let clock = 0;
	const { auth } = setup(() => clock);
	const principal = auth.authenticate("gsa_local-admin")!;
	const a = auth.mintTicket(principal, "ses_a");
	assert.equal(auth.redeemTicket(a.ticket, "ses_b"), undefined, "wrong session (and now spent)");
	assert.equal(auth.redeemTicket(a.ticket, "ses_a"), undefined);
	const b = auth.mintTicket(principal, "ses_a");
	assert.deepEqual(auth.redeemTicket(b.ticket, "ses_a"), principal);
	assert.equal(auth.redeemTicket(b.ticket, "ses_a"), undefined);
	const c = auth.mintTicket(principal, "ses_a");
	clock += 60_000;
	assert.equal(auth.redeemTicket(c.ticket, "ses_a"), undefined);
});

test("helpers: code normalization, constant-time compare, scope parsing", () => {
	assert.equal(normalizePairingCode(" abcd-efgh "), "ABCDEFGH");
	assert.equal(normalizePairingCode("o1il"), "0111");
	assert.equal(sameSecret("abc", "abc"), true);
	assert.equal(sameSecret("abc", "abcd"), false);
	assert.equal(sameSecret("", ""), false);
	assert.deepEqual(parseScopes(["sessions:read,admin", "admin"]), { scopes: ["sessions:read", "admin"] });
	assert.deepEqual(parseScopes(["root"]), { error: 'unknown scope "root" (expected sessions:read, sessions:operate, terminal, admin)' });
	assert.deepEqual(parseScopes([","]), { error: "--scope needs at least one scope" });
});
