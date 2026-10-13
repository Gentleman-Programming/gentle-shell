import { type EnvSummary, validateEnvName } from "./gentle-shell-envs.ts";

// The `gentle-shell envs` manager: a pure key parser, reducer and renderer.
// It is dependency-free on purpose (no pi-tui), because the launcher runs
// before any Pi runtime is resolved. bin/gentle-shell.mjs owns raw-mode
// stdin, the alternate screen, and carrying out the returned effects.

export type EnvsKey =
	| { name: "up" }
	| { name: "down" }
	| { name: "enter" }
	| { name: "backspace" }
	| { name: "escape" }
	| { name: "ctrl-c" }
	| { name: "char"; char: string };

export type EnvsEffect =
	| { kind: "quit" }
	| { kind: "launch"; name: string }
	| { kind: "set-default"; name: string }
	| { kind: "setup"; name: string }
	| { kind: "auth-check"; name: string }
	| { kind: "create"; name: string }
	| { kind: "rename"; from: string; to: string }
	| { kind: "delete"; name: string }
	| { kind: "install"; name: string; source: string };

type PromptKind = "create" | "rename" | "delete" | "install";

export interface EnvsPrompt {
	kind: PromptKind;
	label: string;
	value: string;
	// The env the prompt acts on (rename/delete/install).
	target?: string;
	error?: string;
}

export interface EnvsState {
	envs: EnvSummary[];
	selected: number;
	prompt?: EnvsPrompt;
	// One-line status shown above the key hints (results, hints).
	message?: string;
}

export function initialEnvsState(envs: EnvSummary[], message?: string, selectName?: string): EnvsState {
	const byName = selectName === undefined ? -1 : envs.findIndex((e) => e.name === selectName);
	const byDefault = envs.findIndex((e) => e.isDefault);
	return { envs, selected: byName >= 0 ? byName : Math.max(0, byDefault), message };
}

// --- key parsing -------------------------------------------------------------

export function parseKeys(data: string): EnvsKey[] {
	const keys: EnvsKey[] = [];
	const chars = [...data];
	for (let i = 0; i < chars.length; i += 1) {
		const c = chars[i];
		if (c === "\x1b") {
			const next = chars[i + 1];
			if (next === "[" || next === "O") {
				// CSI / SS3: parameters, then one final byte in @..~.
				let j = i + 2;
				while (j < chars.length && !/[@-~]/.test(chars[j])) j += 1;
				const sequence = chars.slice(i + 2, j + 1).join("");
				if (sequence === "A") keys.push({ name: "up" });
				else if (sequence === "B") keys.push({ name: "down" });
				i = j;
				continue;
			}
			keys.push({ name: "escape" });
			continue;
		}
		if (c === "\r" || c === "\n") keys.push({ name: "enter" });
		else if (c === "\x7f" || c === "\b") keys.push({ name: "backspace" });
		else if (c === "\x03") keys.push({ name: "ctrl-c" });
		else if (c >= " ") keys.push({ name: "char", char: c });
	}
	return keys;
}

// --- reducer -------------------------------------------------------------------

export interface EnvsStep {
	state: EnvsState;
	effect?: EnvsEffect;
}

const EMPTY_HINT = "No env selected: press n to create one.";

function openPrompt(state: EnvsState, prompt: EnvsPrompt): EnvsStep {
	return { state: { ...state, prompt, message: undefined } };
}

function reducePrompt(state: EnvsState, prompt: EnvsPrompt, key: EnvsKey): EnvsStep {
	if (key.name === "escape" || key.name === "ctrl-c") return { state: { ...state, prompt: undefined } };
	if (key.name === "backspace") return { state: { ...state, prompt: { ...prompt, value: [...prompt.value].slice(0, -1).join(""), error: undefined } } };
	if (key.name === "char") return { state: { ...state, prompt: { ...prompt, value: prompt.value + key.char, error: undefined } } };
	if (key.name !== "enter") return { state };

	const fail = (error: string): EnvsStep => ({ state: { ...state, prompt: { ...prompt, error } } });
	const done = (effect: EnvsEffect): EnvsStep => ({ state: { ...state, prompt: undefined }, effect });
	const value = prompt.value.trim();
	const target = prompt.target ?? "";

	if (prompt.kind === "create" || prompt.kind === "rename") {
		if (prompt.kind === "rename" && value === target) return { state: { ...state, prompt: undefined } };
		const invalid = validateEnvName(value);
		if (invalid !== undefined) return fail(invalid);
		if (state.envs.some((e) => e.name === value)) return fail(`env "${value}" already exists`);
		return done(prompt.kind === "create" ? { kind: "create", name: value } : { kind: "rename", from: target, to: value });
	}
	if (prompt.kind === "delete") {
		if (value !== target) return fail(`type "${target}" to confirm, or esc to cancel`);
		return done({ kind: "delete", name: target });
	}
	if (value.length === 0) return fail("enter a package source, e.g. npm:pi-btw");
	return done({ kind: "install", name: target, source: value });
}

export function reduceEnvs(state: EnvsState, key: EnvsKey): EnvsStep {
	if (state.prompt !== undefined) return reducePrompt(state, state.prompt, key);

	if (key.name === "ctrl-c" || key.name === "escape") return { state, effect: { kind: "quit" } };
	const last = state.envs.length - 1;
	const char = key.name === "char" ? key.char : undefined;
	if (key.name === "up" || char === "k") return { state: { ...state, selected: Math.max(0, state.selected - 1), message: undefined } };
	if (key.name === "down" || char === "j") return { state: { ...state, selected: Math.max(0, Math.min(last, state.selected + 1)), message: undefined } };
	if (char === "q") return { state, effect: { kind: "quit" } };
	if (char === "n") return openPrompt(state, { kind: "create", label: "New env name", value: "" });

	const current = state.envs[state.selected];
	const scoped = key.name === "enter" || (char !== undefined && "sparid".includes(char));
	if (!scoped) return { state };
	if (current === undefined) return { state: { ...state, message: EMPTY_HINT } };
	const name = current.name;
	if (key.name === "enter") return { state, effect: { kind: "launch", name } };
	if (char === "s") return { state, effect: { kind: "set-default", name } };
	if (char === "p") return { state, effect: { kind: "setup", name } };
	if (char === "a") return { state, effect: { kind: "auth-check", name } };
	if (char === "r") return openPrompt(state, { kind: "rename", label: `Rename "${name}" to`, value: name, target: name });
	if (char === "i") return openPrompt(state, { kind: "install", label: `Install into "${name}"`, value: "", target: name });
	return openPrompt(state, { kind: "delete", label: `Delete "${name}" and all its data? Type its name`, value: "", target: name });
}

// --- rendering -----------------------------------------------------------------

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const INVERSE = "\x1b[7m";
const RED = "\x1b[31m";
const ACCENT = "\x1b[35m";
const RESET = "\x1b[0m";

// Truncate to `width` code points (the renderer only emits plain text inside
// a style, so visible width equals code points for the ASCII it controls).
function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const chars = [...text];
	if (chars.length <= width) return text;
	return width === 1 ? "…" : `${chars.slice(0, width - 1).join("")}…`;
}

function pad(text: string, width: number): string {
	const fitted = fit(text, width);
	return fitted + " ".repeat(Math.max(0, width - [...fitted].length));
}

function styled(style: string, text: string): string {
	return text.length === 0 ? "" : `${style}${text}${RESET}`;
}

function detailLines(env: EnvSummary | undefined): string[] {
	if (env === undefined) return ["No envs yet.", "", "Press n to create your first env."];
	const sessions = `${env.sessionCount} session${env.sessionCount === 1 ? "" : "s"}`;
	return [
		`${env.name}${env.isDefault ? "  (default)" : ""}`,
		"",
		`Path       ${env.dir}`,
		`Setup      ${env.provisioned}`,
		`Sessions   ${sessions}${env.lastSessionAt ? ` · last ${env.lastSessionAt.slice(0, 16).replace("T", " ")}` : ""}`,
		`Providers  ${env.providers.length > 0 ? env.providers.join(", ") : "none signed in"}`,
		`Packages   ${env.packages.length > 0 ? "" : "none"}`,
		...env.packages.map((source) => `  · ${source}`),
	];
}

const HINTS = "enter launch · n new · r rename · d delete · s default · p setup · i install · a auth · q quit";

export function renderEnvsScreen(state: EnvsState, width: number, height: number): string[] {
	const w = Math.max(1, width);
	const h = Math.max(1, height);
	const lines: string[] = [];

	const header = `gentle-shell envs · ${state.envs.length} env${state.envs.length === 1 ? "" : "s"}`;
	lines.push(styled(BOLD + ACCENT, pad(header, w)));

	// Footer: status/prompt line plus the key hints.
	const footer: string[] = [];
	if (state.prompt !== undefined) {
		const p = state.prompt;
		footer.push(styled(BOLD, pad(`${p.label}: ${p.value}`, w)));
		footer.push(p.error === undefined ? styled(DIM, pad("enter confirm · esc cancel", w)) : styled(RED, pad(p.error, w)));
	} else {
		footer.push(state.message === undefined ? " ".repeat(w) : pad(state.message, w));
		footer.push(styled(DIM, pad(HINTS, w)));
	}

	const bodyHeight = Math.max(0, h - 1 - footer.length);
	const listWidth = Math.min(28, Math.max(8, Math.floor(w / 3)));
	const detailWidth = w - listWidth - 3;
	const details = detailLines(state.envs[state.selected]);
	// Keep the selection visible when the list is taller than the body.
	const offset = Math.max(0, Math.min(state.selected - bodyHeight + 1, state.envs.length - bodyHeight));
	for (let row = 0; row < bodyHeight; row += 1) {
		const index = row + Math.max(0, offset);
		const env = state.envs[index];
		const label = env === undefined ? "" : `${env.isDefault ? "★" : " "} ${env.name}`;
		const selected = env !== undefined && index === state.selected;
		// Too narrow for the detail pane: the list alone takes the full width.
		const listOnly = detailWidth < 4;
		const cell = pad(label, listOnly ? w : listWidth);
		const left = selected ? styled(INVERSE, cell) : cell;
		lines.push(listOnly ? left : `${left} │ ${pad(details[row] ?? "", detailWidth)}`);
	}

	// Tiny terminals: the header and footer still must not exceed `h` lines.
	const all = [...lines, ...footer];
	if (all.length > h) return [...all.slice(0, Math.max(0, h - footer.length)), ...footer].slice(-h);
	return all;
}
