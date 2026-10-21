import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { colorToRgb, parseColor } from "@earendil-works/pi-tui";

const MAX_BYTES = 256_000;
const HEX = /^#[0-9a-fA-F]{6}$/;
const REFERENCE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/** Read only the installed source supplied by Pi; never use the active theme as a fallback. */
export function sourcePalettePreview(name: string, sourcePath: string | undefined): { title: string; sample: string } {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) || !sourcePath || !isAbsolute(sourcePath)) throw new Error("Installed theme source unavailable.");
	// Pi's installed themes can live behind platform symlinks. Resolve the
	// Pi-supplied path, then open the target without following another symlink.
	const path = realpathSync(sourcePath);
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	let text: string;
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Theme source unavailable or too large.");
		const bytes = readFileSync(fd);
		if (bytes.length > MAX_BYTES) throw new Error("Theme source too large.");
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} finally { closeSync(fd); }
	const document: unknown = JSON.parse(text);
	if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("Invalid theme source.");
	const { name: sourceName, colors, vars } = document as Record<string, unknown>;
	if (sourceName !== name || !colors || typeof colors !== "object" || Array.isArray(colors)) throw new Error("Theme source does not match installed theme.");
	if (vars !== undefined && (!vars || typeof vars !== "object" || Array.isArray(vars))) throw new Error("Invalid theme variables.");
	const palette = colors as Record<string, unknown>;
	const variables = (vars ?? {}) as Record<string, unknown>;
	const escape = (role: "accent" | "text", background: boolean): string => {
		let value: unknown = palette[role];
		const seen = new Set<string>();
		while (typeof value === "string" && REFERENCE.test(value)) {
			if (seen.has(value) || !Object.hasOwn(variables, value)) throw new Error("Invalid theme color reference.");
			seen.add(value);
			value = variables[value];
		}
		const prefix = background ? 48 : 38;
		if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255) return `\x1b[${prefix};5;${value}m`;
		if (typeof value === "string" && HEX.test(value)) return `\x1b[${prefix};2;${parseInt(value.slice(1, 3), 16)};${parseInt(value.slice(3, 5), 16)};${parseInt(value.slice(5, 7), 16)}m`;
		// Pi 0.99.1's built-in palettes use OKHSL. Delegate the exact color
		// grammar, finite/range checks and conversion to the public host utility;
		// do not broaden this source-only preview to arbitrary CSS colors.
		if (typeof value === "string" && value.startsWith("okhsl(")) {
			const { r, g, b } = colorToRgb(parseColor(value));
			return `\x1b[${prefix};2;${r};${g};${b}m`;
		}
		throw new Error("Invalid theme palette color.");
	};
	return { title: `${name} · source palette`, sample: `${escape("accent", true)}  \x1b[0m ${escape("text", false)}Aa  sample text\x1b[0m` };
}
