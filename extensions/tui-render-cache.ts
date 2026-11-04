import { Container, type Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Bounded render cache for pi-tui Containers (upstream pi issue #7730).
//
// On long sessions every streamed delta, spinner tick, and extension status
// re-renders the whole transcript: `Container.render` concatenates every
// child's lines into a fresh array on every frame, even when no child changed.
// With thousands of transcript components that is O(transcript lines) of work
// and allocation per frame, which is the reported 50-110% CPU on long macOS
// sessions. Painting is already viewport-clipped upstream; the cost lives in
// this construction pass.
//
// The patch reuses the concatenated array across frames when every child
// returned the same line-array instance as the previous frame. Cached
// components (Text, Markdown, nested patched Containers) return their internal
// cachedLines array unchanged until they re-render, so identical identities
// imply identical aggregate output. An uncached child allocates a fresh array
// per render, which never matches and forces an honest rebuild — staleness is
// impossible without hooking invalidate(), and mutators that bypass
// invalidate() (Text.setText) still re-render and change the identity.
//
// Residual cost is O(children) cheap render() calls per frame; the
// O(transcript lines) concatenation and allocation are what this removes.
// Upstream viewport-first layout would subsume this (pi#7730 follow-ups).

interface AggregateCache {
	width: number;
	identities: string[][];
	aggregate: string[];
}

type ContainerRender = (this: Container, width: number) => string[];

const aggregateCaches = new WeakMap<object, AggregateCache>();

// Process-wide marker (not per extension instance): /reload re-runs this
// factory and must not wrap the already-patched render a second time.
const STATE_KEY = Symbol.for("gentle-pi.tui-render-cache");
type StateHolder = { [STATE_KEY]?: ApplyResult };

export interface ApplyResult {
	applied: boolean;
	reason?: "missing-render" | "shape-drift" | "already-applied";
}

/**
 * Whether a Container.prototype.render source still has the shape the patch
 * relies on: it must render each child and maintain `mouseLayout`. A minified
 * or refactored upstream render fails this guard and the patch stays off,
 * leaving current behavior untouched.
 */
export function renderSourceIsPatchable(source: string): boolean {
	return source.includes("mouseLayout") && /child\.render\(\s*width\s*\)/.test(source);
}

const PATCH_MARKER = "__gentleAggregateCache";

export function applyTuiRenderCache(): ApplyResult {
	const holder = globalThis as StateHolder;
	const proto = Container.prototype as unknown as { render: ContainerRender & { [PATCH_MARKER]?: boolean } };
	const original = proto.render;
	if (typeof original !== "function") {
		const result: ApplyResult = { applied: false, reason: "missing-render" };
		holder[STATE_KEY] = result;
		return result;
	}
	if (original[PATCH_MARKER]) {
		const result: ApplyResult = { applied: true, reason: "already-applied" };
		holder[STATE_KEY] = result;
		return result;
	}
	if (!renderSourceIsPatchable(Function.prototype.toString.call(original))) {
		const result: ApplyResult = { applied: false, reason: "shape-drift" };
		holder[STATE_KEY] = result;
		return result;
	}
	const patched = function patchedRender(this: Container, width: number): string[] {
		const children = this.children as Component[];
		const identities: string[][] = [];
		const childLineLists: string[][] = [];
		for (const child of children) {
			const childLines = child.render(width);
			identities.push(childLines);
			childLineLists.push(childLines);
		}
		const cached = aggregateCaches.get(this);
		if (
			cached !== undefined &&
			cached.width === width &&
			cached.identities.length === identities.length
		) {
			let unchanged = true;
			for (let index = 0; index < identities.length; index += 1) {
				if (cached.identities[index] !== identities[index]) {
					unchanged = false;
					break;
				}
			}
			// Identical child arrays imply identical heights, so the mouseLayout
			// recorded by the rebuild that filled this cache stays valid.
			if (unchanged) return cached.aggregate;
		}
		const lines: string[] = [];
		const mouseChildren: Array<{ component: Component; height: number }> = [];
		for (let index = 0; index < children.length; index += 1) {
			const childLines = childLineLists[index];
			mouseChildren.push({ component: children[index], height: childLines.length });
			for (const line of childLines) lines.push(line);
		}
		// mouseLayout is private in pi-tui's typings; the runtime property is
		// what the unpatched render assigns, so write it through the same shape.
		(this as unknown as { mouseLayout: { width: number; children: Array<{ component: Component; height: number }> } }).mouseLayout = { width, children: mouseChildren };
		aggregateCaches.set(this, { width, identities, aggregate: lines });
		return lines;
	};
	patched[PATCH_MARKER] = true;
	proto.render = patched;
	const result: ApplyResult = { applied: true };
	holder[STATE_KEY] = result;
	return result;
}

/** Test-only: the outcome of the last apply attempt in this process. */
export function tuiRenderCacheState(): ApplyResult | undefined {
	return (globalThis as StateHolder)[STATE_KEY];
}

export default function tuiRenderCache(_pi: ExtensionAPI): void {
	applyTuiRenderCache();
}
