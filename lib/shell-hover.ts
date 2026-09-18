// One shared hover treatment for every clickable inline text/button surface
// in the shell: the header usage segment, the usage overlay's footer hints,
// the changes modal's rows and controls, and the agents panel. A single role
// swap on hover -- no per-surface variant -- so every clickable text reads
// the same way once the pointer is over it.
//
// This is presentation only. Each surface still tracks its own hovered state
// from its own "move" events (or, where it already uses NativePointerRegion,
// from that region's onHover/onLeave); this module exists so they all paint
// that state identically.
//
// Under tmux, zellij, and screen, pi-tui's alt-screen driver only forwards
// button-motion mouse reports, never plain "move" events (see
// node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js, the input
// parser around its SGR mouse handling), so nothing here ever activates in
// those multiplexers -- there is no hover to paint, and clicking still works
// exactly as before. This is a known platform limitation, not a bug to work
// around here.

export interface HoverTheme {
	fg(role: string, text: string): string;
}

/** The single role every clickable surface uses to paint its own hover. */
export const HOVER_ROLE = "warning";

/** Paint `text` in the shared hover role when `hovered`, unchanged otherwise. */
export function paintHoverable(theme: HoverTheme, text: string, hovered: boolean, idleRole?: string): string {
	if (hovered) return theme.fg(HOVER_ROLE, text);
	return idleRole === undefined ? text : theme.fg(idleRole, text);
}
