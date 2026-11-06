import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { createNativePointerScope } from "../lib/native-pointer-region.ts";

function mouse(
	type: TuiMouseEvent["type"], button: TuiMouseEvent["button"], y: number, height: number,
): TuiMouseEvent {
	return {
		type, button, x: 0, y, screenX: 0, screenY: y, width: 40, height,
		shift: false, alt: false, ctrl: false,
	};
}

function dispatch(
	root: Container,
	observer: ReturnType<ReturnType<typeof createNativePointerScope>["createMouseObserver"]>,
	event: TuiMouseEvent,
) {
	observer.beforeMouse(event);
	try {
		return root.handleMouse(event);
	} finally {
		observer.afterMouse(event);
	}
}

type PublicCustomFactory = Parameters<ExtensionContext["ui"]["custom"]>[0];
type PublicCustomOptions = NonNullable<Parameters<ExtensionContext["ui"]["custom"]>[1]>;

// Typed callback harness, not proof of physical terminal overlay UX.
async function mountOverlay(
	factory: PublicCustomFactory,
	options: PublicCustomOptions,
): Promise<Component & { dispose?(): void }> {
	assert.equal(options.overlay, true, "the public custom factory receives overlay mode");
	return factory(
		{} as Parameters<PublicCustomFactory>[0],
		{} as Parameters<PublicCustomFactory>[1],
		{} as Parameters<PublicCustomFactory>[2],
		() => {},
	);
}

test("pointer regions give a public Text hover, press, and click behavior without implicit focus", () => {
	const scope = createNativePointerScope();
	const calls: string[] = [];
	const region = scope.wrap(new Text("Open editor", 0, 0), {
		onHover: () => {
			calls.push("hover");
			return { handled: true, render: true };
		},
		onPress: () => {
			calls.push("press");
			return { handled: true };
		},
		onClick: () => {
			calls.push("click");
			return { handled: true };
		},
		onWheel: () => {
			calls.push("wheel");
			return { handled: true };
		},
	});
	const root = new Container();
	root.addChild(region);
	const height = root.render(40).length;
	const observer = scope.createMouseObserver();

	assert.equal(dispatch(root, observer, mouse("move", "none", 0, height))?.render, true);
	const press = dispatch(root, observer, mouse("press", "left", 0, height));
	assert.equal(press?.handled, true);
	assert.equal(press?.focus, undefined, "a Text region never claims keyboard focus by itself");
	assert.equal(dispatch(root, observer, mouse("click", "left", 0, height))?.handled, true);
	assert.equal(dispatch(root, observer, mouse("wheel", "none", 0, height))?.handled, true);
	assert.deepEqual(calls, ["hover", "press", "click", "wheel"]);
});

test("pointer scopes clear hover only through observed lifecycle boundaries", () => {
	const scope = createNativePointerScope();
	const states: string[] = [];
	const region = scope.wrap(new Text("Hover me", 0, 0), {
		onHover: () => {
			states.push("hover");
			return { handled: true, render: true };
		},
		onLeave: () => states.push("leave"),
	});
	const root = new Container();
	root.addChild(region);
	const observer = scope.createMouseObserver();
	const height = root.render(40).length;

	dispatch(root, observer, mouse("move", "none", 0, height));
	dispatch(root, observer, mouse("move", "none", height, height + 1));
	assert.deepEqual(states, ["hover", "leave"], "an in-root empty move clears hover");

	dispatch(root, observer, mouse("move", "none", 0, height));
	region.render(30);
	assert.deepEqual(states, ["hover", "leave", "hover", "leave"], "resize clears hover");

	dispatch(root, observer, mouse("move", "none", 0, height));
	region.invalidate();
	region.setDisabled(true);
	region.dispose();
	scope.dispose();
	dispatch(root, observer, mouse("move", "none", 0, height));
	assert.deepEqual(
		states,
		["hover", "leave", "hover", "leave", "hover", "leave"],
		"invalidate, disable, disposal, and late events cannot retain or restore hover",
	);
});

test("a consuming public Box child keeps its exact native target and focus without outer callbacks", () => {
	const scope = createNativePointerScope();
	let outerClicks = 0;
	const child: Component = {
		render: () => ["native child"],
		invalidate() {},
		handleMouse: () => ({ handled: true, focus: true, render: true }),
	};
	const box = new Box(0, 0);
	box.addChild(child);
	const region = scope.wrap(box, {
		onClick: () => {
			outerClicks++;
			return { handled: true };
		},
	});
	const root = new Container();
	root.addChild(region);
	const height = root.render(40).length;
	const result = dispatch(root, scope.createMouseObserver(), mouse("click", "left", 0, height));

	assert.equal(result?.target.component, child);
	assert.equal(result?.focusTarget, child);
	assert.equal(outerClicks, 0, "a consumed child prevents outer pointer callbacks");
});

test("the same composed region can open an input entry point without answering on press", () => {
	const scope = createNativePointerScope();
	let opened = 0;
	const panel = new Container();
	panel.addChild(scope.wrap(new Text("Open input", 0, 0), {
		onPress: () => ({ handled: true }),
		onClick: () => {
			opened++;
			return { handled: true };
		},
	}));
	const root = new Container();
	root.addChild(panel);
	const height = root.render(40).length;
	const observer = scope.createMouseObserver();

	assert.equal(dispatch(root, observer, mouse("press", "left", 0, height))?.handled, true);
	assert.equal(opened, 0, "press can prepare a control but cannot answer it");
	assert.equal(dispatch(root, observer, mouse("click", "left", 0, height))?.handled, true);
	assert.equal(opened, 1, "a caller-owned callback opens the input entry point");
});

test("a typed public custom overlay factory composes pointer content and disposes late events", async () => {
	let opened = 0;
	let leaves = 0;
	const component = await mountOverlay(() => {
		const scope = createNativePointerScope();
		const panel = new Container();
		panel.addChild(scope.wrap(new Text("Open overlay input", 0, 0), {
			onHover: () => ({ handled: true, render: true }),
			onLeave: () => { leaves++; },
			onClick: () => {
				opened++;
				return { handled: true };
			},
		}));
		const observer = scope.createMouseObserver();
		return {
			render: (width) => panel.render(width),
			handleMouse: (event) => {
				observer.beforeMouse(event);
				try {
					return panel.handleMouse(event);
				} finally {
					observer.afterMouse(event);
				}
			},
			invalidate: () => panel.invalidate(),
			dispose: () => scope.dispose(),
		};
	}, { overlay: true });
	const height = component.render(40).length;
	const hover = component.handleMouse?.(mouse("move", "none", 0, height));
	const click = component.handleMouse?.(mouse("click", "left", 0, height));

	assert.equal(hover?.render, true);
	assert.equal(click?.focus, undefined, "overlay content does not claim focus without a caller result");
	assert.equal(opened, 1, "the factory-returned component routes a native click to its callback");
	component.dispose?.();
	assert.equal(component.handleMouse?.(mouse("click", "left", 0, height)), undefined);
	assert.deepEqual([opened, leaves], [1, 1], "disposal clears hover and rejects late overlay events");
});

test("scopes apply disabled and disposed state to later Text regions", () => {
	const calls: string[] = [];
	const disabled = createNativePointerScope();
	disabled.setDisabled(true);
	const disabledRoot = new Container();
	disabledRoot.addChild(disabled.wrap(new Text("Disabled", 0, 0), {
		onClick: () => {
			calls.push("disabled");
			return { handled: true };
		},
	}));
	const disabledHeight = disabledRoot.render(40).length;
	const disabledClick = dispatch(
		disabledRoot, disabled.createMouseObserver(), mouse("click", "left", 0, disabledHeight),
	);
	disabled.setDisabled(false);
	const reenabledClick = dispatch(
		disabledRoot, disabled.createMouseObserver(), mouse("click", "left", 0, disabledHeight),
	);

	const disposed = createNativePointerScope();
	disposed.dispose();
	const disposedRoot = new Container();
	disposedRoot.addChild(disposed.wrap(new Text("Disposed", 0, 0), {
		onClick: () => {
			calls.push("disposed");
			return { handled: true };
		},
	}));
	const disposedHeight = disposedRoot.render(40).length;
	const disposedClick = dispatch(
		disposedRoot, disposed.createMouseObserver(), mouse("click", "left", 0, disposedHeight),
	);

	assert.deepEqual(
		[disabledClick?.handled, reenabledClick?.handled, disposedClick?.handled, calls],
		[undefined, true, undefined, ["disabled"]],
		"later regions inherit scope disable/disposal while a live scope can be re-enabled",
	);
});
