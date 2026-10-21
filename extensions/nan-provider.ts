import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createNanProviderConfig } from "../lib/nan-provider.ts";

export default function registerNanProvider(pi: ExtensionAPI): void {
	pi.registerProvider(createNanProviderConfig());
}
