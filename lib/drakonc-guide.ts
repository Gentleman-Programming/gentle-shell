import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderPaletteCard, type CommandPaletteTheme } from "./command-palette.ts";
import { effectiveKey, loadKeymaps } from "./keymaps.ts";

// El recorrido de /drakonc:guide, al estilo de driver.js: una ventana por
// paso, colocada junto a la parte de la pantalla que el paso describe. Es
// puro (sin la API de extensiones de Pi), así que extensions/drakonc-guide.ts
// es dueño de la capa y de la herramienta del agente, y las pruebas manejan
// los pasos, la colocación y las teclas directamente.

/** Hacia dónde apunta un paso: el prompt, la barra lateral (o las tarjetas alrededor del prompt sin ella), o nada en particular. */
export type GuideRegion = "center" | "editor" | "sidebar";
export type GuideMode = "local" | "agent";
/** Cómo termina una ventana: se pasó el último paso, lo cerraron el usuario o el agente, o se cerró para reabrirse en otro sitio. */
export type GuideResult = "finished" | "ended" | "moved";

export interface GuideStep {
	id: string;
	title: string;
	body: string;
	region: GuideRegion;
	/** El comando de barra que se puede probar, mostrado con su tecla actual. */
	command?: string;
	/** El id del atajo cuya tecla muestra el paso (lib/keymaps.ts). */
	keymap?: string;
	/** Un comando o herramienta que debe existir en la sesión para que el paso se muestre. */
	requires?: string;
}

export const GUIDE_STEPS: readonly GuideStep[] = [
	{ id: "welcome", title: "Bienvenido a Drakonc Shell", region: "center",
		body: "Drakonc Shell es un arnés de agente de programación: explora antes de escribir, hace seguimiento del trabajo grande, delega en subagentes y comprueba sus propios cambios. Este recorrido muestra dónde está cada cosa." },
	{ id: "prompt", title: "El prompt", region: "editor",
		body: "Pide lo que quieras en lenguaje natural. Los comandos de barra empiezan por /, y Esc detiene el turno en curso del agente." },
	{ id: "palette", title: "Paleta de comandos", region: "center", command: "drakonc:commands", keymap: "commands", requires: "drakonc:commands",
		body: "Todos los comandos de Drakonc, agrupados y con búsqueda. Tab sobre una fila le da a ese comando una tecla propia." },
	{ id: "keymaps", title: "Atajos de teclado", region: "center", command: "drakonc:customize", requires: "drakonc:customize",
		body: "La sección Keymaps de /drakonc:customize lista todos los atajos: pulsa Enter sobre uno y después la tecla nueva. Los cambios se aplican tras /reload." },
	{ id: "models", title: "Modelos y perfiles", region: "center", command: "drakonc:profiles", requires: "drakonc:profiles",
		body: "Elige el modelo del agente principal y el de cada tipo de subagente, y guarda la combinación como perfil." },
	{ id: "agents", title: "Subagentes", region: "sidebar", command: "drakonc:agents", keymap: "agents.view", requires: "drakonc:agents",
		body: "El agente encarga la exploración, la escritura o la verificación a subagentes. Aparecen mientras trabajan; ábrelos para leer qué están haciendo." },
	{ id: "todos", title: "Lista de tareas", region: "sidebar", keymap: "todo.collapse", requires: "todo",
		body: "Para trabajos grandes el agente mantiene a la vista una lista de tareas y la actualiza cuando cada una empieza y termina." },
	{ id: "jobs", title: "Trabajos en segundo plano", region: "sidebar", command: "drakonc:jobs", keymap: "jobs.collapse", requires: "drakonc:jobs",
		body: "Los comandos largos, como compilaciones o suites de pruebas, se ejecutan en segundo plano mientras sigues hablando con el agente." },
	{ id: "changes", title: "Cambios", region: "editor", command: "drakonc:changes", keymap: "changes", requires: "drakonc:changes",
		body: "Todos los cambios sin confirmar de la sesión y de los árboles de trabajo de sus subagentes, con su diff. Pulsa o para abrir un archivo en tu editor." },
	{ id: "design", title: "Lienzo de diseño", region: "center", command: "drakonc:design", requires: "drakonc:design",
		body: "Pide una pantalla, un mockup o una landing y obtén tableros HTML en un lienzo local para comparar, comentar y entregar." },
	{ id: "voice", title: "Voz", region: "center", command: "drakonc:voice", requires: "drakonc:voice",
		body: "Dicta prompts manteniendo pulsada la tecla; la transcripción se ejecuta en local." },
	{ id: "music", title: "Música", region: "center", command: "drakonc:music", requires: "drakonc:music",
		body: "Música de fondo mientras trabajas, controlada desde el prompt." },
	{ id: "customize", title: "Personalización", region: "center", command: "drakonc:customize", requires: "drakonc:customize",
		body: "Temas, disposición, banner, tarjetas, animaciones, notificaciones de audio, edición Vim e historial del prompt, con vista previa antes de aplicarse." },
	{ id: "permissions", title: "Permisos", region: "center", command: "drakonc:yolo", requires: "drakonc:yolo",
		body: "YOLO deja al agente trabajar sin preguntas de permisos durante esta sesión. Los secretos y las credenciales siguen fuera de su alcance en cualquier caso." },
	{ id: "memory", title: "Memoria", region: "center", requires: "mem_search",
		body: "El agente guarda decisiones, arreglos y hallazgos, y los recuerda en sesiones posteriores. Pregúntale qué hiciste la última vez." },
	{ id: "usage", title: "Consumo", region: "center", command: "drakonc:usage", keymap: "usage", requires: "drakonc:usage",
		body: "Las ventanas de consumo de tu suscripción; /drakonc:stats añade tokens, coste y modelos a lo largo del tiempo." },
	{ id: "diagnostics", title: "Diagnóstico", region: "center", command: "drakonc:doctor", requires: "drakonc:doctor",
		body: "/drakonc:doctor y /drakonc:status revisan la instalación cuando algo no cuadra." },
	{ id: "end", title: "Fin del recorrido", region: "center",
		body: "Ejecuta /drakonc:guide otra vez cuando quieras, o pregúntale al agente cómo hacer algo." },
];

/** Los pasos de una sesión: los que no exigen nada y los que tienen su comando o herramienta disponibles. */
export function guideSteps(available: ReadonlySet<string>, steps: readonly GuideStep[] = GUIDE_STEPS): GuideStep[] {
	return steps.filter((step) => !step.requires || available.has(step.requires));
}

/** Posición dentro de una lista de pasos no vacía. */
export class GuideTour {
	readonly steps: readonly GuideStep[];
	private index = 0;

	constructor(steps: readonly GuideStep[]) {
		if (steps.length === 0) throw new Error("Un recorrido necesita al menos un paso.");
		this.steps = steps;
	}

	current(): GuideStep { return this.steps[this.index]!; }
	position(): number { return this.index + 1; }
	isLast(): boolean { return this.index === this.steps.length - 1; }
	/** Falso, sin moverse, en el último paso. */
	next(): boolean { if (this.isLast()) return false; this.index += 1; return true; }
	/** Falso, sin moverse, en el primer paso. */
	previous(): boolean { if (this.index === 0) return false; this.index -= 1; return true; }
	show(id: string): boolean {
		const found = this.steps.findIndex((step) => step.id === id);
		if (found < 0) return false;
		this.index = found;
		return true;
	}
}

export const GUIDE_POPOVER_WIDTH = 56;
const MIN_POPOVER_WIDTH = 40;
/** Filas entre el borde inferior de la pantalla y la ventana en los pasos del prompt: el prompt, su línea y la barra de estado siguen a la vista. */
const EDITOR_OFFSET_ROWS = 6;

/**
 * Opciones de la capa para un paso: a la izquierda de la barra lateral cuando
 * se muestra, encima del prompt en los pasos del prompt, y centrada en el
 * resto. En modo agente la ventana nunca toma el foco, así que el usuario
 * sigue escribiendo en el prompt.
 */
export function guidePlacement(region: GuideRegion, columns: number, railColumns: number | undefined, mode: GuideMode) {
	const width = Math.min(GUIDE_POPOVER_WIDTH, Math.max(MIN_POPOVER_WIDTH, columns - 4));
	const nonCapturing = mode === "agent";
	if (region === "sidebar" && railColumns) return { anchor: "right-center" as const, offsetX: -(railColumns + 1), width, nonCapturing };
	if (region === "editor") return { anchor: "bottom-center" as const, offsetY: -EDITOR_OFFSET_ROWS, width, nonCapturing };
	return { anchor: "center" as const, width, nonCapturing };
}

/** "Prueba: /comando · tecla" para un paso, con la tecla que el usuario tiene ahora; undefined cuando no hay nada que probar. */
export function guideTryLine(step: GuideStep, env: NodeJS.ProcessEnv): string | undefined {
	const key = step.keymap ? effectiveKey(step.keymap, env, loadKeymaps(env).bindings) : undefined;
	const parts = [step.command ? `/${step.command}` : undefined, key].filter((part): part is string => Boolean(part));
	return parts.length ? `Prueba: ${parts.join(" · ")}` : undefined;
}

function pointerLine(region: GuideRegion, railColumns: number | undefined): string | undefined {
	if (region === "sidebar") return railColumns ? "▸ En la barra lateral derecha" : "▾ En las tarjetas junto al prompt";
	if (region === "editor") return "▾ Abajo, en el prompt";
	return undefined;
}

export interface GuidePopoverOptions {
	tour: GuideTour;
	mode: GuideMode;
	theme: CommandPaletteTheme;
	env: NodeJS.ProcessEnv;
	/** Las columnas de la barra lateral mientras se muestra; undefined sin ella. */
	railColumns?: () => number | undefined;
	/** Se llama después de que una tecla local moviera el recorrido, para que el dueño reabra la ventana junto al paso nuevo. */
	onMove?: () => void;
	done(result: GuideResult): void;
}

export class GuidePopover {
	private completed = false;
	private readonly options: GuidePopoverOptions;

	constructor(options: GuidePopoverOptions) {
		this.options = options;
	}

	invalidate(): void {}

	/** Solo en modo local: en modo agente la ventana nunca tiene el foco. */
	handleInput(data: string): void {
		if (this.completed || this.options.mode !== "local" || isKeyRelease(data)) return;
		const { tour } = this.options;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") return this.finish("ended");
		if (matchesKey(data, "right") || matchesKey(data, "enter") || matchesKey(data, "return") || data === " " || data === "l") {
			if (!tour.next()) return this.finish("finished");
			this.options.onMove?.();
			return;
		}
		if ((matchesKey(data, "left") || data === "h") && tour.previous()) this.options.onMove?.();
	}

	render(width: number): string[] {
		const { tour, theme, mode } = this.options;
		const step = tour.current();
		const inner = Math.max(1, width - 4);
		const fg = (color: string, text: string) => theme.fg(color, text);
		const lines: string[] = [];
		const counter = `${tour.position()}/${tour.steps.length}`;
		const title = truncateToWidth(step.title, Math.max(1, inner - counter.length - 1), "…");
		lines.push(`${fg("accent", title)}${" ".repeat(Math.max(1, inner - visibleWidth(title) - counter.length))}${fg("muted", counter)}`);
		const pointer = pointerLine(step.region, this.options.railColumns?.());
		if (pointer) lines.push(fg("accent", pointer));
		lines.push("");
		for (const line of wrapTextWithAnsi(step.body, inner)) lines.push(fg("text", line));
		const tryLine = guideTryLine(step, this.options.env);
		if (tryLine) lines.push("", fg("accent", truncateToWidth(tryLine, inner, "…")));
		lines.push("");
		const footer = mode === "local" ? "→ siguiente · ← atrás · esc salir" : "Chat: /drakonc:guide stop termina";
		lines.push(fg("muted", truncateToWidth(footer, inner, "…")));
		return renderPaletteCard(lines, width, theme);
	}

	private finish(result: GuideResult): void {
		if (this.completed) return;
		this.completed = true;
		this.options.done(result);
	}
}

/** Lo que la herramienta drakonc_guide devuelve del paso actual, para que el agente lo explique. */
export function guideStepText(tour: GuideTour, env: NodeJS.ProcessEnv): string {
	const step = tour.current();
	const lines = [`Paso ${tour.position()}/${tour.steps.length} · ${step.title}`, step.body];
	const tryLine = guideTryLine(step, env);
	if (tryLine) lines.push(tryLine);
	if (tour.isLast()) lines.push('Este es el último paso: llama a drakonc_guide con action "end" cuando el usuario haya terminado.');
	else lines.push(`Siguiente: ${tour.steps[tour.position()]!.title}`);
	return lines.join("\n");
}
