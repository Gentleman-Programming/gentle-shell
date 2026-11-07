import { Markdown, wrapTextWithAnsi, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";

// File cards: a quiet tool call that touches a skill or an ODD artifact heads as
// that file instead of as a plain `read`/`edit`/`write` row, and an expanded
// Markdown document is drawn as a document rather than as its source.
//
// The classification is about path components, never substrings: `skills` and
// `odd` are folder names, so `lib/skillset/notes.md` and `docs/oddity.md` are
// ordinary files. Both separators are read, so a Windows path classifies like a
// POSIX one.

export const FILE_CARD_IDENTITY = {
	SKILL: "skill",
	ODD: "odd",
} as const;

export type FileCardIdentity = (typeof FILE_CARD_IDENTITY)[keyof typeof FILE_CARD_IDENTITY];

/** What one file kind contributes to a card heading. */
export interface FileCardMark {
	identity: FileCardIdentity;
	/** The name the heading leads with, in place of the tool's own. */
	title: string;
	/** The mark that leads the heading. */
	glyph: string;
	/**
	 * Theme role for the heading. A skill keeps the `read` card's own color — only
	 * its name and mark change. An ODD artifact wears the theme's own `mdHeading`
	 * role, so the theme at hand decides the color and no card carries one of its own.
	 */
	titleRole: string;
}

export const SKILL_FILE_CARD: FileCardMark = {
	identity: FILE_CARD_IDENTITY.SKILL,
	title: "skill",
	glyph: "▤",
	titleRole: "toolTitle",
};

export const ODD_FILE_CARD: FileCardMark = {
	identity: FILE_CARD_IDENTITY.ODD,
	title: "odd",
	// The artifact mark: a document, wide enough that the row budgets count it as
	// the two columns it really occupies.
	glyph: "📑",
	// The theme's own heading role, so the theme decides the color.
	titleRole: "mdHeading",
};

const SKILL_FOLDER = "skills";
const ODD_FOLDER = "odd";
const SKILL_DOCUMENT = "skill.md";
const MARKDOWN_NAME = /\.md$/i;

/** The path's components, split on both separators so every platform reads the same path. */
function pathComponents(path: string): string[] {
	return path.split(/[\\/]+/u).filter((component) => component.length > 0);
}

/**
 * The card a file path wears, or undefined for a path that is neither a skill nor
 * an ODD artifact. A document named `SKILL.md` is a skill wherever it sits — the
 * name is the file's own identity, not its folder's. Otherwise the innermost named
 * folder decides, so `odd/work/skills/x.md` is a skill and `skills/pack/odd/x.md`
 * is ODD.
 */
export function fileCardIdentity(path: unknown): FileCardMark | undefined {
	if (typeof path !== "string") return undefined;
	const components = pathComponents(path);
	if (components.length === 0) return undefined;
	if ((components[components.length - 1] ?? "").toLowerCase() === SKILL_DOCUMENT) return SKILL_FILE_CARD;
	// Only the folders decide; a file whose own name is `odd` is not inside one.
	for (let index = components.length - 2; index >= 0; index -= 1) {
		const component = (components[index] ?? "").toLowerCase();
		if (component === SKILL_FOLDER) return SKILL_FILE_CARD;
		if (component === ODD_FOLDER) return ODD_FILE_CARD;
	}
	return undefined;
}

/**
 * The file's own name — the last component of the path — for the collapsed heading
 * of a file card that names the file rather than the whole path it sits in.
 *
 * It splits on both separators and on nothing else, so a name with spaces stays whole
 * (`odd/my design doc.md` is `my design doc.md`), a trailing separator does not name an
 * empty file, and a Windows path is read exactly like a POSIX one. A path that names no
 * component is the empty string, which callers treat as "nothing to show" rather than
 * inventing a name.
 */
export function fileCardName(path: unknown): string {
	if (typeof path !== "string") return "";
	const components = pathComponents(path);
	return components.at(-1) ?? "";
}

/** Whether the path names a Markdown document, which is the only shape a card renders as Markdown. */
export function isMarkdownFile(path: unknown): boolean {
	if (typeof path !== "string") return false;
	const name = pathComponents(path).at(-1) ?? "";
	return MARKDOWN_NAME.test(name);
}

/**
 * The Markdown document a call draws instead of its result rows, or undefined when
 * the call draws rows.
 *
 * Markdown is the shape a document is written in, not a property of where it lives:
 * an expanded read of any `.md` file, and an expanded write to one, render as a
 * document whatever folder holds them, so a project's own notes read the way a
 * skill's do. Everything else keeps its rows — a collapsed card, because the preview
 * is the first rows of the file; a failed call, because its rows are the error; an
 * edit, because its rows are the diff; and every non-Markdown file. A write draws the
 * content it wrote, which the call carries and the result does not echo.
 */
export function markdownDocumentSource(
	toolName: string,
	args: Record<string, unknown> | undefined,
	resultText: string,
	options: { expanded: boolean; isError?: boolean },
): string | undefined {
	if (!options.expanded || options.isError === true) return undefined;
	if (toolName !== "read" && toolName !== "write") return undefined;
	if (!isMarkdownFile(args?.path)) return undefined;
	const source = toolName === "write" ? args?.content : resultText;
	return typeof source === "string" && source.trim().length > 0 ? source : undefined;
}

/**
 * The file line range a card names after the path, as `:start-end`. Only a read
 * states one, because only a read asks for one: a write or an edit knows how many
 * lines it writes, never where in the file those lines land, so it names no range at
 * all rather than dressing a count as a position — the real range of an edit is the
 * diff its result carries. Nothing is invented for a call that states no range, and a
 * malformed one states nothing either.
 */
export function fileCardLineRange(tool: string, args: Record<string, unknown> | undefined): string | undefined {
	if (tool !== "read" || args === undefined) return undefined;
	if (args.offset === undefined && args.limit === undefined) return undefined;
	// A range the call states in a shape the card cannot read is not guessed at:
	// half a range would name lines the call never asked for.
	if (args.offset !== undefined && !Number.isInteger(args.offset)) return undefined;
	if (args.limit !== undefined && !Number.isInteger(args.limit)) return undefined;
	const start = typeof args.offset === "number" ? args.offset : 1;
	const limit = typeof args.limit === "number" ? args.limit : undefined;
	if (start < 1) return undefined;
	if (limit !== undefined && limit < 1) return undefined;
	return limit === undefined ? `:${start}` : `:${start}-${start + limit - 1}`;
}

/** What a Markdown renderer needs from a card's theme. */
export interface FileCardTheme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
	italic?(text: string): string;
	underline?(text: string): string;
	strikethrough?(text: string): string;
}

/**
 * Pi's Markdown theme built from a card's theme, so a heading or a code fence reads
 * in the same roles as the rest of the card, and a theme that carries no text
 * attribute answers with the text itself rather than failing.
 */
export function fileCardMarkdownTheme(theme: FileCardTheme): MarkdownTheme {
	const color = (role: string) => (text: string) => theme.fg(role, text);
	const attribute = (name: "bold" | "italic" | "underline" | "strikethrough") => (text: string) => {
		const apply = theme[name];
		return typeof apply === "function" ? apply.call(theme, text) : text;
	};
	return {
		heading: color("mdHeading"),
		link: color("mdLink"),
		linkUrl: color("mdLinkUrl"),
		code: color("mdCode"),
		codeBlock: color("mdCodeBlock"),
		codeBlockBorder: color("mdCodeBlockBorder"),
		quote: color("mdQuote"),
		quoteBorder: color("mdQuoteBorder"),
		hr: color("mdHr"),
		listBullet: color("mdListBullet"),
		bold: attribute("bold"),
		italic: attribute("italic"),
		underline: attribute("underline"),
		strikethrough: attribute("strikethrough"),
	};
}

/**
 * The rows of a Markdown file's expanded body. A file's text is never swallowed:
 * when the renderer draws nothing at all, or the theme cannot paint Markdown, the
 * source rows are shown as they are, wrapped to the width at hand.
 */
export function fileCardMarkdownRows(source: string, theme: FileCardTheme, width: number): string[] {
	const target = Math.max(0, Math.floor(width));
	if (target === 0 || source.trim().length === 0) return [];
	try {
		const rows = new Markdown(source, 0, 0, fileCardMarkdownTheme(theme)).render(target);
		if (rows.some((row) => row.trim().length > 0)) return rows;
	} catch {
		// A theme that cannot paint Markdown still shows the file.
	}
	return source.split("\n").flatMap((row) => (row === "" ? [""] : wrapTextWithAnsi(row, target)));
}

/** An expanded Markdown file's body, drawn through Pi's own Markdown renderer. */
export class FileCardMarkdown implements Component {
	private readonly source: string;
	private readonly theme: FileCardTheme;

	constructor(source: string, theme: FileCardTheme) {
		this.source = source;
		this.theme = theme;
	}

	render(width: number): string[] {
		return fileCardMarkdownRows(this.source, this.theme, width);
	}

	invalidate(): void {}
}
