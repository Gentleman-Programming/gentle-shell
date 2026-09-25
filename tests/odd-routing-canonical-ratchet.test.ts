import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	ODD_ROUTING_BLOCK_PREFIX,
	ODD_ROUTING_FIXTURE_RELATIVE,
	ODD_ROUTING_SOURCE_PATH,
	ODD_ROUTING_SOURCE_REPO,
	assertCleanGentleAiCheckout,
	parseOddRoutingFixture,
	renderOddRoutingFixture,
	resolveOddRoutingProvenance,
	sha256Hex,
} from "../scripts/mirror-odd-routing.mjs";

// ---------------------------------------------------------------------------
// ODD routing drift ratchet (gentle-pi#1147 follow-up)
//
// gentle-pi hand-mirrors the always-on ODD routing block rendered by gentle-ai
// `internal/components/agentguidance/routing.go` (RenderRouting). There is no
// automated sync, so a canonical change leaves the pi mirror stale with nothing
// catching it. This ratchet vendored-snapshots the canonical block into
// `fixtures/odd-routing-canonical.md` (regenerated via `npm run
// mirror:odd-routing`) and fails when a mandatory-delegation clause is dropped
// either from the canonical fixture or from a pi mirror surface.
//
// Regeneration writes ONLY the fixture; this ratchet never auto-rewrites mirror
// assets, so drift stays visible as a deliberate diff.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, "..");
const FIXTURE_PATH = join(REPO_ROOT, ...ODD_ROUTING_FIXTURE_RELATIVE.split("/"));
const DELEGATION_PATH = join(REPO_ROOT, "assets", "orchestrator-delegation.md");
const CORE_PATH = join(REPO_ROOT, "assets", "orchestrator.md");
const EXTENSION_PATH = join(REPO_ROOT, "extensions", "gentle-ai.ts");

const readRepo = (absolutePath: string): string => readFileSync(absolutePath, "utf8");

// A mandatory-delegation semantic anchor: the clause the canonical block must
// still carry, plus the wording each pi mirror surface is expected to carry.
// A canonical change that drops `canonical` is caught here on regeneration
// because the fixture no longer carries it.
interface RoutingAnchor {
	label: string;
	canonical: string;
	mirrors: ReadonlyArray<{ surface: string; includes: string }>;
}

const DELEGATION = "assets/orchestrator-delegation.md";
const CORE = "assets/orchestrator.md";
const EXTENSION = "extensions/gentle-ai.ts";

const ANCHORS: readonly RoutingAnchor[] = [
	{
		label: "mandatory delegation triggers heading",
		canonical: "### Mandatory Delegation Triggers",
		mirrors: [
			{ surface: DELEGATION, includes: "#### Mandatory Delegation Triggers" },
			{ surface: CORE, includes: "Mandatory Delegation Triggers" },
		],
	},
	{
		label: "triggers are mandatory, not advisory",
		canonical: "These triggers are mandatory, not advisory.",
		mirrors: [
			{ surface: DELEGATION, includes: "These triggers are mandatory, not advisory." },
			{ surface: EXTENSION, includes: "These triggers are mandatory, not advisory" },
		],
	},
	{
		label: "stop and delegate through the runtime's subagent mechanism",
		canonical: "stop and delegate through the runtime's subagent mechanism before continuing",
		mirrors: [
			{ surface: DELEGATION, includes: "stop and delegate through the runtime's subagent mechanism before continuing" },
		],
	},
	{
		label: "executing past a fired trigger is a routing defect",
		canonical: "executing past a fired trigger inline is a routing defect even if the work succeeds",
		mirrors: [
			{ surface: DELEGATION, includes: "executing past a fired trigger inline is a routing defect even if the work succeeds" },
			{ surface: EXTENSION, includes: "executing past a fired trigger inline is a routing defect even if the work succeeds" },
		],
	},
	{
		label: "mapping trigger at 4 or more files",
		canonical: "**Mapping trigger:** when understanding the work requires 4 or more files",
		mirrors: [
			{ surface: DELEGATION, includes: "**Mapping trigger (4-file rule):** when understanding the work requires 4 or more files" },
			{ surface: CORE, includes: "**4-file rule** — 4+ files to understand" },
		],
	},
	{
		label: "writer trigger at 2 or more non-trivial files",
		canonical: "**Writer trigger:** when implementation touches 2 or more non-trivial files",
		mirrors: [
			{ surface: DELEGATION, includes: "**Writer trigger (Multi-file write rule):** when implementation touches 2 or more non-trivial files" },
			{ surface: CORE, includes: "**Multi-file write rule** — 2+ non-trivial files touched" },
		],
	},
	{
		label: "preparation trigger",
		canonical: "**Preparation trigger:**",
		mirrors: [{ surface: DELEGATION, includes: "**Preparation trigger:**" }],
	},
	{
		label: "long-session backstop",
		canonical: "**Long-session backstop:**",
		mirrors: [
			{ surface: DELEGATION, includes: "**Long-session backstop (Long-session rule):**" },
			{ surface: CORE, includes: "**Long-session rule** — ~20 tool calls, 5 exploratory reads, or 2 non-mechanical edits without delegation" },
		],
	},
	{
		label: "route declaration records the chosen route per task",
		canonical: "**Route declaration:**",
		mirrors: [
			{ surface: DELEGATION, includes: "record the chosen route per task" },
		],
	},
	{
		label: "triggers select only the ODD topology",
		canonical: "These triggers never select SDD and never create SDD artifacts",
		mirrors: [
			{ surface: DELEGATION, includes: "These triggers only choose between direct inline and delegated direct inside ODD" },
		],
	},
	{
		label: "ODD step 6 honors its mandatory delegation triggers",
		canonical: "honoring its mandatory delegation triggers",
		mirrors: [{ surface: EXTENSION, includes: "honoring its mandatory delegation triggers" }],
	},
];

// Condensed trigger rows that live only in the always-on core prompt; the
// canonical RenderRouting block does not carry the incident or verification
// rows, so they are mirror-only and not fixture-derived anchors.
const CORE_ONLY_TRIGGERS = [
	"**Incident rule** — diagnose wrong cwd/worktree/git/tooling incidents separately",
	"**Verification rule** — executing/delegating verification commands",
] as const;

function fixtureBody(): string {
	assert.ok(
		existsSync(FIXTURE_PATH),
		`missing canonical fixture ${ODD_ROUTING_FIXTURE_RELATIVE}; regenerate it with \`npm run mirror:odd-routing\``,
	);
	return parseOddRoutingFixture(readRepo(FIXTURE_PATH)).body;
}

// ---------------------------------------------------------------------------
// 1 — Fixture provenance readback
// ---------------------------------------------------------------------------

test("the canonical routing fixture exists with managed provenance (source repo, commit, digest)", () => {
	assert.ok(
		existsSync(FIXTURE_PATH),
		`missing canonical fixture ${ODD_ROUTING_FIXTURE_RELATIVE}; regenerate it with \`npm run mirror:odd-routing\``,
	);
	const { header } = parseOddRoutingFixture(readRepo(FIXTURE_PATH));
	assert.equal(header.source_repo, ODD_ROUTING_SOURCE_REPO);
	assert.equal(header.source_path, ODD_ROUTING_SOURCE_PATH);
	assert.match(header.source_commit ?? "", /^[0-9a-f]{40}$/, "fixture must record the gentle-ai source commit");
	assert.match(header.generated_at ?? "", /^\d{4}-\d{2}-\d{2}T/, "fixture must record a generation date");
	assert.match(header.block_sha256 ?? "", /^[0-9a-f]{64}$/, "fixture must record the block body digest");
});

test("the fixture digest matches its block body byte-for-byte", () => {
	const { header, body } = parseOddRoutingFixture(readRepo(FIXTURE_PATH));
	assert.equal(header.block_sha256, sha256Hex(body), "the fixture body was hand-edited without regenerating its digest");
});

// ---------------------------------------------------------------------------
// 2 — Canonical fixture carries every mandatory anchor
// ---------------------------------------------------------------------------

test("the canonical fixture carries every mandatory-delegation anchor", () => {
	const body = fixtureBody();
	for (const anchor of ANCHORS) {
		assert.ok(body.includes(anchor.canonical), `canonical fixture dropped anchor: ${anchor.label}`);
	}
});

// ---------------------------------------------------------------------------
// 3 — Every pi mirror surface carries the mapped anchor
// ---------------------------------------------------------------------------

test("the pi mirror surfaces carry every mapped mandatory-delegation anchor", () => {
	const surfaces: Record<string, string> = {
		[DELEGATION]: readRepo(DELEGATION_PATH),
		[CORE]: readRepo(CORE_PATH),
		[EXTENSION]: readRepo(EXTENSION_PATH),
	};
	for (const anchor of ANCHORS) {
		for (const mirror of anchor.mirrors) {
			const text = surfaces[mirror.surface];
			assert.ok(text !== undefined, `unknown mirror surface ${mirror.surface}`);
			assert.ok(
				text.includes(mirror.includes),
				`${mirror.surface} is missing the mirror of "${anchor.label}": ${JSON.stringify(mirror.includes)}`,
			);
		}
	}
});

test("the always-on core prompt carries the condensed incident and verification trigger rows", () => {
	const core = readRepo(CORE_PATH);
	for (const row of CORE_ONLY_TRIGGERS) {
		assert.ok(core.includes(row), `assets/orchestrator.md is missing condensed trigger row: ${JSON.stringify(row)}`);
	}
});

// ---------------------------------------------------------------------------
// 4 — Regeneration provenance: idempotent and fail-closed
// ---------------------------------------------------------------------------

// The fixture header claims provenance from the source commit, so regeneration
// must be byte-reproducible: the same gentle-ai commit must not produce a
// date-only diff. `generated_at` therefore tracks the source commit's committer
// date instead of wall-clock time.
test("fixture rendering is idempotent and derives generated_at from the source commit", () => {
	const sourceCommit = "e7729359fd9d6cb691ed2a88e8f72b1372f7c92e";
	const committerDate = "2026-09-18T13:49:03+02:00";
	const fakeGit = (args: readonly string[]): string => {
		switch (args[0]) {
			case "status":
				return "";
			case "rev-parse":
				return `${sourceCommit}\n`;
			case "show":
				return `${committerDate}\n`;
			default:
				throw new Error(`unexpected git invocation: ${args.join(" ")}`);
		}
	};
	const block = `${ODD_ROUTING_BLOCK_PREFIX}\n\n- a canonical clause\n`;
	const first = renderOddRoutingFixture(block, resolveOddRoutingProvenance("/fake/gentle-ai", fakeGit));
	const second = renderOddRoutingFixture(block, resolveOddRoutingProvenance("/fake/gentle-ai", fakeGit));
	assert.equal(first, second, "rendering the same source commit twice must be byte-identical");
	const { header } = parseOddRoutingFixture(first);
	assert.equal(header.source_commit, sourceCommit);
	assert.equal(
		header.generated_at,
		committerDate,
		"generated_at must track the source commit's committer date, not wall-clock time",
	);
});

// A dirty checkout would render uncommitted content under the committed
// provenance claim, so the mirror fails closed before rendering and names the
// tracked paths. Untracked files (the odd/tasks notes) must never block.
test("the mirror fails closed on a dirty source checkout and names the tracked paths", () => {
	const recordedCalls: string[][] = [];
	const cleanGit = (args: readonly string[]): string => {
		recordedCalls.push([...args]);
		switch (args[0]) {
			case "status":
				return "";
			case "rev-parse":
				return `${"a".repeat(40)}\n`;
			case "show":
				return "2026-09-18T13:49:03+02:00\n";
			default:
				throw new Error(`unexpected git invocation: ${args.join(" ")}`);
		}
	};
	resolveOddRoutingProvenance("/fake/gentle-ai", cleanGit);
	assert.deepEqual(
		recordedCalls.find((args) => args[0] === "status"),
		["status", "--porcelain", "--untracked-files=no"],
		"the dirty guard must ignore untracked files",
	);

	assert.doesNotThrow(() => assertCleanGentleAiCheckout(""));
	const dirtyGit = (args: readonly string[]): string => {
		if (args[0] === "status") {
			return " M internal/components/agentguidance/routing.go\n M scripts/other.mjs\n";
		}
		throw new Error(`unexpected git invocation: ${args.join(" ")}`);
	};
	assert.throws(
		() => resolveOddRoutingProvenance("/fake/gentle-ai", dirtyGit),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(
				error.message,
				/gentle-ai checkout is dirty; provenance would be unverifiable: internal\/components\/agentguidance\/routing\.go, scripts\/other\.mjs\. Commit or stash first\./,
			);
			return true;
		},
	);
});
