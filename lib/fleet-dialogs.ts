// Fleet member dialogs (odd/tasks/fleet-orchestrator.md T3, S2). The fleet
// answers member dialogs on the human's behalf, except protected classes,
// which code relays to the human: provider consent, security permissions and
// destructive actions. Each class is recognized by an exact, stable marker of
// its producer in this repository (pinned by tests/fleet-dialogs.test.ts);
// anything else is model-answerable. Markers are matched anywhere in the text,
// so a subagent dialog its member relays behind the agents glyph keeps its
// class, and a false positive only sends a question to the human.

export type ProtectedDialogClass = "provider-consent" | "security-permission" | "destructive";

export interface ProtectedDialog {
	class: ProtectedDialogClass;
	marker: string;
}

export interface DialogShape {
	method: string;
	title: string;
	message?: string;
	options?: string[];
}

export type FleetDialogAnswer = { answer: string; cancel?: undefined } | { cancel: true; answer?: undefined };

export type DialogResponse = { value: string } | { confirmed: boolean } | { cancelled: true };

interface Marker extends ProtectedDialog {
	matches(dialog: DialogShape): boolean;
	/**
	 * The approval code may give under the controller's Super YOLO (user, T3
	 * scope addition); absent for classes that always reach the human.
	 */
	approve?(dialog: DialogShape): DialogResponse | undefined;
}

// Case-insensitive, so a recased title cannot slip out of its class.
const inTitle = (text: string) => (dialog: DialogShape) => dialog.title.toLowerCase().includes(text.toLowerCase());
const confirmYes = (dialog: DialogShape): DialogResponse | undefined => dialog.method === "confirm" ? { confirmed: true } : undefined;

const MARKERS: Marker[] = [
	// lib/review-consent-ui.ts:5 (label), :48 (third option); RPC members get the select at :102.
	{ class: "provider-consent", marker: "review consent", matches: dialog => dialog.options?.some(option => option.includes("Review and allow this session")) ?? false },
	// lib/orchestrator-helper-consent.ts:90
	{ class: "provider-consent", marker: "model-cost permission", matches: inTitle("Model-cost permission only:") },
	// extensions/gentle-ai.ts:6498 (both prefixes), :6927, :7014, :9886
	{ class: "destructive", marker: "review authority", matches: dialog => /Authorize (?:destructive )?review authority /.test(dialog.title) },
	// lib/session-messaging-grants.ts:91; least privilege: one message at a time.
	{ class: "security-permission", marker: "cross-orchestrator messaging grant", matches: inTitle("Authorize cross-orchestrator message to "), approve: dialog => dialog.options?.includes("Allow once") ? { value: "Allow once" } : undefined },
	// lib/foreign-target-grants.ts:21
	{ class: "security-permission", marker: "foreign clone grant", matches: inTitle("Authorize foreign clone subagent"), approve: confirmYes },
	// lib/yolo-session-policy.ts:350 (gentle:yolo menu)
	{ class: "security-permission", marker: "YOLO standing permission", matches: inTitle("Gentle YOLO 🔥 — standing permission") },
	// extensions/gentle-ai.ts:1717, :1720, :1721
	{ class: "destructive", marker: "guarded command", matches: inTitle("Allow guarded "), approve: confirmYes },
	// extensions/gentle-ai.ts:2186
	{ class: "destructive", marker: "data-loss command", matches: inTitle("Allow recognized data-loss command?"), approve: confirmYes },
	// extensions/session-scratch.ts:310
	{ class: "destructive", marker: "scratch removal", matches: dialog => /Remove \d+ recorded clones?\/worktrees?\?/.test(dialog.title) },
	// extensions/gentle-ai.ts:5472
	{ class: "destructive", marker: "profile deletion", matches: inTitle("Delete profile?") },
	// extensions/gentle-ai.ts: these overwrite the human's models.json or profiles,
	// which the model cannot write in any mode; the confirm is the human's barrier.
	{ class: "destructive", marker: "model routing restore", matches: inTitle("Restore saved model routing?") },
	{ class: "destructive", marker: "profile overwrite", matches: dialog => inTitle("Replace existing profile?")(dialog) || /^(?:\S+\s+)?apply (?:orchestrator-only |empty )?profile\b.*\?$/i.test(dialog.title.trim()) },
];

// Private material is never approved by code, whatever the mode: the same
// families the Super YOLO directive keeps off limits (lib/yolo-session-policy.ts:16).
const SECRET_PATTERN = /(?:^|[\s/'"=:(~])(?:\.env(?:\.[\w-]+)?|\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.docker|\.npmrc|\.netrc|\.pypirc|auth\.json|id_(?:rsa|dsa|ecdsa|ed25519)|[\w.-]+\.(?:pem|key|p12|pfx)|keychains?|secrets?|credentials?)(?=$|[\s/'"),;:.?|&>])/i;

function markerFor(dialog: DialogShape): Marker | undefined {
	return MARKERS.find(marker => marker.matches(dialog));
}

export function classifyDialog(dialog: DialogShape): ProtectedDialog | undefined {
	const marker = markerFor(dialog);
	return marker && { class: marker.class, marker: marker.marker };
}

export function touchesSecrets(dialog: DialogShape): boolean {
	return SECRET_PATTERN.test([dialog.title, dialog.message ?? "", ...(dialog.options ?? [])].join("\n"));
}

/** The response code gives under Super YOLO, or undefined when the human must decide. */
export function autoApproval(dialog: DialogShape): DialogResponse | undefined {
	if (touchesSecrets(dialog)) return undefined;
	return markerFor(dialog)?.approve?.(dialog);
}

function numbered(options: string[]): string {
	return options.map((option, index) => `${index + 1}. ${option}`).join(" | ");
}

/**
 * The extension_ui_response fields for an answer, per pi-coding-agent
 * docs/rpc-extension-ui.md:176-193: `value` for select/input/editor,
 * `confirmed` for confirm, `cancelled: true` for any dialog.
 */
export function dialogResponse(dialog: { method: string; options?: string[] }, answer: FleetDialogAnswer): { ok: true; response: DialogResponse } | { ok: false; error: string } {
	if (!["select", "confirm", "input", "editor"].includes(dialog.method)) return { ok: false, error: `cannot answer a ${dialog.method} dialog` };
	if (answer.cancel) return { ok: true, response: { cancelled: true } };
	const text = answer.answer;
	switch (dialog.method) {
		case "select": {
			const options = dialog.options ?? [];
			if (options.includes(text)) return { ok: true, response: { value: text } };
			const index = /^\d+$/.test(text.trim()) ? Number(text.trim()) : 0;
			if (index >= 1 && index <= options.length) return { ok: true, response: { value: options[index - 1] } };
			return { ok: false, error: `"${text}" is not one of the offered options: ${numbered(options)}. Answer with the exact option or its number.` };
		}
		case "confirm": {
			const word = text.trim().toLowerCase();
			if (["yes", "y", "true"].includes(word)) return { ok: true, response: { confirmed: true } };
			if (["no", "n", "false"].includes(word)) return { ok: true, response: { confirmed: false } };
			return { ok: false, error: `a confirm dialog takes yes or no, not "${text}"` };
		}
		default:
			return { ok: true, response: { value: text } };
	}
}

/** How an answer reads in the log and the audit. */
export function describeResponse(response: DialogResponse): string {
	if ("cancelled" in response) return "cancel";
	if ("confirmed" in response) return response.confirmed ? "yes" : "no";
	return response.value;
}
