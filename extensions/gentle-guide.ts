import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { appendSystemPromptOnce } from "../lib/append-system-prompt.ts";
import { codemodeReaches, GUIDE_TOOL_ROUTE, hideBehindCodemode } from "../lib/hidden-tools.ts";
import { guidePlacement, GuidePopover, guideStepText, guideSteps, GuideTour, type GuideMode, type GuideResult } from "../lib/gentle-guide.ts";
import { sidebarState } from "../lib/shell-sidebar.ts";

// /gentle:guide: a guided tour of Gentle Shell. With a model, the agent
// drives it through the gentle_guide tool, one step per turn, and the
// popover stays beside the prompt without taking its focus, so the user can
// ask questions mid-tour. Without one (or with `local`), the user steps
// through it with the arrow keys. Pi reads overlay options only when an
// overlay opens, so a step for another region closes the popover and
// reopens it there.

export const GUIDE_COMMAND_NAME = "gentle:guide";
export const GUIDE_TOOL_NAME = "gentle_guide";
const GUIDE_MESSAGE_TYPE = "gentle-guide";
const USAGE = "Usage: /gentle:guide [local|stop]";

export const GUIDE_AGENT_REQUEST = `The user ran /gentle:guide. Give them the guided tour of Gentle Shell, one step per turn: call ${GUIDE_TOOL_NAME} with action "start", explain that step in two or three sentences in the user's language, and end your turn asking whether to continue or if they have a question. When they want to continue, call ${GUIDE_TOOL_NAME} with action "next" and do the same. If they ask something, answer it and stay on the current step. After the last step, call ${GUIDE_TOOL_NAME} with action "end".`;

export const GUIDE_PROMPT_HINT = `Gentle Shell guided tour: when the user asks how to use Gentle Shell or what it can do, offer /gentle:guide; you can also drive it with the ${GUIDE_TOOL_NAME} tool (start, next, previous, show, end), one step per turn.`;

const GuideParams = Type.Object({
	action: Type.Union([Type.Literal("start"), Type.Literal("next"), Type.Literal("previous"), Type.Literal("show"), Type.Literal("end")], { description: "start opens the first step; next and previous move; show jumps to a step id; end closes the tour." }),
	step: Type.Optional(Type.String({ description: "show only: the step id to jump to." })),
});

interface GuideParamsValue {
	action: "start" | "next" | "previous" | "show" | "end";
	step?: string;
}

interface Session {
	tour: GuideTour;
	mode: GuideMode;
	ctx: ExtensionContext;
	/** Closes the popover with `result`; a no-op once it is closed. */
	close(result: GuideResult): void;
	/** The placement the popover opened with, to tell whether a step needs it elsewhere. */
	placement: string;
	/** Resolves when this popover closes; immediately resolved without a terminal. */
	settled: Promise<GuideResult | undefined>;
	/** True without a terminal: the agent explains the steps in text only. */
	headless?: boolean;
	tui?: TUI;
}

function railColumns(tui: TUI | undefined): number | undefined {
	if (!tui) return undefined;
	const state = sidebarState(tui);
	return state.active && (state.ownsHost?.() ?? true) ? state.railColumns : undefined;
}

export default function gentleGuide(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	// Delegated children only run their task.
	if (env.GENTLE_PI_AGENTS_CHILD === "1") return;
	let active: Session | undefined;

	const available = (): Set<string> => new Set([...pi.getCommands().map((command) => command.name), ...pi.getAllTools().map((tool) => tool.name)]);
	const placementOf = (session: Pick<Session, "tour" | "mode" | "tui">) => {
		const columns = session.tui?.terminal.columns ?? 80;
		return guidePlacement(session.tour.current().region, columns, railColumns(session.tui), session.mode);
	};

	/** Opens the popover at the tour's current step; resolves with how it closed. */
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

	/** After the tour moved: repaint in place, or reopen the popover beside the new step. */
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
		// A move reopens the popover; the new one carries the same tour on.
		while (result === "moved") {
			const next = active;
			if (!next || next.tour !== tour) return;
			result = await next.settled;
		}
		if (result === "finished") ctx.ui.notify("Tour finished. Run /gentle:guide any time to see it again.", "info");
	};

	pi.registerCommand(GUIDE_COMMAND_NAME, {
		description: "Take a guided tour of what Gentle Shell can do, explained by the agent (local: step through it yourself with the arrow keys; stop: end it).",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const arg = args.trim().toLowerCase();
			if (arg === "stop") {
				if (!active) return ctx.ui.notify("No guided tour is running.", "info");
				active.close("ended");
				return ctx.ui.notify("Guided tour ended.", "info");
			}
			if (arg !== "" && arg !== "local") return ctx.ui.notify(USAGE, "warning");
			if (ctx.mode !== "tui") return ctx.ui.notify("The guided tour requires an interactive terminal.", "warning");
			if (arg === "local" || !ctx.model) return runLocal(ctx);
			pi.sendMessage({ customType: GUIDE_MESSAGE_TYPE, content: GUIDE_AGENT_REQUEST, display: false }, ctx.isIdle() ? { triggerTurn: true } : { triggerTurn: true, deliverAs: "followUp" });
			ctx.ui.notify("Starting the guided tour with the agent…", "info");
		},
	});

	pi.registerTool({
		name: GUIDE_TOOL_NAME,
		label: "Gentle guide",
		description: "Drive the /gentle:guide tour of Gentle Shell: start shows the first step as a popover beside the part of the screen it describes and returns its text to explain; next, previous and show (with a step id) move; end closes the popover. Show one step per turn and let the user ask questions between steps.",
		promptSnippet: "Show the Gentle Shell guided tour one step at a time and explain each step.",
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
				return text(`${guideStepText(tour, env)}\nTour steps: ${tour.steps.map((item) => item.title).join(", ")}`);
			}
			const session = active;
			if (!session) return text(`No tour is running. Call ${GUIDE_TOOL_NAME} with action "start".`);
			if (action === "end") {
				session.close("ended");
				return text("Tour ended.");
			}
			const { tour } = session;
			if (action === "show" && !tour.show(step ?? "")) return text(`Unknown step "${step ?? ""}". Steps: ${tour.steps.map((item) => item.id).join(", ")}`);
			if (action === "next" && !tour.next()) return text(`This was the last step. Call ${GUIDE_TOOL_NAME} with action "end".`);
			if (action === "previous" && !tour.previous()) return text(`This is the first step.\n${guideStepText(tour, env)}`);
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
