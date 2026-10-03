import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";

// Local wizard host: a dependency-free loopback HTTP server with a fixed route
// allowlist. The browser never sends commands, paths, plans or environment:
// plans are built here, stored here and handed to the injected runner here.

const HOST = "127.0.0.1";
const COOKIE = "gentle_install_session";
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const defaultLimits = Object.freeze({
	codeTtlMs: 2 * MINUTE,
	idleMs: 30 * MINUTE,
	idleCheckMs: 15 * SECOND,
	bodyBytes: 1024,
	logEntries: 200,
	headersTimeoutMs: 10 * SECOND,
	requestTimeoutMs: 30 * SECOND,
});
const securityHeaders = Object.freeze({
	"Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
	"X-Content-Type-Options": "nosniff",
	"Cache-Control": "no-store",
	"Referrer-Policy": "no-referrer",
	"X-Frame-Options": "DENY",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Cross-Origin-Opener-Policy": "same-origin",
});
// Fixed asset names only: the request path never reaches the filesystem.
const assets = Object.freeze({
	"/": { file: "index.html", type: "text/html; charset=utf-8" },
	"/wizard.js": { file: "wizard.js", type: "text/javascript; charset=utf-8" },
	"/wizard.css": { file: "wizard.css", type: "text/css; charset=utf-8" },
});
const routes = Object.freeze({
	...Object.fromEntries(Object.keys(assets).map((path) => [path, "GET"])),
	"/session": "GET",
	"/api/plan": "GET",
	"/api/progress": "GET",
	"/api/install": "POST",
	"/api/shutdown": "POST",
});
// Served on a valid code instead of a 303: when the session URL is reached from
// the file: redirect page, a redirect chain counts as cross-site and a
// SameSite=Strict cookie could be withheld on `/`. This same-origin page starts
// the navigation, so the cookie is sent. No script or style, as the CSP requires.
const sessionPage = [
	"<!doctype html>",
	'<meta charset="utf-8">',
	'<meta http-equiv="refresh" content="0; url=/">',
	"<title>Gentle Shell installation wizard</title>",
	'<p><a href="/">Continue to the Gentle Shell installation wizard</a></p>',
	"",
].join("\n");

/** Fixed English descriptions for every action planPreflight can emit. */
export const actionDescriptions = Object.freeze({
	"acquire-node": "Download a verified Node.js runtime.",
	"verify-node": "Check that the downloaded Node.js runtime runs.",
	"acquire-pnpm": "Download a verified pnpm package manager.",
	"verify-pnpm": "Check that the downloaded pnpm runs.",
	"setup-global-bin": "Run `pnpm setup` so new terminals find globally installed commands.",
	"persist-node": "Install Node.js under PNPM_HOME with `pnpm runtime set node -g`.",
	"persist-package-managers": "Install npm and pnpm under PNPM_HOME with one `pnpm add -g`.",
	"configure-npm-prefix": "Point npm's user-level global prefix at PNPM_HOME when its default would be inside pnpm's store.",
	"persist-npm": "Install npm under PNPM_HOME with `pnpm add -g`.",
	"persist-pnpm": "Install pnpm under PNPM_HOME with `pnpm add -g`.",
	"acquire-go": "Download a verified Go toolchain.",
	"verify-go": "Check that the Go toolchain runs.",
	"install-pi": "Install the Pi coding agent globally with pnpm.",
	"install-shell": "Install Gentle Shell (gentle-pi) globally with pnpm.",
	"provision-native": "Provision the package-native Gentle AI binary with the existing installer.",
	"setup-shell": "Run the normal `gentle-shell setup`.",
	"verify-readiness": "Verify that the installed stack is ready.",
});

const tryAgain = "Fix the cause, then run the installer again.";
/** Fixed English guidance for every runner blocked reason, failed step and preflight blocker. */
export const guidance = Object.freeze({
	blocked: Object.freeze({
		"invalid-request": "The installation request was not an unmodified plan. Reload the wizard to get a fresh plan.",
		"consent-required": "Nothing was installed because consent was not given. Review the plan and confirm to continue.",
		"preflight-blocked": "Preflight found a blocker, so nothing was installed. Resolve the listed blockers and run the installer again.",
		"go-required": "Windows needs Go 1.25.10 or newer on PATH before Gentle AI can be provisioned. Install Go, then run the installer again.",
		"unsupported-plan": "This machine needs steps the wizard does not run yet, such as updating an existing installation. Use `gentle-shell update` or follow the README.",
		"pnpm-home-unknown": "The pnpm home directory could not be determined. Set PNPM_HOME to an absolute directory, then run the installer again.",
		"node-unavailable": "The installer could not find its own Node.js executable. Run the installer again from the bootstrap script.",
		"pnpm-unavailable": "pnpm could not be started. Run the installer again from the bootstrap script so it can provide pnpm.",
		"npm-unavailable": "A genuine npm was not found on PATH. Gentle AI needs it; reinstall Node.js with npm, then run the installer again.",
		"npm-shadowed": "Another `npm` program appears on PATH before Node.js's npm. Remove or reorder it, then run the installer again.",
		"global-bin-mismatch": "pnpm reported a different global bin directory than expected. Check PNPM_HOME, then run the installer again.",
		"global-list-unavailable": "pnpm could not list global packages. Check that `pnpm list -g` works, then run the installer again.",
		"existing-stack": "Pi or Gentle Shell is already installed globally. Nothing was changed; use `gentle-shell update` instead.",
		"existing-stack-unverified": "The installed Pi and Gentle Shell changed after the plan was made, or are no longer the versions this installer set up. Nothing was changed; run the installer again to check this computer again.",
	}),
	failed: Object.freeze({
		"persist-node": `Installing Node.js under PNPM_HOME failed. Check your network connection. ${tryAgain}`,
		"persist-package-managers": `Installing npm and pnpm under PNPM_HOME failed. Check your network connection. ${tryAgain}`,
		"persist-npm": `Installing npm under PNPM_HOME failed. Check your network connection. ${tryAgain}`,
		"persist-pnpm": `Installing pnpm under PNPM_HOME failed. Check your network connection. ${tryAgain}`,
		"verify-persistent-runtime": `Node.js and npm were not found in the pnpm global bin directory after installation. ${tryAgain}`,
		"verify-persistent-pnpm": `pnpm was not found in the pnpm global bin directory after installation. ${tryAgain}`,
		"check-npm": `The installed npm could not be verified as genuine npm. ${tryAgain}`,
		"configure-npm-prefix": `npm's global prefix could not be checked or set to PNPM_HOME. Your npm configuration was left as it was. ${tryAgain}`,
		"install-global": `Installing Pi and Gentle Shell with pnpm failed. Check your network connection. ${tryAgain}`,
		"verify-global-list": `The installed Pi and Gentle Shell packages could not be verified under PNPM_HOME. ${tryAgain}`,
		"verify-shell-bin": `The gentle-shell command was not found in the pnpm global bin directory. ${tryAgain}`,
		"verify-gentle-ai": `The package-native Gentle AI binary could not be verified. ${tryAgain}`,
		"shell-setup": "`gentle-shell setup` did not finish. Run `gentle-shell setup` in a terminal to see the details.",
		"persist-path": "`pnpm setup` could not add the global bin directory to your PATH. Run `pnpm setup` in a terminal, then open a new terminal.",
	}),
	blockers: Object.freeze({
		"unsupported-target": "This operating system or CPU is not supported by the wizard. Follow the README for a manual installation.",
		"unknown-tool": "A required tool could not be checked safely. Make sure it runs from a terminal, or remove the broken installation, then run the installer again.",
		"incompatible-tool": "A required tool is installed at an incompatible version. Update it, then run the installer again.",
	}),
	outcomes: Object.freeze({
		ready: "Gentle Shell is installed. Run `gentle-shell` in a terminal.",
		"terminal-action-required": "Gentle Shell is installed. Open a new terminal so it picks up the updated PATH, then run `gentle-shell`.",
	}),
	// A failed shell-setup whose detail shows GitHub's anonymous API limit.
	setupRateLimit: "`gentle-shell setup` could not finish because GitHub's limit for anonymous API requests was reached on this network. Wait up to an hour, then run the installer again.",
	// A failed persist-path whose detail shows pnpm could not tell the shell (POSIX SHELL missing or unsupported).
	persistPathShell: "`pnpm setup` could not tell which shell profile to edit because the SHELL environment variable is missing or names an unsupported shell. Open a regular terminal and run the installer again, or add `$PNPM_HOME/bin` to your PATH yourself.",
	fallback: "The installation stopped for an unexpected reason. Nothing else will run; check the terminal and run the installer again.",
});

/** The runner's setup detail, bounded again: text only, no control characters,
 * at most 300 characters. Null when nothing remains.
 */
function setupDetail(value) {
	if (typeof value !== "string") return null;
	const text = Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim()).slice(0, 300).join("");
	return text.length > 0 ? text : null;
}
const rateLimited = (detail) => /rate limit/i.test(detail) || (/GitHub API/i.test(detail) && /\b403\b/.test(detail));
const unknownShell = (detail) => /ERR_PNPM_(?:UNKNOWN|UNSUPPORTED)_SHELL/.test(detail);
// Fixed setup commands whose sanitized last error line may reach the browser.
const detailSteps = Object.freeze({ "shell-setup": rateLimited, "persist-path": unknownShell });
const detailGuidance = Object.freeze({ "shell-setup": "setupRateLimit", "persist-path": "persistPathShell" });

const ID = /^[a-z][a-z0-9-]{0,63}$/;
function identifier(value, fallback = "unknown") {
	return typeof value === "string" && ID.test(value) ? value : fallback;
}
// Preflight tool names include camelCase keys such as gentleAi and globalBin.
const TOOL = /^[a-z][A-Za-z0-9-]{0,63}$/;
function toolName(value) {
	return typeof value === "string" && TOOL.test(value) ? value : "unknown";
}
function plainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function token(random, bytes) {
	return random(bytes).toString("base64url");
}
function sameSecret(expected, actual) {
	const [a, b] = [Buffer.from(expected), Buffer.from(String(actual))];
	return a.length === b.length && timingSafeEqual(a, b);
}
function fingerprint(collected) {
	return createHash("sha256").update(JSON.stringify({ plan: collected.plan, binDir: collected.inventory?.globalBin?.path ?? null }))
		.digest("hex");
}

/** Browser view of a server-held plan: fixed descriptions, never commands. */
function planView(planId, { inventory, plan }) {
	const ids = plan.actions.map((action) => action.id);
	const binDir = typeof inventory?.globalBin?.path === "string" ? inventory.globalBin.path : null;
	const pnpmHome = binDir === null ? null : dirname(binDir);
	const changesProfile = ids.includes("setup-global-bin");
	let tools = [];
	if (ids.includes("persist-node")) tools = ["node", "npm", "pnpm"];
	else if (ids.includes("persist-package-managers")) tools = ["npm", "pnpm"];
	else if (ids.includes("persist-npm")) tools = ["npm"];
	else if (ids.includes("persist-pnpm")) tools = ["pnpm"];
	return {
		planId,
		ready: plan.ready === true,
		actions: plan.actions.map((action) => ({
			id: identifier(action.id),
			description: actionDescriptions[action.id] ?? "Prepare the installation.",
		})),
		blockers: plan.blockers.map((blocker) => ({
			code: identifier(blocker.code),
			tool: toolName(blocker.tool),
			guidance: guidance.blockers[blocker.code] ?? guidance.fallback,
		})),
		profileChange: {
			changesProfile,
			command: "pnpm setup",
			binDir,
			description: changesProfile
				? `\`pnpm setup\` will add ${binDir ?? "the pnpm global bin directory"} to your PATH: it edits your shell profile on macOS and Linux, or your user PATH on Windows. Open a new terminal afterwards.`
				: "Your PATH already contains the pnpm global bin directory; no shell profile or PATH change is planned.",
		},
		persistence: {
			tools,
			pnpmHome,
			description: tools.length > 0
				? `${tools.join(", ")} will be installed under $PNPM_HOME (${pnpmHome ?? "pnpm's home directory"}) so new terminals keep working after the temporary installer tools are removed. Existing installations are not replaced.`
				: "No runtime needs to be installed under $PNPM_HOME; your existing Node.js, npm and pnpm are reused.",
		},
	};
}

function outcomeView(result) {
	if (!plainObject(result) || !["ready", "terminal-action-required", "blocked", "failed"].includes(result.outcome)) {
		return { outcome: "failed", failedStep: null, completed: [], guidance: guidance.fallback };
	}
	const view = { outcome: result.outcome, completed: Array.isArray(result.completed) ? result.completed.map((step) => identifier(step)) : [] };
	if (result.outcome === "blocked") {
		view.reason = identifier(result.reason);
		view.guidance = guidance.blocked[result.reason] ?? guidance.fallback;
	} else if (result.outcome === "failed") {
		view.failedStep = identifier(result.failedStep);
		view.guidance = guidance.failed[result.failedStep] ?? guidance.fallback;
		const step = Object.hasOwn(detailSteps, result.failedStep) ? result.failedStep : null;
		const detail = step ? setupDetail(result.detail) : null;
		if (detail) {
			view.detail = detail;
			if (detailSteps[step](detail)) view.guidance = guidance[detailGuidance[step]];
		}
	} else {
		view.guidance = guidance.outcomes[result.outcome];
		if (result.action === "open-new-terminal") view.action = "open-new-terminal";
		if (["configured", "unchanged"].includes(result.npmPrefix)) view.npmPrefix = result.npmPrefix;
	}
	return view;
}

/**
 * createInstallerServer({ collectPlan, runInstall, assetsDir, now?, random?, limits?, onRedeemed? })
 * collectPlan() -> { inventory, plan } (fresh preflight, trusted local code);
 * runInstall({ plan, consent: true }, log) -> runner result; onRedeemed() runs once
 * when the one-time code is used (it must not throw). Returns
 * { listen(), close(reason), closed, checkIdle(), outcome() }.
 */
export function createInstallerServer({ collectPlan, runInstall, assetsDir, now = Date.now, random = randomBytes, limits = {},
	onRedeemed = () => {} }) {
	const limit = { ...defaultLimits, ...limits };
	const secret = token(random, 32);
	let code = token(random, 32);
	let codeExpires = 0;
	let port = 0;
	let origin = "";
	let lastActivity = now();
	let stored = null;
	let planning = null;
	let installing = false;
	let lastOutcome = null;
	let seq = 0;
	const log = [];
	let idleTimer = null;
	let closing = null;
	let resolveClosed;
	const closed = new Promise((resolve) => { resolveClosed = resolve; });

	// requireHostHeader:false lets a missing Host get the same 421 as a wrong one.
	const server = createServer({ maxHeaderSize: 16 * 1024, requireHostHeader: false }, (req, res) => {
		handle(req, res).catch(() => {
			if (!res.headersSent) reply(res, 500, { error: "internal" });
			else res.destroy();
		});
	});
	server.headersTimeout = limit.headersTimeoutMs;
	server.requestTimeout = limit.requestTimeoutMs;
	server.keepAliveTimeout = 5 * SECOND;

	function reply(res, status, body, headers = {}) {
		const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
		res.writeHead(status, {
			...securityHeaders,
			"Content-Type": "application/json; charset=utf-8",
			...headers,
			"Content-Length": Buffer.byteLength(payload),
		});
		res.end(payload);
	}

	function hasSession(req) {
		const pairs = String(req.headers.cookie ?? "").split(";").map((part) => part.trim())
			.filter((part) => part.startsWith(`${COOKIE}=`));
		return pairs.length === 1 && sameSecret(secret, pairs[0].slice(COOKIE.length + 1));
	}

	async function readJson(req, res) {
		const declared = Number(req.headers["content-length"]);
		if (Number.isFinite(declared) && declared > limit.bodyBytes) {
			reply(res, 413, { error: "body-too-large" }, { Connection: "close" });
			return undefined;
		}
		const chunks = [];
		let size = 0;
		for await (const chunk of req) {
			size += chunk.length;
			if (size > limit.bodyBytes) {
				reply(res, 413, { error: "body-too-large" }, { Connection: "close" });
				return undefined;
			}
			chunks.push(chunk);
		}
		try {
			return { value: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") };
		} catch {
			return { value: undefined };
		}
	}

	function record(entry) {
		const value = plainObject(entry) ? entry : {};
		seq += 1;
		log.push({ seq, step: identifier(value.step), status: identifier(value.status),
			reason: value.reason === undefined || value.reason === null ? null : identifier(value.reason) });
		while (log.length > limit.logEntries) log.shift();
	}

	function collect() {
		planning ??= Promise.resolve().then(collectPlan).finally(() => { planning = null; });
		return planning;
	}

	async function getPlan(res) {
		// Probing while the runner mutates the machine would describe a moving target.
		if (installing) {
			reply(res, 409, { error: "install-running" });
			return;
		}
		let collected;
		try {
			collected = await collect();
		} catch {
			reply(res, 500, { error: "plan-unavailable" });
			return;
		}
		if (installing) {
			reply(res, 409, { error: "install-running" });
			return;
		}
		stored = { planId: token(random, 18), collected: structuredClone(collected), fingerprint: fingerprint(collected) };
		reply(res, 200, planView(stored.planId, stored.collected));
	}

	async function install(req, res) {
		const body = await readJson(req, res);
		if (body === undefined) return;
		const { value } = body;
		const keys = plainObject(value) ? Object.keys(value).sort() : [];
		if (keys.length !== 2 || keys[0] !== "consent" || keys[1] !== "planId" || value.consent !== true ||
			typeof value.planId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.planId)) {
			reply(res, 400, { error: "invalid-request" });
			return;
		}
		if (installing) {
			reply(res, 409, { error: "install-running" });
			return;
		}
		// One installation per wizard run: a final outcome is never replaced.
		if (lastOutcome !== null) {
			reply(res, 409, { error: "already-completed" });
			return;
		}
		if (stored === null || !sameSecret(stored.planId, value.planId)) {
			reply(res, 409, { error: "plan-changed" });
			return;
		}
		installing = true;
		const current = stored;
		let fresh;
		try {
			// Re-inventory: install only when the machine still matches the consented plan.
			fresh = await collect();
		} catch {
			fresh = null;
		}
		if (fresh === null || stored !== current || fingerprint(fresh) !== current.fingerprint) {
			installing = false;
			stored = null;
			reply(res, 409, { error: "plan-changed" });
			return;
		}
		stored = null;
		const request = { plan: structuredClone(current.collected.plan), consent: true };
		// Viewing an untrusted result can throw; the installation must still end
		// with a failed outcome and release the single-flight and idle locks.
		Promise.resolve()
			.then(() => runInstall(request, record))
			.then((result) => {
				try {
					return outcomeView(result);
				} catch {
					return outcomeView(null);
				}
			}, () => outcomeView(null))
			.then((view) => {
				lastOutcome = view;
			})
			.finally(() => {
				installing = false;
				lastActivity = now();
			});
		reply(res, 202, { started: true });
	}

	function progress(query, res) {
		const params = new URLSearchParams(query);
		const keys = [...params.keys()];
		const after = params.get("after") ?? "0";
		if (keys.some((key) => key !== "after") || keys.length > 1 || !/^(0|[1-9]\d{0,15})$/.test(after)) {
			reply(res, 400, { error: "invalid-request" });
			return;
		}
		const from = Number(after);
		reply(res, 200, { entries: log.filter((entry) => entry.seq > from), running: installing, outcome: lastOutcome });
	}

	async function session(query, res) {
		const params = new URLSearchParams(query);
		const supplied = params.get("code");
		const valid = code !== null && now() <= codeExpires && [...params.keys()].length === 1 && supplied !== null && sameSecret(code, supplied);
		if (!valid) {
			reply(res, 401, { error: "unauthorized" });
			return;
		}
		code = null;
		lastActivity = now();
		try {
			onRedeemed();
		} catch {
			// Cleanup hooks are best effort and never break the session.
		}
		reply(res, 200, sessionPage, {
			"Content-Type": "text/html; charset=utf-8",
			"Set-Cookie": `${COOKIE}=${secret}; HttpOnly; SameSite=Strict; Path=/`,
		});
	}

	async function asset(path, res) {
		let content;
		try {
			content = await readFile(join(assetsDir, assets[path].file));
		} catch {
			reply(res, 404, { error: "not-found" });
			return;
		}
		reply(res, 200, content, { "Content-Type": assets[path].type });
	}

	async function handle(req, res) {
		// Only authenticated requests (and a code redemption) count as activity.
		if (req.headers.host !== `${HOST}:${port}`) return reply(res, 421, { error: "misdirected" });
		const raw = String(req.url ?? "");
		const mark = raw.indexOf("?");
		const path = mark === -1 ? raw : raw.slice(0, mark);
		const query = mark === -1 ? "" : raw.slice(mark + 1);
		const method = routes[Object.hasOwn(routes, path) ? path : ""];
		if (method === undefined) return reply(res, 404, { error: "not-found" });
		if (req.method !== method) return reply(res, 405, { error: "method-not-allowed" }, { Allow: method });
		// Browsers send Origin on cross-origin GETs; only our own origin may.
		if (req.headers.origin !== undefined && req.headers.origin !== origin) return reply(res, 403, { error: "forbidden" });
		if (path === "/session") return session(query, res);
		if (!hasSession(req)) return reply(res, 401, { error: "unauthorized" });
		lastActivity = now();
		// A custom header makes every cross-origin API fetch need a CORS preflight, which never succeeds.
		if (path.startsWith("/api/") && req.headers["x-gentle-install"] !== "1") return reply(res, 403, { error: "forbidden" });
		if (method === "POST") {
			if (req.headers.origin !== origin) return reply(res, 403, { error: "forbidden" });
			const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
			if (type !== "application/json") return reply(res, 415, { error: "unsupported-media-type" });
		}
		if (query !== "" && path !== "/api/progress") return reply(res, 400, { error: "invalid-request" });
		if (Object.hasOwn(assets, path)) return asset(path, res);
		if (path === "/api/plan") return getPlan(res);
		if (path === "/api/progress") return progress(query, res);
		if (path === "/api/install") return install(req, res);
		// /api/shutdown
		const body = await readJson(req, res);
		if (body === undefined) return undefined;
		if (body.value !== null && !(plainObject(body.value) && Object.keys(body.value).length === 0)) {
			return reply(res, 400, { error: "invalid-request" });
		}
		if (installing) return reply(res, 409, { error: "install-running" });
		res.once("finish", () => close("shutdown"));
		reply(res, 200, { closing: true });
		return undefined;
	}

	function checkIdle() {
		if (closing || installing || now() - lastActivity < limit.idleMs) return false;
		close("idle");
		return true;
	}

	function close(reason) {
		closing ??= new Promise((resolve) => {
			if (idleTimer) clearInterval(idleTimer);
			code = null;
			server.close(() => resolve());
			server.closeIdleConnections();
			setImmediate(() => server.closeAllConnections());
		}).then(() => {
			resolveClosed({ reason, outcome: lastOutcome });
		});
		return closing;
	}

	async function listen() {
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen({ host: HOST, port: 0, exclusive: true }, () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address();
		if (typeof address !== "object" || address === null || address.address !== HOST || address.family !== "IPv4") {
			await close("bind-mismatch");
			throw new Error("Wizard host is not bound to 127.0.0.1");
		}
		port = address.port;
		origin = `http://${HOST}:${port}`;
		codeExpires = now() + limit.codeTtlMs;
		lastActivity = now();
		idleTimer = setInterval(checkIdle, limit.idleCheckMs);
		idleTimer.unref();
		return { port, address: address.address, origin, url: `${origin}/session?code=${code}` };
	}

	return { listen, close, closed, checkIdle, outcome: () => lastOutcome };
}
