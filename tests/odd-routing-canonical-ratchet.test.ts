import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import { PI_RUNTIME_IDENTITY, ROUTING_REQUIRED_SINCE_MINOR, verifyProviderContractBundleTree } from "../lib/provider-contract-bundle.ts";
import { PROVIDER_CONTRACT_LOCK_FILE, PROVIDER_CONTRACT_MIRROR_ROOT } from "../scripts/mirror-provider-contract.mjs";

// ---------------------------------------------------------------------------
// ODD routing drift ratchet (gentle-pi#1147 follow-up)
//
// gentle-ai renders the always-on ODD routing block for Pi
// (`internal/components/agentguidance/routing.go`) and publishes it in the
// provider contract bundle as `routing/pi.md` (contract 1.4.0). The mirrored
// bundle (`contracts/review-provider-contract-mirror/`, refreshed with
// `scripts/mirror-provider-contract.mjs`) is the canonical reference: the
// harness ODD steps are rendered from it, and this ratchet fails when a
// mandatory-delegation clause is dropped either from the canonical block or
// from a Pi surface that restates it (the `assets/orchestrator*.md` modules
// stay Pi's own and keep their anchors).
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, "..");
const MIRROR_ROOT = join(REPO_ROOT, ...PROVIDER_CONTRACT_MIRROR_ROOT.split("/"));
const DELEGATION_PATH = join(REPO_ROOT, "assets", "orchestrator-delegation.md");
const CORE_PATH = join(REPO_ROOT, "assets", "orchestrator.md");

const readRepo = (absolutePath: string): string => readFileSync(absolutePath, "utf8");

// A mandatory-delegation semantic anchor: the clause the canonical block must
// still carry, plus the wording each pi mirror surface is expected to carry.
// A canonical change that drops `canonical` is caught here once the bundle is re-mirrored
// because the mirrored routing block no longer carries it.
interface RoutingAnchor {
	label: string;
	canonical: string;
	mirrors: ReadonlyArray<{ surface: string; includes: string }>;
}

const DELEGATION = "assets/orchestrator-delegation.md";
const CORE = "assets/orchestrator.md";
// The harness prompt rendered by extensions/gentle-ai.ts, including the ODD
// steps it takes from the mirrored routing/pi.md.
const EXTENSION = "rendered harness prompt";

const ANCHORS: readonly RoutingAnchor[] = [
	{
		// S9 canon change (gentle-ai 87a3b2eb): the heading dropped "Mandatory";
		// a trigger is mandatory only once its condition truly holds.
		label: "delegation triggers heading",
		canonical: "### Delegation Triggers",
		mirrors: [
			{ surface: DELEGATION, includes: "#### Delegation Triggers" },
			// Writer-rule fix: the core names them "Delegation Triggers" and says
			// each holds only when its condition truly holds; the lazy port keeps
			// the canonical heading.
			{ surface: CORE, includes: "Delegation Triggers — each mechanism turns on only when its own trigger condition truly holds" },
		],
	},
	{
		// S9 canon change: "These triggers are mandatory, not advisory." read as a
		// default to delegate (L8); a trigger now holds only when its condition
		// truly holds, none by default, inline when in doubt.
		label: "triggers hold only when their condition truly holds",
		canonical: "Each trigger holds only when its condition truly holds, and only then is it mandatory, not advisory; no trigger holds by default, and when in doubt work inline.",
		mirrors: [
			{ surface: DELEGATION, includes: "Each trigger holds only when its condition truly holds, and only then is it mandatory, not advisory; no trigger holds by default, and when in doubt work inline." },
			{ surface: EXTENSION, includes: "No trigger holds by default and, when in doubt, work inline" },
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
		label: "mapping trigger when understanding exceeds the evidence budget",
		canonical: "**Mapping trigger:** when understanding exceeds the inline batch budget",
		// gentle-ai#5139 replaced the 4-file count with the evidence budget;
		// gentle-ai#5218 scoped it to understanding (gentle-shell#1494).
		mirrors: [
			{ surface: DELEGATION, includes: "**Mapping trigger (Evidence-budget rule):** read inline only when the evidence fits one parallel batch of at most 3 calls" },
			{ surface: CORE, includes: "**Evidence-budget rule** — understanding needs more than one read batch" },
		],
	},
	{
		// S9 canon change: exploration never reads files an inline write reads anyway.
		label: "never explore to read files an inline write reads anyway",
		canonical: "Never explore to read files you will read anyway before writing inline.",
		mirrors: [
			{ surface: DELEGATION, includes: "Never explore to read files you will read anyway before writing inline." },
			{ surface: CORE, includes: "never for reading before an inline write" },
		],
	},
	{
		label: "writer trigger fires only for a named reason, never by size or file count",
		// S9 canon change (gentle-ai 87a3b2eb): the canon caught up with Gentle
		// Shell (gentle-shell#1731): the writer fires on named reasons
		// (parallelism, context), never on size alone or a price ratio.
		canonical: "**Writer trigger:** a writer is delegated only for a named reason, one bounded writer per unit",
		mirrors: [
			{ surface: DELEGATION, includes: "**Writer trigger (Writer rule):** a large task alone never delegates, and file count never fires this trigger" },
			{ surface: CORE, includes: "**Writer rule** — never by file count or a large task alone" },
		],
	},
	{
		// S9 canon change: a writer unit is one independent behavior with its
		// code, tests, and docs together, never split across writers.
		label: "a writer unit is one independent behavior",
		canonical: "A unit is one independent piece of behavior with its code, tests, and docs together",
		mirrors: [
			{ surface: DELEGATION, includes: "A unit is one independent piece of behavior with its code, tests, and docs together" },
			{ surface: CORE, includes: "Tests, docs, and code of the same behavior are one unit, never separate writers" },
		],
	},
	{
		// S9 canon change: a unit qualifies only with several minutes of work,
		// because a subagent spends one to two minutes reading before it writes.
		label: "a writer unit needs several minutes of work",
		canonical: "several files or roughly 100+ changed lines",
		mirrors: [
			{ surface: DELEGATION, includes: "several files or ~100+ changed lines; a subagent spends 1-2 minutes reading before it writes" },
			{ surface: CORE, includes: "several files or roughly 100+ changed lines" },
		],
	},
	{
		// S9 canon change (gentle-ai c3763aa7, C3): whoever writes reuses the
		// existing shared-state helper and keeps its invariants.
		label: "writers reuse the existing shared-state function",
		canonical: "reuses the existing function for shared state",
		mirrors: [
			{ surface: DELEGATION, includes: "reuses the existing function for shared state and keeps its invariants (ordering, uniqueness, validation, normalization)" },
		],
	},
	{
		// S9 canon change (gentle-ai c3763aa7, C8): PRESERVE diffs each existing
		// command that shares the changed code against the previous code.
		label: "differential check against the previous code",
		canonical: "run a differential check",
		mirrors: [
			{ surface: DELEGATION, includes: "**Differential check (PRESERVE):**" },
			// weak-model-economy S2: the harness gates the check on shared code an unnamed command uses.
			{ surface: EXTENSION, includes: "run one differential check" },
		],
	},
	{
		label: "task size decides the route (gentle-shell#1494)",
		canonical: "### Task Size",
		mirrors: [
			{ surface: CORE, includes: "## Task Size" },
			{ surface: EXTENSION, includes: "Size the task by the orchestrator's Task Size section" },
		],
	},
	{
		label: "verification trigger is reserved for a named high-risk item",
		// S9 canon change (gentle-ai 6b9a71ef): only a change whose Risk line
		// names a high-risk item gets the independent verifier.
		canonical: "**Verification trigger:** only a change whose Risk line names a high-risk item gets an independent verifier",
		mirrors: [
			// Verification by named risk: the core row names the escalate-only verifier.
			{ surface: CORE, includes: "**Verification rule** — only a named high-risk item (assess `escalate`) → independent `gentle-ai-verify`" },
			{ surface: DELEGATION, includes: "only a change whose Risk line names a high-risk item (Task Size, assess `escalate`) gets an independent `gentle-ai-verify` run" },
		],
	},
	{
		label: "tracking trigger is reserved for large tasks",
		canonical: "**Tracking trigger:** a large task gets the feature document",
		mirrors: [
			{ surface: CORE, includes: "**Track** — large task → feature document" },
			{ surface: DELEGATION, includes: "**Track:** a large task gets the feature document" },
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
		// Gentle Shell intentionally leads the canon here: a parent-context token
		// backstop replaces the tool-call count (tracked by gentle-ai#5139), and the
		// runtime measures it and signals it instead of the canon's advisory ~150k
		// estimate (harness roadmap R1), so the Pi anchor names the runtime signal.
		mirrors: [
			{ surface: DELEGATION, includes: "**Context backstop:** when the runtime signals it" },
			{ surface: CORE, includes: "**Context backstop** — when the runtime signals it" },
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
		canonical: "These triggers only choose between direct inline and delegated direct inside the organic flow",
		mirrors: [
			{ surface: DELEGATION, includes: "These triggers only choose between direct inline and delegated direct inside ODD" },
		],
	},
	{
		label: "handoffs pass the feature spec by reference (gentle-shell#1713)",
		canonical: "Hand off by reference, never by paraphrase: name the document, task, and specs",
		mirrors: [
			{ surface: EXTENSION, includes: "Hand off by reference, never by paraphrase: name the document, task, and specs" },
		],
	},
	{
		label: "verify runs only authorized examples on isolated state",
		canonical: "runs the spec's examples the parent authorized, against isolated state when they mutate data",
		mirrors: [
			{ surface: EXTENSION, includes: "runs the spec's examples the parent authorized, against isolated state when they mutate data" },
		],
	},
	{
		// S9 canon change: step 6 honors its triggers only when their conditions truly hold.
		label: "ODD step 6 honors its delegation triggers when their conditions hold",
		canonical: "honoring its delegation triggers when their conditions truly hold",
		mirrors: [{ surface: EXTENSION, includes: "honoring its delegation triggers when their conditions truly hold" }],
	},
];

// Condensed trigger rows that live only in the always-on core prompt; the
// canonical RenderRouting block does not carry the incident or verification
// rows, so they are mirror-only and not anchors of the canonical routing block.
const CORE_ONLY_TRIGGERS = [
	"**Incident rule** — diagnose wrong cwd/worktree/git/tooling incidents separately",
	"**Verification rule** — only a named high-risk item (assess `escalate`) → independent `gentle-ai-verify`",
] as const;

// The verified mirrored routing/pi.md: the bundle tree must pass the strict
// decoder, so a hand edit to the canonical block fails here as well as in
// `pnpm run check:provider-contract`.
function canonicalRoutingBlock(): string {
	const lock = JSON.parse(readFileSync(join(MIRROR_ROOT, PROVIDER_CONTRACT_LOCK_FILE), "utf8")) as { contract_semver: string };
	const bundle = verifyProviderContractBundleTree(join(MIRROR_ROOT, `v${lock.contract_semver}`, "bundle"));
	const block = bundle.routing.get(PI_RUNTIME_IDENTITY);
	assert.ok(block !== undefined, `the mirrored provider contract ${bundle.contractSemver} carries no routing/${PI_RUNTIME_IDENTITY}.md`);
	return block;
}

// ---------------------------------------------------------------------------
// 1 — The canonical reference is the verified mirrored bundle
// ---------------------------------------------------------------------------

test("the canonical routing reference is the verified mirrored routing/pi.md (contract >= 1.4.0)", () => {
	const lock = JSON.parse(readFileSync(join(MIRROR_ROOT, PROVIDER_CONTRACT_LOCK_FILE), "utf8")) as { contract_semver: string; entries: Record<string, string> };
	const [major, minor] = lock.contract_semver.split(".").map(Number);
	assert.ok(major === 1 && (minor ?? 0) >= ROUTING_REQUIRED_SINCE_MINOR, `mirrored contract ${lock.contract_semver} predates routing`);
	assert.match(lock.entries[`routing/${PI_RUNTIME_IDENTITY}.md`] ?? "", /^[0-9a-f]{64}$/);
	assert.ok(canonicalRoutingBlock().startsWith("## Implementation Routing\n"));
});

// ---------------------------------------------------------------------------
// 2 — The canonical block carries every mandatory anchor
// ---------------------------------------------------------------------------

test("the canonical routing block carries every mandatory-delegation anchor", () => {
	const body = canonicalRoutingBlock();
	for (const anchor of ANCHORS) {
		assert.ok(body.includes(anchor.canonical), `canonical routing block dropped anchor: ${anchor.label}`);
	}
});

// ---------------------------------------------------------------------------
// 3 — Every pi mirror surface carries the mapped anchor
// ---------------------------------------------------------------------------

test("the pi mirror surfaces carry every mapped mandatory-delegation anchor", () => {
	const surfaces: Record<string, string> = {
		[DELEGATION]: readRepo(DELEGATION_PATH),
		[CORE]: readRepo(CORE_PATH),
		[EXTENSION]: __testing.buildGentlePrompt("gentleman"),
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
