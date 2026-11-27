import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokens } from "./shell-bar.ts";
import { paintSurfaceRow, surfaceOpener, type CardTheme } from "./shell-card.ts";
import { interpolateRgb, isCineEstelarLive, isCineEstelarSkin, paintHorizontalGradientRow, PANEL_SURFACE_ROLE, type RgbStop } from "./shell-panel.ts";

// The dense info box at the foot of the main pane (DESIGN.md §C2,
// design/gentle-tui-cinlo/01-cinlo-console.html): one box, a violet frame, the
// title bitten into the top rule and the session's facts inside —
// model/profile/ctx, session/tokens/cost, dir/branch. In the reference video
// these fit in two rows because the terminal is narrow; here they take three.
//
// Pure: the caller hands in the same `footerModel()` and `currentStats()` the
// console column already reads, plus the theme and the width. Nothing here
// touches the filesystem, git, the clock or the session, so a caller can memoize
// the rows by the digest of that model and pay nothing per frame.

/** Glyph and name the info box is titled with. */
export const INFO_BOX_GLYPH = "◆";
export const INFO_BOX_NAME = "Gentle Shell";

/** Frame role of the info box, and of its bitten title: structure, in violet. */
const INFO_FRAME_ROLE = "accent";
const LABEL_ROLE = "dim";
const VALUE_ROLE = "text";
/** Values that name *where* the session lives read as links, like the mockup's cyan. */
const LINK_ROLE = "mdLink";
const BRANCH_ROLE = "accent";
const GAP = "  ";

/** Everything the info box shows; a subset of `ShellBarModel` plus session stats. */
export interface ShellInfoModel {
	/** Gentle Shell version the chrome was installed from, e.g. `4.7.0`. */
	version?: string;
	modelId: string;
	effort: string | undefined;
	profile?: string;
	contextPercent: number | null;
	contextWindow: number;
	turns: number;
	toolCalls: number;
	input: number;
	output: number;
	cost: number;
	cwd: string;
	branch: string | null;
	dirty?: number;
}

interface Field {
	label: string;
	value: string;
	role: string;
}

const plain = (field: Field): string => `${field.label}: ${field.value}`;

/** The widest row of `candidates` that fits `width`, or the smallest one clipped. */
function fitRow(candidates: Field[][], width: number, theme: CardTheme): string {
	if (width <= 0) return "";
	const paint = (fields: Field[]): string =>
		fields.map((field) => `${theme.fg(LABEL_ROLE, `${field.label}:`)} ${theme.fg(field.role, field.value)}`).join(GAP);
	for (const fields of candidates) {
		if (fields.length === 0) continue;
		if (visibleWidth(fields.map(plain).join(GAP)) <= width) return paint(fields);
	}
	// Nothing fits: keep the smallest variant's order and clip it once, so a
	// narrow terminal never wraps and never loses the field names.
	const smallest = candidates[candidates.length - 1] ?? [];
	return smallest.length === 0 ? "" : truncateToWidth(paint(smallest), width, "…");
}

/** The home-relative directory, the way the console's Sesión panel shows it. */
function shortPath(path: string, home: string | undefined): string {
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

const clean = (value: string | undefined): string => (value ?? "").replace(/[\r\n\t]/g, " ").trim();

/**
 * The three body rows, each as its list of progressively smaller variants: the
 * row sheds the least important fact before it clips anything.
 */
function rowCandidates(model: ShellInfoModel, home: string | undefined): Field[][][] {
	const percent = model.contextPercent;
	const modelValue = [clean(model.modelId), model.effort ? `(${clean(model.effort)})` : ""].filter(Boolean).join(" ");
	const identity: Field = { label: "Model", value: modelValue, role: LINK_ROLE };
	const profile: Field = { label: "Profile", value: clean(model.profile) || "sin perfil", role: LINK_ROLE };
	const ctx: Field = { label: "Ctx", value: percent === null ? "—" : `${percent}%`, role: percent !== null && percent >= 80 ? "warning" : "success" };
	const session: Field = { label: "Session", value: `${model.turns} turnos · ${model.toolCalls} tools`, role: VALUE_ROLE };
	const tokens: Field = { label: "Tokens", value: `${formatTokens(model.input)} in · ${formatTokens(model.output)} out`, role: VALUE_ROLE };
	const cost: Field = { label: "Cost", value: `$${model.cost.toFixed(3)}`, role: VALUE_ROLE };
	const dir: Field = { label: "Dir", value: shortPath(clean(model.cwd) || "—", home), role: VALUE_ROLE };
	const branch: Field = { label: "⎇", value: `${clean(model.branch ?? "") || "sin rama"}${model.dirty ? ` ±${model.dirty}` : ""}`, role: BRANCH_ROLE };
	return [
		// Model first: it is the one fact the box always keeps.
		[[identity, profile, ctx], [identity, ctx], [identity], [ctx]],
		[[session, tokens, cost], [session, cost], [session], [cost]],
		[[dir, branch], [dir], [branch]],
	];
}

const PLAQUE_BG_STOPS: readonly RgbStop[] = [
	[170, 238, 232],
	[186, 226, 248],
	[200, 196, 250],
	[210, 186, 250],
];

const PLAQUE_BORDER_STOPS: readonly RgbStop[] = [
	[138, 232, 226],
	[176, 214, 248],
	[204, 178, 250],
];

function renderCinePlaqueRule(width: number, leftCorner: string, rightCorner: string): string {
	let rule = "\x1b[49m";
	for (let i = 0; i < width; i++) {
		const ch = i === 0 ? leftCorner : i === width - 1 ? rightCorner : "─";
		const t = width <= 1 ? 0 : i / (width - 1);
		const [fr, fg, fb] = interpolateRgb(PLAQUE_BORDER_STOPS, t);
		rule += `\x1b[38;2;${fr};${fg};${fb}m${ch}`;
	}
	return `${rule}\x1b[39m`;
}

function renderCinePlaqueRow(width: number, plainRow: string): string {
	const inner = Math.max(0, width - 4);
	const fitted = truncateToWidth(plainRow, inner, "…");
	const padding = " ".repeat(Math.max(0, inner - visibleWidth(fitted)));
	const [lfr, lfg, lfb] = PLAQUE_BORDER_STOPS[0]!;
	const [rfr, rfg, rfb] = PLAQUE_BORDER_STOPS[PLAQUE_BORDER_STOPS.length - 1]!;
	const leftEdge = `\x1b[49m\x1b[38;2;${lfr};${lfg};${lfb}m│\x1b[39m`;
	const rightEdge = `\x1b[49m\x1b[38;2;${rfr};${rfg};${rfb}m│\x1b[39m`;
	return leftEdge + paintHorizontalGradientRow(` ${fitted}${padding} `, Math.max(0, width - 2), PLAQUE_BG_STOPS, [20, 26, 44]) + rightEdge;
}

/** `╭─ ◆ Gentle Shell · 4.7.0 ──────────────────────────────╮` */
function topRule(model: ShellInfoModel, theme: CardTheme, width: number): string {
	const frame = (text: string) => theme.fg(INFO_FRAME_ROLE, text);
	const [tl, tr] = isCineEstelarSkin() ? ["╭", "╮"] : ["┌", "┐"];
	const open = surfaceOpener(theme, PANEL_SURFACE_ROLE);
	const name = [INFO_BOX_NAME, clean(model.version)].filter(Boolean).join(" · ");
	const title = theme.fg(INFO_FRAME_ROLE, `${INFO_BOX_GLYPH} ${name}`);
	const fixed = 2 + 1 + 1 + visibleWidth(name) + 1 + 1 + 1;
	const room = width - fixed;
	if (room < 1) return frame(tl) + paintSurfaceRow(truncateToWidth(`${frame("─")} ${title} `, Math.max(0, width - 2), ""), open) + frame(tr);
	return frame(tl) + paintSurfaceRow(`${frame("─")} ${title} ${frame("─".repeat(room))}`, open) + frame(tr);
}

/** `│ <row> … │`, the interior of the box with smoked-glass surface. */
function bodyRow(theme: CardTheme, width: number, row: string): string {
	const open = surfaceOpener(theme, PANEL_SURFACE_ROLE);
	const inner = Math.max(0, width - 4);
	const fitted = truncateToWidth(row, inner, "…");
	const padding = " ".repeat(Math.max(0, inner - visibleWidth(fitted)));
	return `${theme.fg(INFO_FRAME_ROLE, "│")}${paintSurfaceRow(` ${fitted}${padding} `, open)}${theme.fg(INFO_FRAME_ROLE, "│")}`;
}

/**
 * The whole box, exactly `width` columns wide. Narrow terminals lose facts
 * before they lose the frame, and a width too small for a border renders
 * nothing at all rather than a broken one.
 */
export function renderShellInfoBox(model: ShellInfoModel, theme: CardTheme, width: number, home?: string): string[] {
	const target = Math.max(0, Math.floor(width));
	if (target < 8) return [];
	const [bl, br] = isCineEstelarSkin() ? ["╰", "╯"] : ["└", "┘"];
	if (isCineEstelarLive()) {
		const plaqueTheme: CardTheme = {
			fg(role: string, text: string) {
				if (role === LABEL_ROLE) return `\x1b[38;2;42;52;80m${text}\x1b[39m`;
				if (role === LINK_ROLE) return `\x1b[1m\x1b[38;2;14;20;38m${text}\x1b[22m\x1b[39m`;
				if (role === "success") return `\x1b[1m\x1b[38;2;12;128;90m${text}\x1b[22m\x1b[39m`;
				if (role === BRANCH_ROLE) return `\x1b[1m\x1b[38;2;78;48;172m${text}\x1b[22m\x1b[39m`;
				return `\x1b[1m\x1b[38;2;16;22;40m${text}\x1b[22m\x1b[39m`;
			},
		};
		const inner = target - 4;
		const rows = rowCandidates(model, home)
			.map((candidates) => fitRow(candidates, inner, plaqueTheme))
			.filter((row) => row !== "");
		return [
			renderCinePlaqueRule(target, "╭", "╮"),
			...rows.map((row) => renderCinePlaqueRow(target, row)),
			renderCinePlaqueRule(target, "╰", "╯"),
		];
	}
	const open = surfaceOpener(theme, PANEL_SURFACE_ROLE);
	const inner = target - 4;
	const rows = rowCandidates(model, home)
		.map((candidates) => fitRow(candidates, inner, theme))
		.filter((row) => row !== "");
	const bottomRule = `${theme.fg(INFO_FRAME_ROLE, bl)}${paintSurfaceRow(theme.fg(INFO_FRAME_ROLE, "─".repeat(Math.max(0, target - 2))), open)}${theme.fg(INFO_FRAME_ROLE, br)}`;
	return [topRule(model, theme, target), ...rows.map((row) => bodyRow(theme, target, row)), bottomRule];
}

/** The facts the box renders, in the order they are measured: the memo key. */
export function shellInfoDigest(model: ShellInfoModel, width: number, home?: string): string {
	return JSON.stringify([
		width,
		home ?? "",
		model.version ?? "",
		model.modelId,
		model.effort ?? "",
		model.profile ?? "",
		model.contextPercent,
		model.contextWindow,
		model.turns,
		model.toolCalls,
		model.input,
		model.output,
		model.cost,
		model.cwd,
		model.branch ?? "",
		model.dirty ?? "",
	]);
}
