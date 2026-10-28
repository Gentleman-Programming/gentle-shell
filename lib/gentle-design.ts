import { join } from "node:path";
import { designCommentBatchContent, designCommentContent, hasSystemTokens, listDesignEntries, readDesignManifest, resolveSystemBoard, startDesignCanvasServer, type DesignArtboard, type DesignCanvasServer, type DesignCanvasServerOptions, type DesignSessionContent } from "./design-canvas-server.ts";
import { createDesignCommentStore, DesignCommentsError, type StoredDesignComment } from "./design-comments.ts";
import { createDesignHandoffStore, DesignHandoffsError, sendDesignHandoff, type DesignHandoff, type DesignHandoffDelivery, type DesignHandoffStatus } from "./design-handoffs.ts";
import { openInBrowser, type OpenInBrowserResult } from "./design-open-browser.ts";
import { detectDesignSources, staleDesignSources } from "./design-sources.ts";

// Gentle Design helpers: argument parsing, the designs already written under
// design/<slug>/design.json, the usage text, the per-session canvas that
// open/stop drive, and the comments tool. The extension stays a thin wrapper.

export const DESIGN_SKILL_NAME = "gentle-design";

export const DESIGN_SUBCOMMANDS = ["open", "stop", "sync", "implement"] as const;
export type DesignSubcommand = (typeof DESIGN_SUBCOMMANDS)[number];

export type DesignArgs =
	| { kind: "usage" }
	| { kind: "subcommand"; name: DesignSubcommand; rest: string }
	| { kind: "brief"; brief: string };

export function parseDesignArgs(args: string): DesignArgs {
	const text = args.trim();
	if (!text) return { kind: "usage" };
	const [head = "", ...rest] = text.split(/\s+/);
	const name = DESIGN_SUBCOMMANDS.find((subcommand) => subcommand === head);
	return name ? { kind: "subcommand", name, rest: rest.join(" ") } : { kind: "brief", brief: text };
}

export interface DesignSummary {
	slug: string;
	title: string;
	/** design.json modification time in milliseconds. */
	mtime: number;
}

/** Designs under <cwd>/design, through the listing the canvas server uses (same containment rule). */
export function listDesigns(cwd: string): DesignSummary[] {
	return listDesignEntries(join(cwd, "design")).map(({ slug, title, mtime }) => ({ slug, title, mtime }));
}

/** Whether design/system.html exists, so the canvas can open on the system board alone. */
export function hasSystemBoard(cwd: string): boolean {
	return resolveSystemBoard(join(cwd, "design")) !== undefined;
}

export const DESIGN_HELP =
	"Design HTML artboards with any model: /gentle:design <brief> starts a design run; no arguments open the latest design (or the system board alone) on the local canvas. Subcommands: open [slug], stop, sync (write design/system.md and design/system.html from the project's design sources; the canvas shows that system board first), implement <slug>/<artboard> (hand an artboard off to the project's real stack, also from the canvas Implement button).";

/** What /gentle:design sync asks the skill to do; it rides designRunMessage like a brief. */
export const DESIGN_SYNC_REQUEST =
	'sync the project design system: follow "Design system sync" to read the project\'s design sources and write design/system.md and design/system.html.';

export function designUsage(designs: readonly DesignSummary[]): string {
	const lines = ["Usage: /gentle:design <brief>", "Describe the goal, layout, content, and audience. Directions are written to design/<slug>/."];
	if (designs.length > 0) {
		lines.push("", "Designs in this project:");
		for (const design of designs) lines.push(`  ${design.title} (${design.slug})`);
	}
	return lines.join("\n");
}

/** The message that runs the skill: a skill command when Pi has it loaded, otherwise a pointer to the bundled file. */
export function designRunMessage(brief: string, skill: { loaded: boolean; path: string }): string {
	if (skill.loaded) return `/skill:${DESIGN_SKILL_NAME} ${brief}`;
	return `Read the ${DESIGN_SKILL_NAME} skill at ${skill.path} and follow it for this design brief:\n\n${brief}`;
}

export type DesignNotice = { message: string; level: "info" | "warning" | "error" };

export type DesignImplementInput = {
	slug: string;
	artboard: Pick<DesignArtboard, "file" | "title" | "tradeoff">;
	/** The design's valid ODD feature document, when design.json links one. */
	feature?: string;
	/** Whether design/system.md exists. */
	systemTokens: boolean;
	/** The open comments on this artboard. */
	comments: ReadonlyArray<Pick<StoredDesignComment, "id" | "selector" | "excerpt" | "comment">>;
};

/** The handoff message for one artboard (S8); the command and the canvas button both send exactly this. */
export function designImplementMessage(input: DesignImplementInput): string {
	const path = `design/${input.slug}/${input.artboard.file}`;
	const lines = [
		`Implement the design artboard ${path}`,
		"",
		`Artboard: ${path}`,
		`Title: ${input.artboard.title}`,
	];
	if (input.artboard.tradeoff) lines.push(`Tradeoff: ${input.artboard.tradeoff}`);
	lines.push(
		"",
		"Implement it in the project's real stack. Use the artboard as the visual spec: map its parts to the project's existing components and styles, and do not copy the artboard HTML verbatim.",
	);
	if (input.systemTokens) lines.push("Take colors, typography, spacing, radius and shadows from design/system.md, the project's token source.");
	if (input.comments.length > 0) {
		lines.push("", `Open comments on this artboard (${input.comments.length}); apply each one in the implementation:`);
		input.comments.forEach((comment, index) => {
			lines.push(
				`${index + 1}. Comment id: ${comment.id}`,
				`   Element: ${comment.selector}`,
				`   Excerpt: ${comment.excerpt ? JSON.stringify(comment.excerpt) : "(none)"}`,
				"   Comment:",
				...comment.comment.split("\n").map((line) => `   ${line}`),
			);
		});
		const ids = input.comments.map((comment) => JSON.stringify(comment.id)).join(", ");
		lines.push(`When they are applied, resolve them with the ${DESIGN_COMMENTS_TOOL_NAME} tool (action "resolve", slug "${input.slug}", ids [${ids}]).`);
	}
	lines.push(
		"",
		`Report progress with the ${DESIGN_TOOL_NAME} tool: action "handoff", target "${input.slug}/${input.artboard.file}", status "in_progress" when you start; status "implemented" when it is done, with previewUrl set to the running app's loopback URL (localhost, 127.0.0.1 or [::1]) when one is running, so the canvas can compare it with the artboard.`,
		input.feature
			? `This design belongs to an ODD feature: track this implementation in ${input.feature} (add or reopen its task there and log this handoff).`
			: "This design is not linked to an ODD feature document: size it under the project's ODD rules as usual.",
		"This handoff itself commits nothing.",
	);
	return lines.join("\n");
}

/** The artboard a handoff records in handoffs.json (S15). */
export type DesignHandoffTarget = { slug: string; file: string; feature?: string };

/** `warnings` name what design.json dropped (an invalid feature link), so the command can report it. */
export type DesignImplementPlan = { kind: "send"; message: string; warnings: string[]; handoff: DesignHandoffTarget } | { kind: "refuse"; notice: DesignNotice };

function implementTargets(cwd: string): string[] {
	const targets: string[] = [];
	for (const design of listDesigns(cwd)) {
		try {
			for (const artboard of readDesignManifest(join(cwd, "design"), design.slug).artboards) targets.push(`${design.slug}/${artboard.file}`);
		} catch {
			// An unreadable design has no artboard to hand off.
		}
	}
	return targets;
}

type DesignRefusal = Extract<DesignImplementPlan, { kind: "refuse" }>;

function unknownTarget(cwd: string, reason: string): DesignRefusal {
	const targets = implementTargets(cwd);
	if (targets.length === 0) return { kind: "refuse", notice: { message: `${reason}\nNo designs in design/ yet.\n${designUsage([])}`, level: "warning" } };
	const shown = targets.length > 30 ? [...targets.slice(0, 30), `… ${targets.length - 30} more`] : targets;
	return { kind: "refuse", notice: { message: `${reason}\nUsage: /gentle:design implement <slug>/<artboard>. Available: ${shown.join(", ")}.`, level: "warning" } };
}

type ResolvedTarget = { kind: "artboard"; slug: string; artboard: DesignArtboard; feature?: string; warnings: string[] };

/** `<slug>/<file>` checked against the design's manifest; `what` names the action in the refusal. */
function resolveDesignTarget(cwd: string, target: string, what: string): ResolvedTarget | DesignRefusal {
	const text = target.trim();
	const slash = text.indexOf("/");
	const slug = slash === -1 ? text : text.slice(0, slash);
	const file = slash === -1 ? "" : text.slice(slash + 1);
	if (!slug || !file) return unknownTarget(cwd, `Name the artboard to ${what} as <slug>/<artboard>.`);
	if (!listDesigns(cwd).some((design) => design.slug === slug)) return unknownTarget(cwd, `No design "${slug}" in design/.`);
	let manifest;
	try {
		manifest = readDesignManifest(join(cwd, "design"), slug);
	} catch (error) {
		return { kind: "refuse", notice: { message: error instanceof Error ? error.message : String(error), level: "warning" } };
	}
	const artboard = manifest.artboards.find((candidate) => candidate.file === file);
	if (!artboard) return unknownTarget(cwd, `No artboard "${file}" in design/${slug}/design.json.`);
	const warnings = (manifest.warnings ?? []).map((warning) => `design/${slug}/design.json: ${warning}`);
	return { kind: "artboard", slug, artboard, feature: manifest.feature, warnings };
}

/** Validates `<slug>/<file>` against the design's manifest and builds its handoff message. */
export async function planDesignImplement(cwd: string, target: string): Promise<DesignImplementPlan> {
	const resolved = resolveDesignTarget(cwd, target, "implement");
	if (resolved.kind === "refuse") return resolved;
	const { slug, artboard, feature, warnings } = resolved;
	const designRoot = join(cwd, "design");
	let comments: StoredDesignComment[];
	try {
		comments = await createDesignCommentStore(designRoot).listOpen(slug, artboard.file);
	} catch (error) {
		const reason = error instanceof DesignCommentsError && error.code === "invalid-file"
			? `design/${slug}/comments.json cannot be read: ${error.message}. Fix the file by hand; it is never overwritten.`
			: error instanceof Error ? error.message : String(error);
		return { kind: "refuse", notice: { message: reason, level: "warning" } };
	}
	return { kind: "send", message: designImplementMessage({ slug, artboard, feature, systemTokens: hasSystemTokens(designRoot), comments }), warnings, handoff: { slug, file: artboard.file, feature } };
}

/** A handoffs.json problem as the reason the user or the model reads; a broken file is never overwritten. */
function handoffsProblem(slug: string, error: unknown): Error {
	if (error instanceof DesignHandoffsError && error.code === "invalid-file") {
		return new Error(`design/${slug}/handoffs.json cannot be read: ${error.message}. Fix the file by hand; it is never overwritten.`);
	}
	return error instanceof Error ? error : new Error(String(error));
}

/**
 * Sends a planned handoff (the command): recorded in handoffs.json as sent and
 * chosen before `deliver` runs, then marked queued when the delivery says so.
 */
export async function sendDesignImplement(cwd: string, plan: Extract<DesignImplementPlan, { kind: "send" }>, deliver: (message: string) => DesignHandoffDelivery | Promise<DesignHandoffDelivery>): Promise<{ queued: boolean }> {
	const store = createDesignHandoffStore(join(cwd, "design"));
	return sendDesignHandoff(store, plan.handoff, () => deliver(plan.message)).catch((error: unknown) => {
		throw error instanceof DesignHandoffsError ? handoffsProblem(plan.handoff.slug, error) : error;
	});
}

export interface DesignCanvasDeps {
	startServer?: (options: DesignCanvasServerOptions) => Promise<DesignCanvasServer>;
	openBrowser?: (url: string) => Promise<OpenInBrowserResult>;
}

/**
 * `url` is set once the canvas shows something; `opened` says whether a browser tab shows it.
 * `refreshed` is true when an already connected canvas page was told to show and reload it,
 * so no new tab was opened (S14).
 */
export type DesignOpenNotice = DesignNotice & { url?: string; opened?: boolean; refreshed?: boolean };

export interface DesignCanvas {
	/**
	 * Shows `slug`, or the most recent design, on the session's canvas server, starting it when needed.
	 * A running server with a connected canvas page refreshes that page instead of opening the browser.
	 */
	open(cwd: string, slug?: string): Promise<DesignOpenNotice>;
	/** Closes the running server; false when none was running. */
	stop(): Promise<boolean>;
	/** The URL the running canvas last showed; undefined when none is running. */
	url(): string | undefined;
}

/** The canvas of `slug`, or the root canvas (system board only) when slug is null. */
function canvasUrl(server: DesignCanvasServer, slug: string | null): string {
	return new URL(slug === null ? `/${server.token}/` : `/${server.token}/d/${slug}/`, server.url).href;
}

/**
 * One canvas server per session; comment messages go to `deliver`, whose failure the server reports as HTTP 500.
 * For a handoff, `deliver` also answers whether the message was queued behind a busy agent.
 * A comment with a readable screenshot arrives as text followed by the attached image.
 */
export function createDesignCanvas(deliver: (message: DesignSessionContent) => DesignHandoffDelivery | Promise<DesignHandoffDelivery>, deps: DesignCanvasDeps = {}): DesignCanvas {
	const startServer = deps.startServer ?? startDesignCanvasServer;
	const openBrowser = deps.openBrowser ?? ((url: string) => openInBrowser(url));
	let running: { root: string; server: Promise<DesignCanvasServer>; url?: string } | undefined;

	async function stop(): Promise<boolean> {
		const current = running;
		running = undefined;
		if (!current) return false;
		const server = await current.server.catch(() => undefined);
		await server?.close();
		return server !== undefined;
	}

	async function serverFor(cwd: string): Promise<DesignCanvasServer> {
		const root = join(cwd, "design");
		// A new session cwd means a different design root, so the old server goes.
		if (running && running.root !== root) await stop();
		if (!running) {
			const server = startServer({
				designRoot: root,
				onComment: async (comment) => { await deliver(designCommentContent(comment)); },
				onComments: async (batch) => { await deliver(designCommentBatchContent(batch)); },
				// The same plan as /gentle:design implement, so both send identical text; the server
				// has already recorded the handoff, and this answers whether it was queued.
				onImplement: async ({ slug, file }) => {
					const plan = await planDesignImplement(cwd, `${slug}/${file}`);
					if (plan.kind === "refuse") throw new Error(plan.notice.message);
					return deliver(plan.message);
				},
			});
			running = { root, server };
			server.catch(() => { if (running?.server === server) running = undefined; });
		}
		return running.server;
	}

	async function open(cwd: string, requested?: string): Promise<DesignOpenNotice> {
		const designs = listDesigns(cwd);
		// With only design/system.html, the canvas opens on the system board alone (L14).
		const systemOnly = designs.length === 0 && requested === undefined && hasSystemBoard(cwd);
		if (designs.length === 0 && !systemOnly) {
			return { message: `No designs in design/ yet.\n${designUsage([])}`, level: "warning" };
		}
		const slug = systemOnly ? null : requested ?? designs[0].slug;
		if (slug !== null && !designs.some((design) => design.slug === slug)) {
			return { message: `No design "${slug}" in design/. Available: ${designs.map((design) => design.slug).join(", ")}.`, level: "warning" };
		}
		// Only a server that was already running can have a canvas page of its own connected.
		const reused = running?.root === join(cwd, "design");
		let server: DesignCanvasServer;
		try {
			server = await serverFor(cwd);
		} catch (error) {
			return { message: `The design canvas could not start: ${error instanceof Error ? error.message : String(error)}`, level: "error" };
		}
		const url = canvasUrl(server, slug);
		if (running) running.url = url;
		if (reused && server.connectedClients() > 0 && server.show(slug) > 0) {
			return { message: `Design canvas refreshed: ${url}`, level: "info", url, opened: true, refreshed: true };
		}
		const result = await openBrowser(url);
		if (result.opened) return { message: `Design canvas: ${url}`, level: "info", url, opened: true };
		const reason = result.error ? ` (${result.error})` : "";
		return { message: `Design canvas: ${url}\nThe browser could not be opened${reason}. Open the URL manually.`, level: "warning", url, opened: false };
	}

	return { open, stop, url: () => running?.url };
}

export const DESIGN_COMMENTS_TOOL_NAME = "gentle_design_comments";

export type DesignCommentsToolParams = { action: "list" | "resolve"; slug?: string; file?: string; ids?: string[] };
export type DesignCommentsToolResult = { text: string; details: { comments: Array<StoredDesignComment & { slug: string }> } | { slug: string; resolved: string[]; unknown: string[] } };

function describeComment(slug: string, comment: StoredDesignComment): string[] {
	return [
		`- [${comment.id}] design/${slug}/${comment.file}`,
		`  Element: ${comment.selector}`,
		`  Excerpt: ${comment.excerpt ? JSON.stringify(comment.excerpt) : "(none)"}`,
		`  Comment: ${comment.comment.split("\n").join("\n           ")}`,
		...(comment.screenshot ? [`  Screenshot: design/${slug}/${comment.screenshot} (open it with the read tool)`] : []),
	];
}

/** list: open comments (all designs, or one design and artboard); resolve: mark ids of one design resolved. */
export async function runDesignCommentsTool(cwd: string, params: DesignCommentsToolParams): Promise<DesignCommentsToolResult> {
	const store = createDesignCommentStore(join(cwd, "design"));
	const failure = (slug: string, error: unknown) => error instanceof DesignCommentsError && error.code === "invalid-file"
		? new Error(`design/${slug}/comments.json cannot be read: ${error.message}. Fix the file by hand; it is never overwritten.`)
		: error;
	if (params.action === "resolve") {
		if (typeof params.slug !== "string" || !params.slug) throw new Error("resolve needs the design slug.");
		const ids = params.ids ?? [];
		if (ids.length === 0) throw new Error("resolve needs at least one comment id in ids.");
		const { updated, unknown } = await store.setStatus(params.slug, ids, "resolved").catch((error: unknown) => { throw failure(params.slug!, error); });
		const resolved = updated.map((comment) => comment.id);
		const lines = [`Resolved ${resolved.length} comment${resolved.length === 1 ? "" : "s"} in design/${params.slug}${resolved.length ? `: ${resolved.join(", ")}` : ""}.`];
		if (unknown.length) lines.push(`Unknown ids: ${unknown.join(", ")}.`);
		return { text: lines.join("\n"), details: { slug: params.slug, resolved, unknown } };
	}
	const slugs = params.slug ? [params.slug] : listDesigns(cwd).map((design) => design.slug);
	const found: Array<StoredDesignComment & { slug: string }> = [];
	const problems: string[] = [];
	for (const slug of slugs) {
		try {
			for (const comment of await store.listOpen(slug, params.file)) found.push({ slug, ...comment });
		} catch (error) {
			// One design's broken file must not hide the others, unless it was asked for by name.
			if (params.slug) throw failure(slug, error);
			problems.push(`design/${slug}/comments.json: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const scope = params.slug ? `design/${params.slug}${params.file ? `/${params.file}` : ""}` : "design/";
	const lines = found.length === 0
		? [`No open comments in ${scope}.`]
		: [`Open design comments in ${scope} (${found.length}):`, ...found.flatMap((comment) => describeComment(comment.slug, comment)), "", `After applying a comment, resolve it with ${DESIGN_COMMENTS_TOOL_NAME} (action "resolve", slug, ids).`];
	if (problems.length) lines.push("", "Unreadable comment files:", ...problems.map((problem) => `- ${problem}`));
	return { text: lines.join("\n"), details: { comments: found } };
}

export const DESIGN_TOOL_NAME = "gentle_design";

/** Appended to the system prompt while the gentle-design skill is available (S11). */
export const DESIGN_PROMPT_HINT = [
	`Gentle Design: any request for a UI design, mockup, screen, landing page or visual directions uses the ${DESIGN_SKILL_NAME} skill by default; read the skill first when it is not loaded.`,
	`Before designing, call the ${DESIGN_TOOL_NAME} tool (action "list"); when the project has design sources but no design/system.md, run the skill's design system sync first.`,
	`After writing or changing a design, open or refresh it on the canvas with the ${DESIGN_TOOL_NAME} tool (action "open" with the slug), unless the user said not to.`,
	"Designs stay under design/<slug>/.",
].join("\n");

export type DesignToolParams = {
	action: "list" | "open" | "stop" | "implement" | "handoff";
	slug?: string;
	target?: string;
	/** handoff only. */
	status?: string;
	note?: string;
	previewUrl?: string;
};
/** How many design source paths list names; `total` still counts them all. */
const LISTED_DESIGN_SOURCES = 20;

export type DesignSystemState = { exists: boolean; file: "design/system.md"; staleSources: string[] };
export type DesignToolDetails =
	| {
		designs: Array<{ slug: string; title: string; artboards: Array<{ file: string; title: string }>; error?: string }>;
		systemBoard: boolean;
		designSources: { paths: string[]; total: number };
		system: DesignSystemState;
		canvas: { running: boolean; url?: string };
	}
	| { url: string; opened: boolean; refreshed?: true }
	| { stopped: boolean }
	| { target: string; warnings: string[] }
	| { target: string; chosen: string | null; handoff: DesignHandoff };
/** `texts` become the tool's content parts; a refusal throws, so Pi flags the result as an error. */
export type DesignToolResult = { texts: string[]; details: DesignToolDetails };

function handoffState(entry: DesignHandoff): string {
	const status = entry.status === "in_progress" ? "in progress" : entry.status;
	const parts = [`handoff ${status}${entry.status === "sent" && entry.queued ? ", queued" : ""}`];
	if (entry.previewUrl) parts.push(`preview ${entry.previewUrl}`);
	return parts.join("; ");
}

type ListedDesign = {
	slug: string;
	title: string;
	artboards: Array<{ file: string; title: string }>;
	error?: string;
	/** Present only when the design has handoff records (S15). */
	chosen?: string | null;
	handoffs?: Record<string, DesignHandoff>;
	handoffsError?: string;
};

async function listDesignTool(cwd: string, canvas: DesignCanvas): Promise<DesignToolResult> {
	const designRoot = join(cwd, "design");
	const handoffStore = createDesignHandoffStore(designRoot);
	const designs: ListedDesign[] = [];
	for (const { slug, title } of listDesigns(cwd)) {
		let design: ListedDesign;
		try {
			const artboards = readDesignManifest(designRoot, slug).artboards.map(({ file, title }) => ({ file, title }));
			design = { slug, title, artboards };
		} catch (error) {
			design = { slug, title, artboards: [], error: error instanceof Error ? error.message : String(error) };
		}
		try {
			const document = await handoffStore.read(slug);
			if (document.chosen !== null || Object.keys(document.handoffs).length > 0) {
				design.chosen = document.chosen;
				design.handoffs = document.handoffs;
			}
		} catch (error) {
			design.handoffsError = error instanceof Error ? error.message : String(error);
		}
		designs.push(design);
	}
	const systemBoard = hasSystemBoard(cwd);
	const url = canvas.url();
	const lines = designs.length === 0 ? ["No designs in design/ yet."] : [`Designs in design/ (${designs.length}):`];
	for (const design of designs) {
		lines.push(`- ${design.slug}: ${design.title}${design.error ? ` (design.json cannot be read: ${design.error})` : ""}`);
		if (design.chosen) lines.push(`  Chosen: ${design.chosen} (the other artboards are alternatives)`);
		if (design.handoffsError) lines.push(`  handoffs.json cannot be read: ${design.handoffsError}`);
		for (const artboard of design.artboards) {
			const entry = design.handoffs && Object.hasOwn(design.handoffs, artboard.file) ? design.handoffs[artboard.file] : undefined;
			lines.push(`  - ${artboard.file}: ${artboard.title}${entry ? ` (${handoffState(entry)})` : ""}`);
		}
	}
	lines.push(systemBoard ? "System board: design/system.html (shown first on the canvas)." : "No system board (design/system.html).");
	const sources = detectDesignSources(cwd);
	const exists = hasSystemTokens(designRoot);
	const system: DesignSystemState = { exists, file: "design/system.md", staleSources: exists ? staleDesignSources(cwd, sources) : [] };
	lines.push(sources.length === 0 ? "Design sources: none detected." : `Design sources (${sources.length}): ${capped(sources)}`);
	if (!system.exists) lines.push(`Design system: no design/system.md.${sources.length > 0 ? " Run the skill's Design system sync before designing." : ""}`);
	else if (system.staleSources.length === 0) lines.push("Design system: design/system.md is up to date.");
	else {
		const count = system.staleSources.length;
		lines.push(`Design system: design/system.md is older than ${count} source${count === 1 ? "" : "s"} changed after it: ${capped(system.staleSources)}. Say its tokens may be outdated and offer to sync again before designing.`);
	}
	lines.push(url ? `Canvas: running at ${url}` : "Canvas: not running.");
	const designSources = { paths: sources.slice(0, LISTED_DESIGN_SOURCES), total: sources.length };
	return { texts: [lines.join("\n")], details: { designs, systemBoard, designSources, system, canvas: url ? { running: true, url } : { running: false } } };
}

function capped(paths: readonly string[]): string {
	const shown = paths.slice(0, LISTED_DESIGN_SOURCES);
	if (paths.length > shown.length) shown.push(`… ${paths.length - shown.length} more`);
	return shown.join(", ");
}

/** The handoff action: the agent's progress on one artboard, validated by the manifest and the store. */
async function handoffTool(cwd: string, params: DesignToolParams): Promise<DesignToolResult> {
	if (params.status !== "in_progress" && params.status !== "implemented") throw new Error('handoff needs status "in_progress" or "implemented".');
	const status: Exclude<DesignHandoffStatus, "sent"> = params.status;
	const resolved = resolveDesignTarget(cwd, params.target ?? "", "report on");
	if (resolved.kind === "refuse") throw new Error(resolved.notice.message);
	const { slug, artboard } = resolved;
	const store = createDesignHandoffStore(join(cwd, "design"));
	const handoff = await store.setStatus(slug, artboard.file, status, { note: params.note, previewUrl: params.previewUrl }).catch((error: unknown) => { throw handoffsProblem(slug, error); });
	const { chosen } = await store.read(slug).catch((error: unknown) => { throw handoffsProblem(slug, error); });
	const path = `design/${slug}/${artboard.file}`;
	const lines = [`Handoff of ${path}: ${status === "in_progress" ? "in progress" : "implemented"}.${chosen === artboard.file ? ` It is the chosen artboard of design/${slug}.` : ""}`];
	if (handoff.previewUrl) lines.push(`Preview: ${handoff.previewUrl}${status === "implemented" ? " (the canvas offers Compare)" : ""}.`);
	return { texts: [lines.join("\n")], details: { target: `${slug}/${artboard.file}`, chosen, handoff } };
}

/** The gentle_design tool: the /gentle:design actions on the session's canvas, without sending a user message. */
export async function runDesignTool(cwd: string, params: DesignToolParams, canvas: DesignCanvas): Promise<DesignToolResult> {
	if (params.action === "handoff") return handoffTool(cwd, params);
	if (params.action === "list") return listDesignTool(cwd, canvas);
	if (params.action === "stop") {
		const stopped = await canvas.stop();
		return { texts: [stopped ? "Design canvas stopped." : "No design canvas is running."], details: { stopped } };
	}
	if (params.action === "open") {
		const notice = await canvas.open(cwd, params.slug || undefined);
		if (notice.url === undefined) throw new Error(notice.message);
		const details = notice.refreshed ? { url: notice.url, opened: true, refreshed: true as const } : { url: notice.url, opened: notice.opened === true };
		return { texts: [notice.message], details };
	}
	const target = params.target ?? "";
	const plan = await planDesignImplement(cwd, target);
	if (plan.kind === "refuse") throw new Error(plan.notice.message);
	// The model follows this handoff in its current run, so it is never queued.
	await createDesignHandoffStore(join(cwd, "design")).markSent(plan.handoff.slug, plan.handoff.file, { queued: false, feature: plan.handoff.feature })
		.catch((error: unknown) => { throw handoffsProblem(plan.handoff.slug, error); });
	return { texts: [plan.message, ...plan.warnings.map((warning) => `Warning: ${warning}`)], details: { target: target.trim(), warnings: plan.warnings } };
}
