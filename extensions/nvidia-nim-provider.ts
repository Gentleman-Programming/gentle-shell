import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createNvidiaNimProviderConfig } from "../lib/nvidia-nim-provider.ts";

export default function registerNvidiaNimProvider(pi: ExtensionAPI): void {
	pi.registerProvider(createNvidiaNimProviderConfig());
}