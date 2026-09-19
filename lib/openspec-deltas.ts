export interface RequirementBlock {
	name: string;
	content: string;
	start: number;
	end: number;
}

export interface DeltaSpec {
	added: RequirementBlock[];
	modified: RequirementBlock[];
	removed: RequirementBlock[];
}

type DeltaOperation = keyof DeltaSpec;

const REQUIREMENT_HEADING = /^### Requirement:\s*(.+?)\s*$/gm;
const DELTA_SECTION_HEADING = /^##\s+(ADDED|MODIFIED|REMOVED)\s+Requirements\s*$/gim;

function normalizeMarkdown(markdown: string): string {
	return markdown.replace(/\r\n/g, "\n");
}

function nextTopLevelSection(markdown: string, from: number): number {
	const match = /^##\s+/gm;
	match.lastIndex = from;
	const next = match.exec(markdown);
	return next?.index ?? markdown.length;
}

function cleanRequirementContent(content: string): string {
	return content.trimEnd().replace(/(?:\r?\n\s*---\s*)+$/, "").trimEnd();
}

function operationKey(label: string): DeltaOperation {
	switch (label.toUpperCase()) {
		case "ADDED":
			return "added";
		case "MODIFIED":
			return "modified";
		case "REMOVED":
			return "removed";
		default:
			throw new Error(`Unsupported delta operation: ${label}`);
	}
}

export function parseRequirementBlocks(markdown: string): RequirementBlock[] {
	const source = normalizeMarkdown(markdown);
	const matches = [...source.matchAll(REQUIREMENT_HEADING)];
	return matches.map((match, index) => {
		const start = match.index ?? 0;
		const end = matches[index + 1]?.index ?? nextTopLevelSection(source, start + match[0].length);
		return {
			name: match[1].trim(),
			content: cleanRequirementContent(source.slice(start, end)),
			start,
			end,
		};
	});
}

export function parseDeltaSpec(markdown: string): DeltaSpec {
	const source = normalizeMarkdown(markdown);
	const sectionMatches = [...source.matchAll(DELTA_SECTION_HEADING)];
	const delta: DeltaSpec = { added: [], modified: [], removed: [] };
	const seen = new Map<string, string>();

	for (const [index, match] of sectionMatches.entries()) {
		const sectionStart = (match.index ?? 0) + match[0].length;
		const sectionEnd = sectionMatches[index + 1]?.index ?? source.length;
		const key = operationKey(match[1]);
		const section = source.slice(sectionStart, sectionEnd);
		const blocks = parseRequirementBlocks(section);
		delta[key].push(...blocks);
	}

	for (const [operation, blocks] of Object.entries(delta) as [DeltaOperation, RequirementBlock[]][]) {
		for (const block of blocks) {
			const previous = seen.get(block.name);
			if (previous) {
				throw new Error(
					`Duplicate delta operation for requirement "${block.name}" (${previous} and ${operation})`,
				);
			}
			seen.set(block.name, operation);
		}
	}

	return delta;
}

function requirementMap(blocks: RequirementBlock[]): Map<string, RequirementBlock> {
	const out = new Map<string, RequirementBlock>();
	for (const block of blocks) {
		if (out.has(block.name)) throw new Error(`Duplicate canonical requirement "${block.name}"`);
		out.set(block.name, block);
	}
	return out;
}

function requireCanonicalBlock(
	canonical: Map<string, RequirementBlock>,
	name: string,
	operation: string,
): RequirementBlock {
	const block = canonical.get(name);
	if (!block) throw new Error(`Missing canonical requirement "${name}" for ${operation}`);
	return block;
}

function appendAddedRequirements(markdown: string, added: RequirementBlock[]): string {
	if (added.length === 0) return markdown;
	const addition = added.map((block) => block.content.trim()).join("\n\n---\n\n");
	const requirementsHeading = /^## Requirements\s*$/m.exec(markdown);
	if (!requirementsHeading) return `${markdown.trimEnd()}\n\n## Requirements\n\n${addition}\n`;

	const sectionStart = requirementsHeading.index + requirementsHeading[0].length;
	const sectionEnd = nextTopLevelSection(markdown, sectionStart);
	const before = markdown.slice(0, sectionEnd).trimEnd();
	const after = markdown.slice(sectionEnd).replace(/^\n+/, "");
	return after
		? `${before}\n\n---\n\n${addition}\n\n${after}`
		: `${before}\n\n---\n\n${addition}\n`;
}

export function applyDeltaSpec(canonicalMarkdown: string, deltaMarkdown: string): string {
	let result = normalizeMarkdown(canonicalMarkdown);
	const delta = parseDeltaSpec(deltaMarkdown);
	const canonical = requirementMap(parseRequirementBlocks(result));

	for (const block of delta.added) {
		if (canonical.has(block.name)) {
			throw new Error(`Cannot add existing canonical requirement "${block.name}"`);
		}
	}

	const replacements: Array<{ start: number; end: number; content: string }> = [];
	for (const block of delta.modified) {
		const target = requireCanonicalBlock(canonical, block.name, "MODIFIED");
		replacements.push({ start: target.start, end: target.end, content: block.content.trimEnd() });
	}
	for (const block of delta.removed) {
		const target = requireCanonicalBlock(canonical, block.name, "REMOVED");
		replacements.push({ start: target.start, end: target.end, content: "" });
	}

	for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
		const prefix = result.slice(0, replacement.start).trimEnd();
		const suffix = result.slice(replacement.end).replace(/^\n+/, "");
		result = replacement.content
			? `${prefix}\n\n${replacement.content}\n\n${suffix}`.trimEnd() + "\n"
			: `${prefix}\n\n${suffix}`.trimEnd() + "\n";
	}

	return appendAddedRequirements(result, delta.added).trimEnd() + "\n";
}
