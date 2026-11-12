import { isArtboardPath, locateDesignFile, readDesignFile, replaceDesignFile, serializeDesignWrite } from "./design-comments.ts";

// The single owner of design/<slug>/layout.json (canvas-layout S3): where each artboard sits on the canvas and the
// arrangement last chosen. Only the canvas server writes it, after validating the whole document, through the same
// per-file queue and temp file + rename as comments.json. It is view state, not design content: a file this module
// cannot read or parse is never an error that stops the canvas, and the next save replaces it. `load` tells such a
// file apart from a missing one (the server answers it as an error, so the canvas keeps the layout it shows);
// `read` takes both as no layout.

export const DESIGN_LAYOUT_FILE = "layout.json";
export const DESIGN_LAYOUT_ARRANGEMENTS = ["row", "column", "grid", "free"] as const;
/** The key of design/system.html, the first board of every design; never an artboard path, which ends in .html. */
export const DESIGN_LAYOUT_SYSTEM_KEY = "system";
/** The most positions one layout keeps: every artboard a manifest may list (64) and the system board, with room. */
export const DESIGN_LAYOUT_MAX_POSITIONS = 100;
/** The farthest a board may sit from the origin, in canvas px on each axis: a row or column of the largest artboards fits. */
export const DESIGN_LAYOUT_COORDINATE_MAX = 2_000_000;
const MAX_FILE_BYTES = 256 * 1024;

export type DesignLayoutArrangement = (typeof DESIGN_LAYOUT_ARRANGEMENTS)[number];
export type DesignLayoutPosition = { x: number; y: number };
export type DesignLayout = { arrangement: DesignLayoutArrangement; positions: Record<string, DesignLayoutPosition> };

export type DesignLayoutErrorCode = "not-found" | "invalid-input" | "invalid-file";

export class DesignLayoutError extends Error {
	readonly code: DesignLayoutErrorCode;
	constructor(code: DesignLayoutErrorCode, message: string) {
		super(message);
		this.name = "DesignLayoutError";
		this.code = code;
	}
}

export interface DesignLayoutStore {
	/** The design's layout; null when layout.json is missing, unreadable or invalid. */
	read(slug: string): Promise<DesignLayout | null>;
	/**
	 * The design's layout; null only when layout.json is missing. A layout.json that is a link, a directory, too large,
	 * fails to read or holds no valid layout throws an "invalid-file" error saying why; it is left as it is.
	 */
	load(slug: string): Promise<DesignLayout | null>;
	/** Validates `value` as a whole layout and replaces layout.json with it; a refused value writes nothing. */
	write(slug: string, value: unknown): Promise<DesignLayout>;
}

const isCoordinate = (value: unknown): value is number => Number.isInteger(value) && Math.abs(value as number) <= DESIGN_LAYOUT_COORDINATE_MAX;

/** The layout `value` describes, with its keys in a stable order; throws the first problem in words. */
export function parseDesignLayout(value: unknown): DesignLayout {
	const invalid = (message: string) => new DesignLayoutError("invalid-input", message);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("layout must be a JSON object");
	const record = value as Record<string, unknown>;
	const extra = Object.keys(record).filter((key) => key !== "arrangement" && key !== "positions");
	if (extra.length > 0) throw invalid(`layout has unknown keys: ${extra.join(", ")}`);
	if (!DESIGN_LAYOUT_ARRANGEMENTS.includes(record.arrangement as DesignLayoutArrangement)) throw invalid('arrangement must be "row", "column", "grid" or "free"');
	const raw = record.positions;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("positions must be an object");
	const entries = Object.entries(raw as Record<string, unknown>);
	if (entries.length > DESIGN_LAYOUT_MAX_POSITIONS) throw invalid(`positions may hold at most ${DESIGN_LAYOUT_MAX_POSITIONS} boards`);
	const positions: Record<string, DesignLayoutPosition> = {};
	for (const [key, position] of entries) {
		if (key !== DESIGN_LAYOUT_SYSTEM_KEY && !isArtboardPath(key)) throw invalid(`positions keys must be relative .html artboard paths or "${DESIGN_LAYOUT_SYSTEM_KEY}"`);
		if (!position || typeof position !== "object" || Array.isArray(position)) throw invalid(`positions["${key}"] must be an object with x and y`);
		const { x, y, ...rest } = position as Record<string, unknown>;
		if (Object.keys(rest).length > 0) throw invalid(`positions["${key}"] may hold only x and y`);
		if (!isCoordinate(x) || !isCoordinate(y)) throw invalid(`positions["${key}"] x and y must be integers between -${DESIGN_LAYOUT_COORDINATE_MAX} and ${DESIGN_LAYOUT_COORDINATE_MAX}`);
		positions[key] = { x, y };
	}
	return { arrangement: record.arrangement as DesignLayoutArrangement, positions };
}

export function createDesignLayoutStore(designRoot: string): DesignLayoutStore {
	function locate(slug: string): Promise<{ dir: string; path: string }> {
		return locateDesignFile(designRoot, slug, DESIGN_LAYOUT_FILE, (message) => new DesignLayoutError("not-found", message));
	}

	async function load(slug: string): Promise<DesignLayout | null> {
		const missing = `No design "${slug}" in design/.`;
		const unreadable = (reason: string) => new DesignLayoutError("invalid-file", reason);
		let raw: string | undefined;
		try {
			const { path } = await locate(slug);
			raw = await readDesignFile(path, MAX_FILE_BYTES, () => unreadable(`larger than ${MAX_FILE_BYTES} bytes`));
		} catch (error) {
			// Only a missing design is not found; a layout.json that is a link or a directory is no file to read.
			if (error instanceof DesignLayoutError && (error.message === missing || error.code === "invalid-file")) throw error;
			if (error instanceof DesignLayoutError) throw unreadable("not a regular file");
			const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "";
			throw unreadable(code ? `read error ${code}` : "read error");
		}
		if (raw === undefined) return null;
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			throw unreadable("not valid JSON");
		}
		try {
			return parseDesignLayout(value);
		} catch (error) {
			throw unreadable((error as Error).message);
		}
	}

	return {
		load,

		async read(slug) {
			try {
				return await load(slug);
			} catch (error) {
				if (error instanceof DesignLayoutError && error.code === "invalid-file") return null;
				throw error;
			}
		},

		async write(slug, value) {
			const layout = parseDesignLayout(value);
			const { dir, path } = await locate(slug);
			await serializeDesignWrite(path, () => replaceDesignFile(dir, path, DESIGN_LAYOUT_FILE, `${JSON.stringify(layout, null, 2)}\n`));
			return layout;
		},
	};
}
