import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { appendSystemPromptOnce } from "../lib/append-system-prompt.ts";
import { codemodeReaches, GUIDE_TOOL_ROUTE, hideBehindCodemode } from "../lib/hidden-tools.ts";
import { guidePlacement, GuidePopover, guideStepText, guideSteps, GuideTour, type GuideMode, type GuideResult } from "../lib/drakonc-guide.ts";
import { sidebarState } from "../lib/shell-sidebar.ts";

// /drakonc:guide: un recorrido guiado por Drakonc Shell. Con un modelo, el
// agente lo conduce con la herramienta drakonc_guide, un paso por turno, y la
// ventana se queda junto al prompt sin tomar su foco, así que el usuario puede
// preguntar a mitad del recorrido. Sin modelo (o con `local`), el usuario
// avanza con las flechas. Pi lee las opciones de la capa solo al abrirla, así
// que un paso de otra región cierra la ventana y la reabre allí.

export const GUIDE_COMMAND_NAME = "drakonc:guide";
export const GUIDE_TOOL_NAME = "drakonc_guide";
const GUIDE_MESSAGE_TYPE = "drakonc-guide";
const USAGE = "Uso: /drakonc:guide [local|stop]";

export const GUIDE_AGENT_REQUEST = `El usuario ejecutó /drakonc:guide. Dale el recorrido guiado de Drakonc Shell, un paso por turno: llama a ${GUIDE_TOOL_NAME} con action "start", explica ese paso en dos o tres frases en español y termina tu turno preguntando si quiere seguir o si tiene alguna duda. Cuando quiera seguir, llama a ${GUIDE_TOOL_NAME} con action "next" y haz lo mismo. Si pregunta algo, respóndelo y quédate en el paso actual. Después del último paso, llama a ${GUIDE_TOOL_NAME} con action "end".`;

export const GUIDE_PROMPT_HINT = `Recorrido guiado de Drakonc Shell: cuando el usuario pregunte cómo se usa Drakonc Shell o qué puede hacer, ofrécele /drakonc:guide; también puedes conducirlo con la herramienta ${GUIDE_TOOL_NAME} (start, next, previous, show, end), un paso por turno.`;

const GuideParams = Type.Object({
	action: Type.Union([Type.Literal("start"), Type.Literal("next"), Type.Literal("previous"), Type.Literal("show"), Type.Literal("end")], { description: "start abre el primer paso; next y previous se mueven; show salta a un paso por su id; end cierra el recorrido." }),
	step: Type.Optional(Type.String({ description: "solo con show: el id del paso al que saltar." })),
});

interface GuideParamsValue {
	action: "start" | "next" | "previous" | "show" | "end";
	step?: string;
}

interface Session {
	tour: GuideTour;
	mode: GuideMode;
	ctx: ExtensionContext;
	/** Cierra la ventana con `result`; no hace nada una vez cerrada. */
	close(result: GuideResult): void;
	/** La colocación con la que se abrió la ventana, para saber si un paso la necesita en otro sitio. */
	placement: string;
	/** Se resuelve al cerrarse esta ventana; resuelta de inmediato sin terminal. */
	settled: Promise<GuideResult | undefined>;
	/** Cierto sin terminal: el agente explica los pasos solo por texto. */
	headless?: boolean;
	tui?: TUI;
}

function railColumns(tui: TUI | undefined): number | undefined {
	if (!tui) return undefined;
	const state = sidebarState(tui);
	return state.active && (state.ownsHost?.() ?? true) ? state.railColumns : undefined;
}

export default function drakoncGuide(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	// Los hijos delegados solo ejecutan su tarea.
	if (env.DRAKONC_PI_AGENTS_CHILD === "1") return;
	let active: Session | undefined;

	const available = (): Set<string> => new Set([...pi.getCommands().map((command) => command.name), ...pi.getAllTools().map((tool) => tool.name)]);
	const placementOf = (session: Pick<Session, "tour" | "mode" | "tui">) => {
		const columns = session.tui?.terminal.columns ?? 80;
		return guidePlacement(session.tour.current().region, columns, railColumns(session.tui), session.mode);
	};

	/** Abre la ventana en el paso actual del recorrido; se resuelve con cómo se cerró. */
	const open = (ctx: ExtensionContext, tour: GuideTour, mode: GuideMode): Promise<GuideResult | undefined> => {
		active?.close("ended");
		const session: Session = { tour, mode, ctx, close: () => {}, placement: "", settled: Promise.resolve(undefined) };
		active = session;
		const settled = ctx.ui.custom<GuideResult | undefined>((tui, theme, _keybindings, done) => {
			session.tui = tui;
			let closed = false;
			session.close = (result) => { if (!closed) { closed = true; done(result); } };
			return new GuidePopover({
				tour, mode, theme, env,
				railColumns: () => railColumns(tui),
				onMove: () => moved(session),
				done: (result) => session.close(result),
			});
		}, { overlay: true, overlayOptions: () => {
			const placement = placementOf(session);
			session.placement = JSON.stringify(placement);
			return placement;
		} });
		session.settled = settled.finally(() => { if (active === session) active = undefined; });
		return session.settled;
	};

	/** Tras mover el recorrido: repinta en el sitio, o reabre la ventana junto al paso nuevo. */
	const moved = (session: Session): Promise<GuideResult | undefined> | undefined => {
		if (session.headless) return undefined;
		if (JSON.stringify(placementOf(session)) === session.placement) {
			session.tui?.requestRender();
			return undefined;
		}
		session.close("moved");
		return open(session.ctx, session.tour, session.mode);
	};

	const runLocal = async (ctx: ExtensionContext): Promise<void> => {
		const tour = new GuideTour(guideSteps(available()));
		let result = await open(ctx, tour, "local");
		// Una mudanza reabre la ventana; la nueva lleva el mismo recorrido más adelante.
		while (result === "moved") {
			const next = active;
			if (!next || next.tour !== tour) return;
			result = await next.settled;
		}
		if (result === "finished") ctx.ui.notify("Recorrido completado. Ejecuta /drakonc:guide cuando quieras verlo otra vez.", "info");
	};

	pi.registerCommand(GUIDE_COMMAND_NAME, {
		description: "Recorrido guiado por lo que Drakonc Shell puede hacer, explicado por el agente (local: avanza tú con las flechas; stop: lo termina).",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const arg = args.trim().toLowerCase();
			if (arg === "stop") {
				if (!active) return ctx.ui.notify("No hay ningún recorrido guiado en marcha.", "info");
				active.close("ended");
				return ctx.ui.notify("Recorrido guiado terminado.", "info");
			}
			if (arg !== "" && arg !== "local") return ctx.ui.notify(USAGE, "warning");
			if (ctx.mode !== "tui") return ctx.ui.notify("El recorrido guiado necesita una terminal interactiva.", "warning");
			if (arg === "local" || !ctx.model) return runLocal(ctx);
			pi.sendMessage({ customType: GUIDE_MESSAGE_TYPE, content: GUIDE_AGENT_REQUEST, display: false }, ctx.isIdle() ? { triggerTurn: true } : { triggerTurn: true, deliverAs: "followUp" });
			ctx.ui.notify("Iniciando el recorrido guiado con el agente…", "info");
		},
	});

	pi.registerTool({
		name: GUIDE_TOOL_NAME,
		label: "Guía de Drakonc",
		description: "Conduce el recorrido de /drakonc:guide por Drakonc Shell: start muestra el primer paso en una ventana junto a la parte de la pantalla que describe y devuelve su texto para que lo expliques; next, previous y show (con el id de un paso) se mueven; end cierra la ventana. Muestra un paso por turno y deja que el usuario pregunte entre pasos.",
		promptSnippet: "Muestra el recorrido guiado de Drakonc Shell paso a paso y explica cada paso.",
		parameters: GuideParams,
		prepareLoadout: hideBehindCodemode(GUIDE_TOOL_NAME),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { action, step } = params as GuideParamsValue;
			const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
			if (action === "start") {
				const tour = new GuideTour(guideSteps(available()));
				if (ctx.hasUI && ctx.mode === "tui") void open(ctx, tour, "agent");
				else {
					active?.close("ended");
					const headless: Session = { tour, mode: "agent", ctx, placement: "", settled: Promise.resolve(undefined), headless: true, close: () => { if (active === headless) active = undefined; } };
					active = headless;
				}
				return text(`${guideStepText(tour, env)}\nPasos del recorrido: ${tour.steps.map((item) => item.title).join(", ")}`);
			}
			const session = active;
			if (!session) return text(`No hay ningún recorrido en marcha. Llama a ${GUIDE_TOOL_NAME} con action "start".`);
			if (action === "end") {
				session.close("ended");
				return text("Recorrido terminado.");
			}
			const { tour } = session;
			if (action === "show" && !tour.show(step ?? "")) return text(`Paso desconocido "${step ?? ""}". Pasos: ${tour.steps.map((item) => item.id).join(", ")}`);
			if (action === "next" && !tour.next()) return text(`Este era el último paso. Llama a ${GUIDE_TOOL_NAME} con action "end".`);
			if (action === "previous" && !tour.previous()) return text(`Este es el primer paso.\n${guideStepText(tour, env)}`);
			void moved(session);
			return text(guideStepText(tour, env));
		},
	});

	pi.on("before_agent_start", (event) => {
		appendSystemPromptOnce(event.systemPromptOptions, GUIDE_PROMPT_HINT);
		if (codemodeReaches(event.systemPromptOptions?.selectedTools) && event.systemPromptOptions?.selectedTools?.includes(GUIDE_TOOL_NAME)) appendSystemPromptOnce(event.systemPromptOptions, GUIDE_TOOL_ROUTE);
		return undefined;
	});
	pi.on("session_shutdown", () => {
		active?.close("ended");
		active = undefined;
	});
}
