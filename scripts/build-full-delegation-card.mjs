#!/usr/bin/env node
// Builds assets/orchestrator-full-delegation-card.md, the lazy card a full
// delegation session reads instead of the organic delegation and writer cards.
//
// Full delegation mode must never put an organic routing rule ("small work stays
// inline", "a large task alone never delegates") in front of the orchestrator,
// but it still needs the rules both modes share: handoff language, launch
// checks, allowed edit surfaces, background policy, the closing block. Those rules
// keep exactly one source, the organic assets that contract tests already pin;
// this script projects the shared sections out of them, so the card can never
// drift into a second, diverging copy.
//
// Every selection and every pointer rewrite throws when its anchor is missing:
// a source edit that moves an anchor must fail the drift check loudly, never
// produce a silently incomplete card.
//
// Usage: node scripts/build-full-delegation-card.mjs --write | --check

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FULL_DELEGATION_CARD = "orchestrator-full-delegation-card.md";

const HEADING = /^#{1,6} /;

function requireIncludes(text, anchor, source) {
	if (!text.includes(anchor)) throw new Error(`${source}: anchor not found: ${JSON.stringify(anchor)}`);
}

/** The lines of one section, from its heading to the next heading of any level, trimmed of blank edges. */
function section(text, heading, source) {
	const lines = text.split("\n");
	const start = lines.indexOf(heading);
	if (start === -1) throw new Error(`${source}: heading not found: ${JSON.stringify(heading)}`);
	const body = [];
	for (const line of lines.slice(start + 1)) {
		if (HEADING.test(line)) break;
		body.push(line);
	}
	while (body.length > 0 && body[0] === "") body.shift();
	while (body.length > 0 && body.at(-1) === "") body.pop();
	return body.join("\n");
}

/** The first heading after the given heading's section starts. */
function headingAfter(text, heading, source) {
	const lines = text.split("\n");
	const start = lines.indexOf(heading);
	if (start === -1) throw new Error(`${source}: heading not found: ${JSON.stringify(heading)}`);
	const next = lines.slice(start + 1).find((line) => HEADING.test(line));
	if (next === undefined) throw new Error(`${source}: no heading follows ${JSON.stringify(heading)}`);
	return next;
}

/** One paragraph line, selected by its exact leading text. */
function paragraph(text, prefix, source) {
	const line = text.split("\n").find((candidate) => candidate.startsWith(prefix));
	if (line === undefined) throw new Error(`${source}: paragraph not found: ${JSON.stringify(prefix)}`);
	return line;
}

/** The marked block, markers included, so its own consumers keep recognizing it. */
function marked(text, name, source) {
	const open = `<!-- ${name} -->`;
	const close = `<!-- /${name} -->`;
	const start = text.indexOf(open);
	const end = text.indexOf(close);
	if (start === -1 || end <= start) throw new Error(`${source}: marked block not found: ${name}`);
	return text.slice(start, end + close.length);
}

/** Apply exact rewrites, each of which must find its anchor. */
function rewrite(text, replacements, source) {
	let result = text;
	for (const [from, to] of replacements) {
		requireIncludes(result, from, source);
		result = result.replace(from, to);
	}
	return result;
}

export function renderFullDelegationCard(assetsDir) {
	const delegationSource = "orchestrator-delegation.md";
	const writerSource = "orchestrator-writer.md";
	const referenceSource = "orchestrator-delegation-reference.md";
	const delegation = readFileSync(join(assetsDir, delegationSource), "utf8");
	const writer = readFileSync(join(assetsDir, writerSource), "utf8");
	const reference = readFileSync(join(assetsDir, referenceSource), "utf8");

	// The card is self-contained: pointers back to the organic cards would send a
	// full delegation session straight into the rules this card exists to keep out.
	const handoff = rewrite(section(delegation, "## Handoff", delegationSource), [
		[" (language domain detail: reference)", ""],
		["via `orchestrator_session_id` (reference).", "via `orchestrator_session_id`."],
	], delegationSource);
	const invariants = rewrite(paragraph(delegation, "**Invariants:**", delegationSource), [
		["whoever writes, inline or delegated, reuses", "the writer reuses"],
		[" (`orchestrator-writer.md`)", ""],
	], delegationSource);
	const differential = paragraph(delegation, "**Differential check (PRESERVE):**", delegationSource);
	const launch = rewrite(section(delegation, "## Launch", delegationSource), [
		[" before launching a writer (`orchestrator-writer.md`).", " before launching a writer (below)."],
		["Otherwise run in the foreground. Detail: reference.", "Otherwise run in the foreground. Detail: below."],
		["report the capability gap; a fired trigger is never replaced by inline work.", "report the capability gap; never do the work yourself instead."],
	], delegationSource);
	const surfaces = section(writer, "#### Allowed edit surfaces (MANDATORY)", writerSource);
	const background = marked(reference, "gentle-pi:background-subagents", referenceSource);
	// The closing-block section is selected by position, as the heading that follows
	// the launch section, and its heading text is copied from the source. Pi runtime
	// code must never carry the block's name (tests/delegated-key-learnings-contract
	// .test.ts): this script copies documentation, it never reads model output.
	const closingHeading = headingAfter(delegation, "## Launch", delegationSource);
	const closing = section(delegation, closingHeading, delegationSource);

	return [
		"# Orchestrator — Full Delegation Card (lazy-loaded)",
		"",
		// The comment names the script, never the organic source cards: anything this
		// card names is something a full delegation session may go and read.
		"<!-- Generated by scripts/build-full-delegation-card.mjs. Do not edit; run it with --write. -->",
		"",
		"Parent Pi session only, in full delegation mode: every authorized change goes to a bounded writer. These are the handoff, launch, edit-surface and background rules both workflow modes share.",
		"",
		"## Handoff",
		"",
		handoff,
		"",
		invariants,
		"",
		differential,
		"",
		"## Launch",
		"",
		launch,
		"",
		"#### Allowed edit surfaces (MANDATORY)",
		"",
		surfaces,
		"",
		background,
		"",
		closingHeading,
		"",
		closing,
		"",
	].join("\n");
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
	const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
	const target = join(assetsDir, FULL_DELEGATION_CARD);
	const rendered = renderFullDelegationCard(assetsDir);
	const mode = process.argv[2];
	if (mode === "--write") {
		writeFileSync(target, rendered);
		process.stdout.write(`wrote assets/${FULL_DELEGATION_CARD}\n`);
	} else if (mode === "--check") {
		let current = "";
		try {
			current = readFileSync(target, "utf8");
		} catch {
			current = "";
		}
		if (current !== rendered) {
			process.stderr.write(`assets/${FULL_DELEGATION_CARD} is out of date with its sources; run node scripts/build-full-delegation-card.mjs --write\n`);
			process.exit(1);
		}
		process.stdout.write(`assets/${FULL_DELEGATION_CARD} is up to date\n`);
	} else {
		process.stderr.write("usage: node scripts/build-full-delegation-card.mjs --write | --check\n");
		process.exit(2);
	}
}
