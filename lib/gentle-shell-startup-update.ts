import type { ParsedLauncherArgs } from "./gentle-shell-launcher.ts";

export interface StartupUpdateOffer {
	current: string;
	latest: string;
	notesUrl: string;
}

export interface StartupUpdateCheckOptions {
	args: ParsedLauncherArgs;
	env: Record<string, string | undefined>;
	bundled: boolean;
	inputTTY: boolean;
	outputTTY: boolean;
}

export interface StartupUpdateLookupOptions {
	current: string;
	skipped?: string;
	lookup: (signal: AbortSignal) => Promise<string | undefined>;
	timeoutMs?: number;
}

export function shouldCheckStartupUpdate({ args, env, bundled, inputTTY, outputTTY }: StartupUpdateCheckOptions): boolean {
	if (!bundled || !inputTTY || !outputTTY || args.command || args.piSubcommand || args.error || args.help || args.version || args.packageRoot !== undefined) {
		return false;
	}
	if (env.GENTLE_PI_AGENTS_CHILD || env.PI_OFFLINE || env.GENTLE_SHELL_SKIP_STARTUP_UPDATE) {
		return false;
	}

	// An allowlist keeps new command modes from accidentally showing a prompt.
	for (let i = 0; i < args.passthrough.length; i += 1) {
		const token = args.passthrough[i];
		if (token === "--continue" || token === "-c") continue;
		if (token.startsWith("--resume=") && token.length > "--resume=".length) continue;
		if (token === "--resume" || token === "-r") {
			const next = args.passthrough[i + 1];
			if (next !== undefined && !next.startsWith("-")) i += 1;
			continue;
		}
		return false;
	}
	return true;
}

function stableParts(version: string): string[] | undefined {
	// No leading zeros, prefixes, whitespace, prereleases or build metadata.
	const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(version);
	return match && match[0] === version ? match.slice(1) : undefined;
}

function isNewer(latest: string[], current: string[]): boolean {
	for (let i = 0; i < 3; i += 1) {
		if (latest[i] === current[i]) continue;
		// Decimal string comparison avoids rounding even for arbitrarily large parts.
		return latest[i].length !== current[i].length
			? latest[i].length > current[i].length
			: latest[i] > current[i];
	}
	return false;
}

export async function findStartupUpdate({ current, skipped, lookup, timeoutMs = 1500 }: StartupUpdateLookupOptions): Promise<StartupUpdateOffer | undefined> {
	const currentParts = stableParts(current);
	if (!currentParts) return undefined;
	const controller = new AbortController();
	const deadline = Number.isFinite(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 2_147_483_647 ? timeoutMs : 1500;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<undefined>((resolve) => {
			timer = setTimeout(() => {
				resolve(undefined);
				controller.abort();
			}, deadline);
		});
		// The race bounds startup even if the injected lookup ignores cancellation.
		const latest = await Promise.race([lookup(controller.signal), timeout]);
		if (latest === undefined || latest === skipped) return undefined;
		const latestParts = stableParts(latest);
		if (!latestParts || !isNewer(latestParts, currentParts)) return undefined;
		return {
			current,
			latest,
			notesUrl: `https://github.com/Gentleman-Programming/gentle-shell/releases/tag/v${latest}`,
		};
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}
