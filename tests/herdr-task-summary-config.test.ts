import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { planHerdrTaskSummaryConfig as plan } from "../lib/herdr-task-summary-config.ts";
const options = { enabled: true, summaryColor: "#123456", continuationColor: "#abc" };
const header = "[ui.sidebar.agents.rows_by_agent]";
const rows = 'pi = [["state_icon", "machine", "workspace", "tab"], ["agent"], [{ token = "$summary", fg = "#123456" }], [{ token = "$summary2", fg = "#abc" }]]';
function stamped(body: string, eol = '\n') {
	return body + '# Gentle Shell task summary end v1 sha256=' + createHash('sha256').update(body).digest('hex') + eol;
}
function enabled(text: string) {
	const result = plan(text, options);
	assert.equal(result.ok, true); // Narrows result to the accepted plan.
	return result;
}
function rejected(text: string, error: string) {
	const before = text;
	assert.deepEqual(plan(text, options), { ok: false, error });
	assert.equal(text, before);
}

test("default enable is an exact owned proposal with two separate continuation rows", () => {
	const text = '# Dots-managed\n[theme]\nname = "one-dark"\n';
	const result = enabled(text);
	assert.deepEqual(result, { ok: true, changed: true, text: text + stamped('# Gentle Shell task summary begin v1 created join=0\n' + header + '\n' + rows + '\n') });
	assert.deepEqual(plan(result.text, options), { ok: true, changed: false, text: result.text });
	assert.equal((result.text.match(/\$summary2/g) ?? []).length, 1);
	assert.equal((result.text.match(/\$summary"/g) ?? []).length, 1);
});

test("update and disable restore exact original bytes, including no final newline", () => {
	for (const original of ["", '# note', '# note\n', '# note\r\n', '[ui.sidebar.agents]\nshow = true\n', header, header + '\r\nclaude = [["agent"]]']) {
		const first = enabled(original);
		const update = plan(first.text, { ...options, summaryColor: "#FF0000", continuationColor: "#00ff00" });
		assert.equal(update.ok, true);
		assert.equal(update.changed, true);
		const end = first.text.indexOf('# Gentle Shell task summary end');
		const begin = first.text.indexOf('# Gentle Shell task summary begin');
		const body = first.text.slice(begin, end).replace('#123456', '#FF0000').replace('#abc', '#00ff00');
		const eol = first.text.includes('\r\n') ? '\r\n' : '\n';
		assert.equal(update.text, first.text.slice(0, begin) + stamped(body, eol));
		assert.deepEqual(plan(update.text, { ...options, enabled: false }), { ok: true, changed: true, text: original });
		assert.deepEqual(plan(original, { ...options, enabled: false }), { ok: true, changed: false, text: original });
	}
});

test("existing non-Pi rows, comments, order and CRLF remain byte-identical", () => {
	const original = '# first\r\n' + header + '\r\n# user rows\r\nclaude = [["agent", "workspace"]] # keep\r\n[other]\r\nvalue = 42\r\n';
	const result = enabled(original);
	const block = stamped('# Gentle Shell task summary begin v1 existing join=0\r\n' + rows + '\r\n', '\r\n');
	assert.equal(result.text, original.replace('[other]', block + '[other]'));
	assert.deepEqual(plan(result.text, { ...options, enabled: false }), { ok: true, changed: true, text: original });
});

test("only concrete strict Herdr hex colors are accepted, even when disabled", () => {
	for (const color of ['accent', '#12', '#1234', '#12345678', 'red', '#ggg', '#abcdef\n', ' #fff']) {
		for (const key of ['summaryColor', 'continuationColor']) {
			assert.deepEqual(plan('', { ...options, enabled: false, [key]: color }), { ok: false, error: 'Colors must be concrete #RGB or #RRGGBB values.' });
		}
	}
	assert.equal(enabled('').ok, true);
});

test("user layouts require an explicit ownership choice", () => {
	for (const text of [header + '\npi = [["agent"]]\n', '[ui.sidebar.agents]\nrows = [["agent"]]\n']) {
		rejected(text, 'Existing agent layout requires an explicit layout ownership choice.');
	}
});

test("bounded syntax rejects forms that could hide conflicting ownership", () => {
	for (const text of [
		'["ui".sidebar.agents]\n', '[ui.sidebar."agents"]\n', 'ui.sidebar.agents.rows = []\n',
		'[ui]\nsidebar = { agents = {} }\n', 'x = """text\ntext"""\n', "x = '''text'''\n",
		'[[ui.sidebar.agents]]\n', header + '\npi = [\n["agent"]\n]\n',
		'[ui]\n[ui]\n', '[ui]\nx = 1\nx = 2\n', 'x = [1,\n2]\n',
		'x = "unterminated\n', 'x = @invalid\n', '# one\r\n# two\n',
		'[ui.sidebar.agents]\nrows_by_agent = []\n', header + '.pi]\n',
		'[ui.sidebar.agents.rows_by_agent.pi]\nx = 1\n',
		'ui = 1\n[ui.sidebar]\n', '[ui.sidebar]\n[ui]\nsidebar = 1\n',
	]) rejected(text, 'Unsupported or ambiguous TOML; no changes proposed.');
});

test("basic strings reject surrogate escapes and raw DEL but keep scalar escapes", () => {
	for (const text of ['x = "\\uD800"\n', 'x = "\\udfff"\n', 'x = "a\x7fb"\n', 'x = ["ok", "\\uDBFF"]\n']) {
		rejected(text, 'Unsupported or ambiguous TOML; no changes proposed.');
		rejected(text + enabled('').text, 'Unsupported or ambiguous TOML; no changes proposed.');
	}
	for (const text of ['x = "\\uD7FF"\n', 'x = "\\uE000"\n', 'x = "\\u00e9\\t"\n']) {
		assert.equal(enabled(text).changed, true);
	}
});

// Each fixture is valid TOML on its own, but defines a value where the
// generated table would require a table ancestor (or the table itself).
for (const [ancestor, text] of [
	['ui', 'ui = true\n'],
	['ui.sidebar', '[ui]\nsidebar = []\n'],
	['ui.sidebar.agents', '[ui.sidebar]\nagents = []\n'],
	['ui.sidebar.agents.rows_by_agent', '[ui.sidebar.agents]\nrows_by_agent = []\n'],
]) {
	test(`generated table rejects value ancestor ${ancestor} without a proposal`, () => {
		rejected(text, 'Unsupported or ambiguous TOML; no changes proposed.');
	});
}

test("legal table ancestors and sibling values still plan and restore exact bytes", () => {
	for (const text of [
		'[ui]\nvisible = true\n',
		'[ui.sidebar]\nwidth = 42\n',
		'[ui.sidebar.agents]\nvisible = true\n',
		'[ui]\nvisible = true\n[ui.sidebar]\nwidth = 42\n[ui.sidebar.agents]\nvisible = true\n',
		'[ui.sidebar.sibling]\nvalue = []\n',
		header + '\nclaude = [["agent"]] # non-Pi\n',
	]) {
		const result = enabled(text);
		assert.equal(result.changed, true);
		assert.deepEqual(plan(result.text, options), { ok: true, changed: false, text: result.text });
		assert.deepEqual(plan(result.text, { ...options, enabled: false }), { ok: true, changed: true, text });
	}
});

test("owned created block cannot bypass prospective ancestor conflicts", () => {
	const owned = enabled('').text;
	for (const prefix of ['ui = true\n', '[ui]\nsidebar = []\n', '[ui.sidebar]\nagents = []\n', '[ui.sidebar.agents]\nrows_by_agent = []\n']) {
		rejected(prefix + owned, 'Unsupported or ambiguous TOML; no changes proposed.');
	}
});

test("manually changed, duplicated or forged owned blocks are never overwritten", () => {
	const original = enabled('').text;
	for (const text of [original.replace('"agent"', '"custom"'), original.replace('#123456', 'accent'), original.replace('#123456', '#654321'), original + original,
		original.replace('end v1', 'end v2'), original.replace('created join=0', 'existing join=0'),
		original.replace('pi =', '# comment\npi ='), original + 'claude = [["agent"]]\n']) {
		rejected(text, 'Owned task summary block was changed or is ambiguous; no changes proposed.');
		assert.deepEqual(plan(text, { ...options, enabled: false }), { ok: false, error: 'Owned task summary block was changed or is ambiguous; no changes proposed.' });
	}
});

test("an unchanged owned block moved away from its planned boundary is never adopted", () => {
	const created = enabled('').text;
	const table = header + '\n[other]\nvalue = 1\n';
	const existing = enabled(table).text;
	const existingBlock = existing.slice(existing.indexOf('# Gentle Shell'), existing.indexOf('[other]'));
	const joined = enabled('# note').text;
	const joinedBlock = joined.slice('# note'.length);
	for (const text of [
		created + '# note\n',
		'# note\n' + created + '# after\n',
		table + existingBlock,
		existingBlock + table,
		'# note\n' + joinedBlock,
		joinedBlock,
		'# note' + joinedBlock + '# after\n',
	]) {
		rejected(text, 'Owned task summary block was changed or is ambiguous; no changes proposed.');
		assert.deepEqual(plan(text, { ...options, enabled: false }), { ok: false, error: 'Owned task summary block was changed or is ambiguous; no changes proposed.' });
	}
});
