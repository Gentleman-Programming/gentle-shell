import { visibleWidth } from "@earendil-works/pi-tui";

// A light theme on a dark terminal leaves every unpainted cell (prose,
// gaps, the column between the conversation and the rail) on the terminal's
// dark background, with the terminal's light default text on top. The page
// paint gives those cells a paper background and the theme's text color.
// Dark themes keep the terminal background (and any wallpaper behind it).

/** Paper behind a light theme: a hair darker than white so cards and the rail still read as surfaces. */
const PAPER = { r: 243, g: 242, b: 241 };
const PAPER_256 = 255;
const IMAGE_LINE = /\x1b_G|\x1b\]1337;File=/;
const SGR = /\x1b\[([0-9;:]*)m/g;

export interface PageTheme {
	appearance?: string;
	getFgAnsi?(token: string): string;
	getColorMode?(): string;
}
export interface PageColors { bg: string; fg: string }

/** The page colors for `theme`, or undefined when the terminal background should show. */
export function pageColors(theme: PageTheme): PageColors | undefined {
	if (theme.appearance !== "light" || typeof theme.getFgAnsi !== "function") return undefined;
	let fg = "";
	try {
		fg = theme.getFgAnsi("text");
	} catch {
		return undefined;
	}
	const bg = theme.getColorMode?.() === "256color" ? `\x1b[48;5;${PAPER_256}m` : `\x1b[48;2;${PAPER.r};${PAPER.g};${PAPER.b}m`;
	return { bg, fg };
}

/** Which defaults an SGR sequence restores: its foreground, its background, or both. */
function resetsOf(params: string): { fg: boolean; bg: boolean } {
	if (params === "") return { fg: true, bg: true };
	const codes = params.split(";");
	let fg = false;
	let bg = false;
	for (let i = 0; i < codes.length; i++) {
		const code = Number(codes[i]);
		// 38/48/58 carry a color: skip `5;n` or `2;r;g;b` so a 0 component is not read as a reset.
		if (code === 38 || code === 48 || code === 58) {
			i += Number(codes[i + 1]) === 5 ? 2 : Number(codes[i + 1]) === 2 ? 4 : 0;
			continue;
		}
		if (code === 0) fg = bg = true;
		else if (code === 39) fg = true;
		else if (code === 49) bg = true;
	}
	return { fg, bg };
}

/** Paints one screen row on the page: padded to `width`, re-arming only what each reset clears. */
export function paintPageRow(line: string, width: number, page: PageColors): string {
	if (IMAGE_LINE.test(line)) return line;
	const body = line.replace(SGR, (sgr, params: string) => {
		const reset = resetsOf(params);
		return sgr + (reset.bg ? page.bg : "") + (reset.fg ? page.fg : "");
	});
	const pad = Math.max(0, Math.floor(width) - visibleWidth(line));
	return `${page.bg}${page.fg}${body}${" ".repeat(pad)}\x1b[0m`;
}

type PageHost = {
	applyLineResets?: (lines: string[]) => string[];
	doRender?: () => void;
	terminal?: { columns: number };
};

/**
 * Paints the fullscreen frame on the page while `theme()` is light. It wraps
 * the frame's last pass (after overlays, selection and search highlights), and
 * only during a fullscreen render, so the document Pi leaves in the scrollback
 * on exit keeps the terminal's colors. Returns the uninstaller.
 */
export function installPagePaint(host: PageHost, theme: () => PageTheme): () => void {
	const ownResets = Object.prototype.hasOwnProperty.call(host, "applyLineResets");
	const ownRender = Object.prototype.hasOwnProperty.call(host, "doRender");
	const resets = host.applyLineResets;
	const render = host.doRender;
	if (typeof resets !== "function" || typeof render !== "function") return () => undefined;
	let painting: PageColors | undefined;
	let cached: { theme: PageTheme; page: PageColors | undefined } | undefined;
	host.applyLineResets = function (this: PageHost, lines: string[]) {
		const done = resets.call(this, lines);
		const page = painting;
		if (!page) return done;
		const width = Math.max(1, this.terminal?.columns ?? 0);
		return done.map((line) => paintPageRow(line, width, page));
	};
	host.doRender = function (this: PageHost) {
		const current = theme();
		if (cached?.theme !== current) cached = { theme: current, page: pageColors(current) };
		painting = cached.page;
		try {
			render.call(this);
		} finally {
			painting = undefined;
		}
	};
	return () => {
		if (ownResets) host.applyLineResets = resets;
		else delete host.applyLineResets;
		if (ownRender) host.doRender = render;
		else delete host.doRender;
	};
}
