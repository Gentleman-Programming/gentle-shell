import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendSystemPromptOnce } from "../lib/append-system-prompt.ts";
import type { DesignSessionContent } from "../lib/design-canvas-server.ts";
import { DESIGN_COMMENTS_TOOL_NAME, DESIGN_HELP, DESIGN_PROMPT_HINT, DESIGN_SKILL_NAME, DESIGN_SYNC_REQUEST, DESIGN_TOOL_NAME, createDesignCanvas, designRunMessage, designUsage, hasSystemBoard, listDesigns, parseDesignArgs, planDesignImplement, runDesignCommentsTool, runDesignTool, sendDesignImplement, type DesignCanvasDeps, type DesignCommentsToolParams, type DesignToolParams } from "../lib/gentle-design.ts";

// Gentle Design: /gentle:design <brief> runs the bundled gentle-design skill,
// which writes self-contained HTML artboards under design/<slug>/ with
// whatever model the session uses. open (and no arguments, when designs
// exist) shows them on a loopback canvas whose comments come back to the
// session and persist in design/<slug>/comments.json; stop and session
// shutdown close it. The gentle_design_comments tool lets any model list and
// resolve those comments. sync runs the skill's design-system mode, which
// writes design/system.md and design/system.html; implement (and the canvas
// Implement button) hands one artboard off to the project's real stack.
// The gentle_design tool gives the model list/open/stop/implement on the same
// canvas, and a system-prompt hint makes the skill the default design flow.
// list also reports the project's design sources and whether design/system.md
// is missing or stale, so the skill syncs first or warns (S13).
// Every handoff (command, tool, canvas) is recorded in design/<slug>/handoffs.json
// as sent and chosen; the tool's handoff action records in_progress and
// implemented (with the running app's loopback previewUrl) for the canvas (S15).

export const DESIGN_COMMAND_NAME = "gentle:design";

const DesignCommentsParams = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("resolve")], { description: "list: open comments; resolve: mark comments resolved after applying them" }),
	slug: Type.Optional(Type.String({ description: "Design slug (directory under design/); required for resolve" })),
	file: Type.Optional(Type.String({ description: "Artboard file within the design, such as 01-calm.html (list only)" })),
	ids: Type.Optional(Type.Array(Type.String(), { maxItems: 500, description: "Comment ids to resolve" })),
});

const DesignParams = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("open"), Type.Literal("stop"), Type.Literal("implement"), Type.Literal("handoff")], { description: "list: designs, artboards, chosen artboards and handoff states, design sources, design/system.md state and canvas state; open: show a design on the canvas; stop: close the canvas; implement: get the handoff for one artboard; handoff: report progress on a handed-off artboard" }),
	slug: Type.Optional(Type.String({ description: "Design slug for open (directory under design/); defaults to the most recent design" })),
	target: Type.Optional(Type.String({ description: "Artboard for implement or handoff, as <slug>/<artboard>, such as login/01-split.html" })),
	status: Type.Optional(Type.Union([Type.Literal("in_progress"), Type.Literal("implemented")], { description: "handoff only: in_progress when you start implementing, implemented when it is done" })),
	note: Type.Optional(Type.String({ maxLength: 1000, description: "handoff only: a short note shown on the canvas" })),
	previewUrl: Type.Optional(Type.String({ maxLength: 2048, description: "handoff only: the running app's loopback URL (http or https on localhost, 127.0.0.1 or [::1], any port), so the canvas can compare it with the artboard" })),
});

export interface GentleDesignDeps extends DesignCanvasDeps {
	/** Absolute path of the bundled skill, named in the message when Pi has not loaded it. */
	skillPath?: string;
	/** Process environment; a delegated child session (GENTLE_PI_AGENTS_CHILD=1) gets no prompt hint. */
	env?: NodeJS.ProcessEnv;
}

/** A stale or replaced context counts as busy, so a comment is queued rather than interrupting. */
function isIdle(ctx: ExtensionContext | undefined): boolean {
	try {
		return ctx?.isIdle() ?? true;
	} catch {
		return false;
	}
}

export default function gentleDesign(pi: ExtensionAPI, deps: GentleDesignDeps = {}): void {
	const skillPath = deps.skillPath ?? fileURLToPath(new URL("../skills/design/SKILL.md", import.meta.url));
	// Canvas comments arrive between commands; the last command's context answers whether the agent is busy.
	let latest: ExtensionContext | undefined;
	// Answers whether the message waits as a follow-up, which a handoff records as queued (S15).
	// A canvas comment with a screenshot is text plus an image; handoffs stay plain text.
	const deliver = (message: DesignSessionContent) => {
		const queued = !isIdle(latest);
		pi.sendUserMessage(message, queued ? { deliverAs: "followUp" } : undefined);
		return { queued };
	};
	const canvas = createDesignCanvas(deliver, deps);

	const open = async (ctx: ExtensionContext, slug?: string) => {
		const notice = await canvas.open(ctx.cwd, slug);
		ctx.ui.notify(notice.message, notice.level);
	};

	const skillLoaded = () => pi.getCommands().some((command) => command.name === `skill:${DESIGN_SKILL_NAME}`);

	// sendUserMessage expands /skill:<name> only when Pi loaded that skill;
	// an unknown skill command would reach the model verbatim.
	const runSkill = (request: string, ctx: ExtensionContext) => {
		const content = designRunMessage(request, { loaded: skillLoaded(), path: skillPath });
		pi.sendUserMessage(content, ctx.isIdle() ? { expandPromptTemplates: true } : { expandPromptTemplates: true, deliverAs: "followUp" });
	};

	const handle = async (args: string, ctx: ExtensionContext) => {
		latest = ctx;
		const parsed = parseDesignArgs(args);
		if (parsed.kind === "usage") {
			if (listDesigns(ctx.cwd).length > 0 || hasSystemBoard(ctx.cwd)) await open(ctx);
			else ctx.ui.notify(designUsage([]), "info");
			return;
		}
		if (parsed.kind === "subcommand") {
			if (parsed.name === "open") return open(ctx, parsed.rest || undefined);
			if (parsed.name === "stop") {
				ctx.ui.notify((await canvas.stop()) ? "Design canvas stopped." : "No design canvas is running.", "info");
				return;
			}
			if (parsed.name === "sync") {
				if (parsed.rest) ctx.ui.notify("/gentle:design sync takes no arguments.", "warning");
				else runSkill(DESIGN_SYNC_REQUEST, ctx);
				return;
			}
			const plan = await planDesignImplement(ctx.cwd, parsed.rest);
			if (plan.kind === "send") {
				for (const warning of plan.warnings) ctx.ui.notify(warning, "warning");
				try {
					await sendDesignImplement(ctx.cwd, plan, deliver);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
				}
			} else ctx.ui.notify(plan.notice.message, plan.notice.level);
			return;
		}
		runSkill(parsed.brief, ctx);
	};

	pi.registerCommand(DESIGN_COMMAND_NAME, { description: DESIGN_HELP, handler: handle });
	pi.registerTool({
		name: DESIGN_COMMENTS_TOOL_NAME,
		label: "Design comments",
		description: "List the open canvas comments stored in design/<slug>/comments.json, or mark comments resolved once you have applied them.",
		promptSnippet: "List open gentle-design canvas comments and resolve them after applying them.",
		parameters: DesignCommentsParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await runDesignCommentsTool(ctx.cwd, params as DesignCommentsToolParams);
			return { content: [{ type: "text" as const, text: result.text }], details: result.details };
		},
	});
	pi.registerTool({
		name: DESIGN_TOOL_NAME,
		label: "Gentle Design",
		description: "Drive the gentle-design canvas. Call list before designing: it reports the project's design sources and whether design/system.md is missing or older than them (sync first, or offer to sync again). list also gives the designs under design/ (artboards, system board, whether the canvas runs and its URL); open a design on the local canvas (optional slug, default the most recent) or refresh it after writing or changing artboards, returning the URL; stop the canvas; implement one artboard (target <slug>/<artboard>), which returns the handoff instructions to follow and records it as the design's chosen artboard; handoff reports your progress on that artboard (status in_progress when you start, implemented when done, with previewUrl of the running app on localhost, 127.0.0.1 or [::1] when there is one), which the canvas shows live. Write briefs and run the design-system sync by following the gentle-design skill, not this tool.",
		promptSnippet: "List gentle-design designs, open or stop their canvas, get an artboard's implementation handoff, and report its progress.",
		parameters: DesignParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Comments from a canvas the tool opened are queued while this run is busy.
			latest = ctx;
			const result = await runDesignTool(ctx.cwd, params as DesignToolParams, canvas);
			return { content: result.texts.map((text) => ({ type: "text" as const, text })), details: result.details };
		},
	});
	// gentle-shell#1485: appendSystemPrompt reaches every provider. Delegated
	// children only run their task, so they never get the default design flow.
	const env = deps.env ?? process.env;
	pi.on("before_agent_start", (event) => {
		if (env.GENTLE_PI_AGENTS_CHILD === "1") return undefined;
		const options = event.systemPromptOptions;
		const available = options?.skills?.some((skill) => skill.name === DESIGN_SKILL_NAME) || skillLoaded();
		if (available) appendSystemPromptOnce(options, DESIGN_PROMPT_HINT);
		return undefined;
	});
	pi.on("session_shutdown", async () => {
		latest = undefined;
		await canvas.stop();
	});
}
