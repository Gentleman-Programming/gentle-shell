import { isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { VoiceInstallProgress } from "./voice-install.ts";
import type { VoiceSessionState } from "./voice-session.ts";

// The two compact /gentle:voice overlays: download progress and one dictation.
// They only render state and report keys; the command owns the install and the
// session. After dispose() a view ignores every update and key and never asks
// for a repaint, so a late state change from a closing session is harmless.

export interface VoiceViewTheme {
	fg(role: string, text: string): string;
}

interface VoiceViewOptions {
	theme: VoiceViewTheme;
	requestRender(): void;
	onCancel(): void;
}

const MB = 1_000_000;
const BAR = 24;

const megabytes = (bytes: number) => `${Math.round(bytes / MB)} MB`;

abstract class VoiceView {
	protected disposed = false;
	protected cancelling = false;
	private readonly options: VoiceViewOptions;

	constructor(options: VoiceViewOptions) {
		this.options = options;
	}

	protected get theme(): VoiceViewTheme {
		return this.options.theme;
	}

	protected abstract body(): string[];

	render(width: number): string[] {
		const rule = this.theme.fg("border", "─".repeat(Math.max(0, width)));
		const title = this.theme.fg("accent", "Voice dictation");
		return [rule, title, ...this.body(), rule].map((line) => truncateToWidth(line, Math.max(0, width)));
	}

	invalidate(): void {}

	dispose(): void {
		this.disposed = true;
	}

	handleInput(data: string): void {
		if (this.disposed || isKeyRelease(data)) return;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (this.cancelling) return;
			this.cancelling = true;
			this.repaint();
			this.options.onCancel();
			return;
		}
		this.onKey(data);
	}

	protected onKey(_data: string): void {}

	protected repaint(): void {
		if (this.disposed) return;
		try {
			this.options.requestRender();
		} catch {
			// A dead terminal must not break the voice workflow.
		}
	}
}

export class VoiceProgressView extends VoiceView {
	private progress: VoiceInstallProgress | undefined;

	update(progress: VoiceInstallProgress): void {
		if (this.disposed) return;
		this.progress = progress;
		this.repaint();
	}

	protected body(): string[] {
		const p = this.progress;
		const total = p?.overallTotalBytes ?? 0;
		const received = Math.min(p?.overallReceivedBytes ?? 0, total);
		const ratio = total > 0 ? received / total : 0;
		const filled = Math.round(ratio * BAR);
		const component = p?.component === "model" ? "Parakeet model" : "Voice runtime";
		const phase = p?.phase === "extract" ? "Extracting" : p?.phase === "publish" ? "Finishing" : "Downloading";
		return [
			`${phase} ${component}${p?.item ? ` · ${p.item}` : ""}`,
			`${this.theme.fg("accent", "█".repeat(filled))}${this.theme.fg("dim", "░".repeat(BAR - filled))} ${Math.floor(ratio * 100)}%`,
			total > 0 ? this.theme.fg("muted", `${megabytes(received)} of ${megabytes(total)}`) : "",
			this.theme.fg("dim", this.cancelling ? "Cancelling…" : "esc cancel"),
		];
	}
}

interface VoiceDictationViewOptions extends VoiceViewOptions {
	onStop(): void;
}

const STATE_TEXT: Record<VoiceSessionState, string> = {
	idle: "Preparing the microphone and model…",
	starting: "Preparing the microphone and model…",
	recording: "● Recording · stops by itself after 2 minutes",
	transcribing: "Transcribing locally…",
	finished: "Finishing…",
};

const PUSH_TO_TALK_STATUS: Record<VoiceSessionState, string> = {
	idle: "Voice: preparing… keep holding Space",
	starting: "Voice: preparing… keep holding Space",
	recording: "● Voice: recording · release Space to insert · esc cancel",
	transcribing: "Voice: transcribing…",
	finished: "Voice: finishing…",
};

// The one-line footer status of a push-to-talk dictation. Push-to-talk uses no
// overlay, so the editor keeps the focus and the transcript lands at its cursor.
export function pushToTalkStatus(state: VoiceSessionState): string {
	return PUSH_TO_TALK_STATUS[state];
}

export class VoiceDictationView extends VoiceView {
	private state: VoiceSessionState = "starting";
	private stopping = false;
	private readonly onStop: () => void;

	constructor(options: VoiceDictationViewOptions) {
		super(options);
		this.onStop = options.onStop;
	}

	setState(state: VoiceSessionState): void {
		if (this.disposed || this.state === state) return;
		this.state = state;
		this.repaint();
	}

	protected onKey(data: string): void {
		if (this.state !== "recording" || this.stopping || this.cancelling) return;
		if (!matchesKey(data, "enter") && !matchesKey(data, "return")) return;
		this.stopping = true;
		this.repaint();
		this.onStop();
	}

	protected body(): string[] {
		const status = this.cancelling ? "Cancelling…" : this.stopping && this.state === "recording" ? "Stopping…" : STATE_TEXT[this.state];
		const color = this.state === "recording" && !this.cancelling ? "error" : "muted";
		const hint = this.cancelling ? "" : this.state === "recording" && !this.stopping ? "enter stop and insert · esc cancel" : "esc cancel";
		return [this.theme.fg(color, status), this.theme.fg("dim", hint)];
	}
}
