import { stripAnsi } from "../lib/terminal-theme.ts";

// Test-only readers for Drakonc AI cards: the title text in the top rule,
// the tone tag around it (with tagged fake themes), and the body between
// the rules with the frame removed. They accept both plain and tagged output.

const TAG = /<\/?[a-zA-Z]+>/g;
const EDGE_LEFT = /^(?:<[a-zA-Z]+>)?│(?:<\/[a-zA-Z]+>)? ?/;
const EDGE_RIGHT = / ?(?:<[a-zA-Z]+>)?│(?:<\/[a-zA-Z]+>)?$/;

function plain(line: string): string {
	return stripAnsi(line).replace(TAG, "");
}

export function cardTitle(rendered: string): string {
	const first = rendered.split("\n")[0] ?? "";
	return plain(first).replace(/^╭─ /, "").replace(/ ─+(?: .* )?╮$/, "").trim();
}

export function cardTone(rendered: string): string | undefined {
	// Avisos y tarjetas propias llevan el mismo dragón; el título nombra el
	// producto (`Drakonc AI`) o la operación (`rdd`/`drakonc-ai`).
	return (rendered.split("\n")[0] ?? "").match(/<([a-zA-Z]+)>(?:🐉 (?:Drakonc AI<|(?:rdd|drakonc-ai)\b))/u)?.[1];
}

export function cardBody(rendered: string): string {
	return rendered
		.split("\n")
		.filter((line) => !/^[╭╰]/.test(plain(line)))
		.map((line) => line.replace(EDGE_LEFT, "").replace(EDGE_RIGHT, "").trimEnd())
		.join("\n");
}

export function cardHint(rendered: string): string | undefined {
	const first = rendered.split("\n")[0] ?? "";
	return plain(first).match(/ ─+ (.+) ╮$/)?.[1];
}
