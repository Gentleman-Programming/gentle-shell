// gentle-shell#1587: delegated children (GENTLE_PI_AGENTS_CHILD=1) load the
// same context files as the orchestrator, including gentle-ai managed blocks
// that bind themselves to the orchestrator only. Those blocks cost ~37k prefix
// tokens per child and give a worker orchestration rules it must not follow.
// This module removes exactly those blocks and keeps everything else.

export const ORCHESTRATOR_ONLY_MANAGED_BLOCKS = [
	"orchestrator",
	"sdd-orchestrator",
	"sdd-model-assignments",
	"agent-routing",
] as const;

export type OrchestratorOnlyManagedBlock = (typeof ORCHESTRATOR_ONLY_MANAGED_BLOCKS)[number];

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
}

export interface ChildContextFilesResult<T extends ContextFile> {
	files: T[];
	removedBlocks: number;
	removedBytes: number;
	failSafePaths: string[];
}

export interface ContextFileOptions {
	contextFiles?: ContextFile[];
}

const REMOVED_NAMES: ReadonlySet<string> = new Set(ORCHESTRATOR_ONLY_MANAGED_BLOCKS);

// A managed marker counts only when it is alone on its line. Inline mentions
// (prose, inline code) and markers inside fenced code are plain text.
const MARKER_LINE = /^[ \t]*<!--[ \t]*(\/?)gentle-ai:([A-Za-z0-9][A-Za-z0-9._-]*)[ \t]*-->[ \t]*$/;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const BLANK_LINE = /^[ \t]*\r?\n?$/;

interface Line {
	text: string;
	// Name of the innermost managed block owning this line (marker lines are
	// owned by the block they delimit), or null for unmanaged text.
	owner: string | null;
}

function splitLines(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function unchanged(content: string): ManagedBlockFilterResult {
	return { content, removedBlocks: 0, failSafe: true };
}

export function filterOrchestratorOnlyBlocks(content: string): ManagedBlockFilterResult {
	const lines: Line[] = [];
	const stack: string[] = [];
	let fence: { char: string; length: number } | null = null;
	let removedBlocks = 0;
	let sawMarker = false;

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
			if (stack.includes(name)) return unchanged(content);
			stack.push(name);
			if (REMOVED_NAMES.has(name)) removedBlocks += 1;
			lines.push({ text, owner: name });
			continue;
		}
		if (stack.length === 0 || stack[stack.length - 1] !== name) return unchanged(content);
		stack.pop();
		lines.push({ text, owner: name });
	}
	if (stack.length > 0) return unchanged(content);
	if (!sawMarker || removedBlocks === 0) return { content, removedBlocks: 0, failSafe: false };

	// Drop lines owned by a removed block. Blank lines that directly follow a
	// removal collapse so at most one empty line remains at that seam; a
	// removal at the start or end of the file leaves no blank edge behind.
	const output: string[] = [];
	let trailingBlanks = 0;
	let afterRemoval = false;
	for (const line of lines) {
		if (line.owner !== null && REMOVED_NAMES.has(line.owner)) {
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
	return { content: output.join(""), removedBlocks, failSafe: false };
}

export function stripOrchestratorOnlyBlocks(content: string): string {
	return filterOrchestratorOnlyBlocks(content).content;
}

const encoder = new TextEncoder();

// Returns filtered copies; the input array and its entries are never mutated.
export function filterChildContextFiles<T extends ContextFile>(files: readonly T[]): ChildContextFilesResult<T> {
	const result: ChildContextFilesResult<T> = { files: [], removedBlocks: 0, removedBytes: 0, failSafePaths: [] };
	for (const file of files) {
		const filtered = filterOrchestratorOnlyBlocks(file.content);
		if (filtered.failSafe) result.failSafePaths.push(file.path);
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
export function filterChildSessionContextFiles(options: ContextFileOptions | null | undefined): ChildContextFilesResult<ContextFile> | null {
	try {
		if (!options || !Array.isArray(options.contextFiles)) return null;
		const result = filterChildContextFiles(options.contextFiles);
		if (result.removedBlocks > 0) options.contextFiles = result.files;
		return result;
	} catch {
		return null;
	}
}
