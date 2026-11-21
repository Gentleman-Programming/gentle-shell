import { Container, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";

export interface NativeFullscreenMouseObserver {
	beforeMouse(event: TuiMouseEvent): void;
	afterMouse(event: TuiMouseEvent): void;
}

export interface NativeFullscreenInteractionOptions {
	keyboardTarget: Component;
	requestRender(): void;
	mouseObserver?: NativeFullscreenMouseObserver;
}

export class NativeFullscreenInteraction extends Container {
	private readonly options: NativeFullscreenInteractionOptions;

	constructor(options: NativeFullscreenInteractionOptions) {
		super();
		this.options = options;
	}

	handleInput(data: string): void {
		if (!this.options.keyboardTarget.handleInput) return;
		this.options.keyboardTarget.handleInput(data);
		this.options.requestRender();
	}

	override handleMouse(event: TuiMouseEvent) {
		// Newer pi-tui containers lay out children at event.width; a malformed
		// event without finite geometry cannot target anything, so ignore it.
		if (!Number.isFinite(event.width) || !Number.isFinite(event.height) || !Number.isFinite(event.y)) return undefined;
		this.options.mouseObserver?.beforeMouse(event);
		try {
			return super.handleMouse(event);
		} finally {
			this.options.mouseObserver?.afterMouse(event);
		}
	}
}

/**
 * Compose native Container mouse dispatch with one keyboard-owning control.
 * Optional observers run around native delegation without rewriting its result,
 * so native layout, targeting, focus, wheel, and click semantics stay intact.
 */
export function createNativeFullscreenInteraction(
	options: NativeFullscreenInteractionOptions,
): NativeFullscreenInteraction {
	return new NativeFullscreenInteraction(options);
}
