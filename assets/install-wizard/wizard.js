// Gentle Shell installation wizard (browser side).
//
// Loaded as an ES module under the host's strict CSP (`default-src 'self'`):
// no inline code or styles, no HTML parsing of server data (DOM APIs and text
// nodes only) and no requests except same-origin `/api/*` calls. The pure
// models, renderers and the controller factory are exported so Node tests can
// load this file without a browser; it starts itself only inside a page.

const API_HEADERS = Object.freeze({ "X-Gentle-Install": "1" });
const LOG_LIMIT = 200;

/** Human labels for every step the runner logs. Unknown ids are shown as-is. */
export const stepLabels = Object.freeze({
	gate: "Safety checks",
	"check-npm": "Check npm",
	"check-global-bin": "Check the pnpm global bin directory",
	"check-existing-stack": "Check for an existing installation",
	"check-recoverable-stack": "Check the existing installation",
	"persist-node": "Install Node.js under PNPM_HOME",
	"persist-package-managers": "Install npm and pnpm under PNPM_HOME",
	"persist-npm": "Install npm under PNPM_HOME",
	"persist-pnpm": "Install pnpm under PNPM_HOME",
	"verify-persistent-runtime": "Verify the persistent Node.js and npm",
	"verify-persistent-pnpm": "Verify the persistent pnpm",
	"configure-npm-prefix": "Configure npm's global prefix",
	"install-global": "Install Pi and Gentle Shell",
	"verify-global-list": "Verify the installed packages",
	"verify-shell-bin": "Verify the gentle-shell command",
	"verify-gentle-ai": "Verify Gentle AI",
	"shell-setup": "Run gentle-shell setup",
	"persist-path": "Add the global bin directory to PATH",
});
export function stepLabel(id) {
	return typeof id === "string" && Object.hasOwn(stepLabels, id) ? stepLabels[id] : String(id);
}

const toolLabels = Object.freeze({
	node: "Node.js",
	pnpm: "pnpm",
	pi: "Pi",
	shell: "Gentle Shell",
	gentleAi: "Gentle AI",
	go: "Go",
	globalBin: "pnpm global bin directory",
	setup: "Gentle Shell setup",
	target: "This computer",
});
const statusText = Object.freeze({
	done: "Done",
	failed: "Failed",
	blocked: "Blocked",
	running: "In progress",
	pending: "Pending",
	skipped: "Not run",
	unknown: "Unknown",
});
const stages = Object.freeze([
	["check", "Check"],
	["review", "Review"],
	["install", "Install"],
	["done", "Done"],
]);

function text(value) {
	return typeof value === "string" ? value : "";
}
function list(value) {
	return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Pure models
// ---------------------------------------------------------------------------

/**
 * The runner's fixed step sequence for a plan, used to show upcoming steps.
 * It mirrors runStandardInstall; progressModel tolerates any divergence.
 */
export function expectedSteps(actionIds) {
	const ids = new Set(list(actionIds));
	const addNpm = ids.has("persist-package-managers") || ids.has("persist-npm");
	const addPnpm = ids.has("persist-package-managers") || ids.has("persist-pnpm");
	if (recoveryPlan(actionIds)) {
		// Setup recovery re-verifies the installed stack and never reinstalls it.
		const steps = ["check-npm", "check-global-bin", "check-recoverable-stack", "verify-global-list", "verify-shell-bin",
			"verify-gentle-ai", "shell-setup"];
		return ids.has("setup-global-bin") ? [...steps, "persist-path"] : steps;
	}
	// An npm that is about to be installed is checked after it is added.
	const steps = [...(addNpm ? [] : ["check-npm"]), "check-global-bin", "check-existing-stack"];
	if (ids.has("persist-node")) {
		steps.push("persist-node", "persist-package-managers", "verify-persistent-runtime", "check-npm", "configure-npm-prefix");
	} else if (addNpm || addPnpm) {
		const add = ["persist-package-managers", "persist-npm", "persist-pnpm"].find((id) => ids.has(id));
		steps.push(add);
		if (addNpm) steps.push("check-npm");
		if (addPnpm) steps.push("verify-persistent-pnpm");
	}
	steps.push("install-global", "verify-global-list", "verify-shell-bin", "verify-gentle-ai", "shell-setup");
	if (ids.has("setup-global-bin")) steps.push("persist-path");
	return steps;
}

/** The runner's fixed setup recovery: only setup, readiness and optionally PATH. */
function recoveryPlan(actionIds) {
	const ids = list(actionIds);
	return ["setup-shell", "verify-readiness"].every((id) => ids.includes(id)) &&
		ids.every((id) => ["setup-global-bin", "setup-shell", "verify-readiness"].includes(id));
}

/** Review screen model for a GET /api/plan view. */
export function planModel(view) {
	const actions = list(view?.actions).map((action) => ({ id: text(action?.id), description: text(action?.description) }));
	const blockers = list(view?.blockers).map((blocker) => ({
		code: text(blocker?.code),
		tool: text(blocker?.tool),
		toolLabel: Object.hasOwn(toolLabels, blocker?.tool) ? toolLabels[blocker.tool] : "A required tool",
		guidance: text(blocker?.guidance),
	}));
	let kind = "install";
	if (blockers.length > 0) kind = "blocked";
	else if (actions.every((action) => action.id === "verify-readiness")) kind = "nothing";
	else if (recoveryPlan(actions.map((action) => action.id))) kind = "recovery";
	const profile = view?.profileChange ?? {};
	const persistence = view?.persistence ?? {};
	const tools = list(persistence.tools).filter((tool) => typeof tool === "string");
	return {
		planId: text(view?.planId),
		kind,
		actions,
		blockers,
		disclosures: [
			{
				id: "profile",
				title: "Your PATH",
				changes: profile.changesProfile === true,
				state: profile.changesProfile === true ? "Will change" : "No change",
				text: text(profile.description),
				detail: typeof profile.binDir === "string" ? profile.binDir : null,
			},
			{
				id: "persistence",
				title: "Runtimes under PNPM_HOME",
				changes: tools.length > 0,
				state: tools.length > 0 ? `Will add ${tools.join(", ")}` : "No change",
				text: text(persistence.description),
				detail: typeof persistence.pnpmHome === "string" ? persistence.pnpmHome : null,
			},
		],
		steps: expectedSteps(actions.map((action) => action.id)),
	};
}

function stepItem(id, status) {
	return { id, label: stepLabel(id), status, statusText: statusText[status] };
}

/**
 * Step list for the progress screen: logged entries in order, then the
 * expected steps that have not run yet. The runner logs a step when it ends,
 * so the first remaining step is the one in progress.
 */
export function progressModel(steps, entries, { running = false, outcome = null } = {}) {
	const expected = list(steps);
	const items = [];
	let cursor = 0;
	for (const entry of list(entries)) {
		const at = expected.indexOf(entry?.step, cursor);
		if (at !== -1) cursor = at + 1;
		const status = ["done", "failed", "blocked"].includes(entry?.status) ? entry.status : "unknown";
		items.push(stepItem(text(entry?.step) || "unknown", status));
	}
	expected.slice(cursor).forEach((id, index) => {
		let status = "pending";
		if (outcome) status = "skipped";
		else if (running && index === 0) status = "running";
		items.push(stepItem(id, status));
	});
	return {
		items,
		done: items.filter((item) => item.status === "done").length,
		total: items.length,
		finished: Boolean(outcome),
	};
}

const detailCommands = new Map([["shell-setup", "gentle-shell setup"], ["persist-path", "pnpm setup"]]);

/** Final screen model for every runner outcome. Guidance always comes from the host. */
export function outcomeModel(outcome) {
	const completed = list(outcome?.completed).map((id) => ({ id: text(id), label: stepLabel(text(id)) }));
	const guidance = text(outcome?.guidance);
	const notes = [];
	if (outcome?.npmPrefix === "configured") notes.push("npm's user-level global prefix now points at PNPM_HOME.");
	if (outcome?.npmPrefix === "unchanged") notes.push("npm's global prefix was already correct and was left unchanged.");
	const base = { outcome: outcome?.outcome, guidance, completed, notes, reason: null, failedStep: null, command: null, detail: null, detailCommand: null };
	if (outcome?.outcome === "ready") {
		return { ...base, tone: "success", badge: "Installed", title: "Gentle Shell is ready",
			lead: "Everything is installed and verified on this computer.", command: "gentle-shell",
			next: ["Open any terminal.", "Run `gentle-shell` to start."] };
	}
	if (outcome?.outcome === "terminal-action-required") {
		return { ...base, tone: "success", badge: "One more step", title: "Open a new terminal",
			lead: "Your PATH was updated, and only terminals opened from now on can see it.", command: "gentle-shell",
			next: ["Open a new terminal window or tab.", "Run `gentle-shell` to start."] };
	}
	if (outcome?.outcome === "blocked") {
		return { ...base, tone: "warning", badge: "Blocked", title: "Installation blocked",
			lead: "Nothing was installed. A safety check stopped the installation before any change.", reason: text(outcome.reason) || null,
			next: ["Follow the guidance above.", "Run the installer again from your terminal."] };
	}
	const id = text(outcome?.failedStep);
	// The host sends a detail only for these fixed setup commands; bound it again here.
	const detailCommand = detailCommands.get(id) ?? null;
	const detail = detailCommand ? Array.from(text(outcome?.detail)).slice(0, 300).join("") : "";
	return { ...base, outcome: "failed", tone: "error", badge: "Failed", title: "Installation failed",
		detail: detail || null, detailCommand: detail ? detailCommand : null,
		lead: id && id !== "unknown"
			? `The step “${stepLabel(id)}” failed. Steps that finished before it were kept; nothing was rolled back.`
			: "The installation stopped unexpectedly. Steps that finished were kept; nothing was rolled back.",
		failedStep: id && id !== "unknown" ? { id, label: stepLabel(id) } : null,
		next: ["Follow the guidance above.", "Run the installer again from your terminal."] };
}

/** The only install request body: null until consent is explicit. */
export function installBody(planId, consent) {
	if (consent !== true || typeof planId !== "string" || planId.length === 0) return null;
	return { planId, consent: true };
}

/** Maps a POST /api/install answer to the wizard's next step. */
export function interpretInstall(status, body) {
	const error = body?.error;
	if (status === 202) return { next: "progress", message: "" };
	if (status === 409 && error === "plan-changed") {
		return { next: "reload-plan", message: "This computer changed since you reviewed the plan. Review the updated plan and confirm again." };
	}
	if (status === 409 && error === "install-running") return { next: "progress", message: "" };
	if (status === 409 && error === "already-completed") return { next: "outcome", message: "" };
	if (status === 401 || status === 403) return { next: "session", message: "" };
	if (status === 400) return { next: "error", message: "The installer rejected the request. Review the plan and try again." };
	return { next: "error", message: "The installer could not start. Check the terminal for details, then try again." };
}

/** Progress polling: quick while steps finish, slower while quiet, bounded on errors. */
export const pollPolicy = Object.freeze({ initialMs: 500, maxMs: 4000, factor: 1.5, errorMaxMs: 8000, maxFailures: 5, maxIdle: 3 });
export function initialPoll() {
	return { delay: pollPolicy.initialMs, failures: 0, idle: 0, stop: false, reason: null };
}
export function nextPoll(state, event) {
	const policy = pollPolicy;
	if (event.type === "error") {
		const failures = state.failures + 1;
		const stop = failures >= policy.maxFailures;
		return { delay: Math.min(Math.max(state.delay, policy.initialMs) * 2, policy.errorMaxMs), failures, idle: state.idle, stop,
			reason: stop ? "errors" : null };
	}
	if (event.outcome) return { delay: policy.initialMs, failures: 0, idle: 0, stop: true, reason: "outcome" };
	// Neither running nor finished should not last: the host is in an unexpected state.
	const idle = event.running ? 0 : state.idle + 1;
	if (idle >= policy.maxIdle) return { delay: state.delay, failures: 0, idle, stop: true, reason: "stalled" };
	const delay = event.count > 0 ? policy.initialMs : Math.min(Math.round(state.delay * policy.factor), policy.maxMs);
	return { delay, failures: 0, idle, stop: false, reason: null };
}

// ---------------------------------------------------------------------------
// Rendering: DOM APIs and text nodes only
// ---------------------------------------------------------------------------

const headingOf = new WeakMap();

function el(doc, tag, attributes = {}, ...children) {
	const node = doc.createElement(tag);
	for (const [name, value] of Object.entries(attributes)) {
		if (value === undefined || value === null || value === false) continue;
		node.setAttribute(name, value === true ? "" : String(value));
	}
	for (const child of children.flat()) {
		if (child === undefined || child === null || child === false) continue;
		node.append(typeof child === "string" ? doc.createTextNode(child) : child);
	}
	return node;
}

/** Text with `code` spans: backtick segments become <code> elements, never markup. */
function rich(doc, value) {
	return text(value).split("`").map((part, index) => (index % 2 === 1 ? el(doc, "code", {}, part) : doc.createTextNode(part)));
}

function panel(doc, { stage, eyebrow, title, lead, tone }, ...children) {
	const heading = el(doc, "h1", { id: "view-title", tabindex: "-1" }, title);
	const node = el(doc, "section", { class: `panel${tone ? ` panel-${tone}` : ""}`, "aria-labelledby": "view-title", "data-stage": stage,
		"data-tone": tone },
		el(doc, "p", { class: "eyebrow" }, eyebrow),
		heading,
		lead ? el(doc, "p", { class: "lead" }, rich(doc, lead)) : null,
		...children);
	headingOf.set(node, heading);
	return node;
}

function actionButton(doc, label, variant, onClick) {
	const node = el(doc, "button", { type: "button", class: `button button-${variant}` }, label);
	node.addEventListener("click", (event) => {
		event?.preventDefault?.();
		onClick(node);
	});
	return node;
}

/** Stage list; `stopped` marks the install stage when it ended blocked or failed. */
export function renderStages(doc, current, { stopped = false } = {}) {
	const index = stages.findIndex(([id]) => id === current);
	return stages.map(([id, label], position) => {
		let state = position < index ? "done" : position === index ? "current" : "upcoming";
		if (stopped && id === "install") state = "issue";
		const glyph = { done: "✓", issue: "!" }[state] ?? String(position + 1);
		const note = { done: " (completed)", issue: " (stopped)" }[state];
		return el(doc, "li", { class: `stage stage-${state}`, "aria-current": state === "current" ? "step" : null },
			el(doc, "span", { class: "stage-dot", "aria-hidden": "true" }, glyph),
			el(doc, "span", { class: "stage-label" }, label),
			note ? el(doc, "span", { class: "sr-only" }, note) : null);
	});
}

export function renderLoading(doc) {
	return panel(doc, { stage: "check", eyebrow: "Step 1 of 4 · Check", title: "Checking this computer",
		lead: "Looking for Node.js, pnpm, Pi and Gentle Shell. Nothing changes until you confirm a plan." },
	el(doc, "div", { class: "loader", "aria-hidden": "true" }, el(doc, "span"), el(doc, "span"), el(doc, "span")));
}

function disclosureCard(doc, item) {
	return el(doc, "article", { class: `card disclosure${item.changes ? " disclosure-changes" : ""}` },
		el(doc, "div", { class: "card-head" },
			el(doc, "h2", { class: "card-title" }, item.title),
			el(doc, "span", { class: `pill ${item.changes ? "pill-accent" : "pill-muted"}` },
				el(doc, "span", { "aria-hidden": "true" }, item.changes ? "● " : "○ "), item.state)),
		el(doc, "p", {}, rich(doc, item.text)),
		item.detail ? el(doc, "p", { class: "detail" }, el(doc, "code", {}, item.detail)) : null);
}

/** Review screen. handlers: install({ consent, checkbox, button }), reload(), close(). */
export function renderPlan(doc, model, handlers) {
	const close = actionButton(doc, "Close installer", "ghost", () => handlers.close());
	if (model.kind === "blocked") {
		return panel(doc, { stage: "review", eyebrow: "Step 2 of 4 · Review", title: "Something needs attention first",
			lead: "Nothing was changed. Resolve these items, then check again.", tone: "warning" },
		el(doc, "ul", { class: "blockers", role: "list" }, model.blockers.map((blocker) => el(doc, "li", { class: "alert alert-warning" },
			el(doc, "h2", { class: "alert-title" }, el(doc, "span", { "aria-hidden": "true" }, "! "), blocker.toolLabel),
			el(doc, "p", {}, rich(doc, blocker.guidance)),
			el(doc, "p", { class: "meta" }, "Code: ", el(doc, "code", {}, blocker.code))))),
		el(doc, "div", { class: "actions" }, actionButton(doc, "Check again", "primary", () => handlers.reload()), close));
	}
	if (model.kind === "nothing") {
		return panel(doc, { stage: "review", eyebrow: "Step 2 of 4 · Review", title: "Gentle Shell is already set up",
			lead: "This computer already has everything the wizard installs." },
		el(doc, "p", {}, rich(doc, "Run `gentle-shell` in a terminal. To upgrade, run `gentle-shell update`.")),
		el(doc, "div", { class: "actions" }, close));
	}
	const recovery = model.kind === "recovery";
	const checkbox = el(doc, "input", { type: "checkbox", id: "consent", class: "consent-input", "aria-describedby": "consent-hint" });
	const install = actionButton(doc, recovery ? "Complete setup" : "Install Gentle Shell", "primary", (button) =>
		handlers.install({ consent: checkbox.checked === true, checkbox, button }));
	checkbox.addEventListener("change", () => {
		if (checkbox.checked) checkbox.removeAttribute("aria-invalid");
		handlers.consentChanged?.(checkbox.checked === true);
	});
	const heading = recovery
		? { title: "Finish setting up Gentle Shell",
			lead: "Gentle Shell is already installed; this completes setup. Nothing is reinstalled, and nothing changes until you confirm." }
		: { title: "Review the installation plan",
			lead: "Nothing changes until you confirm. This is exactly what the installer will do on this computer." };
	return panel(doc, { stage: "review", eyebrow: "Step 2 of 4 · Review", ...heading },
	el(doc, "section", { class: "block", "aria-labelledby": "changes-title" },
		el(doc, "h2", { id: "changes-title", class: "section-title" }, "What changes on this computer"),
		el(doc, "div", { class: "grid" }, model.disclosures.map((item) => disclosureCard(doc, item)))),
	el(doc, "section", { class: "block", "aria-labelledby": "steps-title" },
		el(doc, "h2", { id: "steps-title", class: "section-title" }, recovery ? "Setup steps" : "Installation steps"),
		el(doc, "ol", { class: "plan-steps" }, model.actions.map((action) => el(doc, "li", {},
			el(doc, "span", { class: "plan-step-text" }, rich(doc, action.description)))))),
	el(doc, "div", { class: "consent" },
		checkbox,
		el(doc, "div", {},
			el(doc, "label", { for: "consent", class: "consent-label" }, "I reviewed this plan and agree to these changes on this computer."),
			el(doc, "p", { id: "consent-hint", class: "hint" }, "The installer runs only the steps listed above. Existing installations are not replaced."))),
	el(doc, "div", { class: "actions" }, install, close));
}

function logLine(doc, entry) {
	const status = text(entry.status) || "unknown";
	return el(doc, "li", { class: `log-line log-${status}` },
		el(doc, "span", { class: "log-seq" }, String(entry.seq).padStart(3, "0")),
		el(doc, "span", { class: "log-status" }, status),
		el(doc, "span", { class: "log-step" }, text(entry.step)),
		entry.reason ? el(doc, "span", { class: "log-reason" }, text(entry.reason)) : null);
}

function logPanel(doc, entries) {
	const lines = el(doc, "ol", { class: "log-lines" });
	const empty = el(doc, "p", { class: "log-empty" }, "Waiting for the first step…");
	const node = el(doc, "section", { class: "log", "aria-labelledby": "log-title" },
		el(doc, "div", { class: "log-head" },
			el(doc, "span", { class: "log-dots", "aria-hidden": "true" }, el(doc, "span"), el(doc, "span"), el(doc, "span")),
			el(doc, "h2", { id: "log-title", class: "log-title" }, "Installer log")),
		el(doc, "div", { class: "log-body", tabindex: "0", role: "region", "aria-label": "Installer log lines" }, empty, lines));
	const update = (all) => {
		lines.replaceChildren(...all.map((entry) => logLine(doc, entry)));
		if (all.length > 0) empty.setAttribute("hidden", "");
		else empty.removeAttribute("hidden");
	};
	update(entries);
	return { node, update };
}

const stepIcons = Object.freeze({ done: "✓", failed: "✕", blocked: "!", running: "", pending: "", skipped: "–", unknown: "?" });
function stepRow(doc, item) {
	return el(doc, "li", { class: `step step-${item.status}`, "aria-current": item.status === "running" ? "step" : null },
		el(doc, "span", { class: "step-icon", "aria-hidden": "true" }, stepIcons[item.status]),
		el(doc, "span", { class: "step-label" }, item.label),
		el(doc, "span", { class: "step-status" }, item.statusText));
}

/** Progress screen with in-place updates, so focus stays on the heading. */
export function renderProgress(doc) {
	const bar = el(doc, "progress", { id: "install-progress", max: "1", value: "0", "aria-describedby": "progress-count" });
	const count = el(doc, "span", { id: "progress-count", class: "progress-count" }, "Starting…");
	const steps = el(doc, "ol", { class: "steps" });
	const log = logPanel(doc, []);
	const node = panel(doc, { stage: "install", eyebrow: "Step 3 of 4 · Install", title: "Installing Gentle Shell",
		lead: "This can take a few minutes. Keep this tab and the terminal open." },
	el(doc, "div", { class: "progress" },
		el(doc, "div", { class: "progress-head" }, el(doc, "label", { for: "install-progress", class: "progress-label" }, "Progress"), count),
		bar),
	el(doc, "div", { class: "progress-body" },
		el(doc, "section", { class: "block", "aria-labelledby": "progress-steps-title" },
			el(doc, "h2", { id: "progress-steps-title", class: "section-title" }, "Steps"), steps),
		log.node));
	const update = (model, entries) => {
		bar.setAttribute("max", String(Math.max(model.total, 1)));
		bar.setAttribute("value", String(model.done));
		count.textContent = model.total > 0 ? `${model.done} of ${model.total} steps` : "Starting…";
		steps.replaceChildren(...model.items.map((item) => stepRow(doc, item)));
		log.update(entries);
	};
	return { node, update };
}

/** Final screen. handlers: close(), copy?(text) -> Promise<boolean>. */
export function renderOutcome(doc, model, handlers, entries = []) {
	const children = [
		el(doc, "div", { class: `alert alert-${model.tone}` },
			el(doc, "p", { class: "alert-title" }, el(doc, "span", { "aria-hidden": "true" }, model.tone === "success" ? "✓ " : model.tone === "warning" ? "! " : "✕ "),
				model.badge),
			el(doc, "p", {}, rich(doc, model.guidance))),
	];
	if (model.command) {
		const command = el(doc, "code", { class: "command-text" }, model.command);
		const copy = handlers.copy
			? actionButton(doc, "Copy", "ghost", async (button) => {
				const copied = await handlers.copy(model.command);
				button.textContent = copied ? "Copied" : "Copy failed";
			})
			: null;
		children.push(el(doc, "section", { class: "block", "aria-labelledby": "next-title" },
			el(doc, "h2", { id: "next-title", class: "section-title" }, "Next"),
			el(doc, "ol", { class: "next-steps" }, model.next.map((line) => el(doc, "li", {}, el(doc, "span", { class: "plan-step-text" }, rich(doc, line))))),
			el(doc, "div", { class: "command" }, el(doc, "span", { class: "command-prompt", "aria-hidden": "true" }, "$"), command, copy)));
	} else {
		children.push(el(doc, "section", { class: "block", "aria-labelledby": "next-title" },
			el(doc, "h2", { id: "next-title", class: "section-title" }, "What to do next"),
			el(doc, "ol", { class: "next-steps" }, model.next.map((line) => el(doc, "li", {}, el(doc, "span", { class: "plan-step-text" }, rich(doc, line)))))));
	}
	if (model.notes.length > 0) children.push(el(doc, "ul", { class: "notes" }, model.notes.map((note) => el(doc, "li", {}, note))));
	const facts = [];
	if (model.failedStep) facts.push(el(doc, "li", {}, "Failed step: ", el(doc, "code", {}, model.failedStep.id)));
	if (model.reason) facts.push(el(doc, "li", {}, "Reason: ", el(doc, "code", {}, model.reason)));
	if (facts.length > 0) children.push(el(doc, "ul", { class: "facts" }, facts));
	// Untrusted process output: one plain text node, never `rich` code spans.
	if (model.detail) {
		children.push(el(doc, "section", { class: "block", "aria-labelledby": "setup-detail-title" },
			el(doc, "h2", { id: "setup-detail-title", class: "section-title" }, `Last error from ${model.detailCommand}`),
			el(doc, "p", { class: "detail" }, el(doc, "code", {}, model.detail))));
	}
	if (model.completed.length > 0) {
		children.push(el(doc, "details", { class: "completed" },
			// A blocked run only passed read-only checks before it stopped.
			el(doc, "summary", {}, `${model.outcome === "blocked" ? "Checks that passed" : "Completed steps"} (${model.completed.length})`),
			el(doc, "ul", {}, model.completed.map((item) => el(doc, "li", {}, el(doc, "span", { "aria-hidden": "true" }, "✓ "), item.label)))));
	}
	if (entries.length > 0) {
		const log = logPanel(doc, entries);
		children.push(el(doc, "details", { class: "completed" }, el(doc, "summary", {}, `Installer log (${entries.length} entries)`), log.node));
	}
	children.push(el(doc, "div", { class: "actions" }, actionButton(doc, "Close installer", model.tone === "success" ? "primary" : "secondary",
		() => handlers.close())));
	return panel(doc, { stage: "done", eyebrow: "Step 4 of 4 · Done", title: model.title, lead: model.lead, tone: model.tone }, ...children);
}

export function renderClosed(doc, outcome) {
	const installed = outcome?.outcome === "ready" || outcome?.outcome === "terminal-action-required";
	return panel(doc, { stage: "done", eyebrow: "Finished", title: "Installer closed",
		lead: installed
			? "You can close this tab. Run `gentle-shell` in a terminal to start."
			: "You can close this tab. The terminal shows the same result, and nothing else will run." });
}

export function renderSession(doc) {
	return panel(doc, { stage: "check", eyebrow: "Session ended", title: "This session has ended",
		lead: "The installer link works once, in the browser that opened it, and stops when the installer closes. Run the installer again from your terminal to get a new link." });
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

function isProgress(body) {
	return body !== null && typeof body === "object" && Array.isArray(body.entries);
}
const sessionEnded = (status) => status === 401 || status === 403;
const noAnswer = "The installer did not answer. Check that the terminal is still running it, then try again.";

/**
 * createWizard({ document, fetch, setTimeout, clearTimeout, clipboard? })
 * Expects #view, #stages, #alert (role=alert) and #status (role=status).
 */
export function createWizard({ document: doc, fetch: request, setTimeout: later, clearTimeout: cancel, clipboard = null }) {
	const roots = {
		view: doc.getElementById("view"),
		stages: doc.getElementById("stages"),
		alert: doc.getElementById("alert"),
		status: doc.getElementById("status"),
	};
	const state = { plan: null, steps: [], entries: [], lastSeq: 0, poll: initialPoll(), timer: null, outcome: null, busy: false,
		progress: null, running: false };

	async function api(path, { method = "GET", body } = {}) {
		const init = { method, headers: { ...API_HEADERS }, credentials: "same-origin", cache: "no-store" };
		if (body !== undefined) {
			init.headers["Content-Type"] = "application/json";
			init.body = JSON.stringify(body);
		}
		const response = await request(path, init);
		let data = null;
		try {
			data = await response.json();
		} catch {
			data = null;
		}
		return { status: response.status, body: data };
	}

	function announce(message) {
		if (roots.status) roots.status.textContent = message;
	}
	function clearError() {
		roots.alert?.replaceChildren();
	}
	function showError(message, retry = null, { tone = "error", title = "Problem" } = {}) {
		const retryButton = retry ? actionButton(doc, "Try again", "secondary", () => {
			clearError();
			retry();
		}) : null;
		roots.alert?.replaceChildren(el(doc, "div", { class: `alert alert-${tone}` },
			el(doc, "p", { class: "alert-title" }, el(doc, "span", { "aria-hidden": "true" }, tone === "error" ? "✕ " : "! "), title),
			el(doc, "p", {}, message),
			retryButton ? el(doc, "div", { class: "actions" }, retryButton) : null));
	}
	function stopPolling() {
		if (state.timer !== null) cancel(state.timer);
		state.timer = null;
	}
	function show(node, { focus = true } = {}) {
		const stage = node.getAttribute("data-stage");
		const stopped = stage === "done" && ["warning", "error"].includes(node.getAttribute("data-tone"));
		roots.stages?.replaceChildren(...renderStages(doc, stage, { stopped }));
		roots.view.replaceChildren(node);
		if (focus) headingOf.get(node)?.focus();
	}
	function ingest(entries) {
		const fresh = list(entries).filter((entry) => Number.isInteger(entry?.seq) && entry.seq > state.lastSeq);
		for (const entry of fresh) state.lastSeq = Math.max(state.lastSeq, entry.seq);
		state.entries = [...state.entries, ...fresh].slice(-LOG_LIMIT);
		return fresh;
	}

	async function resume() {
		clearError();
		let result;
		try {
			result = await api("/api/progress?after=0");
		} catch {
			showError(noAnswer, resume);
			return;
		}
		if (sessionEnded(result.status)) return showSession();
		if (result.status !== 200 || !isProgress(result.body)) {
			showError(noAnswer, resume);
			return;
		}
		ingest(result.body.entries);
		if (result.body.outcome) return showOutcome(result.body.outcome);
		if (result.body.running === true) return showProgress();
		return loadPlan();
	}

	async function loadPlan(notice = "") {
		clearError();
		let result;
		try {
			result = await api("/api/plan");
		} catch {
			showError(noAnswer, () => loadPlan(notice));
			return;
		}
		if (sessionEnded(result.status)) return showSession();
		if (result.status === 409 && result.body?.error === "install-running") return showProgress();
		if (result.status !== 200 || result.body === null || typeof result.body !== "object") {
			showError("The installer could not check this computer. Check the terminal for details, then try again.", () => loadPlan(notice));
			return;
		}
		state.plan = planModel(result.body);
		state.steps = state.plan.steps;
		show(renderPlan(doc, state.plan, { install, reload: () => loadPlan(), close, consentChanged: (checked) => { if (checked) clearError(); } }));
		if (notice) showError(notice, null, { tone: "warning", title: "Plan updated" });
	}

	async function install({ consent, checkbox, button }) {
		if (state.busy) return;
		const body = installBody(state.plan?.planId, consent);
		if (body === null) {
			showError("Check the box to confirm that you reviewed the plan. Nothing was installed.");
			checkbox.setAttribute("aria-invalid", "true");
			checkbox.focus();
			return;
		}
		clearError();
		state.busy = true;
		button.disabled = true;
		let result;
		try {
			result = await api("/api/install", { method: "POST", body });
		} catch {
			// The request may have reached the host before the connection broke: check
			// once, and follow a running or finished installation instead of offering a retry.
			const current = await currentProgress();
			state.busy = false;
			if (current?.outcome) return showOutcome(current.outcome);
			if (current?.running) return showProgress();
			button.disabled = false;
			showError(noAnswer);
			return;
		}
		state.busy = false;
		const next = interpretInstall(result.status, result.body);
		if (next.next === "progress") return showProgress();
		if (next.next === "reload-plan") return loadPlan(next.message);
		if (next.next === "outcome") return resume();
		if (next.next === "session") return showSession();
		button.disabled = false;
		showError(next.message, () => loadPlan());
	}

	/** One GET /api/progress?after=0, or null when the host does not answer usefully. */
	async function currentProgress() {
		try {
			const result = await api("/api/progress?after=0");
			if (result.status !== 200 || !isProgress(result.body)) return null;
			ingest(result.body.entries);
			return { running: result.body.running === true, outcome: result.body.outcome ?? null };
		} catch {
			return null;
		}
	}

	function progressSnapshot() {
		return progressModel(state.steps, state.entries, { running: state.running, outcome: state.outcome });
	}

	function showProgress() {
		stopPolling();
		state.running = true;
		state.poll = initialPoll();
		state.progress = renderProgress(doc);
		state.progress.update(progressSnapshot(), state.entries);
		show(state.progress.node);
		announce("Installation started.");
		schedule(state.poll.delay);
	}

	function schedule(ms) {
		stopPolling();
		state.timer = later(() => {
			state.timer = null;
			void pollOnce();
		}, ms);
	}

	function pollFailed(event) {
		state.poll = nextPoll(state.poll, event);
		if (state.poll.stop) return pollStopped();
		schedule(state.poll.delay);
	}

	function pollStopped() {
		const message = state.poll.reason === "stalled"
			? "The installer stopped reporting progress. Check the terminal, then try again."
			: "Lost contact with the installer. Check that the terminal is still running it, then try again.";
		showError(message, () => {
			state.poll = initialPoll();
			schedule(0);
		});
	}

	async function pollOnce() {
		let result;
		try {
			result = await api(`/api/progress?after=${state.lastSeq}`);
		} catch {
			return pollFailed({ type: "error" });
		}
		if (sessionEnded(result.status)) return showSession();
		if (result.status !== 200 || !isProgress(result.body)) return pollFailed({ type: "error" });
		const fresh = ingest(result.body.entries);
		const outcome = result.body.outcome ?? null;
		state.running = result.body.running === true;
		state.poll = nextPoll(state.poll, { type: "entries", count: fresh.length, running: state.running, outcome });
		if (outcome) return showOutcome(outcome);
		clearError();
		state.progress?.update(progressSnapshot(), state.entries);
		const last = fresh.at(-1);
		if (last) announce(`${stepLabel(last.step)}: ${statusText[last.status] ?? last.status}.`);
		if (state.poll.stop) return pollStopped();
		schedule(state.poll.delay);
	}

	function showOutcome(outcome) {
		stopPolling();
		state.outcome = outcome;
		state.running = false;
		const model = outcomeModel(outcome);
		const copy = clipboard ? async (value) => {
			try {
				await clipboard.writeText(value);
				announce("Command copied.");
				return true;
			} catch {
				return false;
			}
		} : undefined;
		show(renderOutcome(doc, model, { close, copy }, state.entries));
		announce(`${model.title}.`);
	}

	function showSession() {
		stopPolling();
		clearError();
		show(renderSession(doc));
	}

	async function close() {
		if (state.busy) return;
		state.busy = true;
		let result;
		try {
			result = await api("/api/shutdown", { method: "POST", body: {} });
		} catch {
			state.busy = false;
			showError("The installer did not answer. It may already be closed; check the terminal.");
			return;
		}
		state.busy = false;
		if (result.status === 200) {
			stopPolling();
			clearError();
			show(renderClosed(doc, state.outcome));
			announce("Installer closed.");
			return;
		}
		if (sessionEnded(result.status)) return showSession();
		if (result.status === 409) {
			showError("An installation is still running. Wait for it to finish, then close the installer.");
			return;
		}
		showError("The installer could not close. Press Ctrl+C in the terminal to stop it.");
	}

	return { start: resume, state };
}

if (typeof window !== "undefined" && typeof document !== "undefined" && typeof fetch === "function") {
	const app = createWizard({
		document,
		fetch: (...args) => fetch(...args),
		setTimeout: (fn, ms) => window.setTimeout(fn, ms),
		clearTimeout: (id) => window.clearTimeout(id),
		clipboard: window.navigator?.clipboard ?? null,
	});
	void app.start();
}
