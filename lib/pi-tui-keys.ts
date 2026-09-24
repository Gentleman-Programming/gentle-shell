/**
 * Vendored printable-key decoding for the packed runtime.
 *
 * pi-tui does not export `decodePrintableKey` from its package root, and the
 * packed runtime cannot resolve deep subpath imports such as
 * `@earendil-works/pi-tui/dist/keys.js` (they load as mangled
 * `dist/index.js/dist/keys.js` paths inside downstream projects). The root
 * does export `decodeKittyPrintable`, so only the modifyOtherKeys half is
 * vendored here.
 *
 * Behavior is copied verbatim from @earendil-works/pi-tui dist/keys.js so
 * replacement input decodes exactly like the base editor inserts.
 */
import { decodeKittyPrintable } from "@earendil-works/pi-tui";

const MODIFIERS = {
	shift: 1,
	alt: 2,
	ctrl: 4,
	super: 8,
};

const LOCK_MASK = 64 + 128; // Caps Lock + Num Lock

interface ModifyOtherKeysSequence {
	codepoint: number;
	modifier: number;
}

function parseModifyOtherKeysSequence(data: string): ModifyOtherKeysSequence | null {
	const match = data.match(/^\x1b\[27;(\d+);(\d+)~$/);
	if (!match) return undefined;
	const modValue = Number.parseInt(match[1], 10);
	const codepoint = Number.parseInt(match[2], 10);
	return { codepoint, modifier: modValue - 1 };
}

function decodeModifyOtherKeysPrintable(data: string): string | undefined {
	const parsed = parseModifyOtherKeysSequence(data);
	if (!parsed) return undefined;
	const modifier = parsed.modifier & ~LOCK_MASK;
	if ((modifier & ~MODIFIERS.shift) !== 0) return undefined;
	if (!Number.isFinite(parsed.codepoint) || parsed.codepoint < 32) return undefined;
	try {
		return String.fromCodePoint(parsed.codepoint);
	} catch {
		return undefined;
	}
}

export function decodePrintableKey(data: string): string | undefined {
	return decodeKittyPrintable(data) ?? decodeModifyOtherKeysPrintable(data);
}
