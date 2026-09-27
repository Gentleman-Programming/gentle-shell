// Bounded, explicit ODD phase signal for the Gentle prompt's working label.
// ODD phases live only in orchestrator instructions; there is no Pi runtime
// event for them, so this module never infers a phase from tool use or
// assistant prose. The orchestrator reports a phase explicitly at ODD
// protocol transitions (see assets/orchestrator-delegation.md); the prompt
// falls back to the generic "working…" label whenever nothing was reported.

// Covers the ODD protocol steps in AGENTS.md (1 authorize .. 7 close); not a
// strict one-to-one mapping. "researching"/"deciding" both cover step 3
// (resolve uncertainty), and "deciding" also covers step 4's classify
// decision (no dedicated label: classifying is typically an instantaneous
// internal decision, not standalone visible work). "checking"/"closing"
// both cover step 7 (close).
export const ODD_PHASES = [
	"authorizing",
	"exploring",
	"researching",
	"deciding",
	"planning",
	"implementing",
	"checking",
	"closing",
] as const;

export type OddPhase = (typeof ODD_PHASES)[number];

export function isOddPhase(value: unknown): value is OddPhase {
	return typeof value === "string" && (ODD_PHASES as readonly string[]).includes(value);
}

export function oddPhaseLabel(phase: OddPhase): string {
	return `${phase}…`;
}

/**
 * Session-scoped, best-effort ODD phase signal. Keyed by Pi session id so a
 * background/child agent — which runs as its own OS process with its own
 * module state (see lib/agents-runner.ts) — can never see or override the
 * primary session's reported phase. The owning extension clears a session's
 * entry at turn and session boundaries (agent_start, agent_settled,
 * session_shutdown) so a stale phase from a finished turn never leaks into
 * the next one.
 */
export class OddPhaseRegistry {
	private readonly phases = new Map<string, OddPhase>();
	// The WORKING-state pulse loop does not run at all under the "potato"
	// animation policy (see GentlePromptEditor.startPulse), and workingLabel
	// is otherwise only read on the next incidental render. Pi's own docs
	// (docs/tui.md) instruct components to call requestRender() themselves
	// after a state change; no host re-render is implicitly guaranteed. The
	// owning prompt registers its own redraw callback here so a phase change
	// is visible immediately regardless of animation policy.
	private readonly renderRequests = new Map<string, () => void>();

	/**
	 * Sets the current ODD phase for a session. Only accepts an
	 * already-validated OddPhase; callers must validate untrusted input
	 * with isOddPhase() (or use clear() for the explicit "clear" token)
	 * before calling this. Returns undefined, without mutating any state or
	 * requesting a redraw, when there is no session id to scope the report
	 * to.
	 */
	report(sessionId: string | undefined, phase: OddPhase): OddPhase | undefined {
		if (!sessionId) return undefined;
		this.phases.set(sessionId, phase);
		this.renderRequests.get(sessionId)?.();
		return phase;
	}

	/**
	 * Clears a session's reported phase (turn/session boundary, or the
	 * explicit "clear" token). An invalid/unrecognized phase report is
	 * never a reason to clear: only this method resets the session, so a
	 * malformed report leaves the previously reported phase in place.
	 */
	clear(sessionId: string | undefined): void {
		if (!sessionId) return;
		if (this.phases.delete(sessionId)) this.renderRequests.get(sessionId)?.();
	}

	get(sessionId: string | undefined): OddPhase | undefined {
		return sessionId ? this.phases.get(sessionId) : undefined;
	}

	/** Working label for the reported phase, or undefined to fall back to the generic "working…" label. */
	label(sessionId: string | undefined): string | undefined {
		const phase = this.get(sessionId);
		return phase ? oddPhaseLabel(phase) : undefined;
	}

	/** Registers (replacing any previous registration) the callback used to request an immediate redraw when this session's phase changes. */
	setRenderRequest(sessionId: string | undefined, requestRender: () => void): void {
		if (sessionId) this.renderRequests.set(sessionId, requestRender);
	}

	clearRenderRequest(sessionId: string | undefined): void {
		if (sessionId) this.renderRequests.delete(sessionId);
	}
}

// Pi loads extensions with separate jiti moduleCache:false loaders, so a
// module-local singleton is duplicated. The global symbol bridges only those
// loaders inside this process; subagents run in separate OS processes. Keep
// the session key inside the registry and clear it at turn/session boundaries.
const ODD_PHASE_REGISTRY = Symbol.for("gentle-pi.odd-phase-registry");
const processState = globalThis as typeof globalThis & { [ODD_PHASE_REGISTRY]?: OddPhaseRegistry };
export const oddPhaseRegistry = processState[ODD_PHASE_REGISTRY] ??= new OddPhaseRegistry();
