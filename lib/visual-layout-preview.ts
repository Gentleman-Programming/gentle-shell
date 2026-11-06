import type { VISUAL_SECTION_KEYS, VisualSettings } from "./visual-customization-policy.ts";

// A four-line schematic of the fullscreen layout for the Customize preview:
// where the header and the input go, whether Status is a rail, a bottom bar
// or hidden, and which rail sections the settings show.

const MAIN = 26;
const RAIL = 22;
/** Rail sections in rail order, named as the rail labels them. */
const RAIL_SECTIONS: ReadonlyArray<[(typeof VISUAL_SECTION_KEYS)[number], string]> = [["todo", "todos"], ["agents", "agents"], ["changes", "changes"], ["rdd", "review"], ["stats", "stats"]];

const fill = (text: string, width: number) => (text.length > width ? text.slice(0, width - 1) + "…" : text + " ".repeat(width - text.length));
const rule = (label: string, width: number) => (label ? `─ ${label} ` : "").padEnd(width, "─").slice(0, width);

export function layoutSchematic(settings: VisualSettings): string {
	const rail = settings.statusPlacement === "right" || settings.statusPlacement === "auto";
	// A split header draws its title row on top and its counters in a bottom status bar.
	const split = settings.headerPlacement === "split";
	const top = settings.headerPlacement === "top" || split;
	// Two rail rows, filled word by word in rail order.
	const railRows = ["", ""];
	let row = 0;
	for (const [key, name] of RAIL_SECTIONS) {
		if (!settings.visibility[key]) continue;
		const next = railRows[row] ? `${railRows[row]} ${name}` : name;
		if (next.length > RAIL - 1 && row === 0) { row = 1; railRows[1] = name; }
		else railRows[row] = next;
	}
	// With a rail, below-input places the bar below both columns, like split.
	const input = top || rail ? "› input" : "› input · header";
	const main = ["conversation", input];
	const width = MAIN + (rail ? RAIL + 1 : 0);
	const railBottomBar = rail && (split || !top);
	const bottom = settings.statusPlacement === "bottom" || railBottomBar ? "status bar" : settings.statusPlacement === "auto" ? "bar under 140 cols" : "";
	if (rail) {
		return [
			top ? `┌${rule(split ? "title" : "header", width)}┐` : `┌${rule("", MAIN)}┬${rule("Status", RAIL)}┐`,
			...main.map((text, line) => `│ ${fill(text, MAIN - 1)}│ ${fill(railRows[line] ?? "", RAIL - 1)}│`),
			railBottomBar ? `└${rule(bottom, width)}┘` : `└${rule(bottom, MAIN)}┴${"─".repeat(RAIL)}┘`,
		].join("\n");
	}
	return [
		`┌${rule(top ? "header" : "", width)}┐`,
		...main.map((text) => `│ ${fill(text, width - 1)}│`),
		`└${rule(bottom, width)}┘`,
	].join("\n");
}
