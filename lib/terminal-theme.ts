const NON_OSC_ANSI_ESCAPE_PATTERN =
	/\x1B\[[0-?]*[ -/]*[@-~]|\x1B[@-Z\\-_]|\x9B[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000b-\u000d\u000e-\u001f\u007f-\u009f]/g;
const OSC_ESCAPE_PATTERN = /(?:\x1B\]|\x9D)[\s\S]*?(?:\x07|\x1B\\|\x9C|$)/g;

export function stripAnsi(value: string): string {
	return stripOsc(value).replace(NON_OSC_ANSI_ESCAPE_PATTERN, "");
}

function stripOsc(value: string): string {
	return value.replace(OSC_ESCAPE_PATTERN, "");
}

export function sanitizeTerminalText(value: string): string {
	return stripAnsi(value).replace(CONTROL_CHAR_PATTERN, "");
}
