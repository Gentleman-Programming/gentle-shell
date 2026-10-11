import assert from "node:assert/strict";
import test from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import { sidebarHeader, sidebarHeaderContributor, sidebarHeaderContributors, sidebarPart, sidebarState } from "../lib/shell-sidebar.ts";

const host = (terminal?: object) => ({ terminal }) as TUI;
const component = () => ({ render: (_width = 80) => ["bottom"], invalidate() {} });

test("unsupported hosts retain the original bottom widget and disposal", () => {
	for (const tui of [host(), host(null as unknown as object)]) {
		let disposed = 0;
		const bottom = { ...component(), dispose() { disposed++; } };
		const part = sidebarPart(tui, "todo", bottom);
		assert.equal(part, bottom);
		assert.deepEqual(part.render(), ["bottom"]);
		part.dispose();
		assert.equal(disposed, 1);
	}
});

test("terminal state survives host replacement without leaking across terminals", () => {
	const terminal = {};
	assert.equal(sidebarState(host(terminal)), sidebarState(host(terminal)));
	assert.notEqual(sidebarState(host(terminal)), sidebarState(host({})));
});

test("bottom paint is suppressed only while the sidebar owns the host", () => {
	const tui = host({});
	const state = sidebarState(tui);
	const part = sidebarPart(tui, "todo", component());
	state.active = true;
	assert.deepEqual(part.render(80), ["bottom"]);
	state.ownsHost = () => true;
	assert.deepEqual(part.render(80), []);
	state.active = false;
	assert.deepEqual(part.render(80), ["bottom"]);
});

test("disposing an old part preserves its replacement and releases its bottom", () => {
	const tui = host({});
	let disposed = 0;
	const first = sidebarPart(tui, "todo", { ...component(), dispose() { disposed++; } });
	const replacement = component();
	const second = sidebarPart(tui, "todo", replacement);
	first.dispose?.();
	assert.equal(disposed, 1);
	assert.equal(sidebarState(tui).parts.get("todo"), replacement);
	(second as typeof second & { dispose?(): void }).dispose?.();
	assert.equal(sidebarState(tui).parts.size, 0);
});

test("sidebarHeader registers the header part under its own key and disposes it without a bottom widget", () => {
	const tui = host({});
	const rail = { render: () => ["header line"], invalidate() {}, digest: () => "d" };
	const dispose = sidebarHeader(tui, rail);
	assert.equal(sidebarState(tui).parts.get("header"), rail);
	dispose();
	assert.equal(sidebarState(tui).parts.get("header"), undefined);
});

test("sidebarHeader on an unsupported host is a harmless no-op", () => {
	const dispose = sidebarHeader(host(), { render: () => [], invalidate() {} });
	assert.doesNotThrow(dispose);
});

test("sidebarHeader dispose does not remove a replacement rail registered after it", () => {
	const tui = host({});
	const first = { render: () => ["first"], invalidate() {} };
	const dispose = sidebarHeader(tui, first);
	const second = { render: () => ["second"], invalidate() {} };
	sidebarHeader(tui, second);
	dispose();
	assert.equal(sidebarState(tui).parts.get("header"), second);
});

test("header contributors are reported in registration order", () => {
	const tui = host({});
	const first = { render: () => ["first row"], invalidate() {} };
	const second = { render: () => ["second row"], invalidate() {} };
	sidebarHeaderContributor(tui, "tabs", first);
	sidebarHeaderContributor(tui, "other", second);
	assert.deepEqual(sidebarHeaderContributors(tui), [first, second]);
});

test("disposing a header contributor releases exactly that contribution", () => {
	const tui = host({});
	const first = { render: () => ["first row"], invalidate() {} };
	const second = { render: () => ["second row"], invalidate() {} };
	const dispose = sidebarHeaderContributor(tui, "tabs", first);
	sidebarHeaderContributor(tui, "other", second);
	dispose();
	assert.deepEqual(sidebarHeaderContributors(tui), [second]);
});

test("a header contributor disposer does not remove a replacement registered under the same key", () => {
	const tui = host({});
	const first = { render: () => [], invalidate() {} };
	const dispose = sidebarHeaderContributor(tui, "tabs", first);
	const second = { render: () => [], invalidate() {} };
	sidebarHeaderContributor(tui, "tabs", second);
	dispose();
	assert.deepEqual(sidebarHeaderContributors(tui), [second]);
});

test("a header contributor on an unsupported host is a harmless no-op", () => {
	const dispose = sidebarHeaderContributor(host(), "tabs", { render: () => [], invalidate() {} });
	assert.doesNotThrow(dispose);
});

test("a terminal with no header contributor reports none", () => {
	assert.deepEqual(sidebarHeaderContributors(host({})), []);
});
