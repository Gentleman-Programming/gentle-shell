import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createNanProviderConfig } from "../lib/nan-provider.ts";

export default function registerNanProvider(pi: ExtensionAPI): void {
	if (typeof pi.registerProvider !== "function") return;
	try {
		pi.registerProvider(createNanProviderConfig());
	} catch {
		// Tolerates alternative host registerProvider signature or missing stream factory
	}
}
