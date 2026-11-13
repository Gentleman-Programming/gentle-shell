# Plugin contributions contract (v1)

A Pi package can add rows to `/gentle:customize`, sections to the sidebar rail, and entries to `/gentle:commands` without importing gentle-pi, without knowing a file path inside it, and without depending on extension load order. Those are the three surfaces slice 1 opens; runtime events for delegations, working agents and background jobs are [slice 2](#slice-2-is-not-in-this-contract) and are not described here.

Source map: [contract](../lib/plugin-contract.ts) (the only stable surface), the read points in [the palette](../lib/command-palette-catalog.ts) and [the sidebar rail](../lib/shell-sidebar.ts), the customize read point in [the shell extension](../extensions/gentle-shell.ts), and the audit command `/gentle:plugins`.

## Why a symbol, not an import

Pi evaluates every extension with `moduleCache: false`. Two packages that both expect gentle-pi's module see two separate evaluations of it, so no module-level export can be the meeting point: whatever one instance holds, the other never sees. The only thing two evaluations share in one process is `globalThis`, and the only collision-free key on it is a `Symbol.for` key, because `Symbol.for` interns by description across module instances.

The contract box is therefore:

```javascript
globalThis[Symbol.for("gentle-pi.contributions/v1")] // a Map<string, Contribution>
```

Three consequences a plugin author relies on:

- **The box is yours to create.** A plain `Map` already installed under that symbol is adopted, never replaced; if nothing is there, the first writer or the first reader creates it. A plugin needs nothing but the symbol and `Map`.
- **Contributions are read at use time.** The customize panel, the sidebar and the palette call the reader when they open or render, not at import time. A contribution registered before or after gentle-pi's own extensions is equally visible, so load order cannot decide whether your row appears. Fill the box once, in `session_start`, before the panel is used.
- **Entries are keyed by their namespaced id.** The map key must equal `Contribution.id`, and once gentle-pi has adopted the box a later `set` on an id it already holds is refused rather than applied: the first value stays, so no package can replace another package's contribution by reusing its id. [The id rules below](#ids-keys-and-the-contract-version) say from which moment that promise holds and what it cannot cover.

The same process-wide-symbol pattern already carries gentle-pi's own cross-evaluation state (for example `Symbol.for("gentle-pi.resume-hint")`); plugins use the public box instead of reaching for those.

## The contract

Every entry in the box is a `Contribution`. These are the exact shapes the reader accepts today:

```typescript
export interface Contribution {
	id: string;
	owner: string;
	contract: number;
	rows?: PluginRow[];
	sidebar?: PluginSidebarSection;
	palette?: PluginPaletteCommand;
}

export interface PluginRow {
	category: string;
	label: string | (() => string);
	preview?: () => PluginRowPreview;
	choice?: PluginRowChoice;
	visible?: () => boolean;
	action(): void | Promise<void>;
}

export interface PluginRowPreview {
	title: string;
	sample: string;
}

export interface PluginRowChoice {
	setting: string;
	value: string;
	current(): boolean;
	hint?: string;
	applyOnMove?: boolean;
}

export interface PluginSidebarSection {
	key: string;
	bottom: boolean;
	rail: unknown;
}

export interface PluginPaletteCommand {
	command: string;
	/** Optional: missing, empty or blank means the palette derives a group from the owner. */
	group?: string;
}
```

`PluginRow` is deliberately not the panel's internal row type. The customize read point adapts a contributed row into a core row, so this slice can grow without exposing gentle-pi internals, and v1 rows have no shortcut key or audio hint of their own. A contributed `action` is called with no arguments, may be async, and is handed no gentle-pi object: the box passes nothing but your own closure. That is a rule, not a barrier — the reader calls your function in gentle-pi's own process, so a closure can open a dialog or write any file that process can, and nothing in this reader prevents it. The contract's rule is that a contribution must not write a gentle-pi preference file and must not open its own dialog; a review refuses a plugin that does.

The row's query slots are synchronous: `label` (when it is a function), `preview`, `visible` and `choice.current` must answer immediately. A `label` that returns a promise drops its row, because a promise cannot fill a row the panel is painting right now. A `choice.setting` is namespaced under your contribution id (as `<id> · <setting>`), so a plugin switch can never merge into a built-in setting line; consecutive contributed rows that share a `setting` render as one line with their values inline.

`PluginSidebarSection.rail` is opaque to the reader: it must be a mounted Pi component (anything with a `render(width)` function), and `bottom` travels with it unchanged — contributed sections are appended after the core keys, in the order the [declared owner order](#declared-owner-order) gives them.

### Ids, keys and the contract version

- `id` is `<owner>.<name>`: both sides non-empty, `owner` is the text before the first dot, and the name may contain more dots. `demo.hello` and `demo.panel.status` are both valid; `.hello`, `demo.` and `demohello` are not.
- `id` must equal the map key it is stored under and must agree with the declared `owner`. The reader rejects a mismatch instead of repairing it.
- A sidebar `key` is `plugin:<owner>:<name>`, with the same owner as the contribution. `todo`, `jobs`, `agents`, `footer` (the rail sections), `header` and `statusbar` are reserved and read-only for plugins, and an unnamespaced key is refused.
- `contract` is exactly `1`. It is the only version this reader accepts; another value is never guessed at, downgraded or upgraded.

First-wins is a promise about a box gentle-pi has adopted, not about any `Map` that carries the symbol. The first time gentle-pi reads the box it adopts the one already installed, or creates it when nothing is there, and replaces `set` with the refusing wrapper; from that moment a later `set` for an id the box already holds writes nothing, so the first value stays, a different object — even one whose contents are identical — is reported as `duplicate-id`, and re-setting the stored reference only marks the id replaced. Before adoption there is nothing that could keep two values: a plain `Map` keeps the last write, so an id a package set twice before gentle-pi read the box has already lost its first value, and the reader can neither recover it nor report it, while writing through `Map.prototype.set.call` on an adopted box bypasses the wrapper the same way. The guarantee therefore rests on the rule above — ids are namespaced per owner — plus one practice: set an id exactly once, and leave the box the only writer.

### Fail-closed reporting

The reader validates each entry on its own. A contribution whose payload is partly malformed is still loaded, with only the bad payload dropped; an entry that fails identity or version is skipped entirely. A property read that throws — a plugin getter that raises — refuses the whole entry, because the reader cannot tell what the rest of the object would have answered. Every refusal is recorded with the id it was stored under and one of these codes:

| Code | Meaning |
| --- | --- |
| `invalid-contribution` | The stored value is not an object, or reading one of its properties threw. |
| `incompatible-contract` | `contract` is not `1`. |
| `invalid-id` | `id` is not namespaced, does not equal the map key, or disagrees with `owner`. |
| `duplicate-id` | Once gentle-pi has adopted the box, a later `set` for an id it already holds passed a different object than the stored one, so it was refused and the first contribution stays. A write made before adoption, or one made through `Map.prototype.set.call`, never reaches the wrapper and is not reported. |
| `malformed-rows` | `rows` is not an array of well-formed rows: every row needs `category`, `label` and `action`, and every optional field must have its declared type. |
| `malformed-sidebar` | The key is reserved, unnamespaced, owned by someone else, or the rail does not render. |
| `malformed-palette` | `palette` lacks a non-empty `command`, or carries a `group` that is not a string. |

From adoption on, a later `set` on an existing id is refused, and the box keeps the first contribution under that id: re-registering an id never replaces what is already there, so a package cannot take over another package's contribution. A refusal whose value is a different object than the stored one is reported as `duplicate-id` on every later read; re-setting the very same reference marks the id as replaced but is not a duplicate. A read records both lists. Skipped entries and replaced ids are shown by `/gentle:plugins`, and `/gentle:customize` additionally raises a warning notice whose text starts with `Plugin <id>:` when it refuses a row. The report is an audit trail, never a second source of truth.

Every contributed callback — `label`, `preview`, `visible`, `choice.current`, `action`, and a rail's `render`, `digest` and `invalidate` — runs through a guard. A callback that throws, or a promise that rejects, degrades to what that read point can render and is reported: a throwing `label` drops its own row (it is not shown with a placeholder), a throwing `preview` shows `Plugin preview unavailable` instead, a throwing `visible` hides the row, and a throwing `choice.current` reads as `false`. A throwing rail `render` paints an empty section and a throwing rail `digest` reads as no digest; the sidebar seam records both, and a throwing `invalidate` too, under `invalid-contribution`, so the audit can say the rail misbehaved. An async `action` is still awaited. A broken plugin degrades its own row or section; it never takes the panel down with it.

### How each read point appends

| Read point | What it does with a valid contribution |
| --- | --- |
| Customize (`/gentle:customize`) | Appends your rows after the built-in rows of the category you name. A category the panel does not know yet starts its own category after the built-in ones, so `Reset` keeps its place. |
| Sidebar rail | Installs your `plugin:<owner>:<name>` rail into the shared parts map, so the layout paints it after `todo`, `jobs`, `agents` and `footer`. A contribution you withdraw is retired on the next read. |
| Command palette (`/gentle:commands`) | Appends a registered command that the curated catalog does not list into the group you name, creating that group after the catalog groups when it is new; a missing, empty or whitespace-only group name falls back to `Plugins · <owner>`. The row's label is the command name and its description comes from your registration. |

A palette entry naming a command that is not registered, or one the catalog already lists, adds nothing: the palette stays a curated menu, never a dump of every registered command. When two contributions name the same command, the first one read owns its group.

### Declared owner order

`plugins.json` in gentle-pi's config directory (`GENTLE_PI_CONFIG_HOME`, else `~/.pi/gentle-ai`) names owners, never ids, and decides the order the read points present contributions in. Each read reads it at use time, never a cached copy, so an edit takes effect on the next read without a reload. Exactly two keys, this schema and this shape:

```json
{ "schema": "gentle-pi.plugins/v1", "order": ["acme", "demo"] }
```

An owner the file names is presented first, in the order the file gives; every owner it does not name keeps the box's registration order after the named ones. A missing file, or one that is unreadable, not JSON or wrongly schemated, means registration order. gentle-pi only reads this file and never writes it, so a hand edit can break the order but never a read point.

### With an empty box

With an empty box the customize panel, the sidebar rail and the palette contribute nothing: no plugin row, section or command appears, and no built-in row, rail key or catalog entry is moved or replaced. That no-op promise covers plugin-contributed content only. Slice 1 also adds the built-in `/gentle:plugins` command, and its catalogued palette row (`Plugins · contribution audit`, in the `Diagnostics` group) is present whether the box is empty or not.

## An example plugin

This is a complete Pi extension: it imports nothing from gentle-pi, names no gentle-pi path, and keeps its state in its own file. It contributes one customize row and registers the command that the row and the palette share.

```javascript
// ~/.pi/agent/extensions/gentle-demo.js — a Pi extension, not a gentle-pi file.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONTRIBUTIONS = Symbol.for("gentle-pi.contributions/v1");

// This plugin's own state file. Never gentle-pi's preferences.
const AGENT_HOME = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const STATE_FILE = join(AGENT_HOME, "gentle-demo.json");

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(next) {
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
}

function toggle(ctx) {
  const next = { ...readState(), on: readState().on !== true };
  writeState(next);
  ctx.ui.notify(`Demo row is ${next.on ? "on" : "off"}`, "info");
}

export default function gentleDemo(pi) {
  pi.registerCommand("demo:toggle", {
    description: "Toggle the demo plugin row",
    handler: (_args, ctx) => toggle(ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    const box = globalThis[CONTRIBUTIONS] instanceof Map
      ? globalThis[CONTRIBUTIONS]
      : new Map();
    globalThis[CONTRIBUTIONS] = box;
    // The first value this process stored is the one that answers.
    if (box.has("demo.hello")) return;

    box.set("demo.hello", {
      id: "demo.hello",
      owner: "demo",
      contract: 1,
      rows: [
        {
          category: "Community",
          // Read on every render, so the row shows live state.
          label: () => `Demo row: ${readState().on === true ? "on" : "off"}`,
          // Never show a row whose action would refuse to run.
          visible: () => true,
          action: () => toggle(ctx),
        },
      ],
      palette: { command: "demo:toggle", group: "Community" },
    });
  });
}
```

`session_start` is where the box is filled, because Pi may load an extension without starting a session, and because a session is where a live `ctx` exists. It also comes after gentle-pi has adopted the box: Pi loads every extension before it starts a session, and gentle-pi claims the box while it loads, so the refusing `set` is already installed when this handler runs.

Fill the box once per process: the entry the process stored first is the one that answers, and `has` is how a plugin honours that rule. The guard above returns before `set` once `demo.hello` is in the box, so only the first `session_start` of the process registers anything, and later sessions raise no refusal — the first entry, with the `ctx` it closed over, stays live. Leave the guard out and the second session calls `set` with a different object, which is refused: the id appears in `/gentle:plugins` under replaced ids, with a `duplicate-id` refusal, while the first entry still answers. Re-setting the very same reference only marks the id as replaced. A `duplicate-id` in `/gentle:plugins` therefore means a plugin is missing its guard, not that gentle-pi misplaced its contribution.

## What a plugin may touch

| Surface | Access | Why |
| --- | --- | --- |
| Customize rows (`rows`) | allowed | Appended after the built-in rows in the category you name; nothing core is replaced or reordered, so an empty box and a full box show the same base panel. |
| Sidebar sections (`sidebar`) | allowed | Appended after the four core keys with a `plugin:<owner>:<name>` key, so a plugin can never occupy `todo`, `jobs`, `agents`, `footer`, `header` or `statusbar`. |
| Palette entries (`palette`) | allowed | Appended after the curated catalog for a command you registered; a command the catalog already names is not listed twice. |
| Its own settings files | allowed, required | A plugin persists only its own state, so a plugin update cannot corrupt a gentle-pi preference and a preference redesign cannot break a plugin. |
| Agent status records | read-only | Writing them would forge a working/blocked/idle claim that another view renders as truth about a session that is not yours. |
| Published runtime documents (activity, presence) | read-only | These are observations gentle-pi publishes for its own panels; writing them would make a plugin's guess indistinguishable from a measured state. |
| Mounted components | read-only, decorational | Decoration is additive rendering; changing another component's state reaches into a surface whose invariants the plugin does not know. |
| Review approval and standing permission | never | A plugin that could approve its own work removes the independent check, and everyone who trusted that check. |
| Permission modes (Normal/Auto/YOLO/Super Yolo) | never | Raising the mode grants standing permission for tool calls the user never saw; that decision belongs to the human at the keyboard. |
| Auto-permission classification and the hard-deny list | never | A plugin could turn a deny into an allow, which is exactly the boundary the classifier exists to hold. |
| YOLO and RDD mode | never | These select how work is authorized and verified; a plugin changing them would rewrite the terms of the session mid-task. |
| Child safety | never | It bounds what a delegated child may do; a plugin editing it could widen every later child's authority. |
| The scratch ledger | never | Scratch accounting is what makes cleanup decisions safe; a plugin writing it could hide or claim files that are not its own. |
| Session profile freeze and binding | never | The freeze pins the model and agent configuration a session started with; changing it mid-session makes results unattributable. |
| Model routing and pins | never | Routing decides which provider sees the work and which cost is charged; a plugin rerouting it spends someone else's budget. |
| Background job guards | never | The guard is what stops a "job" from becoming an unattended destructive command. |
| The `gentle-ai` binary | never | It performs privileged installation and environment work; a plugin invoking or replacing it can change the machine outside the workspace. |
| Worktree identity | never | Worktree ownership decides which checkout a unit of work edits; a plugin claiming it could direct edits into another unit's tree. |

These exclusions are the audit's authority boundary, and this slice touches none of them. A plugin that reaches for one is not contributing to the panel; it is changing the harness, and review rejects it.

## House rules for plugin authors

- **Append, never replace.** Contribute your own ids, rows, sections and commands. Do not wrap, shadow, reorder or delete a core row, a core rail key, a catalog entry or another plugin's entry.
- **Core names are read-only.** `todo`, `jobs`, `agents`, `footer`, `header` and `statusbar` are the rail's; `gentle:*` command names, the curated palette catalog and the built-in customize categories are gentle-pi's. Put your own namespaced name next to them.
- **Fail closed.** Declare `contract: 1`. An unknown version, a malformed payload or a throwing callback is skipped and reported, never guessed at, so an old plugin stays visible as skipped instead of being half-applied.
- **Your state is yours.** Persist in your own file, under your own keys, in your own format. Read gentle-pi's published state; do not write it, and never write a gentle-pi preference file to remember your own setting.
- **Do not monkey-patch `ctx.ui`.** Replacing a `ctx.ui` setter swaps the shared renderer for every extension in the process: your wrapper silently swallows another extension's `setStatus` or `notify` call, and `/gentle:plugins` reports the replacement. Use the box, or the `ctx.ui` methods the host already gives you.

## The stability promise

v1 is the **shape and the behavior**, not a file path and not a handler location: `lib/plugin-contract.ts` may be split, moved or re-exported, and a read point may be refactored, without that being a contract change. What is promised is what a plugin author observes — your row appears in customize under the category you named with the label and action you supplied, your section appears in the rail after the core keys, your command appears in the palette, and a rejected contribution is reported instead of applied. Everything reachable only through gentle-pi's own code (internal row types, panel internals, file layouts) is not part of v1.

The promise is enforced, not just stated: each read point carries one canary test that fails CI when its seam is dropped, so a refactor that removes the customize, sidebar or palette read — or stops guarding contributed callbacks — cannot land quietly. When a concept genuinely changes, the new version is added under its own symbol (the next one would be `gentle-pi.contributions/v2`) and v1 keeps being read for a full cycle, so a plugin that declares `contract: 1` is never retired by surprise.

## What a plugin cannot do, and why

The contract's authority is deliberately narrow: a plugin may add things to what the human sees and may keep its own state, and nothing more. Approvals, permission modes, the hard-deny list, YOLO and RDD mode, child safety, the scratch ledger, session-profile freeze and binding, model routing and pins, background job guards, the `gentle-ai` binary and worktree identity are excluded on purpose, not by omission. Each of them decides *whether* or *with what authority* work happens; a plugin that could reach one could grant itself permission the user never gave, or make an unattributable change look measured. Review will reject a plugin that touches them, so keep to the box.

## Slice 2 is not in this contract

Runtime state — delegations, working agents, background jobs and monitors — is the next slice's subject (`delegation/*` and `job/*` events). Slice 1 does not expose those events, does not reserve their payloads and does not claim they exist. Until slice 2 lands, a plugin that wants to display such state reads the published documents listed as read-only above.
