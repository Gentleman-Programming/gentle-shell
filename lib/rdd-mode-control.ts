import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NativeReviewModeSource } from "./native-review-cli.ts";

/** The owner supplies the live UI; consumers cannot provide a context or a mode setter. */
export interface RddModeControl {
	read(): Promise<{ effective: "on" | "off"; source: NativeReviewModeSource } | undefined>;
	open(): Promise<void>;
}

export const RDD_MODE_CONTROL_CHANNEL = "gentle:rdd:host-ui";

/** Discover the current session owner for a human-operated UI, if one is available. */
export function discoverRddModeControl(pi: ExtensionAPI): Promise<RddModeControl | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => { settled = true; resolve(undefined); }, 100);
		try {
			pi.events.emit(RDD_MODE_CONTROL_CHANNEL, {
				respond(value: RddModeControl) {
					if (settled || typeof value?.read !== "function" || typeof value?.open !== "function") return;
					settled = true;
					clearTimeout(timer);
					resolve(value);
				},
			});
		} catch {
			settled = true;
			clearTimeout(timer);
			resolve(undefined);
		}
	});
}
