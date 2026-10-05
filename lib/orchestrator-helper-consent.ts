import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { MetadataReceipt } from "./orchestrator-consultation.ts";
import { OrchestratorHelper, preflightHelper } from "./orchestrator-helper.ts";

/** Supported public SDK boundaries only. The host supplies its CURRENT context, never a cached one. */
export type HelperHost = Pick<ExtensionContext, "cwd" | "model" | "mode" | "hasUI"> & {
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
	modelRegistry: Pick<ModelRegistry, "streamSimple">;
	ui: Pick<ExtensionContext["ui"], "select">;
};
interface Binding {
	manager: HelperHost["sessionManager"]; sessionId: string; cwd: string;
	model: NonNullable<HelperHost["model"]>; provider: string; id: string;
	registry: HelperHost["modelRegistry"];
}
interface Request {
	receipt: MetadataReceipt; question: string; signal?: AbortSignal;
	/** Re-read the same canonical target/page with existing bounded public readers. */
	readSource: () => Promise<MetadataReceipt>;
	/** Host verifies canonical selected activation/public digest throughout execution. */
	isSourceCurrent: () => boolean;
}
// Pi's jiti loader disables moduleCache. Keep ONLY execution leases across reloads;
// no caller identity, permissions, source snapshots or model configuration here.
const leaseKey = Symbol.for("gentle-pi.orchestrator-helper.execution/v1");
const shared = globalThis as typeof globalThis & { [leaseKey]?: WeakMap<HelperHost["modelRegistry"], OrchestratorHelper> };
const engines = shared[leaseKey] ??= new WeakMap<HelperHost["modelRegistry"], OrchestratorHelper>();
const CHOICES = ["Allow once", "Allow this target + model for this session", "Decline"];
const unavailable = (code: string) => ({ status: "unavailable" as const, code,
	source: "helper_advice" as const, ownerReply: false as const, authority: "none" as const });

/** Ephemeral model-cost permission, NOT messaging/native-action consent or owner authority.
 * Own one coordinator per host runtime. Call clear on every lifecycle/reload/shutdown boundary.
 * No granting API: only exact supported host UI choices can authorize execution. */
export class HelperCostPermission {
	private binding?: Binding;
	private scopes = new Set<string>();
	private epoch = 0;
	private pending = false;
	private engine?: OrchestratorHelper;
	private readHost: () => HelperHost | undefined;
	constructor(readHost: () => HelperHost | undefined) { this.readHost = readHost; }
	clear() {
		this.epoch++;
		this.scopes.clear();
		this.binding = undefined;
		this.engine?.cancel(); // Keep the engine and lease until actual settlement.
	}
	revoke(targetSessionId: string) {
		this.epoch++; // Invalidate even a pending once/session UI choice.
		this.scopes.delete(targetSessionId);
		this.engine?.cancel();
	}
	private capture(): Binding | undefined {
		try {
			const h = this.readHost();
			if (!h?.model || !h.modelRegistry || !h.sessionManager || !h.cwd) return undefined;
			const sessionId = h.sessionManager.getSessionId();
			if (!sessionId || !h.model.provider || !h.model.id) return undefined;
			return { manager: h.sessionManager, sessionId, cwd: h.cwd, model: h.model,
				provider: h.model.provider, id: h.model.id, registry: h.modelRegistry };
		} catch { return undefined; }
	}
	private same(a: Binding | undefined, b: Binding | undefined): boolean {
		return !!a && !!b && a.manager === b.manager && a.sessionId === b.sessionId && a.cwd === b.cwd
			&& a.model === b.model && a.provider === b.provider && a.id === b.id && a.registry === b.registry;
	}
	async run(r: Request) {
		const { receipt, question } = r; // Preserve the original frozen public capture across UI waits.
		const binding = this.capture();
		if (!this.same(binding, this.binding)) { this.clear(); this.binding = binding; }
		if (this.pending || this.engine?.busy || (binding && engines.get(binding.registry)?.busy)) return unavailable("busy");
		if (!binding) return unavailable("permission-required");
		const prepared = preflightHelper(receipt, question, binding.model);
		if (prepared.code) return unavailable(prepared.code);
		const target = receipt.targetSessionId;
		if (!target || receipt.freshness !== "recent") return unavailable("invalid-source");
		const epoch = this.epoch;
		const current = () => {
			try { return !r.signal?.aborted && epoch === this.epoch && this.same(binding, this.capture())
				&& r.isSourceCurrent() === true; } catch { return false; }
		};
		if (!current()) return unavailable(r.signal?.aborted ? "cancelled" : "stale-source");
		const host = this.readHost();
		if (!host?.hasUI || (host.mode !== "tui" && host.mode !== "rpc")) return unavailable("permission-required");
		this.pending = true; // Held through dialog and asynchronous public-source revalidation.
		try {
			let sessionChoice = false;
			if (!this.scopes.has(target)) {
				const title = `Model-cost permission only: one direct model run via ${binding.provider}/${binding.id} (current profile may route). `
					+ `Published target ${target}, captured at ${receipt.observedAt}; only published data/advice, NOT an owner reply. `
					+ "Input 16384 bytes; question 1024 bytes; requested output 512 tokens; local deadline 20000 ms; output 4096 bytes. "
					+ "Provider limits/abort are not a billing guarantee. Not human/native-action consent.";
				const choice = await host.ui.select(title, [...CHOICES], { signal: r.signal });
				if (!current()) return unavailable(r.signal?.aborted ? "cancelled" : "stale-source");
				if (choice !== CHOICES[0] && choice !== CHOICES[1]) return unavailable("permission-required");
				sessionChoice = choice === CHOICES[1];
			}
			const fresh = await r.readSource();
			if (!current() || fresh.status !== "available" || fresh.freshness !== "recent"
				|| fresh.targetSessionId !== target || fresh.digest !== receipt.digest) return unavailable("stale-source");
			if (engines.get(binding.registry)?.busy) return unavailable("busy");
			if (sessionChoice) {
				if (this.scopes.size >= 8) this.scopes.delete(this.scopes.values().next().value!);
				this.scopes.add(target); // Logical target, NOT a snapshot digest or private generation.
			}
			// Each owner keeps its own cancellation handle; stale clear cannot abort a successor.
			this.engine = new OrchestratorHelper(binding.registry);
			engines.set(binding.registry, this.engine);
			const advice = await this.engine.run({ receipt, question,
				model: binding.model, signal: r.signal, isCurrent: current });
			if (advice.status !== "available") return advice;
			// Canonical routing can change independently of publication. Re-read after
			// execution while the same epoch/live model binding still owns the reply.
			const finalSource = await r.readSource();
			return current() && finalSource.status === "available" && finalSource.freshness === "recent"
				&& finalSource.targetSessionId === target && finalSource.digest === receipt.digest
				? advice : unavailable("stale-source");
		} catch { return unavailable("permission-required"); }
		finally { this.pending = false; }
	}
}
