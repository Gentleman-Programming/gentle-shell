import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { TuiMainScreen, type Component, type Terminal, type TUI } from "@earendil-works/pi-tui";
import askUserChoice from "../extensions/ask-user-choice.ts";
import askUserQuestion from "../extensions/ask-user-question.ts";
import { holdOverlayKeyboard, pendingAgentPrompt, restorePendingAgentPrompt, setPendingAgentPrompt } from "../lib/prompt-keyboard-ownership.ts";

// Keyboard ownership between an open overlay (the command palette) and the
// agent prompt Pi mounts below it in the editor slot. The tests assert what
// the user can observe: which component receives a key, and which component
// holds the keyboard afterwards.

const DOWN = "\x1b[B";

afterEach(() => setPendingAgentPrompt(undefined));

/** A component that records every key it receives. */
class RecordingComponent implements Component {
	readonly received: string[] = [];

	render(_width: number): string[] {
		return [];
	}

	invalidate(): void {}

	handleInput(data: string): void {
		this.received.push(data);
	}
}

/**
 * A minimal stand-in for a pi-tui screen: a focus model plus input
 * listeners. `press` mirrors the real dispatch order — listeners first, then
 * the focused component.
 */
class FakeScreen {
	terminal = { rows: 24, columns: 80 };
	private focused: Component | null = null;
	private readonly listeners = new Set<(data: string) => unknown>();

	getFocusedComponent(): Component | null {
		return this.focused;
	}

	setFocus(component: Component | null): void {
		this.focused = component;
	}

	addInputListener(listener: (data: string) => unknown): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	removeInputListener(listener: (data: string) => unknown): void {
		this.listeners.delete(listener);
	}

	press(data: string): void {
		for (const listener of [...this.listeners]) listener(data);
		this.focused?.handleInput?.(data);
	}

	get listenerCount(): number {
		return this.listeners.size;
	}
}

/** A fake terminal that feeds keys back to the screen under test. */
class FakeTerminal implements Terminal {
	private onInput: ((data: string) => void) | undefined;

	start(onInput: (data: string) => void): void {
		this.onInput = onInput;
	}

	stop(): void {
		this.onInput = undefined;
	}

	write(): void {}

	async drainInput(): Promise<void> {}

	get columns(): number {
		return 80;
	}

	get rows(): number {
		return 24;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	moveBy(): void {}

	hideCursor(): void {}

	showCursor(): void {}

	clearLine(): void {}

	clearFromCursor(): void {}

	clearScreen(): void {}

	setTitle(): void {}

	setProgress(): void {}

	setProgramStatus(): void {}

	reportProgramStatus(): void {}

	feed(data: string): void {
		this.onInput?.(data);
	}
}

test("holdOverlayKeyboard hands the key to the overlay when the pending agent prompt holds the focus", () => {
	const screen = new FakeScreen();
	const tui = screen as unknown as TUI;
	const prompt = new RecordingComponent();
	const overlay = new RecordingComponent();
	screen.setFocus(prompt);
	setPendingAgentPrompt(prompt);
	let focusCalls = 0;
	const release = holdOverlayKeyboard({
		tui,
		focusOverlay: () => {
			focusCalls += 1;
			screen.setFocus(overlay);
		},
	});

	screen.press(DOWN);

	assert.equal(focusCalls, 1, "the overlay re-asserts its focus");
	assert.deepEqual(overlay.received, [DOWN], "the visible overlay receives the key");
	assert.deepEqual(prompt.received, [], "the hidden prompt below it receives nothing");
	release();
	assert.equal(screen.listenerCount, 0, "the release unsubscribes the input listener");
});

test("holdOverlayKeyboard leaves the keyboard alone when something else holds the focus", () => {
	const screen = new FakeScreen();
	const tui = screen as unknown as TUI;
	const prompt = new RecordingComponent();
	const other = new RecordingComponent();
	screen.setFocus(other);
	setPendingAgentPrompt(prompt);
	let focusCalls = 0;
	const release = holdOverlayKeyboard({
		tui,
		focusOverlay: () => {
			focusCalls += 1;
		},
	});

	screen.press(DOWN);

	assert.equal(focusCalls, 0, "no overlay focus is forced for an unrelated component");
	assert.deepEqual(other.received, [DOWN]);
	assert.deepEqual(prompt.received, []);
	release();
});

test("holdOverlayKeyboard does nothing while no agent prompt is pending", () => {
	const screen = new FakeScreen();
	const tui = screen as unknown as TUI;
	const overlay = new RecordingComponent();
	screen.setFocus(overlay);
	let focusCalls = 0;
	const release = holdOverlayKeyboard({
		tui,
		focusOverlay: () => {
			focusCalls += 1;
		},
	});

	screen.press(DOWN);

	assert.equal(focusCalls, 0);
	assert.deepEqual(overlay.received, [DOWN]);
	release();
});

test("restorePendingAgentPrompt hands the keyboard back to the pending prompt", () => {
	const screen = new FakeScreen();
	const tui = screen as unknown as TUI;
	const prompt = new RecordingComponent();
	setPendingAgentPrompt(prompt);

	restorePendingAgentPrompt(tui);

	assert.equal(screen.getFocusedComponent(), prompt);
});

test("restorePendingAgentPrompt is a no-op without a pending prompt", () => {
	const screen = new FakeScreen();
	const tui = screen as unknown as TUI;
	const other = new RecordingComponent();
	screen.setFocus(other);
	setPendingAgentPrompt(undefined);

	restorePendingAgentPrompt(tui);

	assert.equal(screen.getFocusedComponent(), other, "the current focus is untouched");
});

test("restorePendingAgentPrompt keeps a prompt that already holds the keyboard", () => {
	const screen = new FakeScreen();
	const tui = screen as unknown as TUI;
	const prompt = new RecordingComponent();
	screen.setFocus(prompt);
	setPendingAgentPrompt(prompt);

	restorePendingAgentPrompt(tui);

	assert.equal(screen.getFocusedComponent(), prompt);
});

test("the real pi-tui routes keys to the overlay while a pending prompt holds the focus", (t) => {
	const terminal = new FakeTerminal();
	const tui = new TuiMainScreen(terminal);
	tui.start();
	t.after(() => {
		tui.stop();
	});
	const overlay = new RecordingComponent();
	const prompt = new RecordingComponent();
	const handle = tui.showOverlay(overlay);
	// What Pi's pushExtensionDialog does when the prompt arrives: the prompt
	// is mounted in the editor slot and takes the keyboard.
	tui.setFocus(prompt);
	setPendingAgentPrompt(prompt);
	const release = holdOverlayKeyboard({ tui, focusOverlay: () => handle.focus() });

	terminal.feed(DOWN);

	assert.deepEqual(overlay.received, [DOWN], "the visible overlay receives the arrow key");
	assert.deepEqual(prompt.received, [], "the prompt below the overlay receives nothing");

	// The palette closes: the overlay hands back its stale pre-focus, and the
	// prompt that waited below it gets the keyboard.
	handle.hide();
	release();
	restorePendingAgentPrompt(tui);

	terminal.feed(DOWN);

	assert.deepEqual(prompt.received, [DOWN], "the prompt receives the key once the overlay is gone");
	assert.deepEqual(overlay.received, [DOWN], "the closed overlay receives nothing");
});

/** The minimal Pi surface the prompt tools need to mount their prompt. */
const promptTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function registerTool(extension: (pi: never) => void): { execute: (...args: unknown[]) => Promise<unknown> } {
	let tool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
	const pi = {
		registerTool: (candidate: { execute: (...args: unknown[]) => Promise<unknown> }) => { tool = candidate; },
		on: () => {},
		events: { emit: () => {} },
		getActiveTools: () => [],
		setActiveTools: () => {},
	};
	extension(pi as never);
	if (!tool) throw new Error("the tool must register");
	return tool;
}

/**
 * A fake `ctx.ui.custom` that mounts the prompt and records what the prompt
 * registered as its pending prompt, at mount time.
 */
function mountingContext(mounted: { component?: Component; registeredAtMount?: Component | undefined }) {
	return {
		mode: "tui",
		hasUI: true,
		ui: {
			custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => Component) => {
				const component = factory({ requestRender() {} }, promptTheme, {}, () => {});
				mounted.component = component;
				mounted.registeredAtMount = pendingAgentPrompt();
				return undefined;
			},
		},
	};
}

test("the ask_user_choice prompt registers itself as the pending prompt and clears it when it closes", async () => {
	const tool = registerTool(askUserChoice);
	const mounted: { component?: Component; registeredAtMount?: Component | undefined } = {};

	await tool.execute(
		"call",
		{
			question: "Pick one",
			options: [
				{ label: "First", description: "The first option.", value: "first" },
				{ label: "Second", description: "The second option.", value: "second" },
			],
		},
		new AbortController().signal,
		undefined,
		mountingContext(mounted),
	);

	assert.ok(mounted.component, "the prompt was mounted");
	assert.equal(mounted.registeredAtMount, mounted.component, "the prompt is registered before Pi focuses it");
	assert.equal(pendingAgentPrompt(), undefined, "the registration is cleared when the prompt closes");
});

test("the ask_user_question prompt registers itself as the pending prompt and clears it when it closes", async () => {
	const tool = registerTool(askUserQuestion);
	const mounted: { component?: Component; registeredAtMount?: Component | undefined } = {};

	await tool.execute(
		"call",
		{
			questions: [
				{
					header: "Scope",
					question: "Which scope?",
					options: [
						{ label: "First", description: "The first option." },
						{ label: "Second", description: "The second option." },
					],
				},
			],
		},
		new AbortController().signal,
		undefined,
		mountingContext(mounted),
	);

	assert.ok(mounted.component, "the prompt was mounted");
	assert.equal(mounted.registeredAtMount, mounted.component, "the prompt is registered before Pi focuses it");
	assert.equal(pendingAgentPrompt(), undefined, "the registration is cleared when the prompt closes");
});
