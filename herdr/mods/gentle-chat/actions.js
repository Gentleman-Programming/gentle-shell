// Desktop actions (T7, docs/desktop-feed.md "Actions"): what a click in a gentle-* mod asks of a
// live Gentle Shell session, with exactly the authority the person has in the terminal.
//
// CANONICAL COPY, carried byte-identical as `./actions.js` by gentle-chat, gentle-inspector,
// gentle-palette and gentle-status (gpui-shell refuses imports outside a mod's folder). Edit it in
// gentle-chat, then copy it.
//
// Herdr's ambient calls (run, props, setShared) only take effect inside a host call: after an
// await on hc or a file read they are ignored, so callers show the Terminal from a timer callback
// (`cx.timer.after(1, …)`), never straight after the await (T10, seen live).
//
// Three paths, never more:
// - sendAction: drops one action file in the session's private inbox
//   (<agentDir>/desktop/inbox/<session>/<id>.json); the session runs it through the owner the
//   desktop RPC uses (permission mode, cancel job, cancel subagent), its own abort (abort_turn,
//   the TUI's Esc Esc, only while the agent works) or checks that a question is still the open
//   one, and answers in its outbox. The owner decides; a refusal is shown.
// - tuiCommand: types one of the TUI's own slash commands (/gentle:changes, /gentle:agents, …)
//   into the terminal with `hc send`, like the person would, and shows the terminal.
// - confirm: Herdr's own confirm dialog before Super-YOLO and the review switch. Its Confirm runs
//   `<mod>.confirm-<nonce>`, which the mod's command loop hands to `confirmed`; only the newest
//   dialog's nonce runs, so no key binding or script can skip the dialog by naming the command.
//   Consent prompts have no action: the person answers them in the terminal.

import { hc, home, openOverlay, readTextFile, run, writeTextFile } from "herdr";
import { exists } from "fs/promises";
import { createHash, randomUUID } from "crypto";

export const ACTION_SCHEMA = "gentle-shell.desktop-action/v1";
export const RESULT_SCHEMA = "gentle-shell.desktop-action-result/v1";
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const WAIT_MS = 6000; // the session answers within a few ms; a stuck one is reported
const STEP_MS = 80;

// <agentDir>/desktop, agentDir = ~/.gentle-shell/agent (as session.js / snapshot.js).
const desktopDir = () => `${home()}/.gentle-shell/agent/desktop`;
// The session's folder name: lib/desktop-feed-store.ts desktopFeedName.
const folderOf = (sessionId) => (SAFE_ID.test(sessionId) ? sessionId : String(createHash("sha256").update(sessionId).digest("hex")));

const failure = (code, message) => ({ ok: false, error: { code, message } });

// Asks the session to run one action and waits for its answer: { ok, data } or { ok: false, error }.
export async function sendAction(cx, sessionId, kind, args) {
  if (typeof sessionId !== "string" || !sessionId) return failure("no_session", "No Gentle Shell session for this view.");
  const folder = folderOf(sessionId);
  const inbox = `${desktopDir()}/inbox/${folder}`;
  // The session creates its inbox (0700). Without it this Gentle Shell is older than T7; never
  // create it here (writeTextFile would make the folder with the default mode).
  let ready = false;
  try { ready = await exists(inbox); } catch { ready = false; }
  if (!ready) return failure("no_inbox", "This session takes no desktop actions. Update Gentle Shell and restart it.");
  const id = randomUUID();
  const body = { schema: ACTION_SCHEMA, id, sessionId, kind, args, createdAt: new Date().toISOString() };
  try {
    await writeTextFile(`${inbox}/${id}.json`, JSON.stringify(body), null);
  } catch (e) {
    return failure("write_failed", String(e?.message ?? e));
  }
  const answer = `${desktopDir()}/outbox/${folder}/${id}.json`;
  for (let waited = 0; waited < WAIT_MS; waited += STEP_MS) {
    let text = null;
    try { text = await readTextFile(answer); } catch { text = null; }
    if (text) {
      try {
        const r = JSON.parse(text);
        // Mods may write only under the app folder, so the answer stays: the session prunes its
        // outbox (32 answers, 10 minutes) and removes it when it ends.
        if (r?.schema === RESULT_SCHEMA && r.id === id) {
          return r.ok ? { ok: true, data: r.data ?? {} } : { ok: false, error: r.error ?? { code: "failed", message: "The session refused this action." } };
        }
      } catch {
        // still being renamed into place: read it again
      }
    }
    await cx.sleep(STEP_MS);
  }
  return failure("timeout", "The session did not answer. Is it still running?");
}

// One line for an action's error, for the view's inline error text.
export const errorText = (r) => String(r?.error?.message || r?.error?.code || "The action failed.");

// Only these key names, as the session answered them, are ever pressed for a question.
const SAFE_KEYS = new Set(["up", "down", "enter"]);
export const safeKeys = (keys) => Array.isArray(keys) && keys.length > 0 && keys.length <= 80 && keys.every((k) => SAFE_KEYS.has(k));

// Whether the terminal is free to take a slash command: an open question or prompt would take
// the typed text (and its Enter) as its answer.
export function terminalFree(snap) {
  if (snap?.pendingQuestion) return "Answer the open question first.";
  if (snap?.activity?.state === "blocked") return "The session waits for you in the Terminal.";
  return null;
}

// Types one of the TUI's own commands into the session's terminal, then shows the terminal.
// Answers an error line, or null.
export async function tuiCommand(address, snap, command, show) {
  if (!address) return "No Gentle Shell terminal.";
  const busy = terminalFree(snap);
  if (busy) return busy;
  try {
    const r = await hc(["send", address, command]);
    if (r.code !== 0) return (r.stderr || r.stdout || "hc send failed").trim();
  } catch (e) {
    return String(e?.message ?? e);
  }
  show?.();
  return null;
}

// Shows the real terminal: the layout stack's terminal child, and the keyboard on its pane.
export function showTerminal(address, stack = "views", child = "main") {
  try { run("layout.select", { stack, child }); } catch { /* not in the Gentle layout */ }
  if (address) {
    try { run("pane.focus", { terminal: address }); } catch { /* the stack shows it anyway */ }
  }
}

// Herdr's confirm dialog (the shipped `confirm` mod: title, detail, Cancel / Confirm; Enter
// confirms, Esc cancels). `onConfirm(cx)` runs when its command comes back to `mod`.
const pending = new Map();
export function confirm(mod, { title, detail }, onConfirm) {
  const nonce = randomUUID().replace(/-/g, "");
  pending.clear(); // only the newest dialog can confirm
  pending.set(nonce, onConfirm);
  openOverlay({ mod: "confirm", kind: "dialog", modal: true, width: 440, height: 200, props: { title, detail, command: { name: `${mod}.confirm-${nonce}` } } });
}

// For the mod's nextCommand loop: true when `command` was a confirmation (run if it is the live one).
export function confirmed(command, cx) {
  if (!command.startsWith("confirm-")) return false;
  const nonce = command.slice("confirm-".length);
  const fn = pending.get(nonce);
  pending.delete(nonce);
  if (fn) fn(cx);
  return true;
}
