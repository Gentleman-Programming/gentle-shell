import {
	MouseRegion,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

export type NativePointerCallback = (event: TuiMouseEvent) => TuiMouseEventResult | undefined;

export interface NativePointerRegionCallbacks {
	onHover?: NativePointerCallback;
	onLeave?: (event?: TuiMouseEvent) => void;
	onPress?: NativePointerCallback;
	onClick?: NativePointerCallback;
	onWheel?: NativePointerCallback;
}

export interface NativePointerMouseObserver {
	beforeMouse(event: TuiMouseEvent): void;
	afterMouse(event: TuiMouseEvent): void;
}

/**
 * A composable adapter around the public MouseRegion component.
 * Child dispatch stays first, so an already handled child result is unchanged.
 */
export class NativePointerRegion implements Component {
	private readonly adapter: MouseRegion;
	private readonly callbacks: NativePointerRegionCallbacks;
	private readonly scope: NativePointerScope | undefined;
	private hovered = false;
	private disabled = false;
	private disposed = false;
	private renderedWidth: number | undefined;

	constructor(child: Component, callbacks: NativePointerRegionCallbacks, scope?: NativePointerScope) {
		this.callbacks = callbacks;
		this.scope = scope;
		this.adapter = new MouseRegion(child, (event) => this.handlePointer(event));
		this.scope?.register(this);
	}

	render(width: number): string[] {
		if (this.renderedWidth !== undefined && this.renderedWidth !== width) this.clearHover();
		this.renderedWidth = width;
		return this.adapter.render(width);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disposed) return undefined;
		return this.adapter.handleMouse(event);
	}

	invalidate(): void {
		this.renderedWidth = undefined;
		this.clearHover();
		this.adapter.invalidate();
	}

	setDisabled(disabled: boolean): void {
		if (this.disabled === disabled) return;
		this.disabled = disabled;
		if (disabled) this.clearHover();
	}

	clearHover(event?: TuiMouseEvent): boolean {
		if (!this.hovered) return false;
		this.hovered = false;
		this.callbacks.onLeave?.(event);
		return true;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.clearHover();
		this.scope?.unregister(this);
	}

	private handlePointer(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disabled || this.disposed) return undefined;
		if (event.type === "move" && event.button === "none") {
			this.scope?.markMove(this, event);
			this.hovered = true;
			return this.callbacks.onHover?.(event);
		}
		if (event.type === "press") return this.callbacks.onPress?.(event);
		if (event.type === "click") return this.callbacks.onClick?.(event);
		if (event.type === "wheel") return this.callbacks.onWheel?.(event);
		return undefined;
	}
}

/** Coordinates pointer regions with a root-compatible native mouse observer. */
export class NativePointerScope {
	private readonly regions = new Set<NativePointerRegion>();
	private moved = false;
	private disabled = false;
	private disposed = false;

	wrap(child: Component, callbacks: NativePointerRegionCallbacks): NativePointerRegion {
		const region = new NativePointerRegion(child, callbacks, this);
		region.setDisabled(this.disabled);
		if (this.disposed) region.dispose();
		return region;
	}

	createMouseObserver(requestRender?: () => void): NativePointerMouseObserver {
		return {
			beforeMouse: (event) => {
				if (!this.disposed && event.type === "move" && event.button === "none") this.moved = false;
			},
			afterMouse: (event) => {
				if (!this.isInRoot(event) || this.moved) return;
				if (this.clearHover(event)) requestRender?.();
			},
		};
	}

	setDisabled(disabled: boolean): void {
		this.disabled = disabled;
		for (const region of this.regions) region.setDisabled(disabled);
	}

	invalidate(): void {
		this.clearHover();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const region of [...this.regions]) region.dispose();
	}

	register(region: NativePointerRegion): void {
		if (!this.disposed) this.regions.add(region);
	}

	unregister(region: NativePointerRegion): void {
		this.regions.delete(region);
	}

	markMove(region: NativePointerRegion, event: TuiMouseEvent): void {
		this.moved = true;
		for (const candidate of this.regions) {
			if (candidate !== region) candidate.clearHover(event);
		}
	}

	private clearHover(event?: TuiMouseEvent): boolean {
		let changed = false;
		for (const region of this.regions) changed = region.clearHover(event) || changed;
		return changed;
	}

	private isInRoot(event: TuiMouseEvent): boolean {
		return !this.disposed && event.type === "move" && event.button === "none" &&
			event.x >= 0 && event.x < event.width && event.y >= 0 && event.y < event.height;
	}
}

export function createNativePointerScope(): NativePointerScope {
	return new NativePointerScope();
}
