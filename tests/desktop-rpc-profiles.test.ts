import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DESKTOP_PROFILES_SERVICE_CHANNEL,
	DESKTOP_PROFILES_SERVICE_SCHEMA,
	DesktopProfilesBridge,
	desktopConfirmationToken,
	discoverDesktopProfilesService,
	type DesktopProfileApplyRequest,
	type DesktopProfileApplyResult,
	type DesktopProfilesService,
} from "../lib/desktop-rpc-profiles.ts";

const context = { cwd: "/repo" } as unknown as ExtensionContext;

function fakeService(result: DesktopProfileApplyResult, seen: DesktopProfileApplyRequest[] = []): DesktopProfilesService & { disposed: number } {
	const service = {
		schema: DESKTOP_PROFILES_SERVICE_SCHEMA as typeof DESKTOP_PROFILES_SERVICE_SCHEMA,
		disposed: 0,
		apply: async (request: DesktopProfileApplyRequest) => {
			seen.push(request);
			return result;
		},
		dispose() {
			service.disposed += 1;
		},
	};
	return service;
}

function bridgeWith(service: DesktopProfilesService | undefined): DesktopProfilesBridge {
	const bridge = new DesktopProfilesBridge({} as ExtensionAPI, async () => service);
	bridge.attach(context);
	return bridge;
}

test("apply_profile rejects malformed params before reaching the owner", async () => {
	const seen: DesktopProfileApplyRequest[] = [];
	const bridge = bridgeWith(fakeService({ status: "applied", notes: [] }, seen));
	const invalid = { ok: false, error: { code: "invalid_request", message: "Invalid apply_profile parameters" } };
	for (const params of [
		{},
		{ profile: "team" },
		{ profile: "", mode: "default" },
		{ profile: "x".repeat(129), mode: "default" },
		{ profile: "team", mode: "global" },
		{ profile: 1, mode: "default" },
		{ profile: "team", mode: "default", confirmation: 1 },
		{ profile: "team", mode: "default", confirmation: "x".repeat(129) },
		{ profile: "team", mode: "default", extra: true },
	]) {
		assert.deepEqual(await bridge.handle("apply_profile", params), invalid, JSON.stringify(params));
	}
	assert.equal(seen.length, 0);
});

test("apply_profile forwards exactly the request and maps each owner outcome", async () => {
	const seen: DesktopProfileApplyRequest[] = [];
	const confirm = fakeService({ status: "confirmation_required", title: "Apply profile \"team\"?", message: "diff", confirmation: "a".repeat(64) }, seen);
	assert.deepEqual(await bridgeWith(confirm).handle("apply_profile", { profile: "team", mode: "default" }), {
		ok: true,
		data: { profile: "team", mode: "default", status: "confirmation_required", confirmation: { title: "Apply profile \"team\"?", message: "diff", token: "a".repeat(64) } },
	});
	assert.deepEqual(seen, [{ profile: "team", mode: "default" }]);
	assert.equal(confirm.disposed, 1, "the owner service is disposed after each request");

	const notes = [{ level: "info" as const, text: "applied" }];
	const applied = fakeService({ status: "applied", notes }, seen);
	assert.deepEqual(await bridgeWith(applied).handle("apply_profile", { profile: "team", mode: "session", confirmation: "b".repeat(64) }), {
		ok: true,
		data: { profile: "team", mode: "session", status: "applied", notes },
		event: { name: "profile_applied", data: { profile: "team", mode: "session", source: "desktop" } },
	});
	assert.deepEqual(seen.at(-1), { profile: "team", mode: "session", confirmation: "b".repeat(64) });

	const failed = [{ level: "warning" as const, text: "could not apply" }];
	assert.deepEqual(await bridgeWith(fakeService({ status: "not_applied", notes: failed })).handle("apply_profile", { profile: "team", mode: "default" }), {
		ok: true,
		data: { profile: "team", mode: "default", status: "not_applied", notes: failed },
	});
	assert.deepEqual(await bridgeWith(fakeService({ status: "unknown_profile" })).handle("apply_profile", { profile: "team", mode: "default" }), {
		ok: false,
		error: { code: "unknown_profile", message: "No saved profile with that name" },
	});
	assert.deepEqual(await bridgeWith(fakeService({ status: "busy" })).handle("apply_profile", { profile: "team", mode: "default" }), {
		ok: false,
		error: { code: "profile_apply_busy", message: "Another profile apply is in progress" },
	});
});

test("apply_profile is unavailable without a host or an owner, and leaves other methods alone", async () => {
	const unavailable = { ok: false, error: { code: "profiles_unavailable", message: "Profiles owner unavailable for this session" } };
	assert.deepEqual(await bridgeWith(undefined).handle("apply_profile", { profile: "team", mode: "default" }), unavailable);
	const detached = new DesktopProfilesBridge({} as ExtensionAPI, async () => fakeService({ status: "applied", notes: [] }));
	assert.deepEqual(await detached.handle("apply_profile", { profile: "team", mode: "default" }), unavailable);
	const bridge = bridgeWith(fakeService({ status: "applied", notes: [] }));
	bridge.reset();
	assert.deepEqual(await bridge.handle("apply_profile", { profile: "team", mode: "default" }), unavailable, "a reset drops the host");
	assert.equal(await bridgeWith(fakeService({ status: "applied", notes: [] })).handle("get_config", { store: "profiles" }), undefined);
	const throwing = { schema: DESKTOP_PROFILES_SERVICE_SCHEMA, apply: async () => { throw new Error("boom"); }, dispose() {} } satisfies DesktopProfilesService;
	assert.deepEqual(await bridgeWith(throwing).handle("apply_profile", { profile: "team", mode: "default" }), unavailable);
});

test("discovery accepts only a schema-shaped owner", async () => {
	const listeners = new Map<string, Array<(payload: unknown) => void>>();
	const pi = {
		events: {
			on(channel: string, listener: (payload: unknown) => void) {
				listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
			},
			emit(channel: string, payload: unknown) {
				for (const listener of listeners.get(channel) ?? []) listener(payload);
			},
		},
	} as unknown as ExtensionAPI;
	assert.equal(await discoverDesktopProfilesService(pi, context), undefined, "no owner times out");
	const owner = fakeService({ status: "applied", notes: [] });
	pi.events.on(DESKTOP_PROFILES_SERVICE_CHANNEL, (payload) => {
		const request = payload as { context: unknown; respond(value: unknown): void };
		assert.equal(request.context, context);
		request.respond({ schema: "other/v1", apply: owner.apply, dispose: owner.dispose });
		request.respond(owner);
	});
	assert.equal(await discoverDesktopProfilesService(pi, context), owner);
});

test("the confirmation token binds the mode, profile, title, message and profile content", () => {
	const config = { worker: { model: "openai/alpha" } };
	const token = desktopConfirmationToken("default", "team", "Apply profile \"team\"?", "diff", config);
	assert.match(token, /^[0-9a-f]{64}$/);
	assert.equal(desktopConfirmationToken("default", "team", "Apply profile \"team\"?", "diff", { worker: { model: "openai/alpha" } }), token);
	for (const other of [
		desktopConfirmationToken("session", "team", "Apply profile \"team\"?", "diff", config),
		desktopConfirmationToken("default", "teams", "Apply profile \"team\"?", "diff", config),
		desktopConfirmationToken("default", "team", "Apply profile \"team\"?!", "diff", config),
		desktopConfirmationToken("default", "team", "Apply profile \"team\"?", "diff2", config),
		desktopConfirmationToken("default", "team", "Apply profile \"team\"?", "diff", { worker: { model: "openai/beta" } }),
	]) assert.notEqual(other, token);
});
