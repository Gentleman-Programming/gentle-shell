// The Projects list by machine (S14), as Herdr's own `spaces` mod groups spaces: this computer
// first, then every other machine by name, each with its spaces in their order. Pure (no host
// calls): main.js passes `spaces()` and `machines()`; tests/gentle-shell-desktop.test.ts imports it.
//
// machines(): [{ name: null | string, layout: "loading" | "ready" | "unavailable" }] — the
// machine's layout document on this connection (Herdr's AGENTS.md: loading ends on the first read,
// offline machines are unavailable). Machines added with `--temp` are not listed by Herdr.

// The state word a machine header shows, or "" for this computer.
export const STATE_WORD = { loading: "loading…", ready: "ready", unavailable: "unavailable" };

// [{ name, state, spaces }] with `name` null for this computer, or null when every space and
// machine is this computer's (the list then shows no machine headers, as Herdr's).
export function machineGroups(spaceList, machineList) {
  const spacesIn = Array.isArray(spaceList) ? spaceList : [];
  const known = Array.isArray(machineList) ? machineList : [];
  const remote = [...new Set([
    ...spacesIn.map((s) => s?.machine).filter((m) => typeof m === "string" && m),
    ...known.map((m) => m?.name).filter((m) => typeof m === "string" && m),
  ])].sort((a, b) => a.localeCompare(b));
  if (!remote.length) return null;
  const stateOf = (name) => {
    const m = known.find((k) => (k?.name ?? null) === name);
    return m && STATE_WORD[m.layout] !== undefined ? m.layout : name === null ? "ready" : "unavailable";
  };
  return [null, ...remote].map((name) => ({
    name,
    state: stateOf(name),
    spaces: spacesIn.filter((s) => (s?.machine || null) === name),
  }));
}
