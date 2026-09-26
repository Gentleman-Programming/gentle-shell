import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import promptHistoryExtension from "../extensions/history/index.ts";
import {
  editorOverlayMargin,
  SIDEBAR_OVERLAY_PADDING,
} from "../extensions/history/selector-helpers.ts";
import { projectHash } from "../extensions/history/store.ts";
import {
  installSidebar,
  SIDEBAR_RAIL_COLUMNS,
} from "../lib/shell-sidebar-layout.ts";
import { sidebarPart, sidebarState } from "../lib/shell-sidebar.ts";

// Sidebar-aware overlay margin (restored from Carolina's #1394 work,
// e2cca1f9b^). The history extension reads the terminal-owned sidebar state
// contract (lib/shell-sidebar.ts) without importing gentle-shell; the rail
// width comes from the published `railColumns` field instead of a constant
// duplicated in the history extension.

function terminalWithState(state: unknown): object {
  return {
    [Symbol.for("gentle-pi.experimental-sidebar.state")]: state,
  } as object;
}

const OWNING = {
  active: true,
  ownsHost: () => true,
  railColumns: SIDEBAR_RAIL_COLUMNS,
};

test("the published rail reservation pins the gentle-shell rail geometry (RAIL_WIDTH 50 + GAP 3)", () => {
  assert.equal(SIDEBAR_RAIL_COLUMNS, 53);
});

test("padding constant pins the user-directed 1-column breathing room", () => {
  assert.equal(SIDEBAR_OVERLAY_PADDING, 1);
});

test("returns 0 for absent, primitive, or null terminals", () => {
  assert.equal(editorOverlayMargin(undefined), 0);
  assert.equal(editorOverlayMargin(null), 0);
  assert.equal(editorOverlayMargin(42), 0);
  assert.equal(editorOverlayMargin("terminal"), 0);
});

test("returns 0 when no sidebar state is stored on the terminal", () => {
  assert.equal(editorOverlayMargin({}), 0);
});

test("returns 0 for malformed state shapes", () => {
  assert.equal(editorOverlayMargin(terminalWithState(undefined)), 0);
  assert.equal(editorOverlayMargin(terminalWithState(null)), 0);
  assert.equal(editorOverlayMargin(terminalWithState("active")), 0);
});

test("returns 0 unless active is exactly true AND ownsHost is a function", () => {
  assert.equal(
    editorOverlayMargin(terminalWithState({ ...OWNING, ownsHost: undefined })),
    0,
    "active without ownsHost",
  );
  assert.equal(
    editorOverlayMargin(terminalWithState({ ...OWNING, active: false })),
    0,
    "inactive",
  );
  assert.equal(
    editorOverlayMargin(terminalWithState({ ...OWNING, active: 1 })),
    0,
    "non-boolean truthy active",
  );
  assert.equal(
    editorOverlayMargin(
      terminalWithState({ ...OWNING, ownsHost: "not-a-function" }),
    ),
    0,
    "non-function ownsHost",
  );
});

test("returns 0 unless the sidebar publishes a positive integer rail reservation", () => {
  for (const railColumns of [undefined, 0, -53, 53.5, "53", Number.NaN]) {
    assert.equal(
      editorOverlayMargin(terminalWithState({ ...OWNING, railColumns })),
      0,
      `railColumns ${String(railColumns)}`,
    );
  }
});

test("returns the rail reservation plus padding only while the sidebar owns the host", () => {
  assert.equal(editorOverlayMargin(terminalWithState(OWNING)), 54);
  assert.equal(
    editorOverlayMargin(terminalWithState({ ...OWNING, railColumns: 40 })),
    41,
    "the margin follows the published reservation",
  );
  assert.equal(
    editorOverlayMargin(
      terminalWithState({ ...OWNING, ownsHost: () => false }),
    ),
    0,
    "state present but host not owned (regular mode / unpatched root)",
  );
});

test("a throwing ownsHost degrades to 0 instead of breaking the picker", () => {
  assert.equal(
    editorOverlayMargin(
      terminalWithState({
        ...OWNING,
        ownsHost: () => {
          throw new Error("boom");
        },
      }),
    ),
    0,
  );
});

// ---------------------------------------------------------------------------
// Seam: the real gentle-shell sidebar publishes the reservation it paints.
// ---------------------------------------------------------------------------

const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const shellTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function sidebarHost(columns: number) {
  const root = {
    render: () => ["transcript"],
    invalidate() {},
    [NODE]: () => ({ type: "vstack", entries: [] }),
  };
  const host = {
    mode: "fullscreen",
    terminal: { columns },
    layoutRoot: root,
    requestRender() {},
  };
  const tui = host as unknown as TUI;
  sidebarPart(tui, "footer", {
    render: (_width: number) => ["Status"],
    invalidate() {},
  });
  return { host, tui, root };
}

test("the installed sidebar publishes its rail reservation; the margin tracks the breakpoint", (t) => {
  const { host, tui, root } = sidebarHost(140);
  t.after(installSidebar(tui, shellTheme));
  assert.equal(sidebarState(tui).railColumns, SIDEBAR_RAIL_COLUMNS);
  root[NODE]();
  assert.equal(
    editorOverlayMargin(host.terminal),
    SIDEBAR_RAIL_COLUMNS + SIDEBAR_OVERLAY_PADDING,
    "fullscreen at the breakpoint with a painting rail",
  );
  host.terminal.columns = 139;
  root[NODE]();
  assert.equal(editorOverlayMargin(host.terminal), 0, "below the breakpoint");
});

// ---------------------------------------------------------------------------
// Overlay options: the picker re-reads the margin on every render pass.
// ---------------------------------------------------------------------------

const CWD = "/pi-history-fixtures/project-overlay-margin";

interface OverlayOptions {
  anchor?: string;
  width?: string;
  offsetY?: number;
  margin?: { right: number };
  visible?: (columns: number, rows: number) => boolean;
}

async function captureOverlayOptions(terminal: object): Promise<OverlayOptions> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-margin-"));
  const dir = path.join(root, "projects", projectHash(CWD));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "store.jsonl"),
    `${JSON.stringify({ v: 1, text: "p00", ts: 1_700_000_000_000 })}\n`,
  );
  const commands: Array<[string, { handler: unknown }]> = [];
  promptHistoryExtension(
    {
      on: () => {},
      registerShortcut: () => {},
      registerCommand: (name: string, def: { handler: unknown }) => {
        commands.push([name, def]);
      },
    } as never,
    {
      env: { GENTLE_PI_HISTORY_CAPTURE: "1" },
      gentlePiConfigHome: fs.mkdtempSync(
        path.join(os.tmpdir(), "pi-history-margin-config-"),
      ),
      root,
      cwd: CWD,
      instanceId: "inst-margin",
      agentDir: path.join(root, "agent"),
      sessionsRoot: path.join(root, "sessions"),
    },
  );
  const command = commands.find(([name]) => name === "history");
  assert.ok(command, "the history command must be registered");
  const handler = command[1].handler as (
    args: unknown,
    ctx: unknown,
  ) => Promise<void>;
  let captured: OverlayOptions | undefined;
  const plain = (_color: string, text: string) => text;
  await handler([], {
    ui: {
      notify: (message: string) => assert.fail(`unexpected: ${message}`),
      pasteToEditor: () => {},
      custom: (
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (result: unknown) => void,
        ) => unknown,
        options: { overlayOptions?: OverlayOptions | (() => OverlayOptions) },
      ) => {
        // Mount first, like pi: the factory captures the TUI handle, then
        // the host resolves the overlay options.
        factory(
          { requestRender: () => {}, terminal },
          { fg: plain, bg: plain, bold: (text: string) => text },
          undefined,
          () => {},
        );
        const resolved = options.overlayOptions;
        captured = typeof resolved === "function" ? resolved() : resolved;
        return Promise.resolve(null);
      },
    },
  });
  assert.ok(captured, "the selector must pass overlay options");
  return captured;
}

test("the picker keeps the native full-window overlay without a painting sidebar", async () => {
  const options = await captureOverlayOptions({});
  assert.equal(options.anchor, "bottom-center");
  assert.equal(options.width, "100%");
  assert.equal(options.offsetY, 5);
  assert.equal(options.margin, undefined);
  assert.equal(options.visible?.(200, 50), true);
});

test("the picker margin stays live while the overlay is open", async () => {
  const state = { ...OWNING };
  const options = await captureOverlayOptions(terminalWithState(state));
  assert.deepEqual(options.margin, { right: 54 });
  // Resizing below the breakpoint: pi-tui calls visible() on every render
  // pass, then re-reads margin while resolving the layout.
  state.active = false;
  assert.equal(options.visible?.(139, 50), true);
  assert.equal(options.margin, undefined);
  state.active = true;
  assert.equal(options.visible?.(140, 50), true);
  assert.deepEqual(options.margin, { right: 54 });
});
