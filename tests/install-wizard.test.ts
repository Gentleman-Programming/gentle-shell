import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as wizard from "../assets/install-wizard/wizard.js";
import { planPreflight, requirements } from "../scripts/installer-preflight.mjs";
import { blockedReasons, failedSteps } from "../scripts/installer-runner.mjs";
import { createInstallerServer, guidance } from "../scripts/installer-server.mjs";
import { scenarioNames, startPreview } from "../scripts/install-wizard-preview.mjs";
import { prefixLayout } from "../scripts/bundled-install.mjs";
import { bundledFailedSteps, bundledPlan, runBundledInstall } from "../scripts/bundled-wizard.mjs";

const assetsDir = fileURLToPath(new URL("../assets/install-wizard/", import.meta.url));
const read = (name: string) => readFileSync(join(assetsDir, name), "utf8");
const API = { "x-gentle-install": "1" };
const BIN = "/home/u/.local/share/pnpm/bin";
// Backtick segments render as <code> elements, so rendered text has no backticks.
const plain = (value: string) => value.replaceAll("`", "");

// ---------------------------------------------------------------------------
// Real HTTP helpers (the real host serving the real assets)
// ---------------------------------------------------------------------------

type Response = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
function send(port: number, { method = "GET", path = "/", headers = {} as Record<string, string>, body = undefined as string | undefined } = {}):
	Promise<Response> {
	return new Promise((resolve, reject) => {
		const all: Record<string, string | number> = { host: `127.0.0.1:${port}`, ...headers };
		if (body !== undefined) all["content-length"] = Buffer.byteLength(body);
		const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: all, setHost: false, agent: false }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
		});
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}
async function login(port: number, url: string) {
	const code = new URL(url).searchParams.get("code") ?? "";
	const response = await send(port, { path: `/session?code=${code}` });
	assert.equal(response.status, 200);
	return String(response.headers["set-cookie"]).split(";")[0];
}
function post(port: number, path: string, cookie: string, body: unknown) {
	return send(port, { method: "POST", path, body: JSON.stringify(body), headers: { cookie, origin: `http://127.0.0.1:${port}`,
		"content-type": "application/json", ...API } });
}
async function getJson(port: number, path: string, cookie: string) {
	const response = await send(port, { path, headers: { cookie, ...API } });
	return { status: response.status, body: JSON.parse(response.body) };
}

const cleanInventory = {
	platform: "linux",
	arch: "x64",
	node: { available: true, version: "24.18.0", usable: true, persistent: false, npm: false },
	pnpm: { available: true, version: "11.1.1", usable: true, compatible: true, persistent: false },
	pi: { available: false },
	shell: { available: false },
	gentleAi: { available: false },
	go: { available: false },
	globalBin: { available: true, path: BIN, writable: true, onPath: false },
	setup: false,
};

/** The real host's /api/plan view for an inventory, so model tests never drift from the server. */
async function serverPlanView(changes: Record<string, unknown> = {}, channel = "release") {
	const inventory = { ...cleanInventory, ...changes };
	const host = createInstallerServer({ assetsDir, collectPlan: async (requested: string) => ({ inventory, plan: planPreflight(inventory, { channel: requested }) }),
		runInstall: async () => ({ outcome: "ready", completed: [] }) });
	const { port, url } = await host.listen();
	try {
		const cookie = await login(port, url);
		const { status, body } = await getJson(port, `/api/plan?channel=${channel}`, cookie);
		assert.equal(status, 200);
		return body;
	} finally {
		await host.close("test");
	}
}

// ---------------------------------------------------------------------------
// Minimal fake DOM: only the APIs wizard.js may use. innerHTML throws.
// ---------------------------------------------------------------------------

class FakeText {
	data: string;
	parent: FakeElement | null = null;
	constructor(data: string) {
		this.data = data;
	}
	get textContent() {
		return this.data;
	}
}
class FakeElement {
	tagName: string;
	ownerDocument: FakeDocument;
	attributes = new Map<string, string>();
	children: Array<FakeElement | FakeText> = [];
	listeners = new Map<string, Array<(event: unknown) => unknown>>();
	parent: FakeElement | null = null;
	checked = false;
	disabled = false;
	constructor(ownerDocument: FakeDocument, tag: string) {
		this.ownerDocument = ownerDocument;
		this.tagName = tag.toUpperCase();
	}
	get textContent(): string {
		return this.children.map((child) => child.textContent).join("");
	}
	set textContent(value: string) {
		this.replaceChildren(String(value));
	}
	set innerHTML(_value: string) {
		throw new Error("innerHTML is forbidden");
	}
	set outerHTML(_value: string) {
		throw new Error("outerHTML is forbidden");
	}
	insertAdjacentHTML() {
		throw new Error("insertAdjacentHTML is forbidden");
	}
	get id() {
		return this.attributes.get("id") ?? "";
	}
	append(...nodes: Array<FakeElement | FakeText | string>) {
		for (const node of nodes) {
			const child = typeof node === "string" ? new FakeText(node) : node;
			child.parent?.children.splice(child.parent.children.indexOf(child), 1);
			child.parent = this;
			this.children.push(child);
		}
	}
	appendChild(node: FakeElement | FakeText) {
		this.append(node);
		return node;
	}
	replaceChildren(...nodes: Array<FakeElement | FakeText | string>) {
		for (const child of this.children) child.parent = null;
		this.children = [];
		this.append(...nodes);
	}
	remove() {
		this.parent?.children.splice(this.parent.children.indexOf(this), 1);
		this.parent = null;
	}
	setAttribute(name: string, value: string) {
		if (name === "style" || /^on/i.test(name)) throw new Error(`forbidden attribute ${name}`);
		this.attributes.set(name, String(value));
	}
	getAttribute(name: string) {
		return this.attributes.get(name) ?? null;
	}
	hasAttribute(name: string) {
		return this.attributes.has(name);
	}
	removeAttribute(name: string) {
		this.attributes.delete(name);
	}
	addEventListener(type: string, listener: (event: unknown) => unknown) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	focus() {
		this.ownerDocument.activeElement = this;
	}
}
class FakeDocument {
	activeElement: FakeElement | null = null;
	roots = new Map<string, FakeElement>();
	constructor() {
		for (const id of ["view", "stages", "alert", "status"]) {
			const root = new FakeElement(this, "div");
			root.setAttribute("id", id);
			this.roots.set(id, root);
		}
	}
	createElement(tag: string) {
		return new FakeElement(this, tag);
	}
	createTextNode(text: string) {
		return new FakeText(text);
	}
	getElementById(id: string) {
		return this.roots.get(id) ?? null;
	}
}

function walk(node: FakeElement | FakeText, out: FakeElement[] = []) {
	if (node instanceof FakeElement) {
		out.push(node);
		for (const child of node.children) walk(child, out);
	}
	return out;
}
const all = (root: FakeElement, tag: string) => walk(root).filter((element) => element.tagName === tag.toUpperCase());
const button = (root: FakeElement, text: string) => all(root, "button").find((element) => element.textContent.includes(text));
const headings = (root: FakeElement) => all(root, "h1");
function dispatch(element: FakeElement, type: string) {
	for (const listener of element.listeners.get(type) ?? []) listener({ type, target: element, preventDefault() {} });
}
async function flush() {
	for (let i = 0; i < 30; i += 1) await new Promise((done) => setImmediate(done));
}

type Timer = { fn: () => void; ms: number; cleared: boolean; ran: boolean };
function fakeTimers() {
	const queue: Timer[] = [];
	const pending = () => queue.filter((timer) => !timer.cleared && !timer.ran);
	return {
		setTimeout: (fn: () => void, ms: number) => {
			const timer = { fn, ms, cleared: false, ran: false };
			queue.push(timer);
			return timer;
		},
		clearTimeout: (timer: Timer | undefined) => {
			if (timer) timer.cleared = true;
		},
		pending,
		async runNext() {
			const [timer] = pending();
			assert.ok(timer, "a timer is scheduled");
			timer.ran = true;
			timer.fn();
			await flush();
			return timer;
		},
	};
}

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Reply = [number, unknown] | Error;
function fakeFetch(handlers: Record<string, (call: Call) => Reply | Promise<Reply>>) {
	const calls: Call[] = [];
	const fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
		const call = { url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body === undefined ? undefined : JSON.parse(init.body) };
		calls.push(call);
		const handler = handlers[`${call.method} ${url.split("?")[0]}`];
		assert.ok(handler, `unexpected request ${call.method} ${url}`);
		const result = await handler(call);
		if (result instanceof Error) throw result;
		const [status, body] = result;
		return { status, ok: status >= 200 && status < 300, json: async () => body };
	};
	return { fetch, calls };
}

type Clipboard = { writeText: (value: string) => Promise<void> } | null;
function mount(handlers: Record<string, (call: Call) => Reply | Promise<Reply>>, { clipboard = null as Clipboard } = {}) {
	const document = new FakeDocument();
	const timers = fakeTimers();
	const server = fakeFetch(handlers);
	const app = wizard.createWizard({ document, fetch: server.fetch, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, clipboard });
	const view = document.roots.get("view") as FakeElement;
	return { document, timers, server, app, view, alert: document.roots.get("alert") as FakeElement,
		status: document.roots.get("status") as FakeElement };
}
const idleProgress = (): Reply => [200, { entries: [], running: false, outcome: null }];
const outcomeProgress = (outcome: Record<string, unknown>): Reply => [200, { entries: [], running: false, outcome }];
const readyOutcome = { outcome: "ready", completed: ["install-global"], guidance: guidance.outcomes.ready };
/** Ticks the consent checkbox on the review screen and presses Install. */
async function consentAndInstall(ui: ReturnType<typeof mount>) {
	const consent = all(ui.view, "input").find((input) => input.getAttribute("type") === "checkbox") as FakeElement;
	consent.checked = true;
	dispatch(consent, "change");
	dispatch(button(ui.view, "Install") as FakeElement, "click");
	await flush();
}
const posts = (ui: ReturnType<typeof mount>, path: string) => ui.server.calls.filter((call) => call.method === "POST" && call.url === path).length;
const progressChecks = (ui: ReturnType<typeof mount>) => ui.server.calls.filter((call) => call.url.startsWith("/api/progress")).length;

// ---------------------------------------------------------------------------
// Static assets under the strict CSP
// ---------------------------------------------------------------------------

test("index.html loads only same-origin wizard.js and wizard.css, with no inline script, style or handlers", () => {
	const html = read("index.html");
	assert.match(html, /<script type="module" src="\/wizard\.js"><\/script>/);
	assert.match(html, /<link rel="stylesheet" href="\/wizard\.css">/);
	assert.equal([...html.matchAll(/<script\b/gi)].length, 1, "only the module script tag");
	assert.doesNotMatch(html, /<style\b|\sstyle=|\son[a-z]+=|javascript:/i);
	assert.doesNotMatch(html, /https?:\/\/|\/\/[a-z]|\bsrc="(?!\/wizard\.js)|\bhref="(?!\/wizard\.css|#)/i);
	// Landmarks, one h1 at load, and live regions present before any update.
	assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
	for (const landmark of ["<header", "<main", "<footer"]) assert.ok(html.includes(landmark), landmark);
	assert.match(html, /id="status"[^>]*role="status"|role="status"[^>]*id="status"/);
	assert.match(html, /id="alert"[^>]*role="alert"|role="alert"[^>]*id="alert"/);
	assert.match(html, /<html lang="en">/);
	assert.match(html, /<noscript>/);
});

test("wizard.js and wizard.css use no HTML injection, dynamic code, inline styles or external resources", () => {
	const js = read("wizard.js");
	for (const forbidden of [/\binnerHTML\b/, /\bouterHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\b/,
		/setAttribute\(\s*["']style["']/, /\.style\b/, /https?:\/\//, /\bimport\s*\(/, /setTimeout\(\s*["'`]/]) {
		assert.doesNotMatch(js, forbidden, String(forbidden));
	}
	const css = read("wizard.css");
	assert.doesNotMatch(css, /@import|url\(|https?:\/\/|@font-face/i);
	assert.match(css, /prefers-reduced-motion/);
	assert.match(css, /:focus-visible/);
	// Only the programmatically focused heading (tabindex=-1, never interactive) drops its outline;
	// every control keeps the :focus-visible ring.
	const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const outlineOff = [...rules.matchAll(/([^{}]+)\{[^{}]*outline:\s*(?:none|0)\b[^{}]*\}/g)].map((match) => match[1].trim());
	assert.deepEqual(outlineOff, ['h1[tabindex="-1"]:focus']);
	assert.doesNotMatch(rules, /h1[^{,]*:focus-visible/);
});

test("the reference hero glow sits behind the panel as a decorative, static pseudo-element", () => {
	const css = read("wizard.css").replace(/\s+/g, " ").replace(/\s*,\s*/g, ",");
	const rule = css.match(/\.view::before \{([^}]*)\}/)?.[1] ?? "";
	assert.ok(rule.includes("radial-gradient(38% 50% at 30% 30%,#f095c838,#0000 70%),radial-gradient(30% 40% at 75% 40%,#b4e7c71f,#0000 70%)"),
		"reference gradients");
	assert.match(rule, /pointer-events: none/);
	assert.match(rule, /filter: blur\(/);
	assert.match(rule, /z-index: -1/);
	assert.doesNotMatch(rule, /animation|transition/, "decorative glow never moves");
});

test("the real host serves the real wizard assets under the strict CSP", async () => {
	const host = createInstallerServer({ assetsDir, collectPlan: async () => ({ inventory: cleanInventory, plan: planPreflight(cleanInventory) }),
		runInstall: async () => ({ outcome: "ready", completed: [] }) });
	const { port, url } = await host.listen();
	try {
		const cookie = await login(port, url);
		for (const [path, type] of [["/", "text/html"], ["/wizard.js", "text/javascript"], ["/wizard.css", "text/css"]]) {
			const response = await send(port, { path, headers: { cookie } });
			assert.equal(response.status, 200, path);
			assert.match(String(response.headers["content-type"]), new RegExp(`^${type}`), path);
			assert.match(String(response.headers["content-security-policy"]), /^default-src 'self';/);
		}
	} finally {
		await host.close("test");
	}
});

// ---------------------------------------------------------------------------
// Pure models
// ---------------------------------------------------------------------------

test("planModel discloses the PATH change and runtime persistence before consent", async () => {
	const view = await serverPlanView();
	const model = wizard.planModel(view);
	assert.equal(model.kind, "install");
	assert.deepEqual(model.actions.map((action: { id: string }) => action.id), view.actions.map((action: { id: string }) => action.id));
	const [profile, persistence] = model.disclosures;
	assert.equal(profile.id, "profile");
	assert.equal(profile.changes, true);
	assert.equal(profile.text, view.profileChange.description);
	assert.equal(profile.detail, BIN);
	assert.match(profile.state, /will change/i);
	assert.equal(persistence.id, "persistence");
	assert.equal(persistence.changes, true);
	assert.equal(persistence.text, view.persistence.description);
	assert.match(persistence.state, /node, npm, pnpm/);

	const unchanged = wizard.planModel(await serverPlanView({ node: { ...cleanInventory.node, persistent: true, npm: true },
		pnpm: { ...cleanInventory.pnpm, persistent: true }, globalBin: { ...cleanInventory.globalBin, onPath: true } }));
	assert.equal(unchanged.kind, "install");
	assert.deepEqual(unchanged.disclosures.map((item: { changes: boolean; state: string }) => [item.changes, /no change/i.test(item.state)]),
		[[false, true], [false, true]]);
});

// S6 notice: shown on the review screen before consent; it changes nothing else.
test("the review screen shows the notice about reused tools in folders another account can change", async () => {
	const weak = { check: "parent-acl-mask", at: "C:\\Users\\m\\AppData\\Roaming", sid: "S-1-5-21-1-2-3-1002", account: "PC\\other", rights: "0x001301BF" };
	const windows = { platform: "win32", node: { ...cleanInventory.node, persistent: true, npm: true }, pnpm: { ...cleanInventory.pnpm, persistent: true },
		go: { available: true, version: "1.26.0", usable: true } };
	const view = await serverPlanView({ ...windows, folders: { node: weak, npm: weak } });
	const model = wizard.planModel(view);
	assert.equal(model.kind, "install");
	assert.equal(model.notice, view.sharedFolders.description);
	assert.deepEqual(model.disclosures.map((item: { id: string }) => item.id), ["profile", "persistence"]);
	const node = wizard.renderPlan(new FakeDocument(), model, { install() {}, reload() {}, close() {} });
	assert.match(node.textContent, /Tools in folders other accounts can change/);
	assert.ok(node.textContent.includes("S-1-5-21-1-2-3-1002 (PC\\other) can change C:\\Users\\m\\AppData\\Roaming"));
	assert.ok(button(node, "Install Gentle Shell"), "still installable");
	const plain = wizard.planModel(await serverPlanView(windows));
	assert.equal(plain.notice, null);
	assert.doesNotMatch(wizard.renderPlan(new FakeDocument(), plain, { install() {}, reload() {}, close() {} }).textContent, /other accounts can change/);
});

test("a recoverable stack is reviewed as completing setup, not as a reinstall", async () => {
	const view = await serverPlanView({ pi: { available: true, version: "1.0.0", usable: true },
		shell: { available: true, version: requirements.shell, usable: true, global: true },
		gentleAi: { available: true, version: requirements.gentleAi, usable: true, compatible: true },
		setup: { available: true, recoverable: true } });
	const model = wizard.planModel(view);
	assert.equal(model.kind, "recovery");
	assert.deepEqual(model.actions.map((action: { id: string }) => action.id), ["setup-global-bin", "setup-shell", "verify-readiness"]);
	assert.equal(model.steps.includes("install-global"), false);
	assert.equal(model.disclosures[1].changes, false);
	const node = wizard.renderPlan(new FakeDocument(), model, { install() {}, reload() {}, close() {} });
	assert.match(node.textContent, /Gentle Shell is already installed; this completes setup/);
	assert.ok(button(node, "Complete setup"));
	assert.equal(button(node, "Install Gentle Shell"), undefined);
	assert.equal(/Review the installation plan|Installation steps/.test(node.textContent), false);
	// A clean plan keeps the installation wording.
	assert.equal(wizard.planModel(await serverPlanView()).kind, "install");
});

test("planModel turns preflight blockers into guidance and offers no install", async () => {
	const model = wizard.planModel(await serverPlanView({ node: { available: true, version: "18.0.0", usable: true, persistent: true, npm: true } }));
	assert.equal(model.kind, "blocked");
	assert.equal(model.blockers.length, 1);
	assert.equal(model.blockers[0].toolLabel, "Node.js");
	assert.equal(model.blockers[0].guidance, "Node.js 18.0.0 is installed, but this installer needs 22.19.0 or newer. Nothing was replaced. Update it, then select Check again.");
	for (const code of Object.keys(guidance.blockers)) {
		const rendered = wizard.planModel({ planId: "p", ready: false, actions: [], blockers: [{ code, tool: "pnpm", guidance: guidance.blockers[code] }],
			profileChange: { changesProfile: false, binDir: null, description: "x" }, persistence: { tools: [], pnpmHome: null, description: "y" } });
		assert.equal(rendered.blockers[0].guidance, guidance.blockers[code]);
	}
	const nothing = wizard.planModel({ planId: "p", ready: true, actions: [{ id: "verify-readiness", description: "Verify." }], blockers: [],
		profileChange: { changesProfile: false, binDir: null, description: "x" }, persistence: { tools: [], pnpmHome: null, description: "y" } });
	assert.equal(nothing.kind, "nothing");
});

test("expectedSteps mirrors the runner sequence and every step has a label", () => {
	const base = ["install-global", "verify-global-list", "verify-shell-bin", "verify-gentle-ai", "shell-setup"];
	assert.deepEqual(wizard.expectedSteps(["install-pi", "install-shell", "setup-shell", "verify-readiness"]),
		["check-npm", "check-global-bin", "check-existing-stack", ...base]);
	assert.deepEqual(wizard.expectedSteps(["setup-global-bin", "persist-node", "persist-package-managers", "configure-npm-prefix", "install-pi",
		"install-shell", "setup-shell", "verify-readiness"]), ["check-global-bin", "check-existing-stack", "persist-node", "persist-package-managers",
		"verify-persistent-runtime", "check-npm", "configure-npm-prefix", ...base, "persist-path"]);
	// Next to a persistent pnpm (never downgraded), a bootstrap-only Node persists only npm with it.
	assert.deepEqual(wizard.expectedSteps(["persist-node", "persist-npm", "configure-npm-prefix", "install-pi", "install-shell", "setup-shell",
		"verify-readiness"]), ["check-global-bin", "check-existing-stack", "persist-node", "persist-npm", "verify-persistent-runtime", "check-npm",
		"configure-npm-prefix", ...base]);
	assert.deepEqual(wizard.expectedSteps(["persist-npm", "install-pi", "install-shell"]),
		["check-global-bin", "check-existing-stack", "persist-npm", "check-npm", ...base]);
	assert.deepEqual(wizard.expectedSteps(["persist-pnpm", "install-pi", "install-shell"]),
		["check-npm", "check-global-bin", "check-existing-stack", "persist-pnpm", "verify-persistent-pnpm", ...base]);
	assert.deepEqual(wizard.expectedSteps(["persist-package-managers", "install-pi", "install-shell"]),
		["check-global-bin", "check-existing-stack", "persist-package-managers", "check-npm", "verify-persistent-pnpm", ...base]);
	// Setup recovery: the installed stack is re-verified, never reinstalled.
	const recovery = ["check-npm", "check-global-bin", "check-recoverable-stack", "verify-global-list", "verify-shell-bin",
		"verify-gentle-ai", "shell-setup"];
	assert.deepEqual(wizard.expectedSteps(["setup-shell", "verify-readiness"]), recovery);
	assert.deepEqual(wizard.expectedSteps(["setup-global-bin", "setup-shell", "verify-readiness"]), [...recovery, "persist-path"]);
	const known = new Set([...failedSteps, "check-global-bin", "check-existing-stack", "check-recoverable-stack"]);
	for (const id of [...known, "gate"]) assert.notEqual(wizard.stepLabel(id), id, `label for ${id}`);
	for (const id of wizard.expectedSteps(["setup-global-bin", "persist-node", "persist-package-managers", "configure-npm-prefix"])) {
		assert.ok(known.has(id), id);
	}
	assert.equal(wizard.stepLabel("not-a-step"), "not-a-step");
});

const mainIds = ["build-gentle-ai-main", "install-shell-main", "record-channel"];
const goReady = { go: { available: true, version: "1.26.0", usable: true } };

test("planModel carries the plan's channel, release unless the host says main", async () => {
	assert.equal(wizard.planModel(await serverPlanView(goReady, "main")).channel, "main");
	assert.equal(wizard.planModel(await serverPlanView()).channel, "release");
	assert.equal(wizard.planModel({ channel: "nightly", actions: [], blockers: [] }).channel, "release");
});

test("expectedSteps places the main steps after the release verification and before setup", () => {
	const verified = ["install-global", "verify-global-list", "verify-shell-bin", "verify-gentle-ai"];
	assert.deepEqual(wizard.expectedSteps(["install-pi", "install-shell", "setup-shell", "verify-readiness", ...mainIds]),
		["check-npm", "check-global-bin", "check-existing-stack", ...verified, ...mainIds, "shell-setup"]);
	assert.deepEqual(wizard.expectedSteps(["setup-shell", "verify-readiness", ...mainIds]),
		["check-npm", "check-global-bin", "check-recoverable-stack", "verify-global-list", "verify-shell-bin", "verify-gentle-ai", ...mainIds, "shell-setup"]);
	for (const id of mainIds) assert.notEqual(wizard.stepLabel(id), id, `label for ${id}`);
});

test("expectedSteps runs the pinned Go acquisition after the pre-install checks and before anything is installed", () => {
	const go = ["acquire-go", "verify-go"];
	assert.deepEqual(wizard.expectedSteps([...go, "install-pi", "install-shell", "setup-shell", "verify-readiness", ...mainIds]),
		["check-npm", "check-global-bin", "check-existing-stack", ...go, "install-global", "verify-global-list", "verify-shell-bin",
			"verify-gentle-ai", ...mainIds, "shell-setup"]);
	// Like the runner, the pinned Go comes before the runtime is persisted.
	assert.deepEqual(wizard.expectedSteps(["setup-global-bin", ...go, "persist-node", "persist-package-managers", "configure-npm-prefix",
		"install-pi", "install-shell", "setup-shell", "verify-readiness", ...mainIds]),
		["check-global-bin", "check-existing-stack", ...go, "persist-node", "persist-package-managers", "verify-persistent-runtime", "check-npm",
			"configure-npm-prefix", "install-global", "verify-global-list", "verify-shell-bin", "verify-gentle-ai", ...mainIds, "shell-setup", "persist-path"]);
	assert.deepEqual(wizard.expectedSteps([...go, "persist-pnpm", "install-pi", "install-shell", "setup-shell", "verify-readiness"]),
		["check-npm", "check-global-bin", "check-existing-stack", ...go, "persist-pnpm", "verify-persistent-pnpm", "install-global",
			"verify-global-list", "verify-shell-bin", "verify-gentle-ai", "shell-setup"]);
	assert.deepEqual(wizard.expectedSteps([...go, "update-shell-main", "setup-shell", "verify-readiness"]),
		["check-npm", "check-global-bin", "check-installed-shell", ...go, "update-shell", "verify-updated-shell", "shell-setup"]);
	for (const id of go) assert.notEqual(wizard.stepLabel(id), id, `label for ${id}`);
});

test("the review screen offers the release and main channels and reloads the plan for the chosen one", async () => {
	const release = await serverPlanView(goReady);
	const main = await serverPlanView(goReady, "main");
	const ui = mount({
		"GET /api/progress": () => idleProgress(),
		"GET /api/plan": (call) => [200, call.url.endsWith("channel=main") ? main : release],
	});
	await ui.app.start();
	await flush();
	const radios = () => all(ui.view, "input").filter((input) => input.getAttribute("type") === "radio");
	assert.deepEqual(radios().map((radio) => [radio.getAttribute("value"), radio.checked === true]), [["release", true], ["main", false]]);
	assert.ok(ui.view.textContent.includes("Latest release"));
	assert.ok(ui.view.textContent.includes("Latest main"));
	const choose = radios()[1];
	choose.checked = true;
	dispatch(choose, "change");
	await flush();
	const plans = ui.server.calls.filter((call) => call.url.startsWith("/api/plan")).map((call) => call.url);
	assert.deepEqual(plans, ["/api/plan?channel=release", "/api/plan?channel=main"]);
	assert.deepEqual(radios().map((radio) => [radio.getAttribute("value"), radio.checked === true]), [["release", false], ["main", true]]);
	assert.ok(ui.view.textContent.includes(plain(main.actions.find((action: { id: string }) => action.id === "build-gentle-ai-main").description)));
});

test("an already set-up computer points to gentle-shell upgrade, and to its main channel when main is chosen", () => {
	for (const [channel, expected] of [["release", "Run gentle-shell in a terminal. To upgrade, run gentle-shell upgrade."],
		["main", "Run gentle-shell in a terminal. To follow main, run gentle-shell upgrade --channel main."]]) {
		const document = new FakeDocument();
		const model = wizard.planModel({ planId: "p", ready: true, channel, actions: [{ id: "verify-readiness", description: "Verify." }], blockers: [] });
		const view = wizard.renderPlan(document, model, { install: () => {}, reload: () => {}, close: () => {} });
		assert.ok(view.textContent.includes(expected), channel);
	}
	assert.equal(guidance.blocked["existing-stack"], "Pi or Gentle Shell is already installed globally. Nothing was changed; use `gentle-shell upgrade` instead.");
	assert.ok(guidance.blocked["unsupported-plan"].includes("Use `gentle-shell upgrade` or follow the README."));
});

test("expectedSteps mirrors the shell-only installation and the update of an existing Gentle Shell", () => {
	assert.deepEqual(wizard.expectedSteps(["install-shell", "setup-shell", "verify-readiness"]),
		["check-npm", "check-global-bin", "check-existing-shell", "install-global", "verify-global-list", "verify-shell-bin", "verify-gentle-ai", "shell-setup"]);
	assert.deepEqual(wizard.expectedSteps(["install-pi", "update-shell-release", "setup-shell", "verify-readiness"]),
		["check-npm", "check-global-bin", "check-installed-shell", "install-pi", "update-shell", "verify-updated-shell", "verify-gentle-ai", "shell-setup"]);
	assert.deepEqual(wizard.expectedSteps(["update-shell-main", "setup-shell", "verify-readiness"]),
		["check-npm", "check-global-bin", "check-installed-shell", "update-shell", "verify-updated-shell", "shell-setup"]);
});

test("expectedSteps checks, updates and verifies an older Pi before any Gentle Shell step", () => {
	assert.deepEqual(wizard.expectedSteps(["update-pi", "install-shell", "setup-shell", "verify-readiness"]),
		["check-npm", "check-global-bin", "check-existing-shell", "check-installed-pi", "update-pi", "verify-updated-pi", "install-global",
			"verify-global-list", "verify-shell-bin", "verify-gentle-ai", "shell-setup"]);
	assert.deepEqual(wizard.expectedSteps(["update-pi", "update-shell-release", "setup-shell", "verify-readiness"]),
		["check-npm", "check-global-bin", "check-installed-shell", "check-installed-pi", "update-pi", "verify-updated-pi", "update-shell",
			"verify-updated-shell", "verify-gentle-ai", "shell-setup"]);
	assert.deepEqual(wizard.expectedSteps(["update-pi", "verify-readiness"]),
		["check-npm", "check-global-bin", "check-installed-pi", "update-pi", "verify-updated-pi"]);
	// The installer's Pi added on its own, next to an older one that neither pnpm nor npm owns.
	assert.deepEqual(wizard.expectedSteps(["install-pi", "verify-readiness"]),
		["check-npm", "check-global-bin", "check-existing-pi", "install-pi", "verify-installed-pi"]);
	for (const id of ["check-installed-pi", "update-pi", "verify-updated-pi", "check-existing-pi", "verify-installed-pi"]) {
		assert.notEqual(wizard.stepLabel(id), id);
	}
});

test("a plan that only updates an older Pi is reviewed as a Pi update, with an Update Pi button", () => {
	const document = new FakeDocument();
	const model = wizard.planModel({ planId: "p", ready: false, channel: "release", blockers: [],
		actions: [{ id: "update-pi", description: "Update Pi 0.87.1 to 1.0.0 with npm." }, { id: "verify-readiness", description: "Verify." }] });
	assert.equal(model.kind, "update-pi");
	const view = wizard.renderPlan(document, model, { install: () => {}, reload: () => {}, close: () => {} });
	assert.ok(headings(view)[0].textContent.includes("Update Pi"));
	assert.ok(button(view, "Update Pi"));
	assert.equal(button(view, "Install Gentle Shell"), undefined);
	const alongside = wizard.planModel({ planId: "p", blockers: [], actions: [{ id: "install-pi", description: "Install Pi." },
		{ id: "verify-readiness", description: "Verify." }] });
	assert.equal(alongside.kind, "install-pi");
	const installView = wizard.renderPlan(document, alongside, { install: () => {}, reload: () => {}, close: () => {} });
	assert.ok(headings(installView)[0].textContent.includes("Install Pi"));
	assert.ok(button(installView, "Install Pi"));
	// The same plan serves a missing Pi and an older one neither pnpm nor npm owns.
	assert.ok(installView.textContent.includes("Pi is missing or older than it needs"));
	assert.equal(installView.textContent.includes("needs a newer Pi"), false);
	// Combined with a Gentle Shell installation or update, the plan keeps its usual kind.
	const install = wizard.planModel({ planId: "p", blockers: [], actions: [{ id: "update-pi" }, { id: "install-shell" }, { id: "setup-shell" },
		{ id: "verify-readiness" }] });
	assert.equal(install.kind, "install");
	const update = wizard.planModel({ planId: "p", blockers: [], actions: [{ id: "update-pi" }, { id: "update-shell-release" },
		{ id: "setup-shell" }, { id: "verify-readiness" }] });
	assert.equal(update.kind, "update");
});

test("an update plan is reviewed as an update, with an Update button", () => {
	const document = new FakeDocument();
	const model = wizard.planModel({ planId: "p", ready: false, channel: "release", blockers: [],
		actions: [{ id: "update-shell-release", description: "Update." }, { id: "setup-shell", description: "Setup." }, { id: "verify-readiness", description: "Verify." }] });
	assert.equal(model.kind, "update");
	const view = wizard.renderPlan(document, model, { install: () => {}, reload: () => {}, close: () => {} });
	assert.ok(headings(view)[0].textContent.includes("Update Gentle Shell"));
	assert.ok(button(view, "Update Gentle Shell"));
	assert.equal(button(view, "Install Gentle Shell"), undefined);
});

test("a main plan blocked by a Go it cannot check still lets the user switch back to release", async () => {
	const blocked = await serverPlanView({ go: { available: null } }, "main");
	assert.ok(blocked.blockers.some((blocker: { code: string }) => blocker.code === "main-requires-go"));
	const ui = mount({ "GET /api/progress": () => idleProgress(), "GET /api/plan": () => [200, blocked] });
	await ui.app.start();
	await flush();
	assert.equal(all(ui.view, "input").filter((input) => input.getAttribute("type") === "radio").length, 2);
});

test("progressModel shows done, failed, in-progress and pending steps without relying on color", () => {
	const steps = ["check-npm", "check-global-bin", "install-global"];
	const running = wizard.progressModel(steps, [{ seq: 1, step: "check-npm", status: "done", reason: null }], { running: true, outcome: null });
	assert.deepEqual(running.items.map((item: { status: string }) => item.status), ["done", "running", "pending"]);
	assert.deepEqual([running.done, running.total], [1, 3]);
	for (const item of running.items) assert.ok(item.statusText.length > 0 && item.label.length > 0);

	const failed = wizard.progressModel(steps, [{ seq: 1, step: "check-npm", status: "done", reason: null },
		{ seq: 2, step: "check-global-bin", status: "done", reason: null }, { seq: 3, step: "install-global", status: "failed", reason: null }],
	{ running: false, outcome: { outcome: "failed", failedStep: "install-global", completed: ["check-npm", "check-global-bin"], guidance: "g" } });
	assert.deepEqual(failed.items.map((item: { status: string }) => item.status), ["done", "done", "failed"]);
	assert.equal(failed.items[2].statusText, "Failed");

	const blocked = wizard.progressModel(steps, [{ seq: 1, step: "gate", status: "blocked", reason: "existing-stack" }],
		{ running: false, outcome: { outcome: "blocked", reason: "existing-stack", completed: [], guidance: "g" } });
	assert.deepEqual(blocked.items.map((item: { status: string }) => item.status), ["blocked", "skipped", "skipped", "skipped"]);
	// An unexpected logged step is still shown, and the total never shrinks below what ran.
	const extra = wizard.progressModel(["check-npm"], [{ seq: 1, step: "check-npm", status: "done", reason: null },
		{ seq: 2, step: "surprise", status: "done", reason: null }], { running: true, outcome: null });
	assert.deepEqual(extra.items.map((item: { id: string }) => item.id), ["check-npm", "surprise"]);
	assert.ok(extra.total >= 2);
});

test("outcomeModel covers every runner outcome, blocked reason and failed step with the server guidance", () => {
	const ready = wizard.outcomeModel({ outcome: "ready", completed: ["install-global"], guidance: guidance.outcomes.ready });
	assert.equal(ready.tone, "success");
	assert.equal(ready.command, "gentle-shell");
	assert.equal(ready.guidance, guidance.outcomes.ready);
	const terminal = wizard.outcomeModel({ outcome: "terminal-action-required", action: "open-new-terminal", npmPrefix: "configured",
		completed: ["persist-path"], guidance: guidance.outcomes["terminal-action-required"] });
	assert.equal(terminal.tone, "success");
	assert.equal(terminal.command, "gentle-shell");
	assert.match(terminal.title, /new terminal/i);
	assert.ok(terminal.next.some((line: string) => /open a new terminal/i.test(line)));
	assert.ok(terminal.notes.some((line: string) => /npm/i.test(line)));
	for (const reason of blockedReasons) {
		const model = wizard.outcomeModel({ outcome: "blocked", reason, completed: [], guidance: guidance.blocked[reason] });
		assert.equal(model.tone, "warning", reason);
		assert.equal(model.guidance, guidance.blocked[reason], reason);
		assert.equal(model.command, null);
		assert.match(model.lead, /nothing was installed/i);
	}
	for (const step of failedSteps) {
		const model = wizard.outcomeModel({ outcome: "failed", failedStep: step, completed: ["check-npm"], guidance: guidance.failed[step] });
		assert.equal(model.tone, "error", step);
		assert.equal(model.guidance, guidance.failed[step], step);
		assert.equal(model.failedStep.label, wizard.stepLabel(step));
		assert.deepEqual(model.completed.map((item: { id: string }) => item.id), ["check-npm"]);
	}
	const unknown = wizard.outcomeModel({ outcome: "failed", failedStep: null, completed: [], guidance: guidance.fallback });
	assert.equal(unknown.guidance, guidance.fallback);
	assert.equal(unknown.failedStep, null);
});

test("a failed setup shows its last error as labelled plain text", () => {
	const document = new FakeDocument();
	const hostile = "Error: `rm -rf` <img src=x onerror=alert(1)> GitHub API returned HTTP 403";
	const model = wizard.outcomeModel({ outcome: "failed", failedStep: "shell-setup", completed: [], guidance: guidance.setupRateLimit, detail: hostile });
	assert.equal(model.detail, hostile);
	assert.equal(model.guidance, guidance.setupRateLimit);
	const node = wizard.renderOutcome(document, model, { close() {} });
	const section = all(node, "section").find((element) => element.textContent.startsWith("Last error from gentle-shell setup"));
	assert.ok(section, "labelled detail section");
	const label = all(section, "h2")[0];
	assert.equal(label.textContent, "Last error from gentle-shell setup");
	assert.equal(section.getAttribute("aria-labelledby"), label.getAttribute("id"));
	// Backticks stay literal: the detail is one text node, never `rich` code spans or markup.
	const codes = all(section, "code");
	assert.equal(codes.length, 1);
	assert.equal(codes[0].textContent, hostile);
	assert.equal(all(node, "img").length, 0);
	// pnpm setup's detail is labelled with its own fixed command name.
	const pnpmDetail = "[ERR_PNPM_UNKNOWN_SHELL] Could not infer shell type.";
	const persist = wizard.outcomeModel({ outcome: "failed", failedStep: "persist-path", completed: [], guidance: guidance.persistPathShell, detail: pnpmDetail });
	assert.equal(persist.detail, pnpmDetail);
	assert.equal(persist.detailCommand, "pnpm setup");
	// The Go download's folder conflict is labelled with that step.
	const goDetail = "Conflicting Go destination: ~/.pi/gentle-ai/tools/go/1.25.14";
	const go = wizard.outcomeModel({ outcome: "failed", failedStep: "acquire-go", completed: [], guidance: guidance.goDestinationConflict, detail: goDetail });
	assert.equal(go.detail, goDetail);
	assert.equal(go.detailCommand, "the Go download");
	const persistNode = wizard.renderOutcome(document, persist, { close() {} });
	const persistSection = all(persistNode, "section").find((element) => element.textContent.startsWith("Last error from pnpm setup"));
	assert.ok(persistSection, "pnpm setup detail section");
	assert.equal(all(persistSection, "code")[0].textContent, pnpmDetail);
	assert.doesNotMatch(persistNode.textContent, /Last error from gentle-shell setup/);
	// The install, main-channel and update steps label their detail with what failed.
	for (const [step, label] of [["install-global", "pnpm add -g"], ["install-shell-main", "the Gentle Shell main install"],
		["build-gentle-ai-main", "the Gentle AI main build"], ["update-shell", "the Gentle Shell update"]]) {
		const failed = wizard.outcomeModel({ outcome: "failed", failedStep: step, completed: [], guidance: "g", detail: hostile });
		assert.deepEqual([failed.detail, failed.detailCommand], [hostile, label], step);
		const rendered = wizard.renderOutcome(document, failed, { close() {} });
		const labelled = all(rendered, "section").find((element) => element.textContent.startsWith(`Last error from ${label}`));
		assert.ok(labelled, `${step} detail section`);
		assert.equal(all(labelled, "code")[0].textContent, hostile);
	}
	// The detail is shown only for a failed setup step with a string value, bounded to 300 characters.
	const long = wizard.outcomeModel({ outcome: "failed", failedStep: "shell-setup", completed: [], guidance: "g", detail: "y".repeat(400) });
	assert.equal(long.detail.length, 300);
	for (const outcome of [
		{ outcome: "failed", failedStep: "record-channel", completed: [], guidance: "g", detail: hostile },
		{ outcome: "failed", failedStep: "shell-setup", completed: [], guidance: "g", detail: 42 },
		{ outcome: "failed", failedStep: "shell-setup", completed: [], guidance: "g", detail: "" },
		{ outcome: "ready", completed: [], guidance: "g", detail: hostile },
	]) {
		const other = wizard.outcomeModel(outcome);
		assert.equal(other.detail, null, JSON.stringify(outcome));
		assert.doesNotMatch(wizard.renderOutcome(document, other, { close() {} }).textContent, /Last error from gentle-shell setup/);
	}
});

test("renderOutcome renders every outcome with text nodes only, so server strings stay inert", () => {
	const document = new FakeDocument();
	const hostile = "<img src=x onerror=alert(1)>";
	const outcomes = [
		{ outcome: "ready", completed: [], guidance: hostile },
		{ outcome: "terminal-action-required", action: "open-new-terminal", completed: [], guidance: hostile },
		...blockedReasons.map((reason: string) => ({ outcome: "blocked", reason, completed: [], guidance: guidance.blocked[reason] })),
		...failedSteps.map((step: string) => ({ outcome: "failed", failedStep: step, completed: [hostile], guidance: guidance.failed[step] })),
	];
	for (const outcome of outcomes) {
		const node = wizard.renderOutcome(document, wizard.outcomeModel(outcome), { close() {} });
		assert.equal(headings(node).length, 1);
		assert.ok(node.textContent.includes(plain(outcome.guidance)), outcome.outcome);
		assert.ok(all(node, "img").length === 0);
		assert.ok(button(node, "Close installer"), "close button");
	}
	const plan = wizard.renderPlan(document, wizard.planModel({ planId: "p", ready: false,
		actions: [{ id: "install-pi", description: hostile }], blockers: [],
		profileChange: { changesProfile: true, binDir: hostile, description: hostile }, persistence: { tools: [], pnpmHome: null, description: hostile } }),
	{ install() {}, reload() {}, close() {} });
	assert.ok(plan.textContent.includes(hostile));
	assert.equal(all(plan, "img").length, 0);
});

// ---------------------------------------------------------------------------
// Request and polling policies
// ---------------------------------------------------------------------------

test("installBody requires explicit consent and sends exactly { planId, consent: true }", () => {
	assert.equal(wizard.installBody("plan-1", false), null);
	assert.equal(wizard.installBody("plan-1", undefined), null);
	assert.equal(wizard.installBody("", true), null);
	assert.deepEqual(wizard.installBody("plan-1", true), { planId: "plan-1", consent: true });
	assert.deepEqual(Object.keys(wizard.installBody("plan-1", true)).sort(), ["consent", "planId"]);
});

test("interpretInstall maps every host answer to one next step", () => {
	assert.equal(wizard.interpretInstall(202, { started: true }).next, "progress");
	assert.equal(wizard.interpretInstall(409, { error: "plan-changed" }).next, "reload-plan");
	assert.match(wizard.interpretInstall(409, { error: "plan-changed" }).message, /changed/i);
	assert.equal(wizard.interpretInstall(409, { error: "install-running" }).next, "progress");
	assert.equal(wizard.interpretInstall(409, { error: "already-completed" }).next, "outcome");
	assert.equal(wizard.interpretInstall(401, { error: "unauthorized" }).next, "session");
	assert.equal(wizard.interpretInstall(403, { error: "forbidden" }).next, "session");
	for (const status of [400, 413, 415, 500, 502]) assert.equal(wizard.interpretInstall(status, { error: "x" }).next, "error", String(status));
});

test("nextPoll backs off while quiet, resets on news, and stops on outcome, repeated errors or a stalled host", () => {
	const policy = wizard.pollPolicy;
	let state = wizard.initialPoll();
	assert.equal(state.delay, policy.initialMs);
	const quiet = [];
	for (let i = 0; i < 7; i += 1) {
		state = wizard.nextPoll(state, { type: "entries", count: 0, running: true, outcome: null });
		quiet.push(state.delay);
	}
	assert.deepEqual(quiet, [750, 1125, 1688, 2532, 3798, 4000, 4000], "quiet polls back off by 1.5x up to 4 s");
	for (let i = 0; i < 20; i += 1) state = wizard.nextPoll(state, { type: "entries", count: 0, running: true, outcome: null });
	assert.equal(state.delay, policy.maxMs);
	assert.equal(state.stop, false, "a long install keeps polling at the capped delay");
	state = wizard.nextPoll(state, { type: "entries", count: 2, running: true, outcome: null });
	assert.equal(state.delay, policy.initialMs);

	const done = wizard.nextPoll(state, { type: "entries", count: 1, running: false, outcome: { outcome: "ready" } });
	assert.deepEqual([done.stop, done.reason], [true, "outcome"]);

	let failing = wizard.initialPoll();
	const delays = [];
	for (let i = 0; i < policy.maxFailures; i += 1) {
		failing = wizard.nextPoll(failing, { type: "error" });
		delays.push(failing.delay);
	}
	assert.deepEqual([failing.stop, failing.reason], [true, "errors"]);
	assert.deepEqual(delays, [1000, 2000, 4000, 8000, 8000], "errors double the delay up to 8 s");
	let recovered = wizard.nextPoll(wizard.nextPoll(wizard.initialPoll(), { type: "error" }), { type: "entries", count: 0, running: true, outcome: null });
	assert.equal(recovered.failures, 0);

	let stalled = wizard.initialPoll();
	for (let i = 0; i < policy.maxIdle; i += 1) stalled = wizard.nextPoll(stalled, { type: "entries", count: 0, running: false, outcome: null });
	assert.deepEqual([stalled.stop, stalled.reason], [true, "stalled"]);
	recovered = wizard.nextPoll(wizard.initialPoll(), { type: "entries", count: 0, running: true, outcome: null });
	assert.equal(recovered.idle, 0);
});

// ---------------------------------------------------------------------------
// Controller with fake DOM, fetch and timers
// ---------------------------------------------------------------------------

test("happy path: plan, consent required before the request, progress polling, outcome, close", async () => {
	const view = await serverPlanView();
	const steps = wizard.expectedSteps(view.actions.map((action: { id: string }) => action.id));
	let polls = 0;
	const ui = mount({
		"GET /api/progress": (call) => {
			polls += 1;
			if (call.url.endsWith("after=0") && polls === 1) return idleProgress();
			if (polls === 2) return [200, { entries: [{ seq: 1, step: steps[0], status: "done", reason: null }], running: true, outcome: null }];
			if (polls === 3) return [200, { entries: [], running: true, outcome: null }];
			return [200, { entries: steps.slice(1).map((step: string, index: number) => ({ seq: index + 2, step, status: "done", reason: null })),
				running: false, outcome: { outcome: "terminal-action-required", action: "open-new-terminal", completed: steps,
					guidance: guidance.outcomes["terminal-action-required"] } }];
		},
		"GET /api/plan": () => [200, view],
		"POST /api/install": () => [202, { started: true }],
		"POST /api/shutdown": () => [200, { closing: true }],
	});
	await ui.app.start();
	await flush();
	assert.equal(headings(ui.view).length, 1);
	assert.match(headings(ui.view)[0].textContent, /review/i);
	assert.equal(ui.document.activeElement, headings(ui.view)[0], "focus moves to the new step heading");
	assert.ok(ui.view.textContent.includes(plain(view.profileChange.description)));
	assert.ok(ui.view.textContent.includes(plain(view.persistence.description)));
	for (const call of ui.server.calls) assert.equal(call.headers["X-Gentle-Install"], "1");

	const install = button(ui.view, "Install") as FakeElement;
	const consent = all(ui.view, "input").find((input) => input.getAttribute("type") === "checkbox") as FakeElement;
	assert.ok(consent && install);
	assert.ok(all(ui.view, "label").some((label) => label.getAttribute("for") === consent.getAttribute("id")), "consent is labelled");
	dispatch(install, "click");
	await flush();
	assert.equal(ui.server.calls.filter((call) => call.method === "POST").length, 0, "no install request without consent");
	assert.ok(ui.alert.textContent.length > 0, "assertive error explains why");
	assert.equal(ui.document.activeElement, consent);

	consent.checked = true;
	dispatch(consent, "change");
	dispatch(install, "click");
	await flush();
	const posted = ui.server.calls.filter((call) => call.method === "POST");
	assert.equal(posted.length, 1);
	assert.deepEqual(posted[0].body, { planId: view.planId, consent: true });
	assert.equal(posted[0].headers["Content-Type"], "application/json");
	assert.equal(ui.alert.textContent, "", "the consent error clears");
	assert.match(headings(ui.view)[0].textContent, /installing/i);
	assert.equal(ui.document.activeElement, headings(ui.view)[0]);
	assert.equal(all(ui.view, "progress").length, 1);

	const first = await ui.timers.runNext();
	assert.equal(first.ms, 500, "the first poll is scheduled at the initial delay");
	assert.ok(ui.status.textContent.length > 0, "polite progress announcement");
	assert.match(ui.server.calls.at(-1)?.url ?? "", /after=0$/);
	const second = await ui.timers.runNext();
	assert.match(ui.server.calls.at(-1)?.url ?? "", /after=1$/);
	assert.equal(second.ms, 500, "news keeps the initial delay");
	const third = await ui.timers.runNext();
	assert.equal(third.ms, 750, "a quiet poll backs off by 1.5x");
	assert.equal(ui.timers.pending().length, 0, "polling stops on the final outcome");
	assert.match(headings(ui.view)[0].textContent, /new terminal/i);
	assert.ok(ui.view.textContent.includes("gentle-shell"));
	assert.equal(ui.document.activeElement, headings(ui.view)[0]);

	dispatch(button(ui.view, "Close installer") as FakeElement, "click");
	await flush();
	assert.deepEqual(ui.server.calls.at(-1)?.body, {});
	assert.match(headings(ui.view)[0].textContent, /closed/i);
	assert.match(ui.status.textContent, /installer closed/i, "the live region announces the closed state");
	assert.doesNotMatch(ui.status.textContent, /new terminal|ready/i);
});

test("409 plan-changed reloads the plan and requires consent again", async () => {
	const first = await serverPlanView({ globalBin: { ...cleanInventory.globalBin, onPath: true } });
	const second = await serverPlanView();
	let plans = 0;
	let installs = 0;
	const ui = mount({
		"GET /api/progress": idleProgress,
		"GET /api/plan": () => [200, plans++ === 0 ? first : second],
		"POST /api/install": () => (installs++ === 0 ? [409, { error: "plan-changed" }] : [202, { started: true }]),
	});
	await ui.app.start();
	await flush();
	let consent = all(ui.view, "input").find((input) => input.getAttribute("type") === "checkbox") as FakeElement;
	consent.checked = true;
	dispatch(button(ui.view, "Install") as FakeElement, "click");
	await flush();
	assert.equal(plans, 2, "the plan was reloaded");
	assert.match(ui.alert.textContent, /changed/i);
	assert.match(headings(ui.view)[0].textContent, /review/i);
	consent = all(ui.view, "input").find((input) => input.getAttribute("type") === "checkbox") as FakeElement;
	assert.equal(consent.checked, false, "consent must be given again");
	assert.ok(ui.view.textContent.includes(plain(second.profileChange.description)));
	dispatch(button(ui.view, "Install") as FakeElement, "click");
	await flush();
	assert.equal(installs, 1, "no request until consent is given again");
	consent.checked = true;
	dispatch(button(ui.view, "Install") as FakeElement, "click");
	await flush();
	assert.equal(installs, 2);
	assert.deepEqual(ui.server.calls.filter((call) => call.method === "POST").at(-1)?.body, { planId: second.planId, consent: true });
});

test("start resumes a running installation or shows a finished outcome instead of a new plan", async () => {
	const running = mount({ "GET /api/progress": () => [200, { entries: [{ seq: 1, step: "check-npm", status: "done", reason: null }], running: true,
		outcome: null }] });
	await running.app.start();
	await flush();
	assert.match(headings(running.view)[0].textContent, /installing/i);
	assert.ok(running.timers.pending().length === 1);
	assert.ok(!running.server.calls.some((call) => call.url === "/api/plan"));

	const finished = mount({ "GET /api/progress": () => [200, { entries: [], running: false, outcome: { outcome: "failed", failedStep: "install-global",
		completed: [], guidance: guidance.failed["install-global"] } }] });
	await finished.app.start();
	await flush();
	assert.match(headings(finished.view)[0].textContent, /failed/i);
	assert.ok(finished.view.textContent.includes(plain(guidance.failed["install-global"])));
	assert.equal(finished.timers.pending().length, 0);
	// The stage bar says in text, not only color, that installation stopped.
	const stagesRoot = finished.document.roots.get("stages") as FakeElement;
	assert.match(stagesRoot.textContent, /Install \(stopped\)/);
	assert.equal(all(stagesRoot, "li").filter((item) => item.getAttribute("aria-current") === "step").length, 1);
	assert.doesNotMatch((running.document.roots.get("stages") as FakeElement).textContent, /stopped/);
});

test("network errors show an assertive message with a working retry; repeated poll errors stop polling", async () => {
	let failPlan = true;
	const view = await serverPlanView();
	const ui = mount({
		"GET /api/progress": idleProgress,
		"GET /api/plan": () => (failPlan ? new TypeError("Failed to fetch") : [200, view]),
	});
	await ui.app.start();
	await flush();
	assert.ok(ui.alert.textContent.length > 0);
	const retry = button(ui.alert, "Try again") ?? button(ui.view, "Try again");
	assert.ok(retry, "retry control");
	failPlan = false;
	dispatch(retry as FakeElement, "click");
	await flush();
	assert.match(headings(ui.view)[0].textContent, /review/i);
	assert.equal(ui.alert.textContent, "");

	let progressCalls = 0;
	const stalled = mount({ "GET /api/progress": () => (progressCalls++ === 0 ? [200, { entries: [], running: true, outcome: null }]
		: new TypeError("Failed to fetch")) });
	await stalled.app.start();
	await flush();
	for (let i = 0; i < wizard.pollPolicy.maxFailures; i += 1) await stalled.timers.runNext();
	assert.equal(stalled.timers.pending().length, 0, "bounded: polling stops after repeated errors");
	assert.ok(stalled.alert.textContent.length > 0);
	assert.ok(button(stalled.alert, "Try again") ?? button(stalled.view, "Try again"));
});

test("an expired session explains how to restart instead of retrying forever", async () => {
	const ui = mount({ "GET /api/progress": () => [401, { error: "unauthorized" }] });
	await ui.app.start();
	await flush();
	assert.match(ui.alert.textContent + ui.view.textContent, /run the installer again/i);
	assert.equal(ui.timers.pending().length, 0);
});

// ---------------------------------------------------------------------------
// Preview script: the real host with fake scenarios, never real probes or installs
// ---------------------------------------------------------------------------

test("every preview scenario runs end to end on the real host with fake plans and steps", async () => {
	assert.deepEqual([...scenarioNames].sort(), ["blocked", "failed", "plan-changed", "preflight", "ready", "recovery", "terminal"]);
	const expected: Record<string, string | null> = { ready: "ready", terminal: "terminal-action-required", blocked: "blocked", failed: "failed",
		"plan-changed": "ready", preflight: null, recovery: "terminal-action-required" };
	for (const scenario of scenarioNames) {
		const { host, url } = await startPreview({ scenario, stepMs: 0, log: () => {} });
		const port = Number(new URL(url).port);
		try {
			const cookie = await login(port, url);
			let { body: plan } = await getJson(port, "/api/plan", cookie);
			// The recovery plan only completes setup; its fake steps match the runner's recovery order.
			if (scenario === "recovery") assert.equal(wizard.planModel(plan).kind, "recovery");
			if (expected[scenario] === null) {
				assert.equal(plan.blockers.length > 0, true, scenario);
				continue;
			}
			let response = await post(port, "/api/install", cookie, { planId: plan.planId, consent: true });
			if (scenario === "plan-changed") {
				assert.equal(response.status, 409);
				assert.equal(JSON.parse(response.body).error, "plan-changed");
				({ body: plan } = await getJson(port, "/api/plan", cookie));
				response = await post(port, "/api/install", cookie, { planId: plan.planId, consent: true });
			}
			assert.equal(response.status, 202, scenario);
			let progress = { outcome: null as null | { outcome: string } };
			for (let i = 0; i < 200 && progress.outcome === null; i += 1) {
				({ body: progress } = await getJson(port, "/api/progress?after=0", cookie));
				if (progress.outcome === null) await new Promise((done) => setTimeout(done, 5));
			}
			assert.equal(progress.outcome?.outcome, expected[scenario], scenario);
		} finally {
			await host.close("test");
		}
	}
});

test("a network failure on the install request checks progress once before offering a retry", async () => {
	const view = await serverPlanView();
	const failingPost = () => new TypeError("Failed to fetch");
	const answers = (later: () => Reply) => {
		let calls = 0;
		return () => (calls++ === 0 ? idleProgress() : later());
	};

	// The request reached the host, which is now installing: show progress, never re-send the install.
	const started = mount({ "GET /api/progress": answers(() => [200, { entries: [{ seq: 1, step: "check-npm", status: "done", reason: null }],
		running: true, outcome: null }]), "GET /api/plan": () => [200, view], "POST /api/install": failingPost });
	await started.app.start();
	await flush();
	await consentAndInstall(started);
	assert.match(headings(started.view)[0].textContent, /installing/i);
	assert.equal(started.alert.textContent, "");
	assert.deepEqual([posts(started, "/api/install"), progressChecks(started)], [1, 2]);
	assert.equal(started.timers.pending().length, 1, "polling continues");

	// The installation already finished: show its outcome.
	const finished = mount({ "GET /api/progress": answers(() => outcomeProgress({ outcome: "failed", failedStep: "install-global", completed: [],
		guidance: guidance.failed["install-global"] })), "GET /api/plan": () => [200, view], "POST /api/install": failingPost });
	await finished.app.start();
	await flush();
	await consentAndInstall(finished);
	assert.match(headings(finished.view)[0].textContent, /failed/i);
	assert.equal(finished.alert.textContent, "");

	// Nothing started, or the host does not answer either: stay on the plan with an error and a usable Install button.
	for (const later of [idleProgress, () => new TypeError("Failed to fetch") as Reply]) {
		const idle = mount({ "GET /api/progress": answers(later), "GET /api/plan": () => [200, view], "POST /api/install": failingPost });
		await idle.app.start();
		await flush();
		await consentAndInstall(idle);
		assert.match(headings(idle.view)[0].textContent, /review/i);
		assert.match(idle.alert.textContent, /did not answer/i);
		assert.equal((button(idle.view, "Install") as FakeElement).disabled, false);
		assert.deepEqual([posts(idle, "/api/install"), progressChecks(idle)], [1, 2], "exactly one progress check");
		assert.equal(idle.timers.pending().length, 0);
	}
});

test("install answers already-completed and install-running resume the host's current state", async () => {
	const view = await serverPlanView();
	let checks = 0;
	const completed = mount({
		"GET /api/progress": () => (checks++ === 0 ? idleProgress() : outcomeProgress(readyOutcome)),
		"GET /api/plan": () => [200, view],
		"POST /api/install": () => [409, { error: "already-completed" }],
	});
	await completed.app.start();
	await flush();
	await consentAndInstall(completed);
	assert.match(headings(completed.view)[0].textContent, /ready/i);
	assert.equal(completed.alert.textContent, "");
	assert.equal(completed.timers.pending().length, 0);

	const running = mount({
		"GET /api/progress": idleProgress,
		"GET /api/plan": () => [200, view],
		"POST /api/install": () => [409, { error: "install-running" }],
	});
	await running.app.start();
	await flush();
	await consentAndInstall(running);
	assert.match(headings(running.view)[0].textContent, /installing/i);
	assert.equal(running.alert.textContent, "");
	assert.equal(running.timers.pending().length, 1, "polls the running installation");
	assert.equal(posts(running, "/api/install"), 1);
});

test("closing while the host still installs keeps the outcome screen and explains why", async () => {
	const ui = mount({
		"GET /api/progress": () => outcomeProgress({ outcome: "failed", failedStep: "shell-setup", completed: [], guidance: guidance.failed["shell-setup"] }),
		"POST /api/shutdown": () => [409, { error: "install-running" }],
	});
	await ui.app.start();
	await flush();
	dispatch(button(ui.view, "Close installer") as FakeElement, "click");
	await flush();
	assert.match(ui.alert.textContent, /still running/i);
	assert.match(headings(ui.view)[0].textContent, /failed/i);
	assert.ok(button(ui.view, "Close installer"), "close stays available");
});

test("Copy writes the command through the injected clipboard and reports success or failure", async () => {
	const writes: string[] = [];
	const ok = mount({ "GET /api/progress": () => outcomeProgress(readyOutcome) }, { clipboard: { writeText: async (value) => {
		writes.push(value);
	} } });
	await ok.app.start();
	await flush();
	const copy = button(ok.view, "Copy") as FakeElement;
	dispatch(copy, "click");
	await flush();
	assert.deepEqual(writes, ["gentle-shell"]);
	assert.equal(copy.textContent, "Copied");
	assert.equal(ok.status.textContent, "Command copied.");

	const denied = mount({ "GET /api/progress": () => outcomeProgress(readyOutcome) }, { clipboard: { writeText: async () => {
		throw new Error("denied");
	} } });
	await denied.app.start();
	await flush();
	const failing = button(denied.view, "Copy") as FakeElement;
	dispatch(failing, "click");
	await flush();
	assert.equal(failing.textContent, "Copy failed");
	assert.notEqual(denied.status.textContent, "Command copied.");

	const none = mount({ "GET /api/progress": () => outcomeProgress(readyOutcome) });
	await none.app.start();
	await flush();
	assert.equal(button(none.view, "Copy"), undefined, "no clipboard, no Copy button");
	assert.ok(none.view.textContent.includes("gentle-shell"), "the command is still shown");
});

test("the PNPM_HOME blocker and the private PNPM_HOME step have labels", () => {
	const model = wizard.planModel({ planId: "p", ready: false, actions: [], blockers: [{ code: "untrusted-pnpm-home", tool: "pnpmHome", guidance: "g" }],
		profileChange: { changesProfile: false, binDir: null, description: "x" }, persistence: { tools: [], pnpmHome: null, description: "y" } });
	assert.equal(model.blockers[0].toolLabel, "pnpm home folder");
	assert.equal(wizard.stepLabel("prepare-pnpm-home"), "Create the private pnpm folder");
});

// T1c: the bundled install's progress list, review copy and outcomes.
const bundledIds = ["bundled-prefix", "bundled-runtime", "bundled-version", "bundled-activate", "bundled-path", "bundled-setup"];
test("expectedSteps mirrors runBundledInstall's step order, and every bundled step has a label", async () => {
	const steps = ["claim-prefix", "copy-npm-settings", "install-runtime", "install-version", "activate-version", "write-launcher", "bundled-path", "shell-setup"];
	assert.deepEqual(wizard.expectedSteps(bundledIds), steps);
	assert.deepEqual(wizard.expectedSteps(bundledIds.filter((id) => id !== "bundled-path")), steps.filter((id) => id !== "bundled-path"));
	assert.deepEqual([...bundledFailedSteps], steps);
	for (const id of steps) assert.notEqual(wizard.stepLabel(id), id, `label for ${id}`);
	// The runner logs exactly that order.
	const layout = prefixLayout({ platform: "linux", env: {}, home: "/home/u" });
	const distribution = { status: "published", manifest: { shell: "4.1.0", pi: "1.0.2" }, lockfile: "lock" };
	const path = { kind: "profile", path: "/home/u/.bashrc", line: "export PATH=x # gentle-shell bundled install", create: false };
	const plan = bundledPlan({ platform: "linux", distribution, layout, path });
	const logged: string[] = [];
	const operations = { claimPrefix: () => layout, userNpmrc: () => "", writeNpmrcAuth: () => {}, ensureRuntime: async () => ({ go: null }), installVersion: async () => ({}),
		activateVersion: () => {}, ensureLauncher: () => {}, pathEntryPlan: () => path, applyPathEntry: () => {}, run: async () => ({ status: 0 }) };
	await runBundledInstall({ plan, consent: true }, { platform: "linux", arch: "x64", env: {}, home: "/home/u", distribution, operations,
		log: (entry: { step: string }) => logged.push(entry.step) });
	assert.deepEqual(logged, wizard.expectedSteps(plan.actions.map((action: { id: string }) => action.id)));
});

test("planModel and renderPlan present the bundled install as one self-contained product", () => {
	const view = { planId: "p", ready: false, bundled: true, channel: "release", blockers: [],
		actions: bundledIds.map((id) => ({ id, description: `${id} text` })),
		profileChange: { changesProfile: true, command: null, binDir: "/home/u/.gentle-shell/bin", description: "adds one line" },
		persistence: { tools: ["node", "npm", "pnpm"], pnpmHome: "/home/u/.gentle-shell", description: "Your own Node.js, npm, pnpm, Go and Pi are not used or changed." } };
	const model = wizard.planModel(view);
	assert.equal(model.kind, "bundled");
	const runtimes = model.disclosures.find((item: { id: string }) => item.id === "persistence");
	assert.equal(runtimes.title, "Gentle Shell's own runtimes");
	assert.equal(runtimes.state, "Uses its own node, npm, pnpm");
	assert.equal(runtimes.detail, "/home/u/.gentle-shell");
	assert.deepEqual(model.steps, wizard.expectedSteps(bundledIds));
	const node = wizard.renderPlan(new FakeDocument(), model, { install() {}, reload() {}, close() {} });
	assert.match(node.textContent, /Install Gentle Shell as one self-contained product/);
	assert.match(node.textContent, /your own Node\.js, npm, pnpm, Go and Pi are not used or changed/i);
	assert.match(node.textContent, /Install Gentle Shell/);
});

test("outcomeModel gives the PATH line to add when the bundled install may not edit the profile", () => {
	const line = 'export PATH="/home/u/.gentle-shell/bin:$PATH" # gentle-shell bundled install';
	const model = wizard.outcomeModel({ outcome: "terminal-action-required", action: "add-path-line", pathLine: { file: "/home/u/.zshrc", line },
		completed: ["claim-prefix"], guidance: guidance.outcomes["add-path-line"] });
	assert.equal(model.tone, "success");
	assert.equal(model.title, "Add Gentle Shell to your PATH");
	assert.equal(model.command, line);
	assert.ok(model.next.some((text: string) => text.includes("/home/u/.zshrc")));
	assert.ok(model.next.some((text: string) => /open a new terminal/i.test(text)));
	assert.equal(wizard.outcomeModel({ outcome: "failed", failedStep: "install-version", completed: [], guidance: "g", detail: "ERR_PNPM_FETCH_401" }).detailCommand,
		"pnpm install");
});
