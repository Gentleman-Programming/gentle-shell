import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createStandardComputeProviderConfig } from "../lib/standard-compute-provider.ts";

export default function registerStandardComputeProvider(pi: ExtensionAPI): void {
	pi.registerProvider(createStandardComputeProviderConfig());
}
