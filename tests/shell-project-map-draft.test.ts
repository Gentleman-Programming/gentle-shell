import assert from "node:assert/strict";
import test from "node:test";
import {
	PROJECT_MAP_ARTIFACT_PATH,
	PROJECT_MAP_SCHEMA_V1,
	serializeProjectMap,
	validateProjectMap,
} from "../lib/shell-project-map-schema.ts";
import {
	collectProjectMapSteps,
	deriveProjectMap,
	generateProjectMapDraft,
	projectMapSourceChanges,
	normalizeIdentifier,
} from "../lib/shell-project-map-draft.ts";
import { readCapabilityDescription } from "../lib/project-map-description.ts";

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: "example-shop",
		description: "An example shop.",
		scripts: { test: "node --test tests/*.test.ts" },
		...overrides,
	};
}

function joined(values: string[]): string {
	return values.join("\n");
}

function sources(text: string) {
	return {
		packageJson: manifest(),
		oddTaskDocuments: [{ path: "odd/tasks/roadmap.md", text }],
	};
}

test("work-unit prefix: T rows become capabilities and continuations remain steps", () => {
	const input = sources('- **Work unit prefix:** `T`\n- [ ] **T1 — First**\n- [x] **T2 — Second**\n- [ ] **T1b — Letter**\n- [ ] **T1.2 — Dot**\n- [ ] **TR-1 — Other**');
	for (const result of [generateProjectMapDraft(input), deriveProjectMap(input, "example")]) {
		assert.deepEqual(result.map?.capabilities.map((row) => row.outcome), ["T1 — First", "T2 — Second"]);
	}
	assert.match(joined(generateProjectMapDraft(input).assumptions), /3 work units.*"T"/);
	assert.deepEqual(collectProjectMapSteps(input.oddTaskDocuments, "T1").map((step) => step.code), ["T1b", "T1.2"]);
});

test("work-unit prefix: resolves different literals per document", () => {
	const input = { packageJson: manifest(), oddTaskDocuments: [
		{ path: "odd/tasks/a.md", text: '- [ ] **T1 — First**\n  + **Work unit prefix:** `T`' },
		{ path: "odd/tasks/b.md", text: '**Work unit prefix:** `HOR-`\n- [ ] **HOR-01 — Second**\n- [ ] **T2 — Not a row**' },
	] };
	for (const result of [generateProjectMapDraft(input), deriveProjectMap(input, "example")]) {
		assert.deepEqual(result.map?.capabilities.map((row) => row.outcome), ["T1 — First", "HOR-01 — Second"]);
	}
	assert.match(joined(generateProjectMapDraft(input).assumptions), /"T".*"HOR-"/);
});

test("work-unit prefix: unreadable declarations report the document and retain the default", () => {
	for (const declaration of ["T", "`T` `HOR-`", "``", "`T T`", "`T\tT`", "`T```"]) {
		const input = sources(`**Work unit prefix:** ${declaration}\n- [ ] **FP-1 — Default**\n- [ ] **T1 — Not a row**`);
		for (const result of [generateProjectMapDraft(input), deriveProjectMap(input, "example")]) {
			assert.deepEqual(result.map?.capabilities.map((row) => row.outcome), ["FP-1 — Default"]);
			assert.match(joined(result.omissions), /odd\/tasks\/roadmap\.md.*unreadable \*\*Work unit prefix:\*\*/);
		}
	}
});

test("work-unit prefix: first readable declaration wins and duplicates are reported", () => {
	const input = sources('**Work unit prefix:** missing\n**Work unit prefix:** `T`\n**Work unit prefix:** `HOR-`\n**Work unit prefix:** `T`\n**Work unit prefix:** ``\n- [ ] **T1 — First**\n- [ ] **HOR-01 — Not a row**');
	for (const result of [generateProjectMapDraft(input), deriveProjectMap(input, "example")]) {
		assert.deepEqual(result.map?.capabilities.map((row) => row.outcome), ["T1 — First"]);
		assert.equal(result.omissions.filter((line) => /unreadable \*\*Work unit prefix:\*\*/.test(line)).length, 2);
		assert.equal(result.omissions.filter((line) => /duplicate \*\*Work unit prefix:\*\*/.test(line)).length, 2);
		assert.ok(result.omissions.filter((line) => /\*\*Work unit prefix:\*\*/.test(line)).every((line) => line.includes("odd/tasks/roadmap.md")));
	}
});

test("work-unit prefix: absent declaration keeps FP-", () => {
	const input = sources('- [ ] **FP-1 — Default**\n- [ ] **T1 — Not a row**');
	for (const result of [generateProjectMapDraft(input), deriveProjectMap(input, "example")]) {
		assert.deepEqual(result.map?.capabilities.map((row) => row.outcome), ["FP-1 — Default"]);
		assert.ok(!joined(result.omissions).includes("**Work unit prefix:**"));
	}
});

test("derives project identity and the repository foundation from a manifest", () => {
	const result = generateProjectMapDraft({ packageJson: manifest() });
	assert.ok(result.map);
	assert.equal(result.map.version, PROJECT_MAP_SCHEMA_V1);
	assert.deepEqual(result.map.project, { id: "example-shop", name: "example-shop" });
	const foundation = result.map.foundations.find((entry) => entry.id === "repository-tooling");
	assert.ok(foundation);
	assert.equal(foundation.state, "done");
	assert.deepEqual(foundation.evidence, ["package.json"]);
});

test("normalizes a scoped package name into an identifier", () => {
	const result = generateProjectMapDraft({ packageJson: manifest({ name: "@gentleman-programming/Gentle_Pi" }) });
	assert.ok(result.map);
	assert.equal(result.map.project.id, "gentle-pi");
	assert.equal(result.map.project.name, "@gentleman-programming/Gentle_Pi");
});

test("returns no map and an omission when the manifest has no usable name", () => {
	for (const packageJson of [undefined, {}, { name: "   " }, { name: "!!!" }, { name: "a".repeat(70) }, { name: 42 }]) {
		const result = generateProjectMapDraft({ packageJson });
		assert.equal(result.map, null);
		assert.ok(joined(result.omissions).includes("package.json"), `expected a package.json omission for ${JSON.stringify(packageJson)}`);
	}
});

test("marks a foundation done only when its source carries a well-formed declaration", () => {
	const declared = generateProjectMapDraft({ packageJson: manifest() });
	assert.equal(declared.map?.foundations.find((entry) => entry.id === "repository-tooling")?.state, "done");

	for (const scripts of [undefined, {}, "test", []]) {
		const undeclared = generateProjectMapDraft({ packageJson: manifest({ scripts }) });
		const foundation = undeclared.map?.foundations.find((entry) => entry.id === "repository-tooling");
		assert.equal(foundation?.state, "planned", `expected planned for scripts ${JSON.stringify(scripts)}`);
		assert.equal(foundation?.evidence, undefined);
	}
});

test("derives the quality gates foundation from a declared test command", () => {
	const declared = generateProjectMapDraft({ packageJson: manifest() });
	const foundation = declared.map?.foundations.find((entry) => entry.id === "quality-gates");
	assert.ok(foundation);
	assert.equal(foundation.state, "done");
	assert.deepEqual(foundation.evidence, ["package.json"]);

	const absent = generateProjectMapDraft({ packageJson: manifest({ scripts: {} }) });
	assert.equal(absent.map?.foundations.find((entry) => entry.id === "quality-gates")?.state, "planned");
});

test("produces no capabilities and reports the gap", () => {
	const result = generateProjectMapDraft({ packageJson: manifest() });
	assert.ok(result.map);
	assert.deepEqual(result.map.capabilities, []);
	assert.ok(joined(result.omissions).toLowerCase().includes("capabilit"));
});

test("always produces a draft map that is never approved", () => {
	const result = generateProjectMapDraft({ packageJson: manifest() });
	assert.deepEqual(result.map?.approval, { state: "draft" });
	assert.ok(joined(result.assumptions).includes("draft"));
});

test("records every absent source as an omission", () => {
	const result = generateProjectMapDraft({});
	assert.equal(result.map, null);
	const omissions = joined(result.omissions);
	assert.ok(omissions.includes("package.json"));
});

test("is deterministic regardless of input key order", () => {
	const first = generateProjectMapDraft({ packageJson: manifest() });
	const second = generateProjectMapDraft({
		packageJson: { scripts: { test: "node --test tests/*.test.ts" }, description: "An example shop.", name: "example-shop" },
	});
	assert.ok(first.map);
	assert.ok(second.map);
	assert.equal(serializeProjectMap(first.map), serializeProjectMap(second.map));
	assert.deepEqual(first.assumptions, second.assumptions);
	assert.deepEqual(first.omissions, second.omissions);
});

test("never throws on malformed input", () => {
	for (const sources of [
		{},
		{ packageJson: null },
		{ packageJson: [] },
		{ packageJson: "text" },
		{ packageJson: manifest({ scripts: 42 }) },
		{ packageJson: manifest({ scripts: "\u0000\n\t" }) },
	]) {
		assert.doesNotThrow(() => generateProjectMapDraft(sources));
	}
});

test("produces a draft that the schema validates with no diagnostics", () => {
	const result = generateProjectMapDraft({ packageJson: manifest() });
	assert.ok(result.map);
	const validated = validateProjectMap(result.map);
	assert.deepEqual(validated.diagnostics, []);
	assert.deepEqual(validated.map, result.map);
});

test("documents the artifact path it is meant to fill", () => {
	assert.equal(PROJECT_MAP_ARTIFACT_PATH, "openspec/project-map.json");
});

const roadmap = [
	"# Project Map Orchestration",
	"",
	"## Outcome",
	"Make the whole product visible from the shell.",
	"",
	"## Work units",
	"",
	"- [x] **FP-1 — Define and validate the versioned Project Map**",
	"  - Specify capability identifiers and outcomes.",
	"- [ ] **FP-2 — Add draft generation and human plan approval**",
	"  - Persist explicit draft and approved transitions.",
	"",
].join("\n");

const unitDocument = [
	"# PM-3 — Render the real map",
	"",
	"## Tasks",
	"",
	"- [ ] **FP-3-1 — Replace static demo data**",
	"- [x] **FP-3-2 — Preserve the card order**",
	"",
].join("\n");

test("extracts work units with their declared completion state", () => {
	const result = generateProjectMapDraft({ packageJson: manifest(), oddTaskDocuments: [{ path: "odd/tasks/roadmap.md", text: roadmap }] });
	assert.ok(result.map);
	const byId = new Map(result.map.capabilities.map((capability) => [capability.id, capability]));
	assert.equal(byId.get("define-and-validate-the-versioned-project-map")?.state, "done");
	assert.equal(byId.get("add-draft-generation-and-human-plan-approval")?.state, "planned");
});

test("points every capability at the document that declared it", () => {
	const result = generateProjectMapDraft({ packageJson: manifest(), oddTaskDocuments: [{ path: "odd/tasks/roadmap.md", text: roadmap }] });
	assert.ok(result.map);
	for (const capability of result.map.capabilities) {
		assert.deepEqual(capability.featureDocs, ["odd/tasks/roadmap.md"]);
	}
});

test("keeps the written work-unit label as the outcome and leaves surfaces undetermined", () => {
	const result = generateProjectMapDraft({ packageJson: manifest(), oddTaskDocuments: [{ path: "odd/tasks/roadmap.md", text: roadmap }] });
	const capability = result.map?.capabilities.find((entry) => entry.id === "add-draft-generation-and-human-plan-approval");
	assert.equal(capability?.outcome, "FP-2 — Add draft generation and human plan approval");
	assert.deepEqual(capability?.surfaces, []);
	assert.deepEqual(capability?.foundationRefs, []);
});

test("reads work units from several documents in a stable order", () => {
	const first = generateProjectMapDraft({
		packageJson: manifest(),
		oddTaskDocuments: [
			{ path: "odd/tasks/zulu.md", text: unitDocument },
			{ path: "odd/tasks/roadmap.md", text: roadmap },
		],
	});
	const second = generateProjectMapDraft({
		packageJson: manifest(),
		oddTaskDocuments: [
			{ path: "odd/tasks/roadmap.md", text: roadmap },
			{ path: "odd/tasks/zulu.md", text: unitDocument },
		],
	});
	assert.ok(first.map);
	assert.ok(second.map);
	assert.equal(serializeProjectMap(first.map), serializeProjectMap(second.map));
	assert.ok(first.map.capabilities.some((capability) => capability.id === "replace-static-demo-data"));
	assert.ok(first.map.capabilities.some((capability) => capability.id === "preserve-the-card-order"));
});

test("deduplicates cross-document capability identifiers and names both source lines", () => {
	const firstLine = "- [ ] **FP-9 — Shared title**";
	const secondLine = "- [ ] **FP-8 — Shared title**";
	const result = generateProjectMapDraft({
		packageJson: manifest(),
		oddTaskDocuments: [
			{ path: "odd/tasks/a.md", text: `${firstLine}\n` },
			{ path: "odd/tasks/b.md", text: `${secondLine}\n` },
		],
	});
	assert.ok(result.map);
	assert.equal(result.map.capabilities.filter((capability) => capability.id === "shared-title").length, 1);
	assert.equal(result.map.capabilities[0].featureDocs[0], "odd/tasks/a.md");
	const omissions = joined(result.omissions);
	assert.ok(omissions.includes("shared-title"));
	assert.ok(omissions.includes("odd/tasks/a.md"));
	assert.ok(omissions.includes("odd/tasks/b.md"));
	assert.ok(omissions.includes(firstLine));
	assert.ok(omissions.includes(secondLine));
});

test("deduplicates a capability declared twice in one document and names both source lines", () => {
	const firstLine = "- [ ] **FP-9 — Shared title**";
	const secondLine = "- [ ] **FP-8 — Shared title**";
	const result = generateProjectMapDraft(sources(`${firstLine}\n${secondLine}\n`));
	assert.equal(result.map?.capabilities.filter((capability) => capability.id === "shared-title").length, 1);
	const omissions = joined(result.omissions);
	assert.ok(omissions.includes("declared twice in odd/tasks/roadmap.md"));
	assert.ok(omissions.includes(firstLine));
	assert.ok(omissions.includes(secondLine));
});

test("reports a document that yields no work units as an omission", () => {
	const result = generateProjectMapDraft({ packageJson: manifest(), oddTaskDocuments: [{ path: "odd/tasks/prose.md", text: "# Just prose\n\nNo units here.\n" }] });
	assert.ok(result.map);
	assert.deepEqual(result.map.capabilities, []);
	assert.ok(joined(result.omissions).includes("odd/tasks/prose.md"));
});

test("ignores prose and checklists that are not work units", () => {
	const result = generateProjectMapDraft({
		packageJson: manifest(),
		oddTaskDocuments: [{ path: "odd/tasks/mixed.md", text: "- [ ] a plain checklist item\n- [x] another one\n- [ ] **FP-1 — Real unit**\n" }],
	});
	assert.ok(result.map);
	assert.deepEqual(result.map.capabilities.map((capability) => capability.id), ["real-unit"]);
});

test("reports an invalid work-unit title with its source line", () => {
	for (const line of ["- [ ] **FP-1 — !!!**", "- [ ] **FP — !!!** trailing"]) {
		const result = generateProjectMapDraft({ packageJson: manifest(), oddTaskDocuments: [{ path: "odd/tasks/odd.md", text: `${line}\n` }] });
		assert.ok(result.map);
		assert.deepEqual(result.map.capabilities, []);
		assert.ok(joined(result.omissions).includes("odd/tasks/odd.md"));
		assert.ok(joined(result.omissions).includes(line));
	}
});

test("never throws on malformed document entries", () => {
	for (const oddTaskDocuments of [
		[{ path: "odd/tasks/a.md", text: null as unknown as string }],
		[{ path: 42 as unknown as string, text: roadmap }],
		[{ path: "", text: roadmap }],
		[null as unknown as { path: string; text: string }],
		"not an array" as unknown as { path: string; text: string }[],
	]) {
		assert.doesNotThrow(() => generateProjectMapDraft({ oddTaskDocuments }));
	}
});

test("produces extracted capabilities that the schema accepts as a draft", () => {
	const result = generateProjectMapDraft({
		packageJson: manifest(),
		oddTaskDocuments: [{ path: "odd/tasks/roadmap.md", text: roadmap }],
	});
	assert.ok(result.map);
	assert.ok(result.map.capabilities.length > 0);
	const validated = validateProjectMap(result.map);
	assert.deepEqual(validated.diagnostics, []);
	assert.deepEqual(validated.map, result.map);
});

test("reads the quality gate from the package manifest test script", () => {
	const result = generateProjectMapDraft({ packageJson: manifest({ scripts: { test: "pnpm test" } }) });
	assert.equal(result.map?.foundations.find((entry) => entry.id === "quality-gates")?.state, "done");
	assert.ok(!joined(result.omissions).includes("declares no usable scripts.test"));
});

test("requires a usable script command, not merely a key", () => {
	for (const scripts of [{ test: 42 }, { test: null }, { test: "   " }, { test: {} }]) {
		const result = generateProjectMapDraft({ packageJson: manifest({ scripts }) });
		assert.equal(
			result.map?.foundations.find((entry) => entry.id === "repository-tooling")?.state,
			"planned",
			`expected planned for scripts ${JSON.stringify(scripts)}`,
		);
	}
	const usable = generateProjectMapDraft({ packageJson: manifest({ scripts: { test: "pnpm test", lint: 42 } }) });
	assert.equal(usable.map?.foundations.find((entry) => entry.id === "repository-tooling")?.state, "done");
});

test("skips a document whose path is not repository-relative", () => {
	const result = generateProjectMapDraft({
		packageJson: manifest(),
		oddTaskDocuments: [
			{ path: "/etc/absolute.md", text: "- [ ] **FP-1 — Absolute**\n" },
			{ path: "../outside.md", text: "- [ ] **FP-2 — Outside**\n" },
			{ path: "C:drive.md", text: "- [ ] **FP-3 — Drive**\n" },
			{ path: "odd/tasks/inside.md", text: "- [ ] **FP-4 — Inside**\n" },
		],
	});
	assert.ok(result.map);
	assert.deepEqual(result.map.capabilities.map((capability) => capability.id), ["inside"]);
	const omissions = joined(result.omissions);
	assert.ok(omissions.includes("/etc/absolute.md"));
	assert.ok(omissions.includes("../outside.md"));
	assert.ok(omissions.includes("C:drive.md"));
});

test("produces a draft that the schema accepts even when a document is skipped", () => {
	const result = generateProjectMapDraft({
		packageJson: manifest(),
		oddTaskDocuments: [{ path: "odd/tasks/inside.md", text: "- [ ] **FP-4 — Inside**\n" }],
	});
	assert.ok(result.map);
	assert.deepEqual(validateProjectMap(result.map).diagnostics, []);
});

test("reads a work unit that carries text after its closing bold label", () => {
	const result = generateProjectMapDraft(sources("- [ ] **FP-1 — Provisioning** (blocked on accounts): the projects\n"));
	assert.deepEqual(result.map?.capabilities, [
		{
			id: "provisioning",
			outcome: "FP-1 — Provisioning",
			foundationRefs: [],
			dependsOn: [],
			contracts: [],
			featureDocs: ["odd/tasks/roadmap.md"],
			surfaces: [],
			state: "planned",
		},
	]);
	assert.ok(!joined(result.omissions).includes("Provisioning"));
});

test("maps an active work-unit marker to active and keeps it explainable", () => {
	const documentText = "- [~] **FP-6 — Merchant order notification**\n  Notify merchants when an order arrives.\n";
	const result = generateProjectMapDraft(sources(documentText));
	const capability = result.map?.capabilities[0];
	assert.equal(capability?.state, "active");
	assert.deepEqual(readCapabilityDescription(documentText, capability?.id ?? ""), {
		title: "Merchant order notification",
		lines: ["Notify merchants when an order arrives."],
	});
});

test("keeps the whole written label as the outcome while the id uses its title", () => {
	const result = generateProjectMapDraft(sources("- [x] **FP-2 — Add draft generation** — **delivered**: notes\n"));
	assert.deepEqual(result.map?.capabilities[0], {
		id: "add-draft-generation",
		outcome: "FP-2 — Add draft generation",
		foundationRefs: [],
		dependsOn: [],
		contracts: [],
		featureDocs: ["odd/tasks/roadmap.md"],
		surfaces: [],
		state: "done",
	});
});

test("truncates a long work-unit title while its description still resolves", () => {
	const documentText = "- [ ] **FP-0 — Local dev service-worker freshness (small, found by the prototype acceptance)**\n  The browser keeps the service worker current.\n";
	const result = generateProjectMapDraft(sources(documentText));
	const capability = result.map?.capabilities[0];
	assert.ok(capability);
	assert.ok(capability.id.length <= 64);
	assert.deepEqual(validateProjectMap(result.map).diagnostics, []);
	assert.ok(!joined(result.omissions).includes("cannot be normalized"));
	assert.deepEqual(readCapabilityDescription(documentText, capability.id), {
		title: "Local dev service-worker freshness (small, found by the prototype acceptance)",
		lines: ["The browser keeps the service worker current."],
	});
});

test("reports unreadable top-level work units instead of silently dropping them", () => {
	for (const line of ["- [-] **Something unreadable**", "- [] **Empty marker**"]) {
		const result = generateProjectMapDraft(sources(`${line}\n`));
		assert.deepEqual(result.map?.capabilities, []);
		assert.ok(joined(result.omissions).includes("odd/tasks/roadmap.md"));
		assert.ok(joined(result.omissions).includes(line));
	}
});

test("reads runs of whitespace around a work-unit marker", () => {
	const result = generateProjectMapDraft(sources("-  [ ] **FP-1 — X**\n-\t[ ] **FP-2 — Tab**\n- [ ]  **FP-5 — Two spaces**\n"));
	assert.deepEqual(result.map?.capabilities.map((capability) => capability.id), ["tab", "two-spaces", "x"]);
	assert.equal(result.map?.capabilities[1]?.outcome, "FP-5 — Two spaces");
});

test("normalizes long identifiers with the documented fallback boundaries", () => {
	assert.equal(normalizeIdentifier("a".repeat(64)), "a".repeat(64));
	assert.equal(normalizeIdentifier("a".repeat(65)), "a".repeat(64));
	assert.equal(normalizeIdentifier(`a-${"b".repeat(62)}`), `a-${"b".repeat(62)}`);
	const fallback = normalizeIdentifier(`a-${"b".repeat(63)}`);
	assert.ok(fallback);
	assert.ok(fallback.length > 1);
	assert.ok(fallback.length <= 64);
	assert.match(fallback, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
});

test("never returns an identifier that a hard cut left ending in a separator", () => {
	// The 64th character of this normalization is the hyphen, so the fallback cut would end in it.
	const boundary = `${"b".repeat(63)} - c`;
	const id = normalizeIdentifier(boundary);
	assert.ok(id);
	assert.ok(id.length <= 64);
	assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
	assert.ok(!id.endsWith("-"));
});

test("does not read an indented work unit", () => {
	const result = generateProjectMapDraft(sources("  - [ ] **Nested unit**\n"));
	assert.deepEqual(result.map?.capabilities, []);
});

test("keeps a plain work unit working", () => {
	const result = generateProjectMapDraft(sources("- [ ] **FP-1 — Do the thing**\n"));
	assert.equal(result.map?.capabilities[0]?.outcome, "FP-1 — Do the thing");
	assert.equal(result.map?.capabilities[0]?.id, "do-the-thing");
});

test("documents that bold text inside a label stops at the first closing emphasis", () => {
	const result = generateProjectMapDraft(sources("- [ ] **FP-1 — Add **dual** support**\n"));
	assert.equal(result.map?.capabilities[0]?.outcome, "FP-1 — Add");
	assert.equal(result.map?.capabilities[0]?.id, "add");
});

test("keeps every supplied ODD task document as a source under the fixed FP convention", () => {
	const result = generateProjectMapDraft({
		packageJson: manifest(),
		oddTaskDocuments: [
			{ path: "odd/tasks/one.md", text: "- [ ] **FP-1 — First capability**\n" },
			{ path: "odd/tasks/two.md", text: "- [ ] **FP-2 — Second capability**\n" },
		],
	});
	assert.deepEqual(result.map?.capabilities.map((capability) => capability.id), ["first-capability", "second-capability"]);
	assert.ok(joined(result.assumptions).includes('resolved prefix ("FP-")'));
});

test("derives surfaces from only backticked declared paths using the longest matching prefix", () => {
	const result = generateProjectMapDraft({
		packageJson: manifest(),
		oddTaskDocuments: [{
			path: "odd/tasks/roadmap.md",
			text: [
				"- [ ] **FP-1 — Catalog**",
				"  **Allowed edit surfaces:** prose packages/ignored and `database/query.ts` plus `web/page.ts`.",
				"",
			].join("\n"),
		}],
	});
	assert.deepEqual(result.map?.capabilities[0]?.surfaces, ["web", "data"]);
	assert.equal(result.omissions.some((omission) => omission.includes("packages/ignored")), false);
});

test("reports all unmatched declared paths in one omission per capability", () => {
	const result = generateProjectMapDraft({
		packageJson: manifest(),
		oddTaskDocuments: [{
			path: "odd/tasks/roadmap.md",
			text: [
				"- [ ] **FP-1 — Catalog**",
				"  **Allowed edit surfaces:** `packages/catalog/` and `docs/catalog.md`.",
				"",
			].join("\n"),
		}],
	});
	const unmatched = result.omissions.filter((omission) => omission.includes("matched no canonical surface prefix"));
	assert.deepEqual(unmatched, [
		"The capability \"catalog\" declared by odd/tasks/roadmap.md has paths that matched no canonical surface prefix: packages/catalog/, docs/catalog.md.",
	]);
});

test("keeps surfaces empty when a capability or its document declares no allowed-edit-surfaces line", () => {
	const result = generateProjectMapDraft({
		packageJson: manifest(),
		oddTaskDocuments: [
			{ path: "odd/tasks/one.md", text: "- [ ] **FP-1 — No line**\n  Body only.\n" },
			{ path: "odd/tasks/two.md", text: "- [ ] **FP-2 — Another no line**\n" },
		],
	});
	assert.deepEqual(result.map?.capabilities.map((capability) => capability.surfaces), [[], []]);
	assert.equal(result.omissions.some((omission) => omission.includes("matched no canonical surface prefix")), false);
});

test("derives declared web surfaces through the canonical table without configuration", () => {
	const mapped = generateProjectMapDraft(sources("- [ ] **FP-1 — Catalog**\n  **Allowed edit surfaces:** `web/page.ts`\n"));
	assert.deepEqual(mapped.map?.capabilities[0]?.surfaces, ["web"]);
	assert.ok(joined(mapped.assumptions).includes("capability's own declared edit surfaces through the canonical surface table"));
	assert.equal(joined(mapped.assumptions).includes("leaves its surface list empty"), false);
	const unmapped = generateProjectMapDraft(sources("- [ ] **FP-1 — Catalog**\n  **Allowed edit surfaces:** `apps/web/page.ts`\n"));
	assert.deepEqual(unmapped.map?.capabilities[0]?.surfaces, []);
	assert.ok(joined(unmapped.assumptions).includes("a capability without that line remains undeclared"));
	assert.equal(joined(unmapped.omissions).includes("matched no canonical surface prefix"), true);
});

for (const [entry, expected] of [
	["web: `apps/web/**`", ["web"]],
	["tests: `apps/web/page.test.ts`", ["tests"]],
	["tests: `web/page.test.ts`", ["tests"]],
	["`web/one.ts`", ["web"]],
	["web: `a.ts`, `api/b.ts`", ["web"]],
	["`api/first.ts`, web: `a.ts`, `b.ts`", ["web", "api"]],
	["mobile:web: `web/one.ts`", ["web"]],
	["web: `apps/web/**`, `apps/web/lib/**`, api: `apps/api/catalog.ts`", ["web", "api"]],
] as const) {
	test(`explicit surface grammar: ${entry}`, () => {
		const result = generateProjectMapDraft(sources(`- [ ] **FP-1 — Catalog**\n  **Allowed edit surfaces:** ${entry}\n`));
		assert.deepEqual(result.map?.capabilities[0]?.surfaces, expected);
		const surfaceOmissions = result.omissions.filter((line) => line.includes("canonical surface"));
		assert.deepEqual(surfaceOmissions, []);
	});
}

for (const [entry, expected, omittedPaths] of [
	["mobile: `a.ts`, `b.ts`", [], ["a.ts", "b.ts"]],
	["mobile: `a.ts`, `web/b.ts`", [], ["a.ts", "web/b.ts"]],
	["mobile: `a.ts`, web: `web/b.ts`, `c.ts`", ["web"], ["a.ts"]],
] as const) {
	test(`explicit surface grammar poisoned group: ${entry}`, () => {
		const input = sources(`- [ ] **FP-1 — Catalog**\n  **Allowed edit surfaces:** ${entry}\n`);
		for (const result of [generateProjectMapDraft(input), deriveProjectMap(input, "example-shop")]) {
			assert.deepEqual(result.map?.capabilities[0]?.surfaces, expected);
			assert.deepEqual(result.omissions.filter((line) => line.includes("canonical surface")), omittedPaths.map((path) =>
				`The capability "catalog" declared by odd/tasks/roadmap.md has an unknown canonical surface name "mobile" for declared path: ${path}.`));
		}
	});
}

test("keeps poisoned surface groups local to their work unit", () => {
	// Regression guard, not TDD: group state is already local to each derivation,
	// so no failing RED run is possible for this existing property.
	const input = sources([
		"- [ ] **FP-1 — Poisoned**",
		"  **Allowed edit surfaces:** mobile: `web/one.ts`, `api/two.ts`",
		"- [ ] **FP-2 — Undeclared**",
		"  Body only.",
	].join("\n"));
	for (const result of [generateProjectMapDraft(input), deriveProjectMap(input, "example-shop")]) {
		assert.deepEqual(result.map?.capabilities.find((row) => row.id === "poisoned")?.surfaces, []);
		assert.deepEqual(result.map?.capabilities.find((row) => row.id === "undeclared")?.surfaces, []);
		assert.deepEqual(result.omissions.filter((line) => line.includes("canonical surface")), [
			'The capability "poisoned" declared by odd/tasks/roadmap.md has an unknown canonical surface name "mobile" for declared path: web/one.ts.',
			'The capability "poisoned" declared by odd/tasks/roadmap.md has an unknown canonical surface name "mobile" for declared path: api/two.ts.',
		]);
		assert.equal(result.omissions.some((line) => line.includes('"undeclared"')), false);
	}
});

for (const name of ["mobile", "Web", "productux"]) {
	test(`explicit surface grammar rejects unknown name ${name} without table fallback`, () => {
		const result = generateProjectMapDraft(sources(`- [ ] **FP-1 — Catalog**\n  **Allowed edit surfaces:** ${name}: \`web/one.ts\`\n`));
		assert.deepEqual(result.map?.capabilities[0]?.surfaces, []);
		assert.deepEqual(result.omissions.filter((line) => line.includes("canonical surface")), [
			`The capability "catalog" declared by odd/tasks/roadmap.md has an unknown canonical surface name "${name}" for declared path: web/one.ts.`,
		]);
	});
}

test("derives camel-cased productUx from either declaration marker colon form", () => {
	for (const marker of ["**Allowed edit surfaces:**", "**Allowed edit surfaces**:"]) {
		const result = generateProjectMapDraft(sources(`- [ ] **FP-1 — Catalog**\n  ${marker} \`ui/menu.ts\`\n`));
		assert.deepEqual(result.map?.capabilities[0]?.surfaces, ["productUx"]);
		assert.equal(result.omissions.some((omission) => omission.includes("matched no canonical surface prefix")), false);
	}
});

test("a fully mapped API document declaration produces no surface omission", () => {
	const generated = generateProjectMapDraft(sources("- [ ] **FP-1 — Catalog**\n  **Allowed edit surfaces:** `api/catalog.ts`\n"));
	assert.deepEqual(generated.map?.capabilities[0]?.surfaces, ["api"]);
	assert.equal(generated.omissions.some((omission) => omission.includes("matched no canonical surface prefix")), false);
});

test("canonical table gap: apps/web/page.ts is named, never guessed, alongside a mapped declaration", () => {
	// An unprefixed monorepo path stays a gap; explicit names do not extend the table.
	const result = generateProjectMapDraft(sources("- [ ] **FP-1 — Gap**\n  **Allowed edit surfaces:** `apps/web/page.ts`\n- [ ] **FP-2 — Canonical**\n  **Allowed edit surfaces:** `web/page.ts`\n"));
	assert.deepEqual(result.map?.capabilities.find((row) => row.id === "gap")?.surfaces, []);
	assert.deepEqual(result.map?.capabilities.find((row) => row.id === "canonical")?.surfaces, ["web"]);
	assert.deepEqual(result.omissions.filter((line) => line.includes("matched no canonical surface prefix")), [
		'The capability "gap" declared by odd/tasks/roadmap.md has paths that matched no canonical surface prefix: apps/web/page.ts.',
	]);
});

const delegableUnits = [
	"- [ ] **FP-0 — Foundation**",
	"- [ ] **FP-1b — Provisioning**",
	"- [ ] **FP-2 — Catalogue**",
	"- [ ] **FP-1b.0 — Provisioning preparation**",
	"- [ ] **FP-1b.8 — Provisioning close**",
	"- [ ] **DEL-1 — Delivery step**",
	"- [ ] **OF-2 — Operations step**",
	"- [ ] **ODD-3 — ODD step**",
	"- [ ] **T1 — Test step**",
	"- [ ] **A plain label with no code**",
	"",
].join("\n");

function delegableSources() {
	return {
		packageJson: manifest(),
		oddTaskDocuments: [{ path: "odd/tasks/roadmap.md", text: delegableUnits }],
	};
}

test("keeps only numbered, undotted convention codes as capability sources with or without a roadmap", () => {
	const noRoadmap = generateProjectMapDraft(delegableSources());
	const withRoadmap = generateProjectMapDraft({ ...delegableSources(), oddTaskDocuments: [{ path: "odd/tasks/other.md", text: delegableUnits }] });
	for (const result of [noRoadmap, withRoadmap]) {
		assert.deepEqual(result.map?.capabilities.map((capability) => capability.outcome), [
			"FP-2 — Catalogue",
			"FP-0 — Foundation",
		]);
		assert.equal(result.omissions.some((omission) => omission.includes("FP-1b") || omission.includes("FP-1b.0") || omission.includes("FP-1b.8") || omission.includes("DEL-1") || omission.includes("OF-2") || omission.includes("ODD-3") || omission.includes("T1") || omission.includes("plain label")), false);
		assert.equal(result.assumptions.filter((assumption) => assumption.includes("read as steps instead of capabilities")).length, 1);
		assert.ok(joined(result.assumptions).includes("8 work units were read as steps instead of capabilities"));
	}
});

test("makes row and sub-element rules disjoint", () => {
	const documents = [{
		path: "odd/tasks/disjoint.md",
		text: [
			"- [ ] **FP-1 — Root**",
			"- [~] **FP-1a2 — Lettered cut with a digit**",
			"- [x] **FP-1-2 — Hyphenated root**",
		].join("\n"),
	}];
	const result = generateProjectMapDraft({ packageJson: manifest(), oddTaskDocuments: documents });

	assert.deepEqual(result.map?.capabilities.map((capability) => capability.outcome), ["FP-1-2 — Hyphenated root", "FP-1 — Root"]);
	assert.deepEqual(collectProjectMapSteps(documents, "FP-1"), [
		{ code: "FP-1a2", title: "Lettered cut with a digit", state: "active", path: "odd/tasks/disjoint.md" },
	]);
	assert.deepEqual(collectProjectMapSteps(documents, "FP-1-2"), []);
});

test("treats an accented continuation as a continuation, because D2 says a letter", () => {
	// The guard is a unicode letter class, not an ASCII one: D2 says "a letter", and it means any.
	const documents = [{
		path: "odd/tasks/accented.md",
		text: ["- [ ] **FP-1 — Root**", "- [ ] **FP-1é — Accented continuation**"].join("\n"),
	}];
	assert.deepEqual(collectProjectMapSteps(documents, "FP-1").map((step) => step.code), ["FP-1é"]);
	const result = generateProjectMapDraft({ packageJson: manifest(), oddTaskDocuments: documents });
	assert.deepEqual(result.map?.capabilities.map((capability) => capability.outcome), ["FP-1 — Root"]);
});

test("pins the complete manifest-backed output under the fixed FP convention", () => {
	const result = generateProjectMapDraft({
		packageJson: manifest(),
		oddTaskDocuments: [{ path: "odd/tasks/roadmap.md", text: "- [ ] **FP-1 — Catalog**\n" }],
	});
	assert.equal(serializeProjectMap(result.map!), expectedHeadSerialization([expectedHeadCapability("odd/tasks/roadmap.md", "catalog", "FP-1 — Catalog")]));
	assert.deepEqual(result.assumptions, headFallbackAssumptions);
	assert.deepEqual(result.omissions, [
		"No structured source in this step names product capabilities; they must come from the ODD work-unit extraction or from the human.",
	]);
});

test("keeps HEAD's no-capability omission unless a convention read the unit as a step", () => {
	const document = "- [ ] **!!!**\n";
	const withoutConvention = generateProjectMapDraft({
		packageJson: manifest(),
		oddTaskDocuments: [{ path: "odd/tasks/invalid.md", text: document }],
	});
	assert.ok(joined(withoutConvention.omissions).includes("cannot be normalized into a capability identifier"));
	assert.equal(joined(withoutConvention.omissions).includes("odd/tasks/invalid.md declares no work unit this generator can read"), false);

	const withConvention = generateProjectMapDraft({
		packageJson: manifest(),
		oddTaskDocuments: [{ path: "odd/tasks/invalid.md", text: document }],
	});
	assert.ok(joined(withConvention.omissions).includes("cannot be normalized into a capability identifier"));
	assert.equal(joined(withConvention.omissions).includes("odd/tasks/invalid.md declares no work unit this generator can read"), false);
	assert.ok(joined(withConvention.assumptions).includes("1 work unit was read as steps instead of capabilities"));
});

test("uses the whole separator-free label as the code under the fixed FP convention", () => {
	const result = generateProjectMapDraft({
		packageJson: manifest(),
		oddTaskDocuments: [{
			path: "odd/tasks/codes.md",
			text: ["- [ ] **FP-1**", "- [ ] **FP-1b.0**", "- [ ] **F5-1**", "- [ ] **Do the thing**", ""].join("\n"),
		}],
	});
	assert.deepEqual(result.map?.capabilities.map((capability) => capability.outcome), ["FP-1"]);
	assert.ok(joined(result.assumptions).includes("3 work units were read as steps instead of capabilities"));
	assert.equal(result.omissions.some((omission) => omission.includes("FP-1b.0") || omission.includes("F5-1") || omission.includes("Do the thing")), false);
});

function expectedHeadCapability(path: string, id: string, outcome: string) {
	return {
		id,
		outcome,
		foundationRefs: [],
		dependsOn: [],
		contracts: [],
		featureDocs: [path],
		surfaces: [],
		state: "planned" as const,
	};
}

const headFallbackAssumptions = [
	"0 work units were read as steps instead of capabilities because their codes do not match their document's resolved prefix (\"FP-\").",
	"Every generated map is a draft: this generator never marks a map approved, and approval requires a human actor and an explicit transition.",
	"A generated foundation is done only when its named structured source carries a well-formed declaration of it; done therefore means declared, not verified.",
	"Foundation identifiers are generic proposals derived from repository tooling, and the human is expected to replace or extend them with the project's real foundations.",
	"Project identity is derived from the package manifest name, with the scope removed and the remainder normalized to lowercase kebab-case.",
	"An ODD work unit becomes a capability named after its title, a checked box becomes done and an unchecked box becomes planned, and the declaring document becomes its feature document. The checkbox is a declaration of completion, not verified progress.",
	"Generated capability surfaces were derived from the capability's own declared edit surfaces through the canonical surface table by default, with explicit canonical names taking precedence; a capability without that line remains undeclared.",
];

function expectedHeadSerialization(capabilities: ReturnType<typeof expectedHeadCapability>[]) {
	return serializeProjectMap({
		version: PROJECT_MAP_SCHEMA_V1,
		project: { id: "example-shop", name: "example-shop" },
		approval: { state: "draft" },
		foundations: [
			{ id: "quality-gates", outcome: "The project declares the automated gates that guard a change.", state: "done", evidence: ["package.json"] },
			{ id: "repository-tooling", outcome: "The repository and its declared tooling are present and consistent.", state: "done", evidence: ["package.json"] },
		],
		capabilities,
	});
}

test("makes numbered roots rows and collects each continuing code under its root", () => {
	const fp1Steps = [
		{ code: "FP-1a", title: "First cut", state: "active" as const, path: "odd/tasks/alpha.md" },
		{ code: "FP-1a.1", title: "First cut one", state: "done" as const, path: "odd/tasks/alpha.md" },
		{ code: "FP-1a.2", title: "First cut two", state: "planned" as const, path: "odd/tasks/alpha.md" },
		{ code: "FP-1a.3", title: "First cut three", state: "done" as const, path: "odd/tasks/alpha.md" },
		{ code: "FP-1a.4", title: "First cut four", state: "planned" as const, path: "odd/tasks/alpha.md" },
		{ code: "FP-1a.5", title: "First cut five", state: "active" as const, path: "odd/tasks/alpha.md" },
		{ code: "FP-1a.6", title: "First cut six", state: "done" as const, path: "odd/tasks/alpha.md" },
		{ code: "FP-1b", title: "Second cut", state: "planned" as const, path: "odd/tasks/bravo.md" },
		{ code: "FP-1b.0", title: "Second cut zero", state: "done" as const, path: "odd/tasks/bravo.md" },
		{ code: "FP-1b.1a", title: "Second cut one-a", state: "active" as const, path: "odd/tasks/bravo.md" },
		{ code: "FP-1b.1", title: "Second cut one", state: "planned" as const, path: "odd/tasks/bravo.md" },
		{ code: "FP-1b.2", title: "Second cut two", state: "done" as const, path: "odd/tasks/bravo.md" },
		{ code: "FP-1b.3", title: "Second cut three", state: "planned" as const, path: "odd/tasks/bravo.md" },
		{ code: "FP-1b.3a", title: "Second cut three-a", state: "done" as const, path: "odd/tasks/bravo.md" },
		{ code: "FP-1b.3a-b", title: "Second cut three-a-b", state: "done" as const, path: "odd/tasks/bravo.md" },
		{ code: "FP-1b.3b", title: "Second cut three-b", state: "active" as const, path: "odd/tasks/bravo.md" },
		{ code: "FP-1b.4", title: "Second cut four", state: "done" as const, path: "odd/tasks/bravo.md" },
		{ code: "FP-1b.5", title: "Second cut five", state: "planned" as const, path: "odd/tasks/bravo.md" },
		{ code: "FP-1b.6", title: "Second cut six", state: "done" as const, path: "odd/tasks/bravo.md" },
		{ code: "FP-1b.7", title: "Second cut seven", state: "active" as const, path: "odd/tasks/bravo.md" },
		{ code: "FP-1b.8", title: "Second cut eight", state: "done" as const, path: "odd/tasks/bravo.md" },
	];
	const documents = [
		{ path: "odd/tasks/alpha.md", text: [
			...Array.from({ length: 10 }, (_, number) => `- [ ] **FP-${number} — Root ${number}**`),
			"- [x] **FP-0b — Foundation cut**",
			"- [~] **FP-1a — First cut**",
			"- [x] **FP-1a.1 — First cut one**",
			"- [ ] **FP-1a.2 — First cut two**",
			"- [x] **FP-1a.3 — First cut three**",
			"- [ ] **FP-1a.4 — First cut four**",
			"- [~] **FP-1a.5 — First cut five**",
			"- [x] **FP-1a.6 — First cut six**",
			"- [ ] **FP-word — Unowned word-shaped step**",
		].join("\n") },
		{ path: "odd/tasks/bravo.md", text: [
			"- [ ] **FP-1b — Second cut**",
			"- [x] **FP-1b.0 — Second cut zero**",
			"- [~] **FP-1b.1a — Second cut one-a**",
			"- [ ] **FP-1b.1 — Second cut one**",
			"- [x] **FP-1b.2 — Second cut two**",
			"- [ ] **FP-1b.3 — Second cut three**",
			"- [x] **FP-1b.3a — Second cut three-a**",
			"- [x] **FP-1b.3a-b — Second cut three-a-b**",
			"- [~] **FP-1b.3b — Second cut three-b**",
			"- [x] **FP-1b.4 — Second cut four**",
			"- [ ] **FP-1b.5 — Second cut five**",
			"- [x] **FP-1b.6 — Second cut six**",
			"- [~] **FP-1b.7 — Second cut seven**",
			"- [x] **FP-1b.8 — Second cut eight**",
		].join("\n") },
	];
	const result = generateProjectMapDraft({ packageJson: manifest(), oddTaskDocuments: documents });

	assert.deepEqual(result.map?.capabilities.map((capability) => capability.outcome), Array.from({ length: 10 }, (_, number) => `FP-${number} — Root ${number}`));
	assert.equal(result.map?.capabilities.some((capability) => ["FP-0b", "FP-1a", "FP-1b", "FP-1b.0"].includes(capability.outcome.split(" — ")[0]!)), false, "letters and dots keep cuts out of rows");
	assert.ok(joined(result.assumptions).includes("23 work units were read as steps instead of capabilities"), "unowned word-shaped units remain accounted for as steps");
	assert.deepEqual(collectProjectMapSteps(documents, "FP-1"), fp1Steps);
	assert.deepEqual(collectProjectMapSteps(documents, "FP-0"), [{ code: "FP-0b", title: "Foundation cut", state: "done", path: "odd/tasks/alpha.md" }]);
	assert.equal(collectProjectMapSteps([{ path: "odd/tasks/guard.md", text: "- [ ] **FP-10 — Ten**\n- [ ] **FP-1b — Cut**\n" }], "FP-1").some((step) => step.code === "FP-10"), false, "a digit cannot continue FP-1");
	assert.equal(collectProjectMapSteps([{ path: "odd/tasks/guard.md", text: "- [ ] **FP-1b — Cut**\n" }], "FP-1a").length, 0, "a sibling cut cannot continue FP-1a");
	assert.equal(collectProjectMapSteps(documents, "FP-word").length, 0, "a word-shaped code extends no row");
});

test("collects only letter- or dot-continuing codes from every document in deterministic order", () => {
	const documents = [
		{
			path: "odd/tasks/zulu.md",
			text: [
				"- [x] **FP-1b.0 — Later duplicate**",
				"- [x] **FP-1b.8 — Final top-level step**",
				"",
			].join("\n"),
		},
		{
			path: "odd/tasks/alpha.md",
			text: [
				"- [ ] **FP-1b — Provisioning**",
				"  - [x] **FP-1b.0 — First nested step**",
				"  - [ ] **FP-1b.1 — Planned nested step**",
				"- [~] **FP-1b.1a — Active top-level step**",
				"- [x] **FP-1b.2 — Done step**",
				"- [ ] **FP-1b.3 — Planned step**",
				"- [x] **FP-1b.3a — Done lettered step**",
				"- [x] **FP-1b.3a-b — Done hyphenated step**",
				"- [x] **FP-1b.3b — Done lettered sibling**",
				"- [x] **FP-1b.4 — Done fourth step**",
				"- [ ] **FP-1b.5 — Planned fifth step**",
				"- [x] **FP-1b.6 — Done sixth step**",
				"- [~] **FP-1b.7 — Active seventh step**",
				"- [x] **FP-1b — The functional point itself**",
				"- [x] **FP-1b-extra.2 — Shares a prefix without the dot**",
				"- [x] **FP-1.b.3 — Carries the dot elsewhere**",
				"- [x] **FP-4a1 — Continues with a letter rather than a dot**",
				"- [x] **An uncoded unit**",
				"",
			].join("\n"),
		},
	];
	const steps = collectProjectMapSteps(documents, "FP-1b");

	assert.deepEqual(steps, [
		{ code: "FP-1b.0", title: "First nested step", state: "done", path: "odd/tasks/alpha.md" },
		{ code: "FP-1b.1", title: "Planned nested step", state: "planned", path: "odd/tasks/alpha.md" },
		{ code: "FP-1b.1a", title: "Active top-level step", state: "active", path: "odd/tasks/alpha.md" },
		{ code: "FP-1b.2", title: "Done step", state: "done", path: "odd/tasks/alpha.md" },
		{ code: "FP-1b.3", title: "Planned step", state: "planned", path: "odd/tasks/alpha.md" },
		{ code: "FP-1b.3a", title: "Done lettered step", state: "done", path: "odd/tasks/alpha.md" },
		{ code: "FP-1b.3a-b", title: "Done hyphenated step", state: "done", path: "odd/tasks/alpha.md" },
		{ code: "FP-1b.3b", title: "Done lettered sibling", state: "done", path: "odd/tasks/alpha.md" },
		{ code: "FP-1b.4", title: "Done fourth step", state: "done", path: "odd/tasks/alpha.md" },
		{ code: "FP-1b.5", title: "Planned fifth step", state: "planned", path: "odd/tasks/alpha.md" },
		{ code: "FP-1b.6", title: "Done sixth step", state: "done", path: "odd/tasks/alpha.md" },
		{ code: "FP-1b.7", title: "Active seventh step", state: "active", path: "odd/tasks/alpha.md" },
		{ code: "FP-1b.8", title: "Final top-level step", state: "done", path: "odd/tasks/zulu.md" },
	]);
	assert.deepEqual(collectProjectMapSteps(documents, "FP-4"), [
		{ code: "FP-4a1", title: "Continues with a letter rather than a dot", state: "done", path: "odd/tasks/alpha.md" },
	]);
	assert.deepEqual(collectProjectMapSteps([{ path: "odd/tasks/alpha.md", text: "- [ ] **FP-1b.0 — Setup**\n" }], "FP-9"), []);
});

test("declared parents own every non-row unit despite its code, indentation, or missing head", () => {
	const documents = [{
		path: "odd/tasks/declared.md",
		text: [
			"  - **Belongs to**: `FP-5`",
			"- [~] **F5b-1 — Coded in another family**",
			"- [x] **A bare prose unit**",
			"  - [ ] **FP-7x — A different row's extension**",
			"    - [x] **FP-1b.0 — Another different row's extension**",
			"- [ ] **FP-9 — A row stays a row**",
		].join("\n"),
	}];

	assert.deepEqual(collectProjectMapSteps(documents, "FP-5", "FP-"), [
		{ code: "F5b-1", title: "Coded in another family", state: "active", path: "odd/tasks/declared.md" },
		{ code: "", title: "A bare prose unit", state: "done", path: "odd/tasks/declared.md" },
		{ code: "FP-7x", title: "A different row's extension", state: "planned", path: "odd/tasks/declared.md" },
		{ code: "FP-1b.0", title: "Another different row's extension", state: "done", path: "odd/tasks/declared.md" },
	]);
	assert.deepEqual(collectProjectMapSteps(documents, "FP-7", "FP-"), [], "a declaration takes precedence over the extension fallback");

	const mixed = [...documents,
		{ path: "odd/tasks/t.md", text: '**Work unit prefix:** `T`\n**Belongs to:** `T1`\n- [ ] **T1b — Letter**\n- [x] **T1.2 — Dot**\n- [ ] **T2 — Another row**' },
		{ path: "odd/tasks/hor.md", text: '**Work unit prefix:** `HOR-`\n**Belongs to:** `HOR-01`\n- [ ] **HOR-01a — Detail**\n- [ ] **HOR-02 — Another row**' },
	];
	assert.deepEqual(collectProjectMapSteps(mixed, "T1", "FP-").map((step) => step.code), ["T1b", "T1.2"]);
	assert.deepEqual(collectProjectMapSteps(mixed, "HOR-01", "FP-").map((step) => step.code), ["HOR-01a"]);
	assert.deepEqual(collectProjectMapSteps(mixed, "FP-5", "FP-"), collectProjectMapSteps(documents, "FP-5", "FP-"));
	assert.deepEqual(collectProjectMapSteps(mixed, "T1", null), []);
	const suppliedDefault = [{ path: "odd/tasks/custom.md", text: '**Work unit prefix:** ``\n**Belongs to:** `X1`\n- [ ] **X1b — Detail**\n- [ ] **X2 — Another row**' }];
	assert.deepEqual(collectProjectMapSteps(suppliedDefault, "X1", "X").map((step) => step.code), ["X1b"]);
});

test("reports each unreadable or unusable declared parent once without falling back", () => {
	const documents = [
		{
			path: "odd/tasks/declared.md",
			text: [
				"**Belongs to:** `FP-5` and `FP-6`",
				"**Belongs to:** `FP-5`",
				"- [ ] **FP-5 — Five**",
				"- [x] **F5-1 — First declared step**",
			].join("\n"),
		},
		{
			path: "odd/tasks/unusable.md",
			text: [
				"**Belongs to:** `F5`",
				"- [x] **FP-5a — Must not fall back**",
			].join("\n"),
		},
	];
	const result = generateProjectMapDraft({
		packageJson: manifest(),
		oddTaskDocuments: documents,
	});

	assert.deepEqual(collectProjectMapSteps(documents, "FP-5", "FP-"), [
		{ code: "F5-1", title: "First declared step", state: "done", path: "odd/tasks/declared.md" },
	]);
	assert.equal(collectProjectMapSteps(documents, "FP-5", "FP-").some((step) => step.title === "Must not fall back"), false);
	assert.deepEqual(result.omissions.filter((omission) => omission.includes("**Belongs to:**")), [
		"odd/tasks/declared.md has an unreadable **Belongs to:** marker that was ignored; the readable declaration \"FP-5\" was used instead.",
		"odd/tasks/unusable.md declares an unusable **Belongs to:** declaration: \"F5\" is not a functional point this map declares, so its work units were associated with no functional-point row.",
	]);
});

test("reports unreadable markers after the winning declaration once while keeping its association", () => {
	for (const unreadable of ["**Belongs to:**", "**Belongs to:** `FP-5` and `FP-6`"]) {
		const documents = [{
			path: "odd/tasks/declared.md",
			text: [
				"**Belongs to:** `FP-5`",
				unreadable,
				"**Belongs to:** `FP-6`",
				unreadable,
				"- [ ] **FP-5 — Five**",
				"- [ ] **FP-6 — Six**",
				"- [x] **F5-1 — Declared step**",
			].join("\n"),
		}];
		const result = generateProjectMapDraft({ packageJson: manifest(), oddTaskDocuments: documents });
		assert.deepEqual(result.omissions.filter((omission) => omission.includes("**Belongs to:**")), [
			'odd/tasks/declared.md has an unreadable **Belongs to:** marker that was ignored; the readable declaration "FP-5" was used instead.',
		]);
		assert.deepEqual(collectProjectMapSteps(documents, "FP-5", "FP-"), [
			{ code: "F5-1", title: "Declared step", state: "done", path: "odd/tasks/declared.md" },
		]);
		assert.deepEqual(collectProjectMapSteps(documents, "FP-6", "FP-"), []);
	}
});

test("reports a readable declared parent without a delegable convention as its own cause", () => {
	const documents = [{ path: "odd/tasks/declared.md", text: "**Belongs to:** `FP-5`\n- [x] **FP-5a — No fallback**" }];
	const result = generateProjectMapDraft({ packageJson: manifest(), oddTaskDocuments: documents });
	assert.deepEqual(result.omissions.filter((omission) => omission.includes("**Belongs to:**")), [
		'odd/tasks/declared.md declares an unusable **Belongs to:** declaration: "FP-5" is not a functional point this map declares, so its work units were associated with no functional-point row.',
	]);
	assert.deepEqual(collectProjectMapSteps(documents, "FP-5", null), []);
});

test("reports a well-shaped declared parent absent from the extracted roadmap once", () => {
	const result = generateProjectMapDraft({
		packageJson: manifest(),
		oddTaskDocuments: [
			{ path: "odd/tasks/roadmap.md", text: "- [ ] **FP-5 — Five**" },
			{ path: "odd/tasks/missing.md", text: "**Belongs to:** `FP-999`\n- [ ] **FP-999a — Not extracted from this document**\n- [x] **FP-5a — Must not fall back**" },
		],
	});
	assert.deepEqual(result.omissions.filter((omission) => omission.includes("**Belongs to:**")), [
		"odd/tasks/missing.md declares an unusable **Belongs to:** declaration: \"FP-999\" is not a functional point this map declares, so its work units were associated with no functional-point row.",
	]);
	assert.deepEqual(result.map?.capabilities.map((capability) => capability.outcome), ["FP-5 — Five"]);
});

test("unhonoured declarations report only non-association even after unreadable markers", () => {
	for (const code of ["FP-999", "FP-5x", "FP-999-1"] as const) {
		const documents = [
			{ path: "odd/tasks/roadmap.md", text: "- [ ] **FP-5 — Five**" },
			{ path: "odd/tasks/declared.md", text: `**Belongs to:**\n**Belongs to:** \`${code}\`\n**Belongs to:** \`FP-5\`\n- [x] **FP-5a — No fallback**` },
		];
		assert.deepEqual(collectProjectMapSteps(documents, "FP-5", "FP-"), [], "the first readable declaration wins even when unusable");
		const result = generateProjectMapDraft({ packageJson: manifest(), oddTaskDocuments: documents });
		assert.deepEqual(result.omissions.filter((omission) => omission.includes("**Belongs to:**")), [
			`odd/tasks/declared.md declares an unusable **Belongs to:** declaration: "${code}" is not a functional point this map declares, so its work units were associated with no functional-point row.`,
		]);
	}
});

test("adding an unreadable marker removes a derived step and reports one omission", () => {
	const document = { path: "odd/tasks/fallback.md", text: "- [ ] **FP-5 — Five**\n- [x] **FP-5a — Extending code**" };
	assert.equal(collectProjectMapSteps([document], "FP-5", "FP-").length, 1);
	const declaring = { ...document, text: "**Belongs to:** `FP-5` and `FP-6`\n" + document.text };
	assert.deepEqual(collectProjectMapSteps([declaring], "FP-5", "FP-"), []);
	const result = generateProjectMapDraft({
		packageJson: manifest(),
		oddTaskDocuments: [declaring],
	});
	assert.deepEqual(result.omissions.filter((omission) => omission.includes("**Belongs to:**")), [
		"odd/tasks/fallback.md declares an unusable **Belongs to:** declaration, so its work units were associated with no functional-point row.",
	]);
});

test("collects the declared junglex-shaped families without crossing into another row", () => {
	// Bold labels transcribed from junglex/odd/tasks/fp-4-writable-catalog.md (2026-09-29).
	// The 33 separator-free labels and nine prose em dashes are intentional, not invented codes.
	const catalogLabels = [
		"Close the coverage gaps independent verification named, which this unit is the right place for.",
		"Restore the storage-path traversal checks in `assertValidStoragePath`.",
		"Scope `imageCreateStatement` to the authorized merchant.",
		"Add the dual-member mismatched-merchant proofs",
		"Classify `last_variant` by SQLSTATE rather than by a `/variant/i` match on any error message",
		"Make product creation honour a sole explicit default regardless of its position in the input.",
		"Add the persisted-state success proofs that are missing.",
		"Cover the category-assignment boundary.",
		"Cover the variant-deletion product equality.",
		"Prove the new ordering fix has teeth",
		"Implement the decided cross-tenant denial vocabulary: uniform absence, always 404.",
		"Discriminate the disabled-merchant refusal from the cross-tenant refusal, because both raise `42501`.",
		"The disabled-merchant answer itself is unowned",
		"Close the default-variant contract divergence measured in FP-4a2",
		"Close the `displayOrder` contract divergence — measured closed.",
		"Close the multiple-default contract divergence — measured closed.",
		"Which layer catches the fourteen table-swap mutants (batch M33–M46) — measured, and the unit layer does not.",
		"The pre-`try` failure release path — measured independently.",
		"Add the missing markup functions to the three catalog controllers",
		"Forced cleanup of pre-existing formatter suppressions.",
		"c2 — the three catalog surfaces are mounted and wired to real routes.",
		"Mount `CategoryManager`, `ProductEditor`, `AvailabilityToggle`, `OnboardingAdmin` and `ServiceSettings` into `apps/web/src/app/shell.ts` for a real merchant session.",
		"Blocked dependency, discovered while mounting: there is no media-upload path in this repository, so `ProductEditorApi.upload` cannot be wired to anything real.",
		"Register `AvailabilityToggle.test.tsx`, `CategoryManager.test.tsx` and `ProductEditor.test.tsx` in both `package.json` (`test:ts:ci:non-rls`) and `tests/unit/test-runner-config.test.ts`.",
		"Run the full gate and confirm zero failures.",
		"Extend the shell tests to cover the mounted surfaces and their absence for a customer session.",
		"BLOCKER (independent verification; r5 scope) — the mounted catalog has no product-creation path.",
		"SECOND LAYER OF THE SAME BLOCKER, found when the fix was attempted — `ProductEditor` is a viewer wearing an editor's name.",
		"BLOCKER (independent verification; r6 scope) — state binding is unproven.",
		"Close the six escapes, then measure the closure (r6).",
		"BLOCKER (final verification; r7a): the mounted variant controls and price are inert.",
		"BLOCKER (final verification; r7b): category management was a viewer with inert buttons.",
		"BLOCKER (final verification; r7b): no product picker and no \"new product\" action.",
		"HIGH (round-three verification; r8a): a successful existing-product save kept stale variant identities.",
		"HIGH (round-three verification; r8a): removing a persisted variant updated and deleted by position instead of identity.",
		"MEDIUM (round-three verification; r8b): mounted interaction coverage is still incomplete.",
		"BLOCKER (round-three verification; r8c/r8d): an empty configuration cannot be populated through the mounted controls — and I measured that the enablement gate therefore cannot be satisfied at all.",
		"DEFECT (round-four verification; r9a): the operating-hours values failed the contract at the browser boundary.",
		"GAP (round-four verification; r9b): the single seven-prerequisite journey and general list retention.",
		"MEASUREMENT (r9c): the four escapes are closed.",
		"BLOCKER (final verification; r7c/r7d): onboarding configuration saves and the service actions were inert.",
		"Follow-up (final verification; r7d): the mounted availability toggle is never clicked.",
	];
	const catalogStates = "              xxxxxxxx xxxx   xxxxx  xxxxx";
	assert.equal(catalogStates.length, 42);
	const documents = [
		{ path: "odd/tasks/fp-4-writable-catalog.md", text: ["**Belongs to:** `FP-4`", ...catalogLabels.map((label, index) => `- [${catalogStates[index]}] **${label}** Trailing prose is outside the label.`)].join("\n") },
		{ path: "odd/tasks/fp-5-geocoding.md", text: ["**Belongs to:** `FP-5`", ...Array.from({ length: 5 }, (_, number) => `- [x] **F5-${number + 1}** Trailing prose is outside the label.`)].join("\n") },
		{ path: "odd/tasks/fp-6-notifications.md", text: ["**Belongs to:** `FP-6`", ...Array.from({ length: 7 }, (_, number) => `- [x] **F6-${number + 1}** Trailing prose is outside the label.`)].join("\n") },
		{ path: "odd/tasks/fp-7-customer-truth-up.md", text: ["**Belongs to:** `FP-7`", ..."abcde".split("").map((letter) => `- [x] **F7-1${letter}** Trailing prose is outside the label.`)].join("\n") },
	];
	for (const [row, titles] of [
		["FP-5", Array.from({ length: 5 }, (_, index) => `F5-${index + 1}`)],
		["FP-6", Array.from({ length: 7 }, (_, index) => `F6-${index + 1}`)],
		["FP-7", "abcde".split("").map((letter) => `F7-1${letter}`)],
	] as const) {
		assert.deepEqual(collectProjectMapSteps(documents, row, "FP-"), titles.map((title) => ({
			code: "", title, state: "done", path: documents.find((document) => document.text.startsWith(`**Belongs to:** \`${row}\``))!.path,
		})));
	}
	const catalog = collectProjectMapSteps(documents, "FP-4", "FP-");
	assert.equal(catalog.length, 42);
	assert.equal(catalog.filter((step) => step.code === "").length, 33);
	assert.deepEqual(catalog.map((step) => step.code ? `${step.code} — ${step.title}` : step.title), catalogLabels);
	assert.deepEqual(catalog.map((step) => step.state), [...catalogStates].map((state) => state === "x" ? "done" : "planned"));
	assert.deepEqual(collectProjectMapSteps(documents, "FP-8", "FP-"), [], "no document declares this row");
});

test("keeps the no-declaration collector and generated draft byte-identical", () => {
	const documents = [{
		path: "odd/tasks/fallback.md",
		text: [
			"- [ ] **FP-5 — Five**",
			"- [x] **FP-5a — Extending code**",
			"- [~] **F5-1 — Non-extending code**",
			"  - [ ] **An uncoded unit**",
		].join("\n"),
	}];
	const result = generateProjectMapDraft({
		packageJson: manifest(),
		oddTaskDocuments: documents,
	});

	assert.deepEqual(collectProjectMapSteps(documents, "FP-5", "FP-"), [
		{ code: "FP-5a", title: "Extending code", state: "done", path: "odd/tasks/fallback.md" },
	]);
	assert.deepEqual(result.map?.capabilities, [expectedHeadCapability("odd/tasks/fallback.md", "five", "FP-5 — Five")]);
	assert.deepEqual(result.omissions, [
		"No structured source in this step names product capabilities; they must come from the ODD work-unit extraction or from the human.",
	]);
	assert.deepEqual(result.assumptions, [
		"2 work units were read as steps instead of capabilities because their codes do not match their document's resolved prefix (\"FP-\").",
		...headFallbackAssumptions.slice(1),
	]);
	assert.equal(serializeProjectMap(result.map!), expectedHeadSerialization([expectedHeadCapability("odd/tasks/fallback.md", "five", "FP-5 — Five")]));
});

test("matches HEAD's complete output for synthetic no-convention corpora", () => {
	const commonOmissions = [
		"No structured source in this step names product capabilities; they must come from the ODD work-unit extraction or from the human.",
	];
	const cases = [
		{
			name: "an invalid title",
			documents: [{ path: "odd/tasks/invalid.md", text: "- [ ] **!!!**\n" }],
			capabilities: [],
			omissions: [
				...commonOmissions,
				'The work unit line "- [ ] **!!!**" in odd/tasks/invalid.md cannot be normalized into a capability identifier.',
				"No supplied source names a product capability, so the draft carries none; capabilities must come from the ODD work-unit extraction or from the human.",
			],
		},
		{
			name: "a document containing only steps",
			documents: [{ path: "odd/tasks/steps.md", text: "- [ ] **DEL-1 — Delivery step**\n" }],
			capabilities: [],
			omissions: [...commonOmissions, "No supplied source names a product capability, so the draft carries none; capabilities must come from the ODD work-unit extraction or from the human."],
		},
		{
			name: "a collision",
			documents: [
				{ path: "odd/tasks/a.md", text: "- [ ] **FP-1 — Shared**\n" },
				{ path: "odd/tasks/b.md", text: "- [ ] **FP-2 — Shared**\n" },
			],
			capabilities: [expectedHeadCapability("odd/tasks/a.md", "shared", "FP-1 — Shared")],
			omissions: [
				...commonOmissions,
				'The capability "shared" is declared by both odd/tasks/a.md, line "- [ ] **FP-1 — Shared**", and odd/tasks/b.md, line "- [ ] **FP-2 — Shared**"; the first document in sorted order wins.',
			],
		},
		{
			name: "only delegable units",
			documents: [{ path: "odd/tasks/delegable.md", text: "- [ ] **FP-1**\n- [ ] **FP-2 — Two**\n" }],
			capabilities: [
				expectedHeadCapability("odd/tasks/delegable.md", "fp-1", "FP-1"),
				expectedHeadCapability("odd/tasks/delegable.md", "two", "FP-2 — Two"),
			],
			omissions: commonOmissions,
		},
	];
	for (const fixture of cases) {
		const result = generateProjectMapDraft({
			packageJson: manifest(),
			oddTaskDocuments: fixture.documents,
		});
		assert.deepEqual(result.map?.capabilities, fixture.capabilities, fixture.name);
		assert.equal(serializeProjectMap(result.map!), expectedHeadSerialization(fixture.capabilities), fixture.name);
		assert.deepEqual(result.omissions, fixture.omissions, fixture.name);
		assert.deepEqual(result.assumptions, [
			`${fixture.name === "an invalid title" || fixture.name === "a document containing only steps" ? "1 work unit was" : "0 work units were"} read as steps instead of capabilities because their codes do not match their document's resolved prefix ("FP-").`,
			...headFallbackAssumptions.slice(1),
		], fixture.name);
	}
});

function comparisonMap(text = "- [ ] **FP-1 — Checkout**", path = "odd/tasks/roadmap.md", scripts: Record<string, unknown> = { test: "node --test" }) {
	const result = generateProjectMapDraft({ packageJson: manifest({ scripts }), oddTaskDocuments: [{ path, text }] });
	assert.ok(result.map);
	return result.map;
}

test("source changes: identical generated maps return no lines without mutating inputs", () => {
	const stored = comparisonMap();
	const generated = comparisonMap();
	assert.deepEqual(stored.capabilities, [expectedHeadCapability("odd/tasks/roadmap.md", "checkout", "FP-1 — Checkout")]);
	const before = JSON.stringify([stored, generated]);
	assert.deepEqual(projectMapSourceChanges(stored, generated), []);
	assert.equal(JSON.stringify([stored, generated]), before);
});

for (const [field, value, rendered] of [
	["outcome", "FP-2 — Checkout", "FP-1 — Checkout → FP-2 — Checkout"],
	["state", "done", "planned → done"],
	["foundationRefs", ["repository-tooling"], '[] → ["repository-tooling"]'],
	["dependsOn", ["catalog"], '[] → ["catalog"]'],
	["contracts", ["checkout-v1", "payment-v1"], '[] → ["checkout-v1","payment-v1"]'],
	["featureDocs", ["odd/tasks/moved.md"], '["odd/tasks/roadmap.md"] → ["odd/tasks/moved.md"]'],
] as const) {
	test(`source changes: ${field} produces its field line with compact arrays`, () => {
		const stored = comparisonMap();
		// References and contracts cannot currently be derived by the generator.
		const generated = comparisonMap(
			field === "outcome" ? "- [ ] **FP-2 — Checkout**" : field === "state" ? "- [x] **FP-1 — Checkout**" : undefined,
			field === "featureDocs" ? "odd/tasks/moved.md" : undefined,
		);
		if (field === "foundationRefs" || field === "dependsOn" || field === "contracts") {
			generated.capabilities[0] = { ...generated.capabilities[0]!, [field]: [...value] };
		}
		assert.deepEqual(projectMapSourceChanges(stored, generated), [`Capability "checkout": ${field} ${rendered}.`]);
	});
}

test("source changes: document-declared surfaces produce a compact field line", () => {
	const stored = comparisonMap("- [ ] **FP-1 — Checkout**\n  **Allowed edit surfaces:** `web/cart.ts`");
	const generated = comparisonMap("- [ ] **FP-1 — Checkout**\n  **Allowed edit surfaces:** `api/cart.ts`");
	assert.deepEqual(projectMapSourceChanges(stored, generated), ['Capability "checkout": surfaces ["web"] → ["api"].']);
});

test("source changes: hand-declared surfaces and removed declarations are ignored when generated surfaces are empty", () => {
	const stored = comparisonMap();
	stored.capabilities[0]!.surfaces = ["web"];
	assert.deepEqual(projectMapSourceChanges(stored, comparisonMap()), []);
	const declared = comparisonMap("- [ ] **FP-1 — Checkout**\n  **Allowed edit surfaces:** `web/cart.ts`");
	assert.deepEqual(projectMapSourceChanges(declared, comparisonMap()), []);
});

test("source changes: approved stored maps with identical sources return no lines", () => {
	const stored = comparisonMap();
	stored.approval = { state: "approved", approvedBy: "maintainer", approvedAt: "2026-09-29T00:00:00Z" };
	assert.deepEqual(projectMapSourceChanges(stored, comparisonMap()), []);
	assert.deepEqual(projectMapSourceChanges(comparisonMap(), stored), []);
});

test("source changes: renamed capability identities are named as removed and added", () => {
	assert.deepEqual(projectMapSourceChanges(comparisonMap(), comparisonMap("- [ ] **FP-1 — Catalog**")), [
		'Capability "checkout" was removed.',
		'Capability "catalog" was added.',
	]);
});

test("source changes: project id and name produce their identity lines", () => {
	const stored = comparisonMap();
	const generated = generateProjectMapDraft({ ...sources("- [ ] **FP-1 — Checkout**"), packageJson: manifest({ name: "new-shop" }) }).map!;
	assert.deepEqual(projectMapSourceChanges(stored, generated), [
		"Project id changed: example-shop → new-shop.",
		"Project name changed: example-shop → new-shop.",
	]);
});

test("source changes: foundations added removed and changed are compared by id", () => {
	const stored = comparisonMap();
	stored.foundations = stored.foundations.filter((foundation) => foundation.id !== "quality-gates");
	const withGate = comparisonMap();
	assert.deepEqual(projectMapSourceChanges(stored, withGate), ['Foundation "quality-gates" was added.']);
	assert.deepEqual(projectMapSourceChanges(withGate, stored), ['Foundation "quality-gates" was removed.']);
	const generated = generateProjectMapDraft({ ...sources("- [ ] **FP-1 — Checkout**"), packageJson: manifest({ scripts: {} }) }).map!;
	// Foundation membership and outcomes are human-owned; test their comparison directly.
	generated.foundations = generated.foundations.filter((foundation) => foundation.id !== "quality-gates");
	generated.foundations[0]!.outcome = "Tooling changed.";
	assert.deepEqual(projectMapSourceChanges(stored, generated), [
		'Foundation "repository-tooling": outcome The repository and its declared tooling are present and consistent. → Tooling changed..',
		'Foundation "repository-tooling": state done → planned.',
		'Foundation "repository-tooling": evidence ["package.json"] → undefined.',
	]);
});

test("source changes: D2/AC5 generated-only capability order does not affect canonical lines", () => {
	const stored = comparisonMap();
	const generated = comparisonMap();
	const capability = generated.capabilities[0]!;
	generated.capabilities.push({ ...capability, id: "zeta" }, { ...capability, id: "alpha" });
	const reversed = { ...generated, capabilities: [...generated.capabilities].reverse() };
	const expected = ['Capability "alpha" was added.', 'Capability "zeta" was added.'];
	assert.deepEqual(projectMapSourceChanges(stored, generated), expected);
	assert.deepEqual(projectMapSourceChanges(stored, reversed), expected);
});

test("source changes: D2/AC5 repeated generated ids are added once in canonical position", () => {
	const stored = comparisonMap();
	const generated = comparisonMap();
	const capability = generated.capabilities[0]!;
	generated.capabilities.push(
		{ ...capability, id: "zeta" },
		{ ...capability, id: "new" },
		{ ...capability, id: "alpha" },
		{ ...capability, id: "new" },
	);
	assert.deepEqual(projectMapSourceChanges(stored, generated), [
		'Capability "alpha" was added.',
		'Capability "new" was added.',
		'Capability "zeta" was added.',
	]);
});

test("source changes: repeated stored ids retain their first position and generated comparison uses the first occurrence", () => {
	const stored = comparisonMap();
	const generated = comparisonMap();
	const capability = stored.capabilities[0]!;
	stored.capabilities.push(
		{ ...capability, id: "removed" },
		{ ...capability, outcome: "Ignored stored duplicate." },
		{ ...capability, id: "removed" },
	);
	generated.capabilities[0] = { ...capability, outcome: "First generated outcome." };
	generated.capabilities.push({ ...capability, outcome: "Ignored generated duplicate." });
	assert.deepEqual(projectMapSourceChanges(stored, generated), [
		`Capability "checkout": outcome ${capability.outcome} → First generated outcome..`,
		'Capability "removed" was removed.',
	]);
});

test("source changes: identity foundations stored capability order and generated-only order are deterministic", () => {
	const stored = comparisonMap("- [ ] **FP-1 — Zebra**\n- [ ] **FP-2 — Alpha**\n- [ ] **FP-3 — Removed**");
	stored.foundations = stored.foundations.filter((foundation) => foundation.id !== "quality-gates");
	const generated = comparisonMap("- [ ] **FP-4 — Aardvark first**\n- [x] **FP-2 — Alpha**\n- [ ] **FP-5 — New second**\n- [x] **FP-1 — Zebra**");
	generated.project = { id: "new-shop", name: "New shop" };
	generated.capabilities.find((capability) => capability.id === "zebra")!.outcome = "FP-9 — Zebra";
	const expected = [
		"Project id changed: example-shop → new-shop.",
		"Project name changed: example-shop → New shop.",
		'Foundation "quality-gates" was added.',
		'Capability "alpha": state planned → done.',
		'Capability "removed" was removed.',
		'Capability "zebra": outcome FP-1 — Zebra → FP-9 — Zebra.',
		'Capability "zebra": state planned → done.',
		'Capability "aardvark-first" was added.',
		'Capability "new-second" was added.',
	];
	assert.deepEqual(projectMapSourceChanges(stored, generated), expected);
	assert.deepEqual(projectMapSourceChanges(stored, generated), expected);
});
