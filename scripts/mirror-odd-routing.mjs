#!/usr/bin/env node
// ODD routing drift ratchet — canonical fixture regeneration.
//
// gentle-pi hand-mirrors the always-on ODD routing block rendered by gentle-ai
// `internal/components/agentguidance/routing.go` (RenderRouting). There is no
// automated sync, so a canonical change leaves the pi mirror stale with nothing
// catching it. This script renders the canonical block from a LOCAL gentle-ai
// checkout and vendors it into `fixtures/odd-routing-canonical.md` with managed
// provenance, where `tests/odd-routing-canonical-ratchet.test.ts` turns drift
// into a failing test.
//
// This script NEVER fetches anything from the network (GOPROXY=off), NEVER
// modifies the gentle-ai checkout beyond a transient temporary Go entrypoint
// that it always deletes, and NEVER touches the installer release pin
// (scripts/gentle-ai-installer.mjs INSTALLER_VERSION). Regeneration writes ONLY
// the fixture; it never auto-rewrites the pi mirror assets.
//
// Usage:
//   node scripts/mirror-odd-routing.mjs [--gentle-ai <path to local checkout>]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ODD_ROUTING_FIXTURE_RELATIVE = "fixtures/odd-routing-canonical.md";
export const ODD_ROUTING_SOURCE_REPO = "https://github.com/Gentleman-Programming/gentle-ai";
export const ODD_ROUTING_SOURCE_PATH = "internal/components/agentguidance/routing.go";
export const ODD_ROUTING_HEADER_OPEN = "<!-- gentle-pi:managed-odd-routing-canonical\n";
export const ODD_ROUTING_HEADER_CLOSE = "\n-->\n";
export const ODD_ROUTING_TEMP_DIR = "tmp-odd-routing-dump";
export const ODD_ROUTING_BLOCK_PREFIX = "## Implementation Routing";

const GO_ENTRYPOINT = `package main

import (
	"fmt"
	"os"

	"github.com/gentleman-programming/gentle-ai/v3/internal/components/agentguidance"
	"github.com/gentleman-programming/gentle-ai/v3/internal/model"
)

func main() {
	rendered, err := agentguidance.RenderRouting(model.AgentPi)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Print(rendered)
}
`;

export function sha256Hex(value) {
	return createHash("sha256").update(value).digest("hex");
}

export function parseOddRoutingFixture(raw) {
	if (!raw.startsWith(ODD_ROUTING_HEADER_OPEN)) {
		throw new Error(`fixture does not start with the managed header ${JSON.stringify(ODD_ROUTING_HEADER_OPEN)}`);
	}
	const headerEnd = raw.indexOf(ODD_ROUTING_HEADER_CLOSE, ODD_ROUTING_HEADER_OPEN.length);
	if (headerEnd === -1) {
		throw new Error(`fixture managed header is not terminated by ${JSON.stringify(ODD_ROUTING_HEADER_CLOSE)}`);
	}
	const headerText = raw.slice(ODD_ROUTING_HEADER_OPEN.length, headerEnd);
	const body = raw.slice(headerEnd + ODD_ROUTING_HEADER_CLOSE.length);
	const header = {};
	for (const line of headerText.split("\n")) {
		const separator = line.indexOf(": ");
		if (separator === -1) continue;
		header[line.slice(0, separator)] = line.slice(separator + 2);
	}
	return { header, body };
}

export function renderOddRoutingFixture(block, { sourceCommit, generatedAt }) {
	const body = block.endsWith("\n") ? block : `${block}\n`;
	const header = [
		ODD_ROUTING_HEADER_OPEN.trimEnd(),
		`source_repo: ${ODD_ROUTING_SOURCE_REPO}`,
		`source_path: ${ODD_ROUTING_SOURCE_PATH}`,
		`source_commit: ${sourceCommit}`,
		`generated_at: ${generatedAt}`,
		`block_sha256: ${sha256Hex(body)}`,
		"-->",
	].join("\n");
	return `${header}\n${body}`;
}

// `git status --porcelain --untracked-files=no` emits one `XY PATH` line per
// modified tracked file. Extract just the repository-relative path so the
// fail-closed error can name what would make provenance unverifiable.
export function parsePorcelainPaths(porcelainOutput) {
	return porcelainOutput
		.split("\n")
		.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
		.filter((line) => line.length > 0)
		.map((line) => line.slice(3).trim())
		.filter((path) => path.length > 0);
}

// Fail closed when the checkout carries uncommitted changes to tracked files.
// The fixture header asserts the rendered block came from the committed tree;
// rendering a dirty tree under that claim would make the provenance a lie.
// Untracked files never reach this guard because the git call excludes them.
export function assertCleanGentleAiCheckout(porcelainOutput) {
	const dirtyPaths = parsePorcelainPaths(porcelainOutput);
	if (dirtyPaths.length > 0) {
		throw new Error(
			`gentle-ai checkout is dirty; provenance would be unverifiable: ${dirtyPaths.join(", ")}. Commit or stash first.`,
		);
	}
}

function parseArguments(argv) {
	const values = { gentleAi: undefined };
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag !== "--gentle-ai" || value === undefined) {
			throw new Error("usage: node scripts/mirror-odd-routing.mjs [--gentle-ai <path to local checkout>]");
		}
		if (values.gentleAi !== undefined) throw new Error("duplicate --gentle-ai argument");
		values.gentleAi = value;
	}
	return values;
}

function requireGentleAiCheckout(gentleAiRoot) {
	if (!existsSync(gentleAiRoot)) {
		throw new Error(
			`no gentle-ai checkout at ${gentleAiRoot}; pass --gentle-ai <path> or clone ${ODD_ROUTING_SOURCE_REPO} as a sibling of gentle-pi`,
		);
	}
	const routingPath = join(gentleAiRoot, ...ODD_ROUTING_SOURCE_PATH.split("/"));
	if (!existsSync(routingPath)) {
		throw new Error(`not a gentle-ai checkout: missing ${routingPath}`);
	}
}

export function renderCanonicalRouting(gentleAiRoot) {
	const tempRoot = join(gentleAiRoot, ODD_ROUTING_TEMP_DIR);
	// Clear any stale temp entrypoint from a previous crash so the render is clean.
	rmSync(tempRoot, { recursive: true, force: true });
	mkdirSync(tempRoot, { recursive: true });
	try {
		writeFileSync(join(tempRoot, "main.go"), GO_ENTRYPOINT, { encoding: "utf8" });
		const rendered = execFileSync("go", ["run", `./${ODD_ROUTING_TEMP_DIR}`], {
			cwd: gentleAiRoot,
			encoding: "utf8",
			// GOPROXY=off fails closed instead of downloading: this script must
			// never touch the network.
			env: { ...process.env, GOPROXY: "off" },
			stdio: ["ignore", "pipe", "inherit"],
		});
		if (!rendered.startsWith(ODD_ROUTING_BLOCK_PREFIX)) {
			throw new Error(
				`RenderRouting(model.AgentPi) did not return the expected routing block (starts with ${JSON.stringify(ODD_ROUTING_BLOCK_PREFIX)})`,
			);
		}
		return rendered;
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

// Resolve fixture provenance from the committed gentle-ai tree. `generatedAt`
// is the committer date, not wall-clock time, so rendering the same commit
// twice yields byte-identical fixture files. `execGit` is injectable for tests.
export function resolveOddRoutingProvenance(gentleAiRoot, execGit) {
	const git = execGit ?? ((args) => execFileSync("git", args, { cwd: gentleAiRoot, encoding: "utf8" }));
	assertCleanGentleAiCheckout(git(["status", "--porcelain", "--untracked-files=no"]));
	return {
		sourceCommit: git(["rev-parse", "HEAD"]).trim(),
		generatedAt: git(["show", "-s", "--format=%cI", "HEAD"]).trim(),
	};
}

export function mirrorOddRouting(packageRoot, gentleAiRoot) {
	requireGentleAiCheckout(gentleAiRoot);
	// Resolve (and fail closed on dirty) provenance BEFORE rendering: the
	// transient Go entrypoint must not run against a tree whose commit hash the
	// fixture would misrepresent.
	const provenance = resolveOddRoutingProvenance(gentleAiRoot);
	const block = renderCanonicalRouting(gentleAiRoot);
	const contents = renderOddRoutingFixture(block, provenance);

	const fixturePath = join(resolve(packageRoot), ...ODD_ROUTING_FIXTURE_RELATIVE.split("/"));
	const previous = readPreviousFixture(fixturePath);
	mkdirSync(dirname(fixturePath), { recursive: true });

	// Atomic overwrite: write a sibling temp file, then rename it into place.
	const stagingPath = `${fixturePath}.tmp`;
	try {
		writeFileSync(stagingPath, contents, { encoding: "utf8" });
		renameSync(stagingPath, fixturePath);
	} finally {
		rmSync(stagingPath, { force: true });
	}

	const next = parseOddRoutingFixture(contents);
	return {
		fixturePath,
		sourceCommit: next.header.source_commit,
		blockSha256: next.header.block_sha256,
		changed: previous === undefined || previous.body !== next.body || previous.header.source_commit !== next.header.source_commit,
		previous,
	};
}

function readPreviousFixture(fixturePath) {
	if (!existsSync(fixturePath)) return undefined;
	const raw = readFileSync(fixturePath, "utf8");
	// Verify the existing fixture before clobbering it: an unparseable file is a
	// signal to inspect, not to silently overwrite.
	const parsed = parseOddRoutingFixture(raw);
	const recorded = parsed.header.block_sha256;
	const actual = sha256Hex(parsed.body);
	if (recorded !== undefined && recorded !== actual) {
		console.warn(`warning: existing fixture body does not match its recorded digest (${recorded}); regenerating from canonical`);
	}
	return parsed;
}

async function main() {
	const packageRoot = join(fileURLToPath(new URL("..", import.meta.url)));
	const { gentleAi } = parseArguments(process.argv.slice(2));
	const gentleAiRoot = resolve(gentleAi ?? join(packageRoot, "..", "gentle-ai"));
	const result = mirrorOddRouting(packageRoot, gentleAiRoot);
	console.log(`${result.changed ? "Wrote" : "Refreshed"} ${result.fixturePath}`);
	console.log(`source commit ${result.sourceCommit}; block sha256 ${result.blockSha256}`);
	if (result.previous !== undefined) {
		console.log(`previous commit ${result.previous.header.source_commit}; previous block sha256 ${result.previous.header.block_sha256}`);
	}
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
	await main();
}
