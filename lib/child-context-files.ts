import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

// gentle-shell#1587: delegated children (GENTLE_PI_AGENTS_CHILD=1) load the
// same context files as the orchestrator, including gentle-ai managed blocks
// that bind themselves to the orchestrator only. Those blocks cost ~37k prefix
// tokens per child and give a worker orchestration rules it must not follow.
// This module removes exactly those blocks and keeps everything else. The
// primary session applies the same filter while Gentle Shell injects its own
// orchestrator prompt (extensions/gentle-ai.ts before_agent_start). Both
// paths also deduplicate the engram-protocol block: when more than one loaded
// file carries it, only the copy nearest to the working directory stays.
//
// gentle-shell#3097: the primary only drops a listed block whose text is
// already carried by the prompt it injects, because there the premise "the
// block duplicates what we inject" is checked rather than assumed. A user who
// wraps their own policy in an `orchestrator` block keeps it; a child, which
// receives no such prompt, keeps the original name-based drop.

export const ORCHESTRATOR_ONLY_MANAGED_BLOCKS = [
	"orchestrator",
	"sdd-orchestrator",
	"sdd-model-assignments",
	"agent-routing",
] as const;

export type OrchestratorOnlyManagedBlock = (typeof ORCHESTRATOR_ONLY_MANAGED_BLOCKS)[number];

// gentle-ai's managed memory protocol. It is deduplicated, never removed:
// a copy goes only when a nearer loaded context file carries it too.
export const ENGRAM_PROTOCOL_MANAGED_BLOCK = "engram-protocol";

export interface ManagedBlockFilterOptions {
	// Also drop engram-protocol blocks (a nearer file keeps its own copy).
	dropEngramProtocol?: boolean;
	// Text of the prompt the session actually receives. When given, a listed
	// block goes only if its normalized text is non-empty and contained in the
	// normalized prompt (gentle-shell#3097); otherwise it is kept where it is.
	// When absent, the block name alone decides, which is what a delegated
	// child relies on (gentle-shell#1587). The engram-protocol deduplication
	// above is not affected.
	injectedPrompt?: string;
}

export interface ContextFilesFilterOptions {
	// The session working directory; when known, only files on its ancestor
	// chain take part in the engram-protocol deduplication.
	cwd?: string;
	// Text of the prompt the session actually receives; see
	// ManagedBlockFilterOptions.injectedPrompt.
	injectedPrompt?: string;
}

export interface ContextFile {
	path: string;
	content: string;
}

export interface ManagedBlockFilterResult {
	content: string;
	removedBlocks: number;
	// True when markers were unbalanced, mismatched, or ambiguous and the
	// content was returned unchanged.
	failSafe: boolean;
	// Names of every managed block opened in the content (empty on fail-safe).
	blockNames: string[];
	// Names of the blocks actually dropped, in document order (empty on
	// fail-safe), so a caller can report the removal instead of it staying
	// silent.
	removedBlockNames: string[];
}

// One loaded file and the block names the filter dropped from it.
export interface DroppedManagedBlock {
	path: string;
	blockNames: string[];
}

export interface ChildContextFilesResult<T extends ContextFile> {
	files: T[];
	removedBlocks: number;
	removedBytes: number;
	failSafePaths: string[];
	// One entry per file that lost at least one block.
	droppedBlocks: DroppedManagedBlock[];
}

export interface ContextFileOptions {
	contextFiles?: ContextFile[];
}

const REMOVED_NAMES: ReadonlySet<string> = new Set(ORCHESTRATOR_ONLY_MANAGED_BLOCKS);
const REMOVED_NAMES_WITH_ENGRAM: ReadonlySet<string> = new Set([...ORCHESTRATOR_ONLY_MANAGED_BLOCKS, ENGRAM_PROTOCOL_MANAGED_BLOCK]);

function removedNames(options: ManagedBlockFilterOptions | undefined): ReadonlySet<string> {
	return options?.dropEngramProtocol === true ? REMOVED_NAMES_WITH_ENGRAM : REMOVED_NAMES;
}

// A managed marker counts only when it is alone on its line. Inline mentions
// (prose, inline code) and markers inside fenced code are plain text.
const MARKER_LINE = /^[ \t]*<!--[ \t]*(\/?)gentle-ai:([A-Za-z0-9][A-Za-z0-9._-]*)[ \t]*-->[ \t]*$/;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const BLANK_LINE = /^[ \t]*\r?\n?$/;

interface Line {
	text: string;
	// Index into `instances` of the innermost managed block owning this line
	// (marker lines are owned by the block they delimit), or null for unmanaged
	// text.
	owner: number | null;
}

interface ManagedBlockInstance {
	name: string;
	openLine: number;
	// Index of the closing marker line; a block left open fails safe before it
	// is ever read.
	closeLine: number;
}

function splitLines(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function unchanged(content: string): ManagedBlockFilterResult {
	return { content, removedBlocks: 0, failSafe: true, blockNames: [], removedBlockNames: [] };
}

// Collapse runs of whitespace to one space and trim, so a block and the prompt
// can be compared regardless of line breaks, indentation, or wrapping.
function normalizeBlockText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

// The text between a block's markers; the marker lines themselves are
// structural and are never quoted inside a prompt. Nested blocks are part of
// their parent's text.
function blockBody(lines: readonly Line[], instance: ManagedBlockInstance): string {
	let body = "";
	for (let index = instance.openLine + 1; index < instance.closeLine; index += 1) body += lines[index].text;
	return body;
}

export function filterOrchestratorOnlyBlocks(content: string, options?: ManagedBlockFilterOptions): ManagedBlockFilterResult {
	const removed = removedNames(options);
	const contentAware = typeof options?.injectedPrompt === "string" ? normalizeBlockText(options.injectedPrompt) : undefined;
	const lines: Line[] = [];
	const instances: ManagedBlockInstance[] = [];
	const stack: number[] = [];
	let fence: { char: string; length: number } | null = null;
	let sawMarker = false;
	const blockNames: string[] = [];

	for (const text of splitLines(content)) {
		const bare = text.replace(/\r?\n$/, "");
		const owner = stack.length > 0 ? stack[stack.length - 1] : null;
		const fenceMatch = FENCE_LINE.exec(bare);
		if (fence !== null) {
			if (fenceMatch !== null && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length && fenceMatch[2].trim() === "") {
				fence = null;
			}
			lines.push({ text, owner });
			continue;
		}
		if (fenceMatch !== null && !(fenceMatch[1][0] === "`" && fenceMatch[2].includes("`"))) {
			fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
			lines.push({ text, owner });
			continue;
		}
		const marker = MARKER_LINE.exec(bare);
		if (marker === null) {
			lines.push({ text, owner });
			continue;
		}
		sawMarker = true;
		const [, closing, name] = marker;
		if (closing === "") {
			// A block reopened inside itself is ambiguous: fail safe.
			if (stack.some((index) => instances[index].name === name)) return unchanged(content);
			instances.push({ name, openLine: lines.length, closeLine: -1 });
			stack.push(instances.length - 1);
			blockNames.push(name);
			lines.push({ text, owner: instances.length - 1 });
			continue;
		}
		if (stack.length === 0) return unchanged(content);
		const open = stack[stack.length - 1];
		if (instances[open].name !== name) return unchanged(content);
		instances[open].closeLine = lines.length;
		stack.pop();
		lines.push({ text, owner: open });
	}
	if (stack.length > 0) return unchanged(content);
	// A block is dropped per instance, so a kept block nested inside a dropped
	// parent is lifted out with its own markers. The engram-protocol copy is a
	// deduplication, never a duplicate of the prompt, so it stays name-based.
	const dropped = instances.map((instance) => {
		if (!removed.has(instance.name)) return false;
		if (contentAware === undefined || instance.name === ENGRAM_PROTOCOL_MANAGED_BLOCK) return true;
		const body = normalizeBlockText(blockBody(lines, instance));
		return body !== "" && contentAware.includes(body);
	});
	const removedBlockNames = instances.flatMap((instance, index) => (dropped[index] ? [instance.name] : []));
	if (!sawMarker || removedBlockNames.length === 0) return { content, removedBlocks: 0, failSafe: false, blockNames, removedBlockNames: [] };

	// Drop lines owned by a dropped block. Blank lines that directly follow a
	// removal collapse so at most one empty line remains at that seam; a
	// removal at the start or end of the file leaves no blank edge behind.
	const output: string[] = [];
	let trailingBlanks = 0;
	let afterRemoval = false;
	for (const line of lines) {
		if (line.owner !== null && dropped[line.owner]) {
			afterRemoval = true;
			continue;
		}
		const blank = BLANK_LINE.test(line.text);
		if (afterRemoval && blank && (output.length === 0 || trailingBlanks >= 1)) continue;
		if (!blank) afterRemoval = false;
		output.push(line.text);
		trailingBlanks = blank ? trailingBlanks + 1 : 0;
	}
	if (afterRemoval) {
		while (output.length > 0 && BLANK_LINE.test(output[output.length - 1])) output.pop();
	}
	return { content: output.join(""), removedBlocks: removedBlockNames.length, failSafe: false, blockNames, removedBlockNames };
}

export function stripOrchestratorOnlyBlocks(content: string): string {
	return filterOrchestratorOnlyBlocks(content).content;
}

const encoder = new TextEncoder();

function isStrictAncestor(ancestor: string, descendant: string): boolean {
	const rel = relative(ancestor, descendant);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isAncestorOrSelf(ancestor: string, descendant: string): boolean {
	return resolve(ancestor) === resolve(descendant) || isStrictAncestor(ancestor, descendant);
}

// Indexes of the files whose engram-protocol copy goes. Pi loads context
// files from the root toward the working directory (nearest last), so the
// nearest copy is the one in the deepest directory on the cwd chain. A copy
// goes only when its directory is a strict ancestor of that nearest copy's
// directory; two copies in the deepest directory, files off the chain, or a
// single copy are all kept.
function redundantEngramCopies(files: readonly ContextFile[], parsed: readonly ManagedBlockFilterResult[], cwd: string | undefined): Set<number> {
	const copies: Array<{ index: number; dir: string }> = [];
	files.forEach((file, index) => {
		if (!parsed[index].blockNames.includes(ENGRAM_PROTOCOL_MANAGED_BLOCK)) return;
		if (typeof file.path !== "string" || file.path === "" || !isAbsolute(file.path)) return;
		const dir = dirname(resolve(file.path));
		if (cwd !== undefined && !isAncestorOrSelf(dir, cwd)) return;
		copies.push({ index, dir });
	});
	const redundant = new Set<number>();
	if (copies.length < 2) return redundant;
	const deepest = copies.filter((copy) => !copies.some((other) => isStrictAncestor(copy.dir, other.dir)));
	if (deepest.length !== 1) return redundant;
	for (const copy of copies) if (isStrictAncestor(copy.dir, deepest[0].dir)) redundant.add(copy.index);
	return redundant;
}

// Returns filtered copies; the input array and its entries are never mutated.
export function filterChildContextFiles<T extends ContextFile>(files: readonly T[], options: ContextFilesFilterOptions = {}): ChildContextFilesResult<T> {
	const result: ChildContextFilesResult<T> = { files: [], removedBlocks: 0, removedBytes: 0, failSafePaths: [], droppedBlocks: [] };
	const promptOptions = typeof options.injectedPrompt === "string" ? { injectedPrompt: options.injectedPrompt } : undefined;
	// The first parse only discovers which files carry an engram-protocol copy.
	const parsed = files.map((file) => filterOrchestratorOnlyBlocks(file.content, promptOptions));
	const cwd = typeof options.cwd === "string" && isAbsolute(options.cwd) ? resolve(options.cwd) : undefined;
	const redundant = redundantEngramCopies(files, parsed, cwd);
	files.forEach((file, index) => {
		const filtered = redundant.has(index)
			? filterOrchestratorOnlyBlocks(file.content, { ...promptOptions, dropEngramProtocol: true })
			: parsed[index];
		if (filtered.failSafe) result.failSafePaths.push(file.path);
		if (filtered.removedBlockNames.length > 0) result.droppedBlocks.push({ path: file.path, blockNames: filtered.removedBlockNames });
		if (filtered.removedBlocks === 0) {
			result.files.push({ ...file });
			return;
		}
		result.removedBlocks += filtered.removedBlocks;
		result.removedBytes += encoder.encode(file.content).length - encoder.encode(filtered.content).length;
		result.files.push({ ...file, content: filtered.content });
	});
	return result;
}

// Replaces contextFiles on the SAME options object: pi-claude-bridge keeps a
// reference to it and rebuilds its prompt from its contextFiles. Never
// throws; on any error the original context files stay in place.
export function filterChildSessionContextFiles(
	options: ContextFileOptions | null | undefined,
	filterOptions?: ContextFilesFilterOptions,
): ChildContextFilesResult<ContextFile> | null {
	try {
		if (!options || !Array.isArray(options.contextFiles)) return null;
		const result = filterChildContextFiles(options.contextFiles, filterOptions);
		if (result.removedBlocks > 0) options.contextFiles = result.files;
		return result;
	} catch {
		return null;
	}
}
