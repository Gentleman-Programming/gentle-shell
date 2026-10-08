import assert from "node:assert/strict";
import test from "node:test";
import {
	SESSION_PROFILE_CUSTOM_TYPE,
	readSessionProfileEntry,
} from "../lib/session-profile-persistence.ts";

const custom = (data: unknown, customType = SESSION_PROFILE_CUSTOM_TYPE) => ({
	type: "custom",
	customType,
	data,
});
const bind = (modelProfiles: unknown = {}) => ({
	kind: "bind",
	origin: "user",
	name: "work",
	modelProfiles,
});

// These are supplied entries, not evidence of persistence on disk.
test("custom type identifies the v1 session profile family", () => {
	assert.equal(SESSION_PROFILE_CUSTOM_TYPE, "gentle-pi.session-profile/v1");
});

test("decoder stays strict about present undefined known fields", () => {
	for (const route of [
		{ model: undefined },
		{ thinking: undefined },
		{ effort: undefined },
	]) {
		assert.deepEqual(readSessionProfileEntry(custom(bind({ worker: route }))), {
			status: "invalid",
		});
	}
});

test("bound empty snapshot is distinct from cleared", () => {
	assert.deepEqual(readSessionProfileEntry(custom(bind())), {
		status: "bound",
		binding: bind(),
	});
	assert.deepEqual(readSessionProfileEntry(custom({ kind: "clear" })), {
		status: "cleared",
	});
});

test("reader accepts all four origins and ignores unknown payload fields", () => {
	for (const origin of ["user", "local", "repo", "global"]) {
		assert.deepEqual(
			readSessionProfileEntry(
				custom({ ...bind(), origin, extra: true, version: 99 }),
			),
			{
				status: "bound",
				binding: { ...bind(), origin },
			},
		);
	}
	assert.deepEqual(
		readSessionProfileEntry(custom({ kind: "clear", extra: true })),
		{ status: "cleared" },
	);
});

test("legacy strings and effort normalize while orchestrator remains in the snapshot", () => {
	const result = readSessionProfileEntry(
		custom(
			bind({
				worker: " provider/model ",
				reviewer: { effort: "high", ignored: true },
				orchestrator: { model: "provider/main", thinking: "low", effort: "max" },
				inheriting: {},
			}),
		),
	);
	assert.deepEqual(result, {
		status: "bound",
		binding: bind({
			worker: { model: "provider/model" },
			reviewer: { thinking: "high" },
			orchestrator: { model: "provider/main", thinking: "low" },
			inheriting: {},
		}),
	});
});

test("missing required fields and invalid known meanings fail closed", () => {
	const invalid: unknown[] = [
		null,
		[],
		{},
		{ kind: "other" },
		{ kind: "bind", name: "work", modelProfiles: {} },
		{ ...bind(), origin: "future" },
		{ ...bind(), name: "../work" },
		{ ...bind(), name: "constructor" },
		{ ...bind(), modelProfiles: undefined },
		{ ...bind(), modelProfiles: [] },
	];
	for (const data of invalid) {
		assert.deepEqual(readSessionProfileEntry(custom(data)), {
			status: "invalid",
		});
	}
});

test("one invalid route invalidates the whole snapshot instead of silently dropping it", () => {
	const routes: unknown[] = [
		null,
		[],
		3,
		"bad model",
		{ model: "bad model", thinking: "low" },
		{ model: "provider/good", thinking: "extreme" },
		{ effort: "extreme" },
		{ thinking: "low", effort: "extreme" },
		{ model: null },
	];
	for (const route of routes) {
		assert.deepEqual(readSessionProfileEntry(custom(bind({ worker: route }))), {
			status: "invalid",
		});
		assert.deepEqual(
			readSessionProfileEntry(
				custom(bind({ good: "provider/good", worker: route })),
			),
			{ status: "invalid" },
		);
	}
	assert.deepEqual(readSessionProfileEntry(custom(bind({ "bad role": {} }))), {
		status: "invalid",
	});
});

test("unknown route fields are ignored, including an unknown-only route", () => {
	assert.deepEqual(
		readSessionProfileEntry(custom(bind({ worker: { future: true } }))),
		{
			status: "bound",
			binding: bind({ worker: {} }),
		},
	);
});

test("hostile record keys remain own data without changing prototypes", () => {
	const routes = JSON.parse(
		'{"__proto__":{"model":"provider/safe"},"constructor":{},"prototype":{}}',
	);
	const result = readSessionProfileEntry(custom(bind(routes)));
	assert.equal(result.status, "bound");
	if (result.status !== "bound") return;
	assert.equal(
		Object.getPrototypeOf(result.binding.modelProfiles),
		Object.prototype,
	);
	assert.equal(Object.hasOwn(result.binding.modelProfiles, "__proto__"), true);
	assert.deepEqual(result.binding.modelProfiles["__proto__"], {
		model: "provider/safe",
	});
});

test("required fields cannot be supplied by prototypes", () => {
	assert.deepEqual(readSessionProfileEntry(custom(Object.create(bind()))), {
		status: "invalid",
	});
});

test("reader returns defensive snapshots", () => {
	const entry = custom(bind({ worker: { model: "provider/first" } }));
	const first = readSessionProfileEntry(entry);
	assert.equal(first.status, "bound");
	if (first.status !== "bound") return;
	first.binding.modelProfiles.worker.model = "provider/third";
	const second = readSessionProfileEntry(entry);
	assert.equal(second.status, "bound");
	if (second.status === "bound")
		assert.equal(second.binding.modelProfiles.worker.model, "provider/first");
});

test("noncustom and unrelated custom entries are absent even with matching payloads", () => {
	for (const entry of [
		{ type: "message", customType: SESSION_PROFILE_CUSTOM_TYPE, data: bind() },
		{ type: "message", message: { role: "user", content: "hello" } },
		custom(bind(), "other/v1"),
	])
		assert.deepEqual(readSessionProfileEntry(entry), { status: "absent" });
});

test("family identifier, not payload version, determines support", () => {
	for (const customType of [
		"gentle-pi.session-profile/v0",
		"gentle-pi.session-profile/v99",
		"gentle-pi.session-profile/future",
	]) {
		assert.deepEqual(readSessionProfileEntry(custom(null, customType)), {
			status: "unsupported",
		});
	}
	assert.deepEqual(
		readSessionProfileEntry(custom(bind(), "gentle-pi.session-profile-other/v1")),
		{ status: "absent" },
	);
});
