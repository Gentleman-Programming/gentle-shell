import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installSessionChangeCapture } from "../lib/session-change-capture.ts";

// gentle-shell#1688: isolated children do not load gentle-shell.ts in the
// Gentle Shell home, so child write/edit evidence capture is installed here.
// In the parent (where gentle-shell.ts already installs capture), this extension
// is inert to avoid duplicate handlers.
export function createChildCaptureExtension(env: NodeJS.ProcessEnv = process.env): (pi: ExtensionAPI) => void {
	return (pi) => {
		if (env.GENTLE_PI_AGENTS_CHILD !== "1") return;
		installSessionChangeCapture(pi, env);
	};
}

export default function childCaptureExtension(pi: ExtensionAPI): void {
	createChildCaptureExtension()(pi);
}
