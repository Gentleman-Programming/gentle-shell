import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { normalizeIdentifier, type ProjectMapStep } from "./shell-project-map-draft.ts";
import type { ProjectMapCapabilityV1, ProjectMapState } from "./shell-project-map-schema.ts";
import { PROJECT_MAP_STATE_GLYPH } from "./shell-project-map-view.ts";
import type { ProjectMapDescription } from "./project-map-description.ts";

// What a capability IS, as an overlay.
//
// The card cannot answer that on its own: the map's `outcome` is the label the document wrote,
// which for a roadmap carries the functional point's code in front of its title. The answer
// comes from the document the capability points at, read by `project-map-description.ts`, and
// this component presents it next to the facts the map does declare.
//
// The surface speaks Spanish because the documents it quotes are written in Spanish: the user
// asked for it in so many words, and an English frame around a Spanish paragraph was the
// mismatch they were reading. The map's own values stay English everywhere else — the state is
// translated for display only, never rewritten in the artifact.
//
// Pure on purpose, like the command palette: data in, lines out, no Pi API, so it is exercised
// without a session.

const CARD_PADDING = 4;
const MIN_TOTAL_ROWS = 12;
const HEIGHT_RATIO = 0.85;
const DEFAULT_ROWS = 40;
/** The frame's two rules, the blank above the footer, and the footer itself. */
const CHROME_ROWS = 4;
const TITLE_GLYPH = "?";

/** The state as the reader sees it. Display only: the artifact keeps the frozen English value. */
const STATE_LABEL: Record<ProjectMapState, string> = {
	planned: "planificada",
	active: "activa",
	review: "en revisión",
	ready: "lista",
	blocked: "bloqueada",
	done: "hecha",
};

export interface ProjectMapHelpTheme {
	fg(color: string, text: string): string;
}

export interface ProjectMapHelpContent {
	capabilityId: string;
	/** What the frame's top rule carries, next to the id. */
	subtitle: string;
	/** One `Label: value` line per declared fact. */
	facts: string[];
	/** The sub-elements the functional point owns across the repository documents. */
	steps: readonly ProjectMapStep[];
	/** Map-level surface roll-up text supplied by the view library, never recomputed here. */
	coverageLines: readonly string[];
	/** The body the declaring document carries for this capability. */
	description: string[];
	/** True when the map names a document, so the description is the document's silence. */
	hasDocument: boolean;
	/**
	 * One line about the description itself, printed above it: whether it is a translation and
	 * whether that translation is still current. Absent when the description needs no explanation.
	 */
	descriptionNote?: string;
}

export type ProjectMapHelpResult = { type: "close" };

/**
 * The facts the map declares, plus the description the document carries. `description` is
 * `null` when the document declares no such work unit, which is a different answer from a work
 * unit that carries no body, and the component says which one it is.
 *
 * An outcome that normalizes to the capability's own id is left out: a plain label repeats it
 * in different words. A prefixed label normally stays, but the test is normalization and not
 * the prefix: `normalizeIdentifier` drops a scope before a `/`, so a label such as
 * `Title/Provisioning` still normalizes to the id and is suppressed.
 */
export function buildProjectMapHelpContent(capability: ProjectMapCapabilityV1, description: ProjectMapDescription | null, blockers: readonly string[] = [], descriptionNote?: string, steps: readonly ProjectMapStep[] = [], coverageLines: readonly string[] = []): ProjectMapHelpContent {
	const list = (values: readonly string[]): string => (values.length === 0 ? "ninguno" : values.join(", "));
	const facts: string[] = [];
	if (normalizeIdentifier(capability.outcome) !== capability.id) facts.push(`Resultado: ${capability.outcome}`);
	facts.push(`Superficies: ${list(capability.surfaces)} · Fundamentos: ${list(capability.foundationRefs)}`);
	facts.push(`Dependencias: ${list(capability.dependsOn)} · Contratos: ${list(capability.contracts)}`);
	facts.push(`Documentos: ${list(capability.featureDocs)}`);
	// The one fact the retired Inspector alone carried: why this capability cannot be worked on.
	facts.push(`Bloqueos: ${list(blockers)}`);
	return {
		capabilityId: capability.id,
		subtitle: STATE_LABEL[capability.state] ?? capability.state,
		facts,
		...(descriptionNote === undefined || descriptionNote.length === 0 ? {} : { descriptionNote }),
		steps,
		coverageLines,
		description: description?.lines ?? [],
		hasDocument: capability.featureDocs.length > 0,
	};
}

export class ProjectMapHelpModal {
	private offset = 0;
	private completed = false;
	private readonly content: ProjectMapHelpContent;
	private readonly done: (result: ProjectMapHelpResult) => void;
	private readonly theme: ProjectMapHelpTheme | undefined;
	private readonly rowsFn: () => number;

	constructor(content: ProjectMapHelpContent, done: (result: ProjectMapHelpResult) => void, theme?: ProjectMapHelpTheme, rows: () => number = () => DEFAULT_ROWS) {
		this.content = content;
		this.done = done;
		this.theme = theme;
		this.rowsFn = rows;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.completed || isKeyRelease(data)) return;
		// The scroll keys are checked before the closing ones for the same reason the palette
		// does it: a bare line feed is both ctrl+j and, on some terminals, Enter.
		if (matchesKey(data, "down") || matchesKey(data, "ctrl+j")) return this.scroll(1);
		if (matchesKey(data, "up") || matchesKey(data, "ctrl+k")) return this.scroll(-1);
		if (matchesKey(data, "pageDown")) return this.scroll(this.pageSize());
		if (matchesKey(data, "pageUp")) return this.scroll(-this.pageSize());
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter") || matchesKey(data, "return")) {
			this.completed = true;
			this.done({ type: "close" });
		}
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - CARD_PADDING);
		const budget = Math.max(MIN_TOTAL_ROWS, Math.floor(this.rowsFn() * HEIGHT_RATIO));
		const body = this.wrap(this.bodyLines(), innerWidth);
		const window = Math.max(1, budget - CHROME_ROWS);
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, body.length - window)));
		const visible = body.slice(this.offset, this.offset + window);
		return this.frame([...visible, "", this.footer(body.length, visible.length)], innerWidth, budget);
	}

	private bodyLines(): string[] {
		const lines = [...this.content.facts, ""];
		if (this.content.steps.length === 0) lines.push("Subelementos: ninguno.");
		else {
			lines.push(`Subelementos: ${this.content.steps.length}`);
			lines.push(...this.content.steps.map((step) => {
				const code = step.code.length === 0 ? "" : `${step.code} — `;
				return `${"  ".repeat(step.code.length === 0 ? 1 : (step.code.match(/\./g) ?? []).length + 1)}· ${code}${step.title} · ${PROJECT_MAP_STATE_GLYPH[step.state] ?? step.state}`;
			}));
		}
		if (this.content.coverageLines.length > 0) {
			lines.push("", "Cobertura por superficie", "Este es el resumen del mapa completo, no de esta capability.");
			if (this.content.coverageLines.every((line) => line.endsWith(" —"))) lines.push("El mapa no declara ninguna superficie.");
			lines.push(...this.content.coverageLines);
		}
		lines.push("");
		if (!this.content.hasDocument) {
			lines.push("El mapa no declara ningún documento para esta capability, así que no hay nada para leer.");
			return lines;
		}
		if (this.content.description.length === 0) {
			lines.push("El documento no declara ninguna unidad de trabajo que coincida con esta capability, o su unidad no tiene cuerpo.");
			return lines;
		}
		if (this.content.descriptionNote !== undefined) lines.push(this.content.descriptionNote);
		lines.push("Lo que dice el documento:");
		lines.push(...this.content.description.map((line) => `· ${line}`));
		return lines;
	}

	private footer(total: number, shown: number): string {
		if (total <= shown) return "esc cerrar";
		const below = total - this.offset - shown;
		return this.offset === 0 ? `↓ ${below} más · esc cerrar` : `↑ ${this.offset} arriba · ↓ ${Math.max(0, below)} más · esc cerrar`;
	}

	/** Wraps rather than truncates: a description's tail is the part that explains the work. */
	private wrap(lines: string[], width: number): string[] {
		return lines.flatMap((line) => (line.length === 0 ? [""] : wrapTextWithAnsi(line, width)));
	}

	private scroll(delta: number): void {
		this.offset = Math.max(0, this.offset + delta);
	}

	private pageSize(): number {
		return Math.max(1, Math.floor(this.rowsFn() * HEIGHT_RATIO) - CHROME_ROWS);
	}

	private paint(text: string, tone?: string): string {
		return this.theme === undefined || tone === undefined ? text : this.theme.fg(tone, text);
	}

	/** The frame carries the id and the state, the way every other shell card carries its title. */
	private frame(lines: string[], innerWidth: number, budget: number): string[] {
		const border = (text: string) => this.paint(text, "border");
		const head = this.paint(`${TITLE_GLYPH} ${this.content.capabilityId} · ${this.content.subtitle}`, "accent");
		const title = visibleWidth(head) <= innerWidth - 4 ? head : truncateToWidth(head, Math.max(1, innerWidth - 4), "…", true);
		const fill = "─".repeat(Math.max(0, innerWidth - visibleWidth(title) - 1));
		const body = lines.slice(0, Math.max(0, budget - 2)).map((line) => {
			const safe = truncateToWidth(line, Math.max(1, innerWidth), "…", true);
			return `${border("│")} ${safe}${" ".repeat(Math.max(0, innerWidth - visibleWidth(safe)))} ${border("│")}`;
		});
		return [`${border("╭─")} ${title} ${border(fill)}${border("╮")}`, ...body, border(`╰${"─".repeat(innerWidth + 2)}╯`)];
	}
}
