import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import installDrakoncShell from "../extensions/drakonc-shell.ts";
import { LEGACY_USAGE_SOURCE_EVENT, LEGACY_USAGE_SOURCE_SCHEMA, SUPPORTED_USAGE_PROVIDERS, USAGE_SOURCE_EVENT, USAGE_SOURCE_SCHEMA } from "../lib/shell-usage.ts";
import type { ShellBarTheme } from "../lib/shell-bar.ts";

// El contrato de fuentes de uso cruza el bus `pi.events` con dos nombres: el
// propio y el heredado. Estas pruebas arrancan la extension real y emiten por
// el bus, porque el emparejamiento evento/esquema y el rechazo de proveedores
// integrados viven en la suscripcion, no en el parser.

initTheme("dark");

const configHomes: string[] = [];
after(() => {
	for (const home of configHomes) rmSync(home, { recursive: true, force: true });
});

function isolatedEnv(env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const home = mkdtempSync(join(tmpdir(), "drakonc-shell-usage-events-"));
	configHomes.push(home);
	return { DRAKONC_PI_SHELL_CHANGES_WATCH_MS: "off", DRAKONC_PI_CONFIG_HOME: home, ...env };
}

const plainTheme = {
	fg(_color: string, value: string) {
		return value;
	},
	bold(value: string) {
		return value;
	},
	bg(_color: string, value: string) {
		return value;
	},
	getBgAnsi() {
		return "";
	},
} as unknown as ShellBarTheme;

const fakeTui = { terminal: { rows: 40, columns: 120 }, requestRender() {} };
const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1, onBranchChange: () => () => {} };

interface FakeUi {
	footerFactory: unknown;
	notices: string[];
}

interface FakePi {
	pi: ExtensionAPI;
	handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
	emit(name: string, payload: unknown): void;
}

function fakePi(): FakePi {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const listeners = new Map<string, (data: unknown) => void>();
	const pi = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		appendEntry() {},
		events: {
			on(name: string, fn: (data: unknown) => void) {
				listeners.set(name, fn);
				return () => listeners.delete(name);
			},
			emit(name: string, data: unknown) {
				listeners.get(name)?.(data);
			},
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		getThinkingLevel() {
			return "medium";
		},
		getCommands() {
			return [];
		},
		sendUserMessage() {},
		async exec() {
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, emit: (name, payload) => listeners.get(name)?.(payload) };
}

function fakeContext(ui: FakeUi, provider: string, token: string | undefined): ExtensionContext {
	return {
		hasUI: true,
		mode: "tui",
		hasPendingMessages: () => false,
		isIdle: () => true,
		cwd: "/repo",
		model: { id: "go-model", provider, reasoning: false, contextWindow: 200_000 },
		sessionManager: {
			getCwd: () => "/repo",
			getSessionName: () => "session",
			getEntries: () => [],
			getSessionId: () => "usage-session",
		},
		modelRegistry: { isUsingOAuth: () => true, getApiKeyForProvider: async () => token },
		getContextUsage: () => ({ tokens: 0, contextWindow: 200_000, percent: 0 }),
		ui: {
			theme: plainTheme,
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false }),
			setFooter(factory: unknown) {
				ui.footerFactory = factory;
			},
			setEditorComponent() {},
			getEditorComponent() {
				return undefined;
			},
			setWidget() {},
			notify(message: string) {
				ui.notices.push(message);
			},
			setWorkingVisible() {},
		},
	} as unknown as ExtensionContext;
}

async function fire(handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>, event: string, ctx: ExtensionContext): Promise<void> {
	for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
}

function renderFooter(ui: FakeUi): string {
	const factory = ui.footerFactory as (tui: unknown, theme: ShellBarTheme, data: unknown) => { render(width: number): string[] };
	return factory(fakeTui, plainTheme, footerData).render(200)[0];
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// Una fuente de OpenCode Go simulada: las tres ventanas que publica el paquete
// de terceros, con los porcentajes del escenario de la especificacion.
function opencodeGoSource(schema: string, onFetch: (apiKey: string | undefined) => void = () => {}): unknown {
	return {
		schema,
		provider: "opencode-go",
		fetch: async (apiKey: string | undefined, _fetchFn: typeof fetch, now: number) => {
			onFetch(apiKey);
			return {
				provider: "opencode-go",
				plan: undefined,
				fetchedAt: now,
				limits: [{
					name: "opencode-go",
					limitReached: false,
					windows: [
						{ label: "5h", usedPercent: 0, windowSeconds: 18_000, resetAt: null },
						{ label: "week", usedPercent: 11, windowSeconds: 604_800, resetAt: null },
						{ label: "30d", usedPercent: 5, windowSeconds: 2_592_000, resetAt: null },
					],
				}],
			};
		},
	};
}

test("the legacy event registers an opencode-go source and the bar draws its three windows", async () => {
	const { pi, handlers, emit } = fakePi();
	const ui: FakeUi = { footerFactory: undefined, notices: [] };
	installDrakoncShell(pi, isolatedEnv(), { now: () => 1_788_600_000_000 });
	const seen: Array<string | undefined> = [];
	emit(LEGACY_USAGE_SOURCE_EVENT, opencodeGoSource(LEGACY_USAGE_SOURCE_SCHEMA, (apiKey) => seen.push(apiKey)));
	const ctx = fakeContext(ui, "opencode-go", "go-token");
	await fire(handlers, "session_start", ctx);
	await settle();
	assert.deepEqual(seen, ["go-token"], "la fuente registrada recibe la clave del proveedor activo");
	assert.match(renderFooter(ui), /opencode-go 5h ▱▱▱▱▱▱▱▱ 0% · week 11% · 30d 5%/);
});

test("the own event registers the same source and the bar draws the same windows", async () => {
	const { pi, handlers, emit } = fakePi();
	const ui: FakeUi = { footerFactory: undefined, notices: [] };
	installDrakoncShell(pi, isolatedEnv(), { now: () => 1_788_600_000_000 });
	emit(USAGE_SOURCE_EVENT, opencodeGoSource(USAGE_SOURCE_SCHEMA));
	const ctx = fakeContext(ui, "opencode-go", "go-token");
	await fire(handlers, "session_start", ctx);
	await settle();
	assert.match(renderFooter(ui), /opencode-go 5h ▱▱▱▱▱▱▱▱ 0% · week 11% · 30d 5%/);
});

test("a schema that belongs to the other event name is ignored", async () => {
	const { pi, handlers, emit } = fakePi();
	const ui: FakeUi = { footerFactory: undefined, notices: [] };
	installDrakoncShell(pi, isolatedEnv(), { now: () => 1_788_600_000_000 });
	let calls = 0;
	emit(LEGACY_USAGE_SOURCE_EVENT, opencodeGoSource(USAGE_SOURCE_SCHEMA, () => { calls += 1; }));
	emit(USAGE_SOURCE_EVENT, opencodeGoSource(LEGACY_USAGE_SOURCE_SCHEMA, () => { calls += 1; }));
	const ctx = fakeContext(ui, "opencode-go", "go-token");
	await fire(handlers, "session_start", ctx);
	await settle();
	assert.equal(calls, 0, "un esquema cruzado nunca llega a ejecutar fetch");
	assert.doesNotMatch(renderFooter(ui), /5h|week|30d/, "sin fuente aceptada la barra no inventa ventanas");
});

test("a built-in provider cannot be replaced by either event, and the foreign fetch never sees the key", async () => {
	for (const [event, schema] of [[LEGACY_USAGE_SOURCE_EVENT, LEGACY_USAGE_SOURCE_SCHEMA], [USAGE_SOURCE_EVENT, USAGE_SOURCE_SCHEMA]] as const) {
		for (const provider of SUPPORTED_USAGE_PROVIDERS) {
			const { pi, handlers, emit } = fakePi();
			const ui: FakeUi = { footerFactory: undefined, notices: [] };
			installDrakoncShell(pi, isolatedEnv(), { now: () => 1_788_600_000_000 });
			const seen: Array<string | undefined> = [];
			emit(event, {
				schema,
				provider,
				fetch: async (apiKey: string | undefined) => {
					seen.push(apiKey);
					return undefined;
				},
			});
			const ctx = fakeContext(ui, provider, `${provider}-token`);
			await fire(handlers, "session_start", ctx);
			await settle();
			assert.deepEqual(seen, [], `${provider} por ${event}: la fuente ajena nunca recibe la clave`);
			assert.doesNotMatch(renderFooter(ui), new RegExp(`${provider} · fetch failed`), "el registro rechazado tampoco marca un fallo");
		}
	}
});
