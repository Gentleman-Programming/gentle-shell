import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerVoiceCommand, type VoiceCommandDeps } from "../lib/voice-command.ts";

// Gentle Voice: /gentle:voice owns optional local dictation (docs/voice.md).
// Loading this extension registers the command and, when the push-to-talk
// toggle is on, a hold-Space listener at session start. Nothing is probed,
// downloaded, loaded or recorded until the user runs the command or holds Space.

export default function gentleVoice(pi: ExtensionAPI, deps: VoiceCommandDeps = {}): void {
	registerVoiceCommand(pi, deps);
}
