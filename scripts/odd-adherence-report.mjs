#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

class UsageError extends Error {}

function parseArgs(argv) {
	let logPath = join(process.env.HOME || homedir(), ".gentle-ai", "odd-adherence.jsonl");
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument !== "--log") throw new UsageError(`Unknown argument: ${argument}`);
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) throw new UsageError("--log requires a path");
		logPath = resolve(value);
		index += 1;
	}
	return logPath;
}

function percent(numerator, denominator) {
	return `${denominator === 0 ? "0.0" : ((numerator / denominator) * 100).toFixed(1)}%`;
}

function validRecord(value) {
	return value && typeof value === "object" && value.v === 1
		&& typeof value.ts === "string" && typeof value.session === "string" && typeof value.repo === "string"
		&& typeof value.provider === "string" && Number.isInteger(value.turn)
		&& Number.isInteger(value.tool_calls) && Number.isInteger(value.reads) && Number.isInteger(value.edits)
		&& Number.isInteger(value.distinct_paths) && Number.isInteger(value.delegations)
		&& typeof value.blocked === "boolean" && value.backstops && typeof value.backstops === "object";
}

function readRecords(logPath) {
	if (!existsSync(logPath)) {
		console.log(`No adherence log found at ${logPath}.`);
		return [];
	}
	let contents;
	try {
		contents = readFileSync(logPath, "utf8");
	} catch (error) {
		console.log(`Could not read adherence log at ${logPath}: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
	const records = [];
	let malformed = 0;
	for (const line of contents.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line);
			if (!validRecord(value)) malformed += 1;
			else records.push(value);
		} catch {
			malformed += 1;
		}
	}
	if (malformed > 0) console.log(`Ignored ${malformed} malformed adherence log line${malformed === 1 ? "" : "s"}.`);
	if (records.length === 0) {
		console.log("No valid adherence records to report.");
		return [];
	}
	return records;
}

function reportMetrics(records) {
	const editTurns = records.filter((record) => record.edits > 0);
	const triggerTurns = editTurns.filter((record) => record.distinct_paths >= 2);
	const violations = editTurns.filter((record) => record.distinct_paths >= 2 && record.delegations === 0);
	const refusals = records.filter((record) => record.blocked === true);
	const followedThrough = refusals.filter((record) => record.delegations > 0);
	console.log(`Turns: ${records.length}`);
	console.log(`Writer-trigger fire rate: ${percent(triggerTurns.length, editTurns.length)} (${triggerTurns.length}/${editTurns.length} edit turns; distinct_paths >= 2)`);
	console.log(`Violation rate: ${percent(violations.length, editTurns.length)} (${violations.length}/${editTurns.length} edit turns; 2+ distinct paths with no delegation)`);
	console.log(`Follow-through after refusal: ${percent(followedThrough.length, refusals.length)} (${followedThrough.length}/${refusals.length} refused turns delegated afterward)`);
	for (const [name, key, threshold] of [["tool calls", "tool_calls", ">=20"], ["reads", "reads", ">=5"], ["edits", "edits", ">=2"]]) {
		const crossed = records.filter((record) => record.backstops[key] === true);
		console.log(`Backstop ${name} ${threshold}: ${percent(crossed.length, records.length)} (${crossed.length}/${records.length} turns)`);
	}
	const providers = new Map();
	for (const record of records) providers.set(record.provider, (providers.get(record.provider) ?? 0) + 1);
	console.log("Provider split:");
	for (const [provider, count] of providers) console.log(`  ${provider}: ${count} (${percent(count, records.length)})`);
}

function repositoryRoot() {
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim() || undefined;
	} catch {
		return undefined;
	}
}

function reportRoutes(records) {
	const root = repositoryRoot();
	if (!root) return;
	const tasksRoot = join(root, "odd", "tasks");
	if (!existsSync(tasksRoot)) return;
	const routes = [];
	for (const name of readdirSync(tasksRoot).filter((entry) => entry.endsWith(".md"))) {
		const path = join(tasksRoot, name);
		try {
			if (!statSync(path).isFile()) continue;
			const text = readFileSync(path, "utf8");
			const id = text.match(/\*\*([^*\n]+?)\s+—/)?.[1]?.trim() ?? name;
			const route = text.match(/^\s*-\s*Route:\s*(.+)$/im)?.[1]?.trim();
			if (route) routes.push({ id, route });
		} catch {
			// A task file that disappears or cannot be read is not a telemetry failure.
		}
	}
	if (routes.length === 0) return;
	const observedDelegations = records.reduce((sum, record) => sum + record.delegations, 0);
	console.log("ODD route declarations joined with observed delegation counts:");
	for (const { id, route } of routes) console.log(`  ${id}: ${route} | observed delegations in log: ${observedDelegations}`);
}

function main() {
	let logPath;
	try {
		logPath = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(`Usage error: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
	const records = readRecords(logPath);
	if (records.length === 0) return 0;
	reportMetrics(records);
	reportRoutes(records);
	return 0;
}

process.exitCode = main();
