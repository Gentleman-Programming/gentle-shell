// gentle-ai appends managed blocks (guidance sections) to the files it
// installs. Those blocks are not part of a published asset body, so a body
// carrying one never matches a shipped body and the installer freezes the file
// as a local edit. This module splits an installed agent into the base body and
// the recognised managed blocks so the body can be compared and refreshed, then
// re-attaches the blocks verbatim. It is comparison-only: a stripped body is
// never written.
//
// Unlike the prompt-assembly reader in ./child-context-files.ts, nothing here
// normalises bytes: no blank-line collapsing at the seam, no trimming, so the
// base body of an untouched install still hashes to the shipped body.

// Same marker shape as ./child-context-files.ts: a managed marker counts only
// when it is alone on its line.
const MARKER_LINE = /^[ \t]*<!--[ \t]*(\/?)gentle-ai:([A-Za-z0-9][A-Za-z0-9._-]*)[ \t]*-->[ \t]*$/;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const BLANK_LINE = /^[ \t]*$/;

export type ManagedBlockFailSafeReason =
	| "unbalanced-markers"
	| "stray-closing-marker"
	| "mismatched-closing-marker"
	| "nested-block-name";

export interface ManagedBlock {
	/** Block name from the opening marker. */
	readonly name: string;
	/**
	 * Verbatim text removed from the base: the blank separation lines directly
	 * before the opening marker plus the marker lines through the closing
	 * marker line, exactly as they appeared.
	 */
	readonly text: string;
	/**
	 * Base lines that followed this block. Re-attachment inserts the block before
	 * those lines, so an unchanged base restores the exact original position and a
	 * block appended to the body stays at the end of a refreshed body.
	 */
	readonly trailingLines: number;
}

export interface ManagedBlockSplit {
	/** The input with every top-level recognised block (and its seam) removed. */
	readonly content: string;
	/** Top-level blocks in document order; empty when nothing was stripped. */
	readonly blocks: readonly ManagedBlock[];
	/** True when at least one block was removed. */
	readonly stripped: boolean;
	/** Set when a marker layout this module cannot trust disabled stripping. */
	readonly failSafe?: ManagedBlockFailSafeReason;
}

interface PendingBlock {
	readonly name: string;
	readonly seam: number;
	readonly parts: string[];
}

function splitLines(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function failSafe(content: string, reason: ManagedBlockFailSafeReason): ManagedBlockSplit {
	return { content, blocks: [], stripped: false, failSafe: reason };
}

/**
 * Splits installed content into its base body and its top-level managed blocks.
 *
 * A marker layout that cannot be trusted (unclosed, stray closing, mismatched,
 * or a name reopened inside itself) returns the input unchanged with `failSafe`
 * set, so the caller falls back to whole-file comparison. Markers inside fenced
 * code and markers that are not alone on their line are plain text, like the
 * prompt-assembly reader in ./child-context-files.ts.
 */
export function splitManagedBlocks(content: string): ManagedBlockSplit {
	const collected: PendingBlock[] = [];
	const base: string[] = [];
	const stack: string[] = [];
	let baseLineCount = 0;
	let pendingBlanks: string[] = [];
	let open: PendingBlock | null = null;
	let fence: { char: string; length: number } | null = null;

	const flushBlanks = (): void => {
		for (const text of pendingBlanks) {
			base.push(text);
			baseLineCount += 1;
		}
		pendingBlanks = [];
	};

	for (const text of splitLines(content)) {
		const bare = text.replace(/\r?\n$/, "");
		const fenceMatch = FENCE_LINE.exec(bare);
		let marker: RegExpExecArray | null = null;
		if (fence !== null) {
			if (
				fenceMatch !== null &&
				fenceMatch[1][0] === fence.char &&
				fenceMatch[1].length >= fence.length &&
				fenceMatch[2].trim() === ""
			) {
				fence = null;
			}
		} else if (
			fenceMatch !== null &&
			!(fenceMatch[1][0] === "`" && fenceMatch[2].includes("`"))
		) {
			fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
		} else {
			marker = MARKER_LINE.exec(bare);
		}

		if (marker === null) {
			if (open !== null) {
				open.parts.push(text);
				continue;
			}
			if (BLANK_LINE.test(bare)) {
				pendingBlanks.push(text);
				continue;
			}
			flushBlanks();
			base.push(text);
			baseLineCount += 1;
			continue;
		}

		const [, closing, name] = marker;
		if (closing === "") {
			// A block reopened inside itself is ambiguous: fail safe.
			if (stack.includes(name)) return failSafe(content, "nested-block-name");
			stack.push(name);
			if (open === null) {
				// The blank run that separated the block from the body travels with it,
				// so the stripped base ends exactly where the shipped body ends and
				// re-attachment restores the same separation.
				open = { name, seam: baseLineCount, parts: [...pendingBlanks, text] };
				pendingBlanks = [];
			} else {
				open.parts.push(text);
			}
			continue;
		}
		if (stack.length === 0) return failSafe(content, "stray-closing-marker");
		if (stack[stack.length - 1] !== name) return failSafe(content, "mismatched-closing-marker");
		stack.pop();
		// `open` is non-null whenever the stack is non-empty.
		open?.parts.push(text);
		if (stack.length === 0 && open !== null) {
			collected.push({ name: open.name, parts: open.parts, seam: open.seam });
			open = null;
		}
	}
	if (stack.length > 0) return failSafe(content, "unbalanced-markers");
	flushBlanks();

	return {
		content: base.join(""),
		blocks: collected.map((block) => ({
			name: block.name,
			text: block.parts.join(""),
			trailingLines: baseLineCount - block.seam,
		})),
		stripped: collected.length > 0,
	};
}

/**
 * Re-attaches blocks produced by {@link splitManagedBlocks}. With an unchanged
 * base this reproduces the original content byte-for-byte. Each block is placed
 * before the number of base lines that followed it, so a block appended to an
 * installed body stays at the end of a refreshed body.
 */
export function attachManagedBlocks(content: string, blocks: readonly ManagedBlock[]): string {
	if (!Array.isArray(blocks) || blocks.length === 0) return content;
	const lines = splitLines(content);
	const ordered = [...blocks].sort((left, right) => left.trailingLines - right.trailingLines);
	let attached = 0;
	for (let index = ordered.length - 1; index >= 0; index -= 1) {
		const block = ordered.at(index);
		if (block === undefined) continue;
		const baseLength = lines.length - attached;
		const trailing = Number.isInteger(block.trailingLines)
			? Math.min(Math.max(block.trailingLines, 0), baseLength)
			: 0;
		lines.splice(baseLength - trailing, 0, block.text);
		attached += 1;
	}
	return lines.join("");
}
