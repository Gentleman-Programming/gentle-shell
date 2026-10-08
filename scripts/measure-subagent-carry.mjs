#!/usr/bin/env node
// Measures what a running subagent's context costs, from the child session store.
//
// A subagent's provider bill is dominated by re-sending its own earlier tool output
// on every later call, not by the size of that output: built-in tools already cap a
// single result, while every later call re-reads everything accumulated before it.
//
// Model: for each child, sum the UTF-8 bytes of its persisted `toolResult` content
// and attribute the running total to every later `assistant` call in that same
// child. That cumulative total ("carry load") is what the provider re-reads per
// call, and comparing it with the one-time content total is the amplification.
//
// Read-only: it opens session transcripts and prints aggregates. No writes, no
// network, no dependencies.
//
// Usage: node scripts/measure-subagent-carry.mjs [--days N] [--top N] [--json]
//        [--home DIR]
//   --days  window in days, filtered by entry timestamp   (default 7)
//   --top   how many of the heaviest children to list     (default 5)
//   --home  agent home to read (default $GENTLE_PI_AGENT_HOME,
//           then $PI_CODING_AGENT_DIR, then ~/.pi/agent)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = argv.indexOf(`--${name}`);
	if (index === -1) return fallback;
	const value = Number(argv[index + 1]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
};

const days = flag("days", 7);
const top = flag("top", 5);
const asJson = argv.includes("--json");
const homeIndex = argv.indexOf("--home");
const agentHome = homeIndex === -1
	? process.env.GENTLE_PI_AGENT_HOME ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")
	: argv[homeIndex + 1];
const cutoff = Date.now() - days * 86_400_000;
const root = join(agentHome, "gentle-agents", "sessions");

function walk(dir) {
	const found = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...walk(path));
		else if (entry.name.endsWith(".jsonl")) found.push(path);
	}
	return found;
}

const utf8Bytes = (text) => Buffer.byteLength(text, "utf8");

// The text a message carries, whether it is a bare string or content parts. Only
// text is counted: images and other blocks are not re-sent as characters and would
// make the byte total mean something else.
function textBytes(message) {
	const content = message?.content;
	if (typeof content === "string") return utf8Bytes(content);
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const part of content) if (part && typeof part.text === "string") total += utf8Bytes(part.text);
	return total;
}

const children = [];
for (const file of walk(root)) {
	try {
		if (statSync(file).mtimeMs < cutoff) continue;
	} catch {
		continue;
	}
	let lines;
	try {
		lines = readFileSync(file, "utf8").split("\n");
	} catch {
		continue;
	}
	let unique = 0;
	let carry = 0;
	let calls = 0;
	let turns = 0;
	let tokens = 0;
	for (const line of lines) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = entry?.message;
		if (!message || typeof message !== "object") continue;
		const when = Number(entry.timestamp);
		if (Number.isFinite(when) && when < cutoff) continue;
		if (message.role === "toolResult") {
			unique += textBytes(message);
			calls += 1;
		} else if (message.role === "assistant") {
			turns += 1;
			// This call re-reads every tool result that preceded it in this child.
			carry += unique;
			const total = Number(message.usage?.totalTokens);
			if (Number.isFinite(total) && total > 0) tokens += total;
		}
	}
	if (calls > 0 || turns > 0) children.push({ id: file.slice(root.length + 1), unique, carry, calls, turns, tokens });
}

const total = (key) => children.reduce((sum, child) => sum + child[key], 0);
const unique = total("unique");
const carry = total("carry");
const tokens = total("tokens");
const summary = {
	days,
	agentHome,
	children: children.length,
	uniqueToolResultBytes: unique,
	carryLoadBytes: carry,
	amplification: unique > 0 ? Number((carry / unique).toFixed(1)) : 0,
	recordedTokens: tokens,
	heaviest: [...children].sort((a, b) => b.carry - a.carry).slice(0, top),
};

if (asJson) {
	console.log(JSON.stringify(summary, null, 2));
} else {
	// 4 bytes per token is a rough English-text ratio, useful to compare against the
	// provider's own numbers rather than as a measurement of them.
	const approxTokens = (value) => `${(value / 4 / 1_000_000).toFixed(1)}M`;
	console.log(`Subagent carry load, last ${days} day(s) — ${root}`);
	console.log(`children with activity      ${children.length}`);
	console.log(`unique tool-result content  ${unique.toLocaleString("en-US")} B (~${approxTokens(unique)} tokens)`);
	console.log(`cumulative carry load       ${carry.toLocaleString("en-US")} B (~${approxTokens(carry)} tokens)`);
	console.log(`amplification               ${summary.amplification}x`);
	console.log(`tokens recorded by the runs ${tokens.toLocaleString("en-US")}`);
	console.log("");
	console.log(`heaviest children (top ${summary.heaviest.length})`);
	for (const child of summary.heaviest) {
		console.log(`  ${child.carry.toLocaleString("en-US").padStart(14)} B carry  ${String(child.calls).padStart(5)} calls  ${String(child.turns).padStart(4)} turns  ${child.id}`);
	}
}
