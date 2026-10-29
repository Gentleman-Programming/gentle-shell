import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { withOverlayRepaint } from "./overlay-repaint.ts";
import { PARAKEET_MODEL_MANIFEST, VOICE_NOTICES, voiceRuntimeManifest, type VoiceTarget } from "./voice-artifacts.ts";
import { installVoiceModel, installVoiceRuntime, readVoiceStatus, VoiceInstallError, type VoiceComponentStatus, type VoiceInstallErrorCode, type VoiceInstallProgress, type VoiceInstallResult } from "./voice-install.ts";
import { diagnoseVoicePlatform, readVoicePlatformProbe, type VoicePlatformDiagnosis, type VoicePlatformProbe } from "./voice-platform.ts";
import { SpaceHoldDetector, type PushToTalkOptions } from "./voice-push-to-talk.ts";
import { createVoiceSession, VoiceSessionError, type VoiceSessionErrorCode, type VoiceSessionState, type VoiceTranscript } from "./voice-session.ts";
import { readVoicePushToTalk, writeVoicePushToTalk } from "./voice-settings.ts";
import { pushToTalkStatus, VoiceDictationView, VoiceProgressView, type VoiceViewTheme } from "./voice-ui.ts";

// /gentle:voice (S1-S3): the only entry point to optional local dictation. It
// shows status, downloads the pinned runtime and model after an explicit
// confirmation, and records one dictation whose transcript is pasted into the
// editor draft, never submitted. Registration does nothing else: the platform
// probe, status reads, downloads and the worker all start from the command, in
// an interactive parent session only. One install or dictation runs at a time.
//
// Push-to-talk (hold Space) is the second way to dictate. When its persisted
// toggle is on, session start arms a raw input listener in an interactive
// parent session; reading the toggle is the only startup work. Whether voice is
// installed is checked at the first hold, and a missing install disarms it.
// A hold shares the single-operation lock with the command.

export const VOICE_COMMAND_NAME = "gentle:voice";

// The part of VoiceSession the command drives.
export interface VoiceDictation {
	readonly state: VoiceSessionState;
	start(): Promise<void>;
	stop(): Promise<VoiceTranscript>;
	cancel(): Promise<void>;
}

export interface VoiceStatusSnapshot {
	voiceHome: string;
	model: VoiceComponentStatus;
	runtime?: VoiceComponentStatus;
}

interface VoiceInstallRequest {
	signal: AbortSignal;
	onProgress(progress: VoiceInstallProgress): void;
}

export interface VoiceCommandDeps {
	env?: NodeJS.ProcessEnv;
	probe?: () => VoicePlatformProbe;
	readStatus?: (target: VoiceTarget) => Promise<VoiceStatusSnapshot>;
	installRuntime?: (options: VoiceInstallRequest & { target: VoiceTarget }) => Promise<VoiceInstallResult>;
	installModel?: (options: VoiceInstallRequest) => Promise<VoiceInstallResult>;
	createSession?: (options: { target: VoiceTarget; onStateChange(state: VoiceSessionState): void }) => VoiceDictation;
	// The persisted push-to-talk toggle.
	settings?: { read(): boolean; write(enabled: boolean): void };
	pushToTalk?: PushToTalkOptions;
}

const MB = 1_000_000;
const OVERLAY = { overlay: true, overlayOptions: { anchor: "center", width: "60%", minWidth: 44 } } as const;

const START = "Start dictation";
const STATUS = "Show status and notices";
const DISABLE_PUSH_TO_TALK = "Disable push-to-talk (hold Space)";
const ENABLE_PUSH_TO_TALK = "Enable push-to-talk (hold Space)";
const STATUS_KEY = "gentle-voice";

const INSTALL_MESSAGES: Record<VoiceInstallErrorCode, string> = {
	aborted: "Voice download was cancelled. Unfinished files were removed; completed components are kept.",
	timeout: "Voice download timed out. Check the network connection and try again.",
	http: "The download server answered with an error. Try again later.",
	redirect: "The download was redirected to an unexpected location and was refused.",
	size: "A downloaded file did not match its pinned size or digest and was discarded.",
	integrity: "A downloaded file did not match its pinned size or digest and was discarded.",
	archive: "A downloaded runtime package failed validation and was discarded.",
	unsupported: "Voice dictation has no pinned runtime for this platform.",
	io: "Voice files could not be written to the voice directory. Check its permissions and free space.",
};

type DictationStart = "command" | "hold";

// What the user can do about a session failure, by platform where it differs.
// Gentle AI never runs an installer for any of these.
function sessionAction(code: VoiceSessionErrorCode, platform: string, start: DictationStart): string | undefined {
	switch (code) {
		case "not-installed":
		case "runtime-invalid":
		case "model-invalid":
			return "Run /gentle:voice and download it again.";
		case "runtime-load":
			if (platform === "linux") return "Install the ALSA library (libasound.so.2, for example the libasound2 or alsa-lib package), then try again.";
			if (platform === "win32") return "Install the Microsoft Visual C++ Redistributable (x64) from Microsoft, then try again.";
			return "Loading has not been verified on hardware for this target.";
		case "no-input-device":
			return "Connect a microphone or choose a default input device, then try again.";
		case "capture":
			return platform === "darwin"
				? "Allow microphone access for this terminal in System Settings > Privacy & Security > Microphone, then try again."
				: "Check that the default microphone is available, then try again.";
		case "node-version":
			return "Run Gentle AI with Node 22 or newer.";
		case "empty-audio":
		case "no-speech":
			return start === "hold" ? "Keep holding Space until recording starts, then speak." : "Speak after recording starts, then press Enter.";
		default:
			return undefined;
	}
}

function sessionErrorMessage(error: unknown, platform: string, start: DictationStart): string {
	if (!(error instanceof VoiceSessionError)) return "Voice dictation failed.";
	const action = sessionAction(error.code, platform, start);
	return action ? `${error.message} ${action}` : error.message;
}

type Outcome = { kind: "text"; transcript: VoiceTranscript } | { kind: "cancelled" } | { kind: "error"; error: unknown };
type Say = (message: string, type: "info" | "warning" | "error") => void;

// Reports a settled dictation. The transcript goes through the editor's paste
// pipeline as is; it is never sent.
function deliver(ctx: ExtensionContext, result: Outcome, platform: string, start: DictationStart, say: Say, afterPaste?: () => void): void {
	if (result.kind === "cancelled") {
		say("Voice dictation cancelled; the draft is unchanged.", "info");
		return;
	}
	if (result.kind === "error") {
		say(sessionErrorMessage(result.error, platform, start), "error");
		return;
	}
	const { text, truncated } = result.transcript;
	if (!text.trim()) {
		say("No speech was recognized.", "warning");
		return;
	}
	ctx.ui.pasteToEditor(text);
	afterPaste?.();
	if (truncated) say("Recording reached the 2-minute limit; the transcript covers what was recorded.", "info");
}

// One dictation session driven to an Outcome. stop() and cancel() settle only
// after the worker has exited; a transcript that lands while cancelling is
// dropped. A release before recording starts waits for recording.
function runDictation(createSession: NonNullable<VoiceCommandDeps["createSession"]>, target: VoiceTarget, onState: (state: VoiceSessionState) => void) {
	let settled = false;
	let stopping = false;
	let cancelled = false;
	let released = false;
	let resolveOutcome!: (outcome: Outcome) => void;
	const outcome = new Promise<Outcome>((resolve) => { resolveOutcome = resolve; });
	const settle = (value: Outcome) => {
		if (settled) return;
		settled = true;
		resolveOutcome(cancelled ? { kind: "cancelled" } : value);
	};
	const collect = () => {
		if (stopping || cancelled || settled) return;
		if (session.state !== "recording" && session.state !== "finished") return;
		stopping = true;
		session.stop().then((transcript) => settle({ kind: "text", transcript }), (error) => settle({ kind: "error", error }));
	};
	const cancel = () => {
		if (cancelled || settled) return;
		cancelled = true;
		session.cancel().catch(() => {}).finally(() => settle({ kind: "cancelled" }));
	};
	// The session calls this synchronously from its own transitions, so it
	// must never throw: a throw there could leave a closing session unsettled.
	const onStateChange = (state: VoiceSessionState) => {
		try {
			onState(state);
			// The recording limit ends capture without a key press.
			if (state === "finished" || (state === "recording" && released)) queueMicrotask(collect);
		} catch {
			/* the observer is advisory */
		}
	};
	const session = createSession({ target, onStateChange });
	return {
		session,
		outcome,
		start: () => { session.start().catch((error) => settle({ kind: "error", error })); },
		stop: () => { released = true; collect(); },
		cancel,
	};
}

const PREREQUISITE_ACTIONS: Partial<Record<string, string>> = {
	linux: "Gentle AI never installs system libraries; install ALSA with your package manager if loading fails.",
	win32: "Gentle AI never installs the Visual C++ runtime; install it from Microsoft if loading fails.",
};

const runtimeBytes = (target: VoiceTarget) => voiceRuntimeManifest(target).packages.reduce((sum, pkg) => sum + pkg.size, 0);
const modelBytes = () => PARAKEET_MODEL_MANIFEST.files.reduce((sum, file) => sum + file.size, 0);
const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / MB))} MB`;

function noticeLines(): string[] {
	return VOICE_NOTICES.flatMap((notice) => [`- ${notice.attribution ?? `${notice.component}: ${notice.license}.`} Source: ${notice.source}`, ...(notice.unresolved ? [`  ${notice.unresolved}`] : [])]);
}

function limitationLines(diagnosis: VoicePlatformDiagnosis, platform: string): string[] {
	const action = PREREQUISITE_ACTIONS[platform];
	return [...diagnosis.limitations, ...(action ? [action] : [])].map((line) => `- ${line}`);
}

const describe = (status: VoiceComponentStatus | undefined) => (!status ? "unknown" : status.state === "invalid" && status.reason ? `invalid (${status.reason})` : status.state);

function statusReport(target: VoiceTarget, diagnosis: VoicePlatformDiagnosis, status: VoiceStatusSnapshot, platform: string): string {
	return [
		"Voice dictation status",
		`Target: ${target} (${diagnosis.support})`,
		`Voice home: ${status.voiceHome}`,
		`Model: ${describe(status.model)}`,
		`Runtime: ${describe(status.runtime)}`,
		"Limitations:",
		...limitationLines(diagnosis, platform),
		"Licenses and attribution:",
		...noticeLines(),
	].join("\n");
}

interface Overlay<V> {
	view(): V | undefined;
	tui(): TUI | undefined;
	// Closes once, whether or not the factory has run yet; resolves when closed.
	close(): Promise<void>;
}

function openOverlay<V extends Component & { dispose(): void }>(ctx: ExtensionCommandContext, make: (theme: VoiceViewTheme, requestRender: () => void) => V): Overlay<V> {
	let view: V | undefined;
	let tui: TUI | undefined;
	let finish: ((value: undefined) => void) | undefined;
	let closing = false;
	const closed = ctx.ui
		.custom<undefined>((t, theme, _keybindings, done) => {
			tui = t;
			finish = withOverlayRepaint(t, done);
			view = make(theme as VoiceViewTheme, () => t.requestRender());
			if (closing) queueMicrotask(() => finish?.(undefined));
			return view;
		}, OVERLAY)
		.catch(() => undefined)
		.finally(() => view?.dispose());
	return {
		view: () => view,
		tui: () => tui,
		close: () => {
			if (!closing) {
				closing = true;
				view?.dispose();
				finish?.(undefined);
			}
			return closed.then(() => undefined);
		},
	};
}

interface Run {
	generation: number;
	abort(): void;
}

export function registerVoiceCommand(pi: ExtensionAPI, deps: VoiceCommandDeps = {}): void {
	const env = deps.env ?? process.env;
	const probe = deps.probe ?? readVoicePlatformProbe;
	const readStatus = deps.readStatus ?? ((target) => readVoiceStatus({ env, target }));
	// Production always installs and runs the pinned manifests: no manifest or
	// fetch override is ever passed from here.
	const installRuntime = deps.installRuntime ?? (({ target, signal, onProgress }) => installVoiceRuntime({ env, target, signal, onProgress }));
	const installModel = deps.installModel ?? (({ signal, onProgress }) => installVoiceModel({ env, signal, onProgress }));
	const createSession = deps.createSession ?? (({ target, onStateChange }) => createVoiceSession({ env, target, onStateChange }));
	const settings = deps.settings ?? { read: () => readVoicePushToTalk({ env }), write: (enabled: boolean) => { writeVoicePushToTalk(enabled, { env }); } };
	let generation = 0;
	let active: Run | undefined;

	const command = async (ctx: ExtensionCommandContext): Promise<void> => {
		if (env.GENTLE_PI_AGENTS_CHILD === "1") {
			if (ctx.hasUI) ctx.ui.notify("Voice dictation is not available in delegated sessions.", "warning");
			return;
		}
		if (!ctx.hasUI) return;
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Voice dictation requires TUI mode.", "warning");
			return;
		}
		if (active) {
			ctx.ui.notify("Voice dictation is already running. Finish or cancel it first.", "warning");
			return;
		}
		const run: Run = { generation, abort: () => {} };
		active = run;
		try {
			await workflow(ctx, run);
		} catch {
			if (run.generation === generation) ctx.ui.notify("Voice dictation failed.", "error");
		} finally {
			if (active === run) active = undefined;
		}
	};

	const workflow = async (ctx: ExtensionCommandContext, run: Run): Promise<void> => {
		// After a session shutdown the old context is stale: say and paste nothing.
		const live = () => run.generation === generation;
		const say = (message: string, type: "info" | "warning" | "error") => {
			if (live()) ctx.ui.notify(message, type);
		};
		const platform = probe();
		const diagnosis = diagnoseVoicePlatform(platform);
		if (diagnosis.support === "unsupported" || !diagnosis.target) {
			say(diagnosis.limitations[0] ?? "Voice dictation is not supported on this platform.", "error");
			return;
		}
		const target = diagnosis.target;
		const status = await readStatus(target);
		if (!live()) return;
		const runtimeMissing = status.runtime?.state !== "installed";
		const modelMissing = status.model.state !== "installed";
		const pending = (runtimeMissing ? runtimeBytes(target) : 0) + (modelMissing ? modelBytes() : 0);
		const download = `Download voice dictation (about ${megabytes(pending)})`;
		const ready = !runtimeMissing && !modelMissing;
		if (ready) installed = { target, platform: platform.platform };
		else if (installed !== "checking") installed = undefined;
		// Enable is offered only once voice is installed; Disable whenever it is on.
		const pushToTalk = readToggle();
		const toggle = pushToTalk ? [DISABLE_PUSH_TO_TALK] : ready ? [ENABLE_PUSH_TO_TALK] : [];
		const choice = await ctx.ui.select(ready ? "Voice dictation · ready" : "Voice dictation · not installed", ready ? [START, ...toggle, STATUS] : [download, ...toggle, STATUS]);
		if (!live() || !choice) return;
		if (choice === STATUS) say(statusReport(target, diagnosis, status, platform.platform), "info");
		else if (choice === DISABLE_PUSH_TO_TALK || choice === ENABLE_PUSH_TO_TALK) setPushToTalk(ctx, choice === ENABLE_PUSH_TO_TALK, say);
		else if (choice === download) await install(ctx, run, { target, diagnosis, status, platform: platform.platform, runtimeMissing, modelMissing }, say);
		else if (choice === START) await dictate(ctx, run, target, platform.platform, say);
	};

	const install = async (
		ctx: ExtensionCommandContext,
		run: Run,
		plan: { target: VoiceTarget; diagnosis: VoicePlatformDiagnosis; status: VoiceStatusSnapshot; platform: string; runtimeMissing: boolean; modelMissing: boolean },
		say: (message: string, type: "info" | "warning" | "error") => void,
	): Promise<void> => {
		const items = [
			...(plan.runtimeMissing ? [`- Voice runtime for ${plan.target} (sherpa-onnx, node-cpal) from the npm registry: ${megabytes(runtimeBytes(plan.target))}`] : []),
			...(plan.modelMissing ? [`- Parakeet TDT 0.6B v3 int8 model from Hugging Face: ${megabytes(modelBytes())}`] : []),
		];
		const message = [
			`Downloads into ${plan.status.voiceHome}:`,
			...items,
			"Every file is checked against its pinned size and digest. Nothing downloaded is loaded or run during the download.",
			"Licenses and attribution:",
			...noticeLines(),
			"Limitations:",
			...limitationLines(plan.diagnosis, plan.platform),
		].join("\n");
		if (!(await ctx.ui.confirm("Download voice dictation?", message))) {
			say("Voice download skipped; nothing was downloaded.", "info");
			return;
		}
		if (run.generation !== generation) return;
		const controller = new AbortController();
		run.abort = () => controller.abort();
		const overlay = openOverlay(ctx, (theme, requestRender) => new VoiceProgressView({ theme, requestRender, onCancel: () => controller.abort() }));
		const onProgress = (progress: VoiceInstallProgress) => overlay.view()?.update(progress);
		let failure: unknown;
		try {
			if (plan.runtimeMissing) await installRuntime({ target: plan.target, signal: controller.signal, onProgress });
			if (plan.modelMissing && !controller.signal.aborted) await installModel({ signal: controller.signal, onProgress });
		} catch (error) {
			failure = error;
		} finally {
			run.abort = () => {};
			await overlay.close();
		}
		if (controller.signal.aborted) say(INSTALL_MESSAGES.aborted, "info");
		else if (failure !== undefined) say(failure instanceof VoiceInstallError ? INSTALL_MESSAGES[failure.code] : "Voice download failed.", "error");
		else {
			// Push-to-talk is turned on by a successful download (assumption in
			// the task document); the menu turns it off again.
			installed = { target: plan.target, platform: plan.platform };
			let enabled = false;
			try {
				if (run.generation === generation) {
					settings.write(true);
					enabled = true;
					arm(ctx);
				}
			} catch {
				/* push-to-talk stays off; /gentle:voice still dictates */
			}
			say(enabled ? "Voice dictation is installed. Hold Space in the editor to dictate, or run /gentle:voice and choose Start dictation." : "Voice dictation is installed. Run /gentle:voice and choose Start dictation.", "info");
		}
	};

	const dictate = async (ctx: ExtensionCommandContext, run: Run, target: VoiceTarget, platform: string, say: Say): Promise<void> => {
		let overlay: Overlay<VoiceDictationView> | undefined;
		const dictation = runDictation(createSession, target, (state) => overlay?.view()?.setState(state));
		const { session } = dictation;
		run.abort = dictation.cancel;
		overlay = openOverlay(ctx, (theme, requestRender) => {
			const view = new VoiceDictationView({ theme, requestRender, onStop: dictation.stop, onCancel: dictation.cancel });
			// The factory may run after the session has already moved on.
			if (session.state !== "idle") view.setState(session.state);
			return view;
		});
		dictation.start();
		const result = await dictation.outcome;
		run.abort = () => {};
		const tui = overlay.tui();
		await overlay.close();
		if (run.generation !== generation) return;
		deliver(ctx, result, platform, "command", say, () => {
			setTimeout(() => {
				try {
					tui?.requestRender();
				} catch {
					/* best-effort repaint after the overlay teardown */
				}
			}, 0);
		});
	};

	// --- push-to-talk (hold Space) ----------------------------------------------

	interface Armed {
		ctx: ExtensionContext;
		detector: SpaceHoldDetector;
		unsubscribe(): void;
		// The dictation a hold started, until it settles.
		hold?: { release(): void; cancel(): void };
	}
	let armed: Armed | undefined;
	// Learned at the first hold or from the command: a target once voice is
	// known to be installed, "checking" while the lazy check runs.
	let installed: { target: VoiceTarget; platform: string } | "checking" | undefined;

	const readToggle = (): boolean => {
		try {
			return settings.read();
		} catch {
			return false;
		}
	};

	const disarm = () => {
		const current = armed;
		armed = undefined;
		if (!current) return;
		current.detector.dispose();
		try {
			current.unsubscribe();
		} catch {
			/* the input listener is already gone */
		}
	};

	const arm = (ctx: ExtensionContext) => {
		if (armed) return;
		const current: Armed = {
			ctx,
			detector: new SpaceHoldDetector({ readDraft: () => ctx.ui.getEditorText(), onHold: () => startHold(current), onRelease: () => current.hold?.release() }, deps.pushToTalk),
			unsubscribe: () => {},
		};
		armed = current;
		current.unsubscribe = ctx.ui.onTerminalInput((data) => {
			try {
				if (current.hold && !isKeyRelease(data) && matchesKey(data, "escape")) {
					current.detector.end();
					current.hold.cancel();
					return { consume: true };
				}
				return current.detector.handleInput(data);
			} catch {
				return undefined;
			}
		});
	};

	// The first hold of a session checks the install; its spaces keep typing
	// meanwhile. A missing install disarms push-to-talk until it is re-enabled.
	const checkInstalled = async (current: Armed): Promise<void> => {
		const checkGeneration = generation;
		let found: { target: VoiceTarget; platform: string } | undefined;
		try {
			const platform = probe();
			const diagnosis = diagnoseVoicePlatform(platform);
			if (diagnosis.support !== "unsupported" && diagnosis.target) {
				const status = await readStatus(diagnosis.target);
				if (status.runtime?.state === "installed" && status.model.state === "installed") found = { target: diagnosis.target, platform: platform.platform };
			}
		} catch {
			/* an unreadable install counts as not installed */
		}
		if (installed === "checking") installed = found;
		if (checkGeneration !== generation || armed !== current || found) return;
		disarm();
		current.ctx.ui.notify("Push-to-talk is paused: voice dictation is not installed. Run /gentle:voice to download it.", "warning");
	};

	const startHold = (current: Armed): boolean => {
		if (armed !== current || active) return false;
		if (installed === undefined) {
			installed = "checking";
			void checkInstalled(current);
			return false;
		}
		if (installed === "checking") return false;
		const run: Run = { generation, abort: () => {} };
		active = run;
		void holdDictation(current, run, installed.target, installed.platform)
			.catch(() => {
				if (run.generation === generation) current.ctx.ui.notify("Voice dictation failed.", "error");
			})
			.finally(() => {
				if (active === run) active = undefined;
			});
		return true;
	};

	// A hold records into the draft with a footer status instead of an overlay,
	// so the editor keeps the focus. Esc cancels; nothing is ever sent.
	const holdDictation = async (current: Armed, run: Run, target: VoiceTarget, platform: string): Promise<void> => {
		const { ctx } = current;
		const live = () => run.generation === generation;
		const say: Say = (message, type) => {
			if (live()) ctx.ui.notify(message, type);
		};
		const status = (text: string | undefined) => {
			if (!live()) return;
			try {
				ctx.ui.setStatus(STATUS_KEY, text);
			} catch {
				/* the status is display only */
			}
		};
		const dictation = runDictation(createSession, target, (state) => status(pushToTalkStatus(state)));
		run.abort = dictation.cancel;
		current.hold = { release: dictation.stop, cancel: dictation.cancel };
		status(pushToTalkStatus("starting"));
		try {
			dictation.start();
			const result = await dictation.outcome;
			if (live()) deliver(ctx, result, platform, "hold", say);
		} finally {
			run.abort = () => {};
			current.hold = undefined;
			status(undefined);
		}
	};

	const setPushToTalk = (ctx: ExtensionContext, enabled: boolean, say: Say) => {
		try {
			settings.write(enabled);
		} catch {
			say("The push-to-talk setting could not be saved.", "error");
			return;
		}
		if (enabled) {
			arm(ctx);
			say("Push-to-talk is on: hold Space in the editor to dictate, release it to insert the text.", "info");
		} else {
			disarm();
			say("Push-to-talk is off.", "info");
		}
	};

	pi.registerCommand(VOICE_COMMAND_NAME, {
		description: "Local voice dictation with Parakeet: download it once, then record and insert the transcript into the draft (never sent).",
		handler: async (_args, ctx) => command(ctx),
	});
	pi.on("session_start", (_event, ctx) => {
		disarm();
		if (env.GENTLE_PI_AGENTS_CHILD === "1" || !ctx?.hasUI || ctx.mode !== "tui") return;
		if (readToggle()) arm(ctx);
	});
	pi.on("session_shutdown", () => {
		generation++;
		active?.abort();
		disarm();
	});
}
