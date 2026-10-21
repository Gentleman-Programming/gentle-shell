import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveWorkContext, listWorks, createWork, updateWork, type Work, type WorkInput, type WorkSession, type WorkStatus } from "../lib/gentle-works.ts";
import { WorksView, observeActivity, safeWorkText, type WorksResult } from "../lib/gentle-works-view.ts";

const HELP = "Usage: /gentle:works [help]\nOpen the work center: create an objective, inspect location/activity, edit explicit status and summary/ODD, or link the current session. Esc cancels without saving. No agents or worktrees are launched; stored locators do not promise resumability.";
const STATUSES: WorkStatus[] = ["pending", "in_progress", "blocked", "completed"];
function currentSession(ctx: ExtensionCommandContext): WorkSession | undefined {
	const file = ctx.sessionManager.getSessionFile?.();
	const id = ctx.sessionManager.getSessionId();
	return file && id ? { id, file } : undefined;
}
// Read-only, bounded Git probe at the canonical worktree (never an arbitrary cwd).
function currentBranch(root: string): Promise<string | undefined> {
	return new Promise(resolve => execFile("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root, encoding: "utf8", timeout: 2000, maxBuffer: 8192 }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined)));
}
async function location(path: string | undefined, directory: boolean): Promise<string> {
	if (!path) return "not linked";
	try {
		const value = await stat(path);
		return (directory ? value.isDirectory() : value.isFile()) ? "present (not proof of activity or resumability)" : "unavailable (wrong file type)";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing (record retained)" : "unavailable (cannot verify)";
	}
}
async function details(work: Work, ctx: ExtensionCommandContext): Promise<string[]> {
	const session = currentSession(ctx);
	const activity = observeActivity(work, session, session ? ctx.isIdle() : undefined);
	const [worktree, file] = await Promise.all([location(work.worktree, true), location(work.session?.file, false)]);
	return [
		`ID: ${work.id}`, `Clone: ${work.cloneIdentity}`, `Status: ${work.status} (explicit)`,
		`Activity: ${activity.state}${activity.observedAt ? ` · observed ${activity.observedAt}` : " · observation unavailable"}`,
		`Branch: ${work.branch ?? "unknown"}`, `Worktree: ${work.worktree ?? "not linked"} · ${worktree}`,
		`Session ID: ${work.session?.id ?? "not linked"}`, `Session file: ${work.session?.file ?? "not linked"} · ${file}`,
		"Objective:", work.objective, "Summary:", work.summary || "(empty)", `ODD: ${work.odd ?? "not linked"}`,
	];
}

export function registerWorks(pi: ExtensionAPI, resolve = resolveWorkContext) {
	pi.registerCommand("gentle:works", {
		description: "Durable work center: create, inspect, edit status/summary/ODD, link session; help",
		handler: async (args, ctx) => {
			const argument = args.trim();
			if (argument) { ctx.ui.notify(HELP, argument === "help" || argument === "--help" ? "info" : "error"); return; }
			if (ctx.mode !== "tui") throw new Error("/gentle:works requires TUI mode; use /gentle:works help for usage");
			try {
				const context = await resolve(ctx.cwd);
				let inspected: string | undefined;
				while (true) {
					const registry = await listWorks(context);
					const work = registry.works.find(item => item.id === inspected);
					const lines = work ? await details(work, ctx) : [];
					const result = await ctx.ui.custom<WorksResult>((tui, theme, _kb, done) => {
						const view = new WorksView(registry.works, done, theme, work, lines, () => tui.terminal.rows);
						return { render: width => view.render(width), invalidate: () => view.invalidate(), handleInput: data => { view.handleInput(data); tui.requestRender(); } };
					});
					if (result.action === "close") { if (inspected) { inspected = undefined; continue; } return; }
					if (result.action === "inspect") { inspected = result.id; continue; }
					// Gather the entire edit before the single public mutation. Cancellation is a no-op.
					try {
						if (result.action === "create") {
							const title = await ctx.ui.input("Create work · title (required)"); if (title === undefined) continue;
							const objective = await ctx.ui.editor("Create work · objective (required)"); if (objective === undefined) continue;
							const session = currentSession(ctx);
							const branch = await currentBranch(context.worktreeRoot);
							await createWork(context, { title, objective, status: "pending", summary: "", worktree: context.worktreeRoot, ...(branch ? { branch } : {}), ...(session ? { session } : {}) });
							ctx.ui.notify(session ? "Work created and current session linked" : "Work created without a session locator: current session is not saved", "info");
						} else if (result.action === "link") {
							const session = currentSession(ctx);
							if (!session) { ctx.ui.notify("Current session is not saved; no locator changed", "warning"); continue; }
							await updateWork(context, result.id, { session });
							ctx.ui.notify("Current session locator linked (previous locator replaced)", "info");
						} else if (result.action === "edit" && work) {
							const status = await ctx.ui.select(`Explicit work status (current: ${work.status})`, STATUSES); if (status === undefined) continue;
							const summary = await ctx.ui.editor("Explicit summary", safeWorkText(work.summary)); if (summary === undefined) continue;
							const odd = await ctx.ui.editor("ODD reference (blank preserves existing)", safeWorkText(work.odd ?? "")); if (odd === undefined) continue;
							// Send only what the user changed; untouched fields keep whatever another writer saved meanwhile.
							const patch: Partial<WorkInput> = {};
							if (status !== work.status) patch.status = status as WorkStatus;
							if (summary !== safeWorkText(work.summary)) patch.summary = summary;
							if (odd.trim() && odd !== safeWorkText(work.odd ?? "")) patch.odd = odd;
							if (!Object.keys(patch).length) { ctx.ui.notify("No changes to save", "info"); continue; }
							await updateWork(context, result.id, patch);
						}
					} catch (error) { ctx.ui.notify(safeWorkText(error instanceof Error ? error.message : "Work update failed"), "error"); }
				}
			} catch (error) { ctx.ui.notify(safeWorkText(error instanceof Error ? error.message : "Work center unavailable"), "error"); }
		},
	});
}
export default registerWorks;
