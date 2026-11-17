// Gentle Desktop update-status bridge: answers `get_update_status` from the
// sources in `lib/update-status.ts` (Gentle Shell's own channel and version
// resolution, the launcher's release lookup and its cached record, and Pi's
// own package update check) and projects them with `lib/desktop-rpc-updates.ts`.
//
// Without `refresh` it answers from what is already known: the launcher's
// recorded release lookup and the results of an earlier refresh in this
// process. Nothing in that path reaches the network. `refresh: true` runs the
// lookups once, bounded by one deadline, and never when `PI_OFFLINE` is set.
// A refresh result lives only in this process's memory: this read never
// writes the launcher config or any other file.

import { homedir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";
import {
	boundedVersion,
	boundPackages,
	isoTime,
	PACKAGES_UPDATE_COMMAND,
	parseUpdateStatusParams,
	PI_UPDATE_COMMAND,
	SHELL_UPDATE_COMMANDS,
	UPDATES_UNAVAILABLE,
	type DesktopPackageUpdate,
	type DesktopUpdateStatus,
	type ItemState,
	type ShellChannel,
} from "./desktop-rpc-updates.ts";
import { defaultUpdateSources, isCurrentMain, isNewerRelease, type UpdateSources } from "./update-status.ts";

/** One deadline for every lookup of a refresh. */
export const UPDATE_CHECK_TIMEOUT_MS = 15_000;

const MAIN_COMMIT = /^[0-9a-f]{40}$/;

interface Recorded<T> { value: T; checkedAt: number }
interface UpdateCache {
	shell?: Recorded<string> & { channel: ShellChannel };
	pi?: Recorded<string>;
	packages?: Recorded<Set<string>>;
}

/** What one refresh learned; an absent field is a lookup that failed, timed out, or does not exist. */
interface RefreshResult {
	shell?: Recorded<string>;
	pi?: Recorded<string>;
	packages?: Recorded<Set<string>>;
}

// Process-wide: a refresh answered for one session still describes this
// installation after a session switch. In memory only, never persisted.
let cache: UpdateCache = {};
let inFlight: Promise<RefreshResult> | undefined;

/** Testing only: forget every refresh result and any refresh in flight. */
export function resetUpdateStatusCacheForTesting(): void {
	cache = {};
	inFlight = undefined;
}

type Settled<T> = { ok: true; value: T } | { ok: false };

async function refreshOnce(sources: UpdateSources, channel: ShellChannel, timeoutMs: number): Promise<RefreshResult> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<Settled<never>>((resolve) => {
		timer = setTimeout(() => {
			resolve({ ok: false });
			controller.abort();
		}, timeoutMs);
	});
	// The race bounds the refresh even when a source ignores the abort signal
	// (Pi's package check cannot be cancelled); its late result is dropped.
	const bounded = <T>(start: () => Promise<T>): Promise<Settled<T>> => {
		let pending: Promise<Settled<T>>;
		try {
			pending = start().then((value) => ({ ok: true as const, value }), () => ({ ok: false as const }));
		} catch {
			pending = Promise.resolve({ ok: false as const });
		}
		return Promise.race([pending, deadline]);
	};
	const skipped = Promise.resolve({ ok: false as const });
	try {
		const latestPi = sources.latestPi;
		const [shell, pi, packages] = await Promise.all([
			channel === "unknown" ? skipped : bounded(() => sources.latestShell(channel, controller.signal)),
			latestPi === undefined ? skipped : bounded(() => latestPi(controller.signal)),
			bounded(() => sources.checkPackages()),
		]);
		const checkedAt = sources.now();
		const result: RefreshResult = {};
		const shellLatest = shell.ok ? (channel === "main" ? (MAIN_COMMIT.test(shell.value) ? shell.value : null) : boundedVersion(shell.value)) : null;
		if (shellLatest !== null) {
			result.shell = { value: shellLatest, checkedAt };
			cache.shell = { ...result.shell, channel };
		}
		const piLatest = pi.ok ? boundedVersion(pi.value) : null;
		if (piLatest !== null) {
			result.pi = { value: piLatest, checkedAt };
			cache.pi = result.pi;
		}
		if (packages.ok && packages.value instanceof Set) {
			result.packages = { value: packages.value, checkedAt };
			cache.packages = result.packages;
		}
		return result;
	} finally {
		clearTimeout(timer);
	}
}

/** Concurrent refreshes share one run of the lookups. */
function sharedRefresh(sources: UpdateSources, channel: ShellChannel, timeoutMs: number): Promise<RefreshResult> {
	if (!inFlight) {
		const run = refreshOnce(sources, channel, timeoutMs).finally(() => {
			if (inFlight === run) inFlight = undefined;
		});
		inFlight = run;
	}
	return inFlight;
}

async function releaseState(current: string | null, latest: string | null, nowMs: number): Promise<ItemState> {
	if (current === null || latest === null) return "unknown";
	if (await isNewerRelease(current, latest, nowMs)) return "update_available";
	// Only an exact match is "up to date"; a newer local build or an
	// incomparable version stays unknown rather than guessed.
	return current === latest ? "up_to_date" : "unknown";
}

export type UpdateSourcesFactory = (context: ExtensionContext) => UpdateSources;

interface DesktopUpdatesBridgeOptions {
	sources?: UpdateSourcesFactory;
	timeoutMs?: number;
}

const defaultSources: UpdateSourcesFactory = (context) => defaultUpdateSources({
	cwd: context.sessionManager?.getCwd?.() ?? context.cwd,
	home: homedir(),
});

/**
 * The Desktop domain slice for `get_update_status`. It is a read: no event,
 * and no write anywhere. A reset (session replacement or shutdown) drops the
 * bound context and any answer of a read that started before it.
 */
export class DesktopUpdatesBridge {
	private readonly sources: UpdateSourcesFactory;
	private readonly timeoutMs: number;
	private host: ExtensionContext | undefined;
	private generation = 0;

	constructor(options: DesktopUpdatesBridgeOptions = {}) {
		this.sources = options.sources ?? defaultSources;
		this.timeoutMs = options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS;
	}

	/** The live interactive context of this Desktop session; bound per command. */
	attach(context: ExtensionContext): void {
		this.host = context;
	}

	reset(): void {
		this.generation += 1;
		this.host = undefined;
	}

	async handle(method: string, params: Record<string, unknown>): Promise<DesktopRpcOutcome | undefined> {
		if (method !== "get_update_status") return undefined;
		// Parse first: a malformed request never triggers a lookup.
		const query = parseUpdateStatusParams(params);
		if ("error" in query) return { ok: false, error: query.error };
		const host = this.host;
		if (!host) return { ok: false, error: UPDATES_UNAVAILABLE };
		const generation = this.generation;
		try {
			const status = await this.read(host, query.refresh);
			if (generation !== this.generation) return { ok: false, error: UPDATES_UNAVAILABLE };
			return { ok: true, data: status as unknown as Record<string, unknown> };
		} catch {
			// Raw source failures can carry paths or command output; none crosses.
			return { ok: false, error: UPDATES_UNAVAILABLE };
		}
	}

	private async read(host: ExtensionContext, refresh: boolean): Promise<DesktopUpdateStatus> {
		const sources = this.sources(host);
		const offline = sources.offline;
		const channel = await sources.shellChannel();
		const refreshed = refresh && !offline;
		// An offline refresh runs nothing and reports every looked-up item as
		// unknown: it never presents an older answer as the result of a check.
		const fresh: RefreshResult | undefined = refreshed ? await sharedRefresh(sources, channel, this.timeoutMs) : refresh ? {} : undefined;
		const nowMs = sources.now();

		// Gentle Shell.
		const shellCurrent = boundedVersion(sources.shellVersion());
		let shellRecord: Recorded<string> | undefined;
		if (fresh) shellRecord = fresh.shell;
		else if (cache.shell && cache.shell.channel === channel) shellRecord = cache.shell;
		else if (channel !== "main" && channel !== "unknown") {
			const recorded = sources.shellReleaseCache();
			const latest = boundedVersion(recorded?.latest);
			if (recorded && latest !== null) shellRecord = { value: latest, checkedAt: recorded.checkedAt };
		}
		let shellState: ItemState = "unknown";
		let shellLatest: string | null = null;
		if (shellRecord && channel === "main") {
			shellLatest = shellRecord.value.slice(0, 12);
			if (shellCurrent !== null) shellState = isCurrentMain(shellCurrent, shellRecord.value) ? "up_to_date" : "update_available";
		} else if (shellRecord && channel !== "unknown") {
			shellLatest = shellRecord.value;
			shellState = await releaseState(shellCurrent, shellLatest, nowMs);
		}

		// Pi.
		const piCurrent = boundedVersion(sources.piVersion());
		const piRecord = fresh ? fresh.pi : cache.pi;
		const piLatest = piRecord?.value ?? null;

		// Packages.
		const facts = sources.packages();
		const updates = fresh ? fresh.packages : cache.packages;
		const items: DesktopPackageUpdate[] = (facts ?? []).map((fact) => ({
			name: fact.name,
			kind: fact.kind,
			scope: fact.scope,
			current: fact.current,
			latest: null,
			pinned: fact.pinned,
			state: fact.kind === "unknown" ? "unknown"
				: !fact.checkable ? "skipped"
				: updates === undefined ? "unknown"
				: updates.value.has(fact.key) ? "update_available" : "no_update_reported",
		}));
		const bounded = boundPackages(items);

		return {
			refreshed,
			offline,
			gentleShell: {
				current: shellCurrent,
				latest: shellLatest,
				channel,
				state: shellState,
				command: SHELL_UPDATE_COMMANDS[channel],
				checkedAt: isoTime(shellLatest === null ? undefined : shellRecord?.checkedAt),
			},
			pi: {
				current: piCurrent,
				latest: piLatest,
				state: await releaseState(piCurrent, piLatest, nowMs),
				command: PI_UPDATE_COMMAND,
				checkedAt: isoTime(piRecord?.checkedAt),
			},
			packages: {
				available: facts !== undefined,
				items: bounded.items,
				truncated: bounded.truncated,
				command: PACKAGES_UPDATE_COMMAND,
				checkedAt: isoTime(updates?.checkedAt),
			},
		};
	}
}
