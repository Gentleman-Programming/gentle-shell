import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

// ---------------------------------------------------------------------------
// persona-single-channel migration test
//
// Freezes the pre-change wrapper (gentle-ai.ts) and orchestrator.md text as
// verbatim string-literal fixtures (from HEAD, BEFORE this change), then
// proves the union survives in the LIVE post-change combined injection
// (`__testing.buildGentlePrompt(persona)`, which calls `getOrchestratorPrompt()`
// internally and reads `assets/orchestrator.md` from disk, memoized for the
// lifetime of the process — see gentle-ai.ts:118-133).
//
// DO NOT edit the PRE_* fixtures to make this test pass — they document the
// pre-change reality. Only the canonical block (gentle-ai.ts / orchestrator.md)
// or the extraction/assertions below may change.
// ---------------------------------------------------------------------------

const orchestratorMdPath = fileURLToPath(
	new URL("../assets/orchestrator.md", import.meta.url),
);

function readOrchestratorMdRaw(): string {
	return readFileSync(orchestratorMdPath, "utf8");
}

// ---------------------------------------------------------------------------
// PRE_* fixtures — frozen verbatim from HEAD before this change
// ---------------------------------------------------------------------------

/** gentle-ai.ts :179-184 — wrapper Identity contract block, pre-change (438 B). */
const PRE_WRAPPER_IDENTITY_BLOCK = `Identity contract:
- If the user asks who or what you are, answer as el Gentleman, not as a generic assistant.
- Say you are a Pi-specific coding-agent harness with senior architect persona.
- Mention SDD/OpenSpec phase artifacts and subagents as core capabilities.
- Mention memory only when memory packages or callable memory tools are actually active; never invent persistent memory.
- Do not claim portability outside the Pi runtime.
`;

/** gentle-ai.ts :173-198 — full wrapper static template, pre-change, rendered for "gentleman". */
const PRE_WRAPPER_GENTLEMAN = `## el Gentleman Identity and Harness

Current persona mode: gentleman

You are el Gentleman: a Pi-specific coding-agent harness for controlled development work.

${PRE_WRAPPER_IDENTITY_BLOCK}
Persona:
- Be direct, technical, and concise.
- When the user writes Spanish, answer in natural Rioplatense Spanish with voseo.
- Act as a senior architect and teacher: concepts before code, no shortcuts.
- Treat AI as a tool directed by the human; never present yourself as a default chatbot.
- Push back when the user asks for code without enough context or understanding.
- Correct errors directly, explain why, and show the better path.

Language: natural Rioplatense Spanish with voseo when the user writes Spanish.

Harness principles:
- el Gentleman is not prompt engineering. It is runtime discipline around powerful agents.
- Prefer SDD/OpenSpec artifacts over floating chat context for non-trivial work.
- Clarify scope, constraints, acceptance criteria, and non-goals before implementation.
- Use subagents when available for exploration, planning, implementation, and review, while keeping one parent session responsible for orchestration.
- Keep writes single-threaded unless the user explicitly approves parallel write isolation.
- If tests exist, use strict TDD evidence: RED, GREEN, TRIANGULATE, REFACTOR.
- Protect the human reviewer: avoid oversized changes, surface review workload risk, and ask before turning one task into a large multi-area change.
- Never claim persistent memory is available because of this package. Memory is provided by separate packages or MCP tools when installed and callable.`;

/** gentle-ai.ts :173-198 — full wrapper static template, pre-change, rendered for "neutral". */
const PRE_WRAPPER_NEUTRAL = `## el Gentleman Identity and Harness

Current persona mode: neutral

You are el Gentleman: a Pi-specific coding-agent harness for controlled development work.

${PRE_WRAPPER_IDENTITY_BLOCK}
Persona:
- Be direct, technical, concise, warm, and professional.
- Always respond in the same language the user writes in.
- Do not use slang or regional expressions.
- When the user writes Spanish, use neutral/professional Spanish. Do NOT use voseo (vos tenés, vos querés, hacé, andá, etc.) or any regional conjugations.
- Act as a senior architect and teacher: concepts before code, no shortcuts.
- Treat AI as a tool directed by the human; never present yourself as a default chatbot.
- Push back when the user asks for code without enough context or understanding.
- Correct errors directly, explain why, and show the better path.

Language: neutral/professional Spanish when the user writes Spanish. Do NOT use voseo or Rioplatense regional expressions.

Harness principles:
- el Gentleman is not prompt engineering. It is runtime discipline around powerful agents.
- Prefer SDD/OpenSpec artifacts over floating chat context for non-trivial work.
- Clarify scope, constraints, acceptance criteria, and non-goals before implementation.
- Use subagents when available for exploration, planning, implementation, and review, while keeping one parent session responsible for orchestration.
- Keep writes single-threaded unless the user explicitly approves parallel write isolation.
- If tests exist, use strict TDD evidence: RED, GREEN, TRIANGULATE, REFACTOR.
- Protect the human reviewer: avoid oversized changes, surface review workload risk, and ask before turning one task into a large multi-area change.
- Never claim persistent memory is available because of this package. Memory is provided by separate packages or MCP tools when installed and callable.`;

/** orchestrator.md :5-21 — Identity Contract section, pre-change (831 B). */
const PRE_ORCH_IDENTITY = `## Identity Contract

You are el Gentleman: a Pi-specific coding-agent harness for controlled development work.

When the user asks who or what you are, answer with this meaning, translated into the user's language:

\`\`\`text
I am el Gentleman: a Pi-specific coding-agent harness for controlled development, with a senior architect persona. I work with SDD/OpenSpec when the task justifies it, coordinate subagents, use phase artifacts, run commands, and edit files. I am not a generic chatbot.
\`\`\`

Rules:

- Never introduce yourself as only "your assistant" or "the default assistant".
- Keep the response in the user's language and follow the currently selected persona mode.
- Mention persistent memory only when a memory package or callable memory tools are actually active.
- Do not claim portability outside the Pi runtime.

`;

/** orchestrator.md :28-42 — Language Boundary section, pre-change (2,117 B). */
const PRE_ORCH_LANGBOUNDARY = `## Language Boundary

User-facing conversation should stay in the user's language and follow the currently active persona mode. The active mode is stated in the \`Current persona mode:\` line in the identity/harness section of this system prompt — always honor it for language style.

Subagent-facing prompts should be written in English by default, even when the user speaks Spanish. Translate the user's request into concise English before delegation. This keeps token usage lower and gives built-in/project subagents a consistent operating language without changing the user-facing persona.

Generated technical artifacts — whether by the parent inline or by subagents — (code, code comments, UI copy, identifiers, commit messages, filenames, PR descriptions, tests, fixtures, SDD/OpenSpec files, delegated phase outputs, and repository-facing documentation) default to English, regardless of the user's conversation language or active persona. Override only when the user explicitly requests another language for that artifact, or when extending a project whose existing convention is non-English.

Public/contextual comments and replies are different from technical artifacts. When using \`comment-writer\` or drafting a human-facing GitHub, PR review, Slack, Discord, or async comment, write in the target context language by default. Spanish issue/thread -> Spanish comment. English thread -> English comment. Mixed context -> target message language. Explicit user language or tone override wins. Spanish comments default to neutral/professional Spanish unless the user or target context clearly calls for regional tone.

Exceptions:

- Preserve exact user quotes, UI copy, error messages, filenames, commands, and domain terms in their original language when they are evidence.
- Ask a subagent to produce Spanish only when its output is intended to be pasted directly to the user, a PR/comment/reply in Spanish, or Spanish-language product/documentation text.
- SDD/OpenSpec artifact content may follow the project's established language, but phase task instructions to subagents should still be English.
`;

// ---------------------------------------------------------------------------
// POST_* fixtures — exact text this change writes (design.md "Exact post-change
// text"), frozen here so the apply commit and this test move together.
// ---------------------------------------------------------------------------

/** design.md "Wrapper Identity contract" — replaces gentle-ai.ts :179-184 (817 B). */
const POST_WRAPPER_IDENTITY_BLOCK = `Identity contract:
- When the user asks who or what you are, answer as el Gentleman, not as a generic assistant, and never introduce yourself as only "your assistant" or "the default assistant". Convey this meaning, translated into the user's language: "I am el Gentleman: a Pi-specific coding-agent harness for controlled development, with a senior architect persona. I work with SDD/OpenSpec when the task justifies it, coordinate subagents, use phase artifacts, run commands, and edit files. I am not a generic chatbot."
- Follow the currently selected persona mode.
- Mention SDD/OpenSpec phase artifacts and subagents as core capabilities.
- Mention memory only when memory packages or callable memory tools are actually active; never invent persistent memory.
- Do not claim portability outside the Pi runtime.
`;

/** New clause folded into GENTLEMAN_PERSONA_PROMPT, mirrors NEUTRAL_PERSONA_PROMPT :158. */
const NEW_GENTLEMAN_LANGUAGE_CLAUSE =
	"- Always respond in the same language the user writes in.";

/** design.md "orchestrator.md `## Identity Contract`" — replaces orchestrator.md :5-21. */
const POST_ORCH_IDENTITY = `## Identity Contract

Defined once in the identity/harness section injected above (the \`Current persona mode:\` line). Honor it; do not restate here.
`;

/** design.md "orchestrator.md `## Language Boundary`" — LB1 pointer + LB2-LB5 verbatim, replaces orchestrator.md :28-42. */
const POST_ORCH_LANGBOUNDARY = `## Language Boundary

Reply-language style and the active persona's Spanish variant are defined once in the identity/harness section above (its \`Current persona mode:\` line). The rules below are delegation/artifact-scoped and not restated there:

Subagent-facing prompts should be written in English by default, even when the user speaks Spanish. Translate the user's request into concise English before delegation. This keeps token usage lower and gives built-in/project subagents a consistent operating language without changing the user-facing persona.

Generated technical artifacts — whether by the parent inline or by subagents — (code, code comments, UI copy, identifiers, commit messages, filenames, PR descriptions, tests, fixtures, SDD/OpenSpec files, delegated phase outputs, and repository-facing documentation) default to English, regardless of the user's conversation language or active persona. Override only when the user explicitly requests another language for that artifact, or when extending a project whose existing convention is non-English.

Public/contextual comments and replies are different from technical artifacts. When using \`comment-writer\` or drafting a human-facing GitHub, PR review, Slack, Discord, or async comment, write in the target context language by default. Spanish issue/thread -> Spanish comment. English thread -> English comment. Mixed context -> target message language. Explicit user language or tone override wins. Spanish comments default to neutral/professional Spanish unless the user or target context clearly calls for regional tone.

Exceptions:

- Preserve exact user quotes, UI copy, error messages, filenames, commands, and domain terms in their original language when they are evidence.
- Ask a subagent to produce Spanish only when its output is intended to be pasted directly to the user, a PR/comment/reply in Spanish, or Spanish-language product/documentation text.
- SDD/OpenSpec artifact content may follow the project's established language, but phase task instructions to subagents should still be English.
`;

// ---------------------------------------------------------------------------
// Byte-size constants (EXT-005) — repeated byte literals grouped by fixture
// instead of duplicated magic numbers across the integrity and byte-delta
// assertions below. Each constant is annotated with the fixture/pairing it
// measures; see the PRE_*/POST_* fixtures above for the underlying text.
// ---------------------------------------------------------------------------

const PRE_WRAPPER_BYTES = 438; // PRE_WRAPPER_IDENTITY_BLOCK
const POST_WRAPPER_BYTES = 817; // POST_WRAPPER_IDENTITY_BLOCK
const WRAPPER_IDENTITY_DELTA_BYTES = 379; // POST_WRAPPER_BYTES - PRE_WRAPPER_BYTES

const PRE_ORCH_IDENTITY_BYTES = 831; // PRE_ORCH_IDENTITY
const ORCH_IDENTITY_DELTA_BYTES = 682; // PRE_ORCH_IDENTITY_BYTES - POST_ORCH_IDENTITY (149 B)

const PRE_ORCH_LANGBOUNDARY_BYTES = 2117; // PRE_ORCH_LANGBOUNDARY

const GENTLEMAN_NET_DELTA_BYTES = -283; // section-sum method, gentleman mode
const NEUTRAL_NET_DELTA_BYTES = -341; // section-sum method, neutral mode

// ---------------------------------------------------------------------------
// Frozen fixture integrity — self-check the transcription against the design's
// judge-measured byte counts (design.md "Byte estimates" table). If these
// fail, the fixture above was transcribed incorrectly — fix the fixture, not
// this assertion.
// ---------------------------------------------------------------------------

test("fixture integrity: PRE byte counts match design.md judge-measured figures", () => {
	assert.equal(
		Buffer.byteLength(PRE_WRAPPER_IDENTITY_BLOCK),
		PRE_WRAPPER_BYTES,
		"PRE_WRAPPER_IDENTITY_BLOCK must equal the judge-measured 438 B (gentle-ai.ts:179-184)",
	);
	assert.equal(
		Buffer.byteLength(PRE_ORCH_IDENTITY),
		PRE_ORCH_IDENTITY_BYTES,
		"PRE_ORCH_IDENTITY must equal the judge-measured 831 B (orchestrator.md:5-21)",
	);
	assert.equal(
		Buffer.byteLength(PRE_ORCH_LANGBOUNDARY),
		PRE_ORCH_LANGBOUNDARY_BYTES,
		"PRE_ORCH_LANGBOUNDARY must equal the judge-measured 2,117 B (orchestrator.md:28-42)",
	);
});

test("fixture integrity: POST_WRAPPER_IDENTITY_BLOCK matches design.md converged 817 B", () => {
	assert.equal(
		Buffer.byteLength(POST_WRAPPER_IDENTITY_BLOCK),
		POST_WRAPPER_BYTES,
		"POST_WRAPPER_IDENTITY_BLOCK must equal the round-2/round-3 converged 817 B",
	);
});

// ---------------------------------------------------------------------------
// Line-level union sweep — one named assertion per Table A / Table B rule.
// Verifies survival (VERBATIM / MERGED / POINTER) in the LIVE post-change
// combined injection: __testing.buildGentlePrompt(persona).
// ---------------------------------------------------------------------------

test("Table A rule: wrapper :177 'You are el Gentleman...' survives verbatim (KEEP once, wrapper)", () => {
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona);
		assert.match(
			prompt,
			/You are el Gentleman: a Pi-specific coding-agent harness for controlled development work\./,
			`[${persona}] wrapper :177 opening sentence must survive`,
		);
	}
});

test("Table A rule: wrapper :180/:181 + orchestrator :9,:12 self-description MERGE into wrapper bullet 1", () => {
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona);
		assert.match(
			prompt,
			/answer as el Gentleman, not as a generic assistant/,
			`[${persona}] merged bullet must keep 'answer as el Gentleman, not as a generic assistant' (subsumes wrapper :180)`,
		);
		assert.match(
			prompt,
			/senior architect persona/,
			`[${persona}] merged bullet must keep 'senior architect persona' (subsumes wrapper :181)`,
		);
		assert.match(
			prompt,
			/I am el Gentleman: a Pi-specific coding-agent harness for controlled development, with a senior architect persona\. I run Organic Driven Development by default and SDD\/OpenSpec when explicitly selected, coordinate subagents, use phase artifacts, run commands, and edit files\. I am not a generic chatbot\./,
			`[${persona}] the richer translated self-description paragraph (orchestrator :9,:12) must survive in the wrapper`,
		);
	}
});

test("Table A rule: orchestrator :17 'never introduce yourself...' ADDED to wrapper (orchestrator-only rule)", () => {
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona);
		assert.match(
			prompt,
			/never introduce yourself as only "your assistant" or "the default assistant"/,
			`[${persona}] orchestrator :17 rule must be added to the wrapper`,
		);
	}
});

test("Table A rule: persona-mode selection (trimmed) survives; language clause NOT restated in Identity contract", () => {
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona);
		assert.match(
			prompt,
			/Follow the currently selected persona mode\./,
			`[${persona}] trimmed persona-mode-selection rule must survive (orchestrator :18, language clause dropped)`,
		);
	}
});

test("Table A rule: SDD/OpenSpec artifacts + subagents core-capabilities bullet survives (KEEP once)", () => {
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona);
		assert.match(
			prompt,
			/Mention ODD as the default workflow, SDD\/OpenSpec phase artifacts, and subagents as core capabilities\./,
			`[${persona}] wrapper :182 rule must survive`,
		);
	}
});

test("Table A rule: memory rule (wrapper phrasing, with never-invent clause) survives (KEEP wrapper)", () => {
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona);
		assert.match(
			prompt,
			/Mention memory only when memory packages or callable memory tools are actually active; never invent persistent memory\./,
			`[${persona}] wrapper :183 memory rule (with never-invent) must survive`,
		);
	}
});

test("Table A rule: 'Do not claim portability outside the Pi runtime.' survives (KEEP once, byte-identical wrapper :184 / orchestrator :20)", () => {
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona);
		assert.match(
			prompt,
			/Do not claim portability outside the Pi runtime\./,
			`[${persona}] portability rule must survive`,
		);
	}
});

test("Table B rule: LB2 subagent-English delegation kept verbatim in orchestrator (unique)", () => {
	// orchestrator-lazy-diet: LB2 moved verbatim to
	// assets/orchestrator-delegation.md (delegation-scoped rule); the always-on
	// combined injection now only carries a pointer to it. Union read so this
	// assertion is repointed, not weakened.
	const delegationDetail = readFileSync(
		fileURLToPath(new URL("../assets/orchestrator-delegation.md", import.meta.url)),
		"utf8",
	);
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona) + delegationDetail;
		assert.match(
			prompt,
			/Subagent-facing prompts should be written in English by default, even when the user speaks Spanish\./,
			`[${persona}] LB2 must remain verbatim`,
		);
	}
});

test("Table B rule: LB3 artifacts-English kept verbatim in orchestrator (unique)", () => {
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona);
		assert.match(
			prompt,
			/Generated technical artifacts — whether by the parent inline or by subagents/,
			`[${persona}] LB3 must remain verbatim`,
		);
	}
});

test("Table B rule: LB4 public-comment target language kept verbatim in orchestrator (unique)", () => {
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona);
		assert.match(
			prompt,
			/Public\/contextual comments and replies are different from technical artifacts\./,
			`[${persona}] LB4 must remain verbatim`,
		);
	}
});

test("Table B rule: LB5 exceptions kept verbatim in orchestrator (unique)", () => {
	// orchestrator-lazy-diet: LB5 moved verbatim to
	// assets/orchestrator-delegation.md (delegation-scoped exceptions); the
	// always-on combined injection now only carries a pointer to it. Union
	// read so this assertion is repointed, not weakened.
	const delegationDetail = readFileSync(
		fileURLToPath(new URL("../assets/orchestrator-delegation.md", import.meta.url)),
		"utf8",
	);
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona) + delegationDetail;
		assert.match(
			prompt,
			/Preserve exact user quotes, UI copy, error messages, filenames, commands, and domain terms in their original language when they are evidence\./,
			`[${persona}] LB5 exceptions bullet 1 must remain verbatim`,
		);
		assert.match(
			prompt,
			/Ask a subagent to produce Spanish only when its output is intended to be pasted directly to the user/,
			`[${persona}] LB5 exceptions bullet 2 must remain verbatim`,
		);
		assert.match(
			prompt,
			/SDD\/OpenSpec artifact content may follow the project's established language/,
			`[${persona}] LB5 exceptions bullet 3 must remain verbatim`,
		);
	}
});

test("orchestrator.md Identity Contract collapses to the one-line pointer (post-change)", () => {
	const raw = readOrchestratorMdRaw();
	assert.ok(
		raw.includes(POST_ORCH_IDENTITY.trim()),
		"orchestrator.md must contain the exact Identity Contract pointer text from design.md",
	);
});

test("orchestrator.md Language Boundary LB1 collapses to the one-line pointer; LB2-LB5 remain verbatim (post-change)", () => {
	const raw = readOrchestratorMdRaw();
	assert.ok(
		raw.includes(
			"Reply-language style and the active persona's Spanish variant are defined once in the identity/harness section above",
		),
		"orchestrator.md must contain the LB1 pointer text from design.md",
	);
});

// ---------------------------------------------------------------------------
// Duplication guard (exact-string) — task 1.3
// ---------------------------------------------------------------------------

function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

test("dup guard (exact-string): 'Do not claim portability outside the Pi runtime.' occurs exactly once", () => {
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona);
		assert.equal(
			countOccurrences(prompt, "Do not claim portability outside the Pi runtime."),
			1,
			`[${persona}] portability rule must occur exactly once in the combined injection`,
		);
	}
});

test("dup guard (exact-string): identity self-description sentence occurs exactly once", () => {
	const selfDescription =
		"I am el Gentleman: a Pi-specific coding-agent harness for controlled development, with a senior architect persona. I run Organic Driven Development by default and SDD/OpenSpec when explicitly selected, coordinate subagents, use phase artifacts, run commands, and edit files. I am not a generic chatbot.";
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona);
		assert.equal(
			countOccurrences(prompt, selfDescription),
			1,
			`[${persona}] self-description sentence must occur exactly once in the combined injection`,
		);
	}
});

test("dup guard (exact-string): LB2/LB3/LB4 each occur exactly once", () => {
	// orchestrator-lazy-diet: LB2 moved verbatim to
	// assets/orchestrator-delegation.md (delegation-scoped rule, absent from
	// the always-on combined injection by design — see "No Double-Delivery").
	// LB3/LB4 stay verbatim in the always-on core. Union read for LB2 so the
	// "exactly once" guard is repointed to its new home, not weakened.
	const delegationDetail = readFileSync(
		fileURLToPath(new URL("../assets/orchestrator-delegation.md", import.meta.url)),
		"utf8",
	);
	const lb2 =
		"Subagent-facing prompts should be written in English by default, even when the user speaks Spanish.";
	const lb3 =
		"Generated technical artifacts — whether by the parent inline or by subagents";
	const lb4 =
		"Public/contextual comments and replies are different from technical artifacts.";
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona);
		assert.equal(
			countOccurrences(prompt + delegationDetail, lb2),
			1,
			`[${persona}] LB2 must occur exactly once`,
		);
		assert.equal(countOccurrences(prompt, lb3), 1, `[${persona}] LB3 must occur exactly once`);
		assert.equal(countOccurrences(prompt, lb4), 1, `[${persona}] LB4 must occur exactly once`);
	}
});

// ---------------------------------------------------------------------------
// Duplication guard (concept-level) — task 1.4, closes JD-001's paraphrase gap.
//
// Regex catches phrasings of "the user's language" / "the same language" —
// this is intentionally BROADER than an exact-string match so it also catches
// the self-description conveyance clause ("... translated into the user's
// language: ..."). That specific clause is a documented, SCOPED EXCEPTION
// (see design.md "Exact post-change text" note, round-2 judge finding): it is
// a self-description conveyance directive, not a general reply-language rule,
// so it is excluded from the count below.
// ---------------------------------------------------------------------------

const LANGUAGE_MATCH_CONCEPT_RE = /user'?s\s+language|same\s+language/gi;
const SCOPED_EXCEPTION_PHRASE = "translated into the user's language";

function countLanguageMatchConceptOccurrences(text: string): number {
	const rawMatches = text.match(LANGUAGE_MATCH_CONCEPT_RE) ?? [];
	const exceptionOccurrences = countOccurrences(text, SCOPED_EXCEPTION_PHRASE);
	return rawMatches.length - exceptionOccurrences;
}

test("dup guard (concept-level): language-match regex matches exactly once per rendered mode, excluding the scoped self-description exception", () => {
	const gentlemanPrompt = __testing.buildGentlePrompt("gentleman");
	const neutralPrompt = __testing.buildGentlePrompt("neutral");
	assert.equal(
		countLanguageMatchConceptOccurrences(gentlemanPrompt),
		1,
		"gentleman mode must have exactly one non-excepted language-match concept occurrence",
	);
	assert.equal(
		countLanguageMatchConceptOccurrences(neutralPrompt),
		1,
		"neutral mode must have exactly one non-excepted language-match concept occurrence",
	);
});

// ---------------------------------------------------------------------------
// Added-rule assertion — task 1.5
// ---------------------------------------------------------------------------

test("added rule: gentleman output contains the new GENTLEMAN_PERSONA_PROMPT language-match clause", () => {
	const prompt = __testing.buildGentlePrompt("gentleman");
	assert.match(
		prompt,
		/Always respond in the same language the user writes in\./,
		"gentleman prompt must contain the new language-match clause mirroring NEUTRAL_PERSONA_PROMPT :158",
	);
});

test("regression: neutral output still contains its own unchanged language-match clause (:158)", () => {
	const prompt = __testing.buildGentlePrompt("neutral");
	assert.match(
		prompt,
		/Always respond in the same language the user writes in\./,
		"neutral prompt must keep its own :158 language-match clause",
	);
});

// ---------------------------------------------------------------------------
// Byte-delta assertion — task 1.6 / 4.3. Values below are the ACTUAL measured
// wc -c deltas (recorded in openspec/changes/persona-single-channel/
// byte-measurements.md), superseding the design's estimates where they
// differ by more than rounding.
// ---------------------------------------------------------------------------

test("byte delta: wrapper Identity contract block grows by the measured delta (post > pre)", () => {
	const pre = Buffer.byteLength(PRE_WRAPPER_IDENTITY_BLOCK);
	const post = Buffer.byteLength(POST_WRAPPER_IDENTITY_BLOCK);
	assert.equal(pre, PRE_WRAPPER_BYTES, "pre wrapper Identity block must be 438 B");
	assert.equal(post, POST_WRAPPER_BYTES, "post wrapper Identity block must be 817 B");
	assert.equal(post - pre, WRAPPER_IDENTITY_DELTA_BYTES, "wrapper Identity block delta must be +379 B");
});

test("byte delta: orchestrator.md Identity Contract shrinks to the measured pointer size (149 B, ±1 B of design's 148 B estimate)", () => {
	const pre = Buffer.byteLength(PRE_ORCH_IDENTITY);
	const post = Buffer.byteLength(POST_ORCH_IDENTITY);
	assert.equal(pre, PRE_ORCH_IDENTITY_BYTES, "pre orchestrator Identity Contract must be 831 B");
	assert.equal(post, 149, "post orchestrator Identity Contract must be 149 B (measured, see byte-measurements.md)");
	assert.equal(pre - post, ORCH_IDENTITY_DELTA_BYTES, "orchestrator Identity Contract delta must be -682 B");
});

test("byte delta: orchestrator.md Language Boundary LB1->pointer shrinks by the measured 38 B (LB2-LB5 unchanged)", () => {
	const pre = Buffer.byteLength(PRE_ORCH_LANGBOUNDARY);
	const post = Buffer.byteLength(POST_ORCH_LANGBOUNDARY);
	assert.equal(pre, PRE_ORCH_LANGBOUNDARY_BYTES, "pre orchestrator Language Boundary must be 2,117 B");
	assert.equal(post, 2079, "post orchestrator Language Boundary must be 2,079 B (measured, see byte-measurements.md)");
	assert.equal(pre - post, 38, "orchestrator Language Boundary delta must be -38 B (262 B LB1 sentence -> 224 B pointer)");
});

test("byte delta: new GENTLEMAN_PERSONA_PROMPT clause is present and small (single added line)", () => {
	assert.equal(
		Buffer.byteLength(`${NEW_GENTLEMAN_LANGUAGE_CLAUSE}\n`),
		58,
		"the added gentleman language-match clause line must be 58 B (measured, ~60 B design estimate)",
	);
});

test("byte delta: net per-session injection delta matches byte-measurements.md (gentleman -283 B, neutral -341 B, section-sum method)", () => {
	// Section-sum method (fixture-derived, internally consistent). Whole-file `wc -c` on the
	// two edited files gives -282 B / -340 B — 1 B off, a trailing-newline/range-boundary
	// counting-convention artifact between `bat --line-range` section extraction and whole-file
	// `wc -c`, documented in byte-measurements.md. Both are within the design's converged
	// "≈ -0.3 KB" range.
	const wrapperDelta =
		Buffer.byteLength(POST_WRAPPER_IDENTITY_BLOCK) - Buffer.byteLength(PRE_WRAPPER_IDENTITY_BLOCK);
	const orchDelta =
		Buffer.byteLength(POST_ORCH_IDENTITY) -
		Buffer.byteLength(PRE_ORCH_IDENTITY) +
		(Buffer.byteLength(POST_ORCH_LANGBOUNDARY) - Buffer.byteLength(PRE_ORCH_LANGBOUNDARY));
	const gentlemanClauseDelta = Buffer.byteLength(`${NEW_GENTLEMAN_LANGUAGE_CLAUSE}\n`);
	assert.equal(
		wrapperDelta + orchDelta + gentlemanClauseDelta,
		GENTLEMAN_NET_DELTA_BYTES,
		"gentleman net per-session injection delta must be -283 B (section-sum method)",
	);
	assert.equal(
		wrapperDelta + orchDelta,
		NEUTRAL_NET_DELTA_BYTES,
		"neutral net per-session injection delta must be -341 B (section-sum method, no persona-prompt change)",
	);
});

// ---------------------------------------------------------------------------
// Requirement: Persona Constant Selection Keeps Working
// ---------------------------------------------------------------------------

test("gentleman persona selected: GENTLEMAN_PERSONA_PROMPT content appears once, no neutral-only rule leaks in", () => {
	const prompt = __testing.buildGentlePrompt("gentleman");
	assert.match(prompt, /Current persona mode: gentleman/);
	assert.match(prompt, /answer in natural Rioplatense Spanish with voseo/i);
	assert.doesNotMatch(
		prompt,
		/Do NOT use voseo \(vos ten[eé]s/i,
		"gentleman prompt must not leak the neutral-only voseo prohibition bullet",
	);
});

test("neutral persona selected: NEUTRAL_PERSONA_PROMPT content appears once, no gentleman-only rule leaks in", () => {
	const prompt = __testing.buildGentlePrompt("neutral");
	assert.match(prompt, /Current persona mode: neutral/);
	assert.match(prompt, /Do NOT use voseo/i);
	assert.doesNotMatch(
		prompt,
		/answer in natural Rioplatense Spanish with voseo/i,
		"neutral prompt must not leak the gentleman-only voseo instruction",
	);
});
