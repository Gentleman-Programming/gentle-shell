// Bounded ODD phase signal for the Gentle prompt's working label. There is
// no Pi runtime event for ODD phases, so the label comes from two sources:
// phases inferred deterministically from the primary session's tool activity
// (lib/odd-phase-inference.ts, wired in extensions/gentle-shell.ts) and
// explicit reports by the orchestrator through gentle_odd_phase, which
// refine it with phases tools cannot show (see
// assets/orchestrator-tracking.md). Never inferred from assistant prose;
// the prompt falls back to the generic "working…" label when nothing applies.

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

/** Who set a session's phase: the orchestrator through gentle_odd_phase, or tool-activity inference. */
export type OddPhaseSource = "explicit" | "inferred";

interface ReportedOddPhase {
	phase: OddPhase;
	source: OddPhaseSource;
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
	private readonly phases = new Map<string, ReportedOddPhase>();
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
	 * to. The source defaults to "explicit"; tool-activity inference goes
	 * through infer() so its precedence rule applies.
	 */
	report(sessionId: string | undefined, phase: OddPhase, source: OddPhaseSource = "explicit"): OddPhase | undefined {
		if (!sessionId) return undefined;
		this.phases.set(sessionId, { phase, source });
		this.renderRequests.get(sessionId)?.();
		return phase;
	}

	/**
	 * Applies a phase inferred from tool activity and returns the session's
	 * resulting phase. An explicit report is not overridden by an inferred
	 * "exploring" (read-only tools are routine while researching or
	 * deciding). Incidental reads and planning bookkeeping also cannot
	 * displace active implementation/checking. A known delegated exploration
	 * is a deliberate transition, not an incidental read; later edits and
	 * checks can still move between active work phases. Inferring the phase
	 * already shown changes nothing,
	 * keeps an explicit source explicit, and never requests a redraw, so
	 * repeated tool calls do not repaint the prompt.
	 */
	infer(sessionId: string | undefined, phase: OddPhase, cause: "tool" | "delegation" = "tool"): OddPhase | undefined {
		if (!sessionId) return undefined;
		const current = this.phases.get(sessionId);
		if (current?.phase === phase) return phase;
		if (phase === "exploring" && cause !== "delegation" &&
			(current?.source === "explicit" || current?.phase === "implementing" || current?.phase === "checking")) return current?.phase;
		if (phase === "planning" && (current?.phase === "implementing" || current?.phase === "checking")) return current.phase;
		return this.report(sessionId, phase, "inferred");
	}

	/**
	 * Clears a session's reported phase (turn/session boundary, or the
	 * explicit "clear" token). An invalid/unrecognized phase report is
	 * never a reason to clear: only this method resets the session, so a
	 * malformed report leaves the previously reported phase in place.
	 * Clearing also drops the report's source.
	 */
	clear(sessionId: string | undefined): void {
		if (!sessionId) return;
		if (this.phases.delete(sessionId)) this.renderRequests.get(sessionId)?.();
	}

	get(sessionId: string | undefined): OddPhase | undefined {
		return sessionId ? this.phases.get(sessionId)?.phase : undefined;
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
