import * as realPiTui from "@earendil-works/pi-tui";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

export class MouseRegion implements Component {
	readonly child: Component;
	readonly onMouse: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;

	constructor(child: Component, onMouse: (event: TuiMouseEvent) => TuiMouseEventResult | undefined) {
		const RealCtor = (realPiTui as unknown as { MouseRegion?: typeof MouseRegion }).MouseRegion;
		if (RealCtor && RealCtor !== MouseRegion) {
			return new RealCtor(child, onMouse);
		}
		this.child = child;
		this.onMouse = onMouse;
	}

	render(width: number): string[] {
		return this.child.render(width);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const childResult = this.child.handleMouse?.(event);
		return childResult ?? this.onMouse(event);
	}

	invalidate(): void {
		this.child.invalidate?.();
	}
}

export const FallbackMouseRegion = MouseRegion;

function extractComponent(entry: unknown): Component | null {
	if (!entry || typeof entry !== "object") return null;
	if ("render" in entry && typeof entry.render === "function") {
		return entry as Component;
	}
	if ("component" in entry) {
		const candidate = entry.component;
		if (candidate && typeof candidate === "object" && "render" in candidate && typeof candidate.render === "function") {
			return candidate as Component;
		}
	}
	return null;
}

export type StackEntryOptions = {
	minSize?: number;
	maxSize?: number;
	weight?: number;
	align?: "stretch" | "start" | "center" | "end";
};
export type StackChild = Component | (StackEntryOptions & { component: Component });

export class VStack implements Component {
	readonly entries: StackChild[];
	readonly options: unknown;

	constructor(entries: StackChild[] = [], options: unknown = {}) {
		const RealCtor = (realPiTui as unknown as { VStack?: typeof VStack }).VStack;
		if (RealCtor && RealCtor !== VStack) {
			return new RealCtor(entries, options);
		}
		this.entries = entries;
		this.options = options;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const entry of this.entries) {
			const comp = extractComponent(entry);
			if (comp) {
				lines.push(...comp.render(width));
			}
		}
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		for (const entry of this.entries) {
			const comp = extractComponent(entry);
			if (comp && typeof comp.handleMouse === "function") {
				const res = comp.handleMouse(event);
				if (res) return res;
			}
		}
		return undefined;
	}

	invalidate(): void {}
}

export const FallbackVStack = VStack;

interface RgbColor {
	r: number;
	g: number;
	b: number;
}

export function fallbackColorToRgb(color: unknown): RgbColor {
	if (color && typeof color === "object") {
		if ("kind" in color && color.kind === "rgb" && "r" in color && "g" in color && "b" in color) {
			const r = color.r;
			const g = color.g;
			const b = color.b;
			if (typeof r === "number" && typeof g === "number" && typeof b === "number") {
				return { r, g, b };
			}
		}
		if ("r" in color && "g" in color && "b" in color) {
			const r = color.r;
			const g = color.g;
			const b = color.b;
			if (typeof r === "number" && typeof g === "number" && typeof b === "number") {
				return { r, g, b };
			}
		}
	}
	return { r: 128, g: 128, b: 128 };
}

export function fallbackParseColor(value: unknown): unknown {
	if (typeof value === "string") {
		const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value);
		if (hex) {
			const hexMatch = hex[1];
			const digits = hexMatch.length === 3 ? [...hexMatch].map((d) => d + d).join("") : hexMatch;
			return {
				kind: "rgb",
				r: Number.parseInt(digits.slice(0, 2), 16),
				g: Number.parseInt(digits.slice(2, 4), 16),
				b: Number.parseInt(digits.slice(4, 6), 16),
			};
		}
	}
	return { kind: "rgb", r: 128, g: 128, b: 128 };
}

const tuiNamespace = realPiTui as unknown as {
	colorToRgb?: (color: unknown) => RgbColor;
	parseColor?: (value: unknown) => unknown;
};

export const colorToRgb = tuiNamespace.colorToRgb ?? fallbackColorToRgb;
export const parseColor = tuiNamespace.parseColor ?? fallbackParseColor;

export * from "@earendil-works/pi-tui";
