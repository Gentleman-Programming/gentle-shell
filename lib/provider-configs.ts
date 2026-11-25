import type { Provider } from "@earendil-works/pi-ai";
import { createNanProviderConfig } from "./nan-provider.ts";

/**
 * The providers gentle-pi itself registers, for hosts that build their own
 * Pi `ModelRuntime` without loading extensions (the desktop app's sign-in
 * helper). Each one goes to `runtime.registerNativeProvider(provider)`,
 * as the extension loader does for `pi.registerProvider(provider)`.
 * Published as `runtime/provider-configs.mjs`; third-party extension
 * providers are not included.
 */
export function getProviderConfigs(): Provider[] {
	return [createNanProviderConfig()];
}
