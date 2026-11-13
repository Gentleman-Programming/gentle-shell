// gentle-shell#1587: delegated children (GENTLE_PI_AGENTS_CHILD=1) load the
// same context files as the orchestrator, including gentle-ai managed blocks
// that bind themselves to the orchestrator only. Those blocks cost ~37k prefix
// tokens per child and give a worker orchestration rules it must not follow.
// This module removes exactly those blocks plus the engram-protocol memory
// block and keeps everything else. The primary session applies the same filter
// while Gentle Shell injects its own orchestrator prompt and gentle-engram
// injects its own MEMORY_INSTRUCTIONS (extensions/gentle-ai.ts
// before_agent_start). Only the injected context is filtered: every file on
// disk keeps its blocks byte-for-byte for runtimes that read them as workspace
// files and carry no runtime-injected equivalent (OpenClaw).
//
// gentle-shell#3097: an orchestrator-only block is dropped only when the prompt
// the session receives already carries its text, because there the premise
// "the block duplicates what we inject" is checked rather than assumed. A user
// who wraps their own policy in an `orchestrator` block keeps it; a child,
// which receives no such prompt, keeps the original name-based drop. The
// engram-protocol block is never content-checked: gentle-engram injects the
// equivalent instructions every turn, so every injected copy goes.

export const ORCHESTRATOR_ONLY_MANAGED_BLOCKS = [
	"orchestrator",
	"sdd-orchestrator",
	"sdd-model-assignments",
	"agent-routing",
] as const;

export type OrchestratorOnlyManagedBlock = (typeof ORCHESTRATOR_ONLY_MANAGED_BLOCKS)[number];

// gentle-ai's managed memory protocol. Dropped from injected context like an
// orchestrator-only block, but for a different reason: gentle-engram injects
// the equivalent instructions every turn, so the loaded copy is a duplicate
// that only adds session-start ceremony.
export const ENGRAM_PROTOCOL_MANAGED_BLOCK = "engram-protocol";

// Every managed block this filter removes from an injected context file.
const DROPPED_MANAGED_BLOCKS: ReadonlySet<string> = new Set([...ORCHESTRATOR_ONLY_MANAGED_BLOCKS, ENGRAM_PROTOCOL_MANAGED_BLOCK]);

export interface ManagedBlockFilterOptions {
	// Text of the prompt the session actually receives. When given, an
	// orchestrator-only block goes only if every one of its non-blank normalized
	// lines appears among the normalized lines of this prompt (gentle-shell#3097,
	// a line-set comparison rather than a substring, so a short body cannot match
	// by accident); otherwise it is kept where it is. When absent, the block name
	// alone decides, which is what a delegated child relies on
	// (gentle-shell#1587). The engram-protocol drop is name-based either way.
	injectedPrompt?: string;
}

export interface ContextFilesFilterOptions {
	// Accepted for call-site compatibility and no longer consulted: an
	// engram-protocol copy is dropped from every injected file, so no ancestor
	// chain decides between copies.
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

// Collapse runs of whitespace to one space and trim, so one block line and one
// prompt line compare regardless of indentation or internal spacing.
function normalizeLine(line: string): string {
	return line.replace(/\s+/g, " ").trim();
}

// The non-blank normalized lines of a text. Both the block body and the
// injected prompt go through this, so the duplicate check is a line-set
// comparison: line order and whitespace do not matter, but a line the prompt
// lacks keeps the block.
function normalizedLines(text: string): string[] {
	return splitLines(text).map(normalizeLine).filter((line) => line !== "");
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
	const contentAware = typeof options?.injectedPrompt === "string" ? new Set(normalizedLines(options.injectedPrompt)) : undefined;
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
	// parent is lifted out with its own markers. Only an orchestrator-only block
	// consults the injected prompt; the engram-protocol copy is a duplicate of
	// what gentle-engram injects, so it goes name-based.
	const dropped = instances.map((instance) => {
		if (!DROPPED_MANAGED_BLOCKS.has(instance.name)) return false;
		if (contentAware === undefined || instance.name === ENGRAM_PROTOCOL_MANAGED_BLOCK) return true;
		const bodyLines = normalizedLines(blockBody(lines, instance));
		return bodyLines.length > 0 && bodyLines.every((line) => contentAware.has(line));
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

// Returns filtered copies; the input array and its entries are never mutated.
export function filterChildContextFiles<T extends ContextFile>(files: readonly T[], options: ContextFilesFilterOptions = {}): ChildContextFilesResult<T> {
	const result: ChildContextFilesResult<T> = { files: [], removedBlocks: 0, removedBytes: 0, failSafePaths: [], droppedBlocks: [] };
	const promptOptions = typeof options.injectedPrompt === "string" ? { injectedPrompt: options.injectedPrompt } : undefined;
	for (const file of files) {
		const filtered = filterOrchestratorOnlyBlocks(file.content, promptOptions);
		if (filtered.failSafe) result.failSafePaths.push(file.path);
		if (filtered.removedBlockNames.length > 0) result.droppedBlocks.push({ path: file.path, blockNames: filtered.removedBlockNames });
		if (filtered.removedBlocks === 0) {
			result.files.push({ ...file });
			continue;
		}
		result.removedBlocks += filtered.removedBlocks;
		result.removedBytes += encoder.encode(file.content).length - encoder.encode(filtered.content).length;
		result.files.push({ ...file, content: filtered.content });
	}
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
