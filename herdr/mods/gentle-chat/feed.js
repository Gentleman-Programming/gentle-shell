// Turns Gentle Shell (pi) session JSONL lines into chat items. Pure: no host calls.
//
// Items:
//   { kind: "user", id, text, time }  (time: "14:02", local, or null)
//   { kind: "assistant", id, blocks: [{ type: "text", text } | { type: "thinking", text }
//       | { type: "tool", call }], cost, model, error, seconds }
//       (seconds: how long the message took, entry write time − message start, or null)
//   { kind: "note", id, text, type }  (a custom message the session displays; type: its customType)
//   { kind: "note", id, text, type, label, system: true }  (a user-role message the runtime wrote,
//       not the person: a Gentle Agents wake, a harness note; drawn as one closed notice row)
//   { kind: "skill", id, name, text }  (a skill the person invoked: pi's <skill> block, before the
//       message typed with it, which follows as its own user item)
//   { kind: "compaction", id, summary, tokens } (the context was compacted from `tokens` tokens)
//   { kind: "branch", id, summary }    (a branch summary: what the abandoned path did)
// Tool calls: { id, name, args, summary, result: null | { text, error, ms, patch, agent } } kept
// in `feed.tools` so a later toolResult line fills in the card that is already drawn.
// `patch`: an edit's unified diff (details.patch); `agent`: a subagent_run's
// details.gentleAgents ({ taskId, agent, status, model, lastStep, ... }).

export function createFeed() {
  return { items: [], tools: new Map(), wakes: new Set(), model: null, provider: null, thinking: null, name: null, total: 0, cwd: null, seq: 0 };
}

// User-role messages the runtime writes (S11: never a "You" bubble). Structured first: Gentle
// Agents persists a `custom` entry `gentle-agents.wake-identity` ({ sessionId, nonce, text })
// before it sends the Claude Bridge wake, and the TUI hides the user message whose text is that
// identity's (extensions/gentle-agents.ts restoreBridgeWakeIdentity). A wake whose identity is
// outside the read tail, and the other runtime texts, are known by the exact prefixes the
// harness gives them (gentle-agents.ts PARENT_WAKE_TEXT, lib/reply-language-anchor.ts).
export const WAKE_IDENTITY_TYPE = "gentle-agents.wake-identity";
const WAKE_PREFIX = "[System-generated Gentle Agents notification, not written by the user]";
const SYSTEM_PREFIX = /^\[System-generated ([^\]]*?)(?: notification)?, not written by the (?:user|human)\]\s*/;
const HARNESS_PREFIX = "[Harness note, not written by the human]";

// { label, type, text } for a runtime-written user message, or null for the person's own.
export function systemMessage(feed, text) {
  const t = String(text ?? "").trim();
  const body = (s) => s.replace(/\s*\[gentle-agents wake: [0-9a-f-]+\]\s*$/i, "").trim();
  if (feed?.wakes?.has(t) || t.startsWith(WAKE_PREFIX)) {
    return { label: "Gentle Agents · wake", type: "gentle-agents.wake", text: body(t.startsWith(WAKE_PREFIX) ? t.slice(WAKE_PREFIX.length) : t) };
  }
  if (t.startsWith(HARNESS_PREFIX)) return { label: "Harness note", type: "harness-note", text: t.slice(HARNESS_PREFIX.length).trim() };
  const m = SYSTEM_PREFIX.exec(t);
  if (m) return { label: `${m[1].trim() || "System"} · notice`, type: "system", text: body(t.slice(m[0].length)) };
  return null;
}

const textOf = (content) =>
  typeof content === "string"
    ? content
    : (content ?? []).filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n");

// The one line beside a tool's name in the minimal view (S11, S15): what the call does, in words,
// never the JSON of its arguments (the open row shows them whole). Known tools say it their way;
// any other tool: the usual keys first, else its first string value (depth-first, bounded).
const str = (v) => (typeof v === "string" && v.trim() ? v : null);
const more = (list) => (list.length > 1 ? ` (+${list.length - 1} more)` : "");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const COMMON_KEYS = ["command", "path", "file_path", "pattern", "query", "url", "prompt", "task", "description"];

// The first string anywhere in a value (objects in key order, arrays in order), or null.
function firstString(value, depth = 0) {
  if (str(value)) return value;
  if (depth > 4 || value == null || typeof value !== "object") return null;
  for (const v of Array.isArray(value) ? value.slice(0, 20) : Object.values(value).slice(0, 40)) {
    const found = firstString(v, depth + 1);
    if (found) return found;
  }
  return null;
}

// todo: "write · 3 tasks, 1 in progress", "update #2 → done", "add · <title>", "list".
function todoSummary(a) {
  const action = str(a.action) ?? "todo";
  if (Array.isArray(a.tasks)) {
    const live = a.tasks.filter((t) => t?.status === "in_progress").length;
    return `${action} · ${plural(a.tasks.length, "task")}${live ? `, ${live} in progress` : ""}`;
  }
  const id = Number.isInteger(a.id) ? ` #${a.id}` : "";
  const status = str(a.status) ? ` → ${a.status}` : "";
  const title = str(a.title) ? ` · ${a.title}` : "";
  return `${action}${id}${status}${title}`;
}

// codemode: its first line that is code (not blank, not only a comment).
function codeLine(code) {
  const lines = String(code ?? "").split("\n").map((l) => l.trim());
  return lines.find((l) => l && !/^(\/\/|\/\*|\*|#)/.test(l)) ?? lines.find(Boolean) ?? "";
}

function describe(name, a) {
  const n = String(name ?? "");
  if (n === "todo") return todoSummary(a);
  if (n === "ask_user_choice") return str(a.question) ?? "";
  if (n === "ask_user_question") {
    const qs = Array.isArray(a.questions) ? a.questions : [];
    const first = str(qs[0]?.question) ?? str(qs[0]?.header);
    return first ? first.split("\n").find((l) => l.trim()) + more(qs) : "";
  }
  if (n === "subagent_run") {
    const what = str(a.label) ?? str(a.task) ?? str(a.prompt);
    return [str(a.agent), what && firstLine(what)].filter(Boolean).join(" · ");
  }
  if (n === "bash_background" || n === "monitor") return str(a.label) ?? str(a.command) ?? "";
  if (n.startsWith("job_")) return str(a.job_id) ?? str(a.id) ?? "";
  if (n === "web_search") {
    const qs = Array.isArray(a.queries) ? a.queries.filter(str) : [];
    return str(a.query) ?? (qs.length ? qs[0] + more(qs) : "");
  }
  if (n === "fetch_content") {
    const us = Array.isArray(a.urls) ? a.urls.filter(str) : [];
    return str(a.url) ?? (us.length ? us[0] + more(us) : "");
  }
  if (n.startsWith("mem_")) {
    const named = str(a.title) ?? str(a.query) ?? str(a.topic_key) ?? str(a.project);
    if (named) return named;
    return a.id != null && a.id !== "" ? `#${a.id}` : "";
  }
  if (n === "codemode" || n.endsWith("__codemode")) return codeLine(a.code ?? a.script);
  if (n.startsWith("gentle_review")) return str(a.operation) ?? str(a.action) ?? "";
  return null;
}

export function summarize(name, args) {
  if (args == null) return "";
  if (typeof args === "string") return firstLine(args);
  if (typeof args !== "object") return firstLine(String(args));
  const said = describe(name, args);
  if (said !== null) return firstLine(said);
  for (const key of COMMON_KEYS) if (str(args[key])) return firstLine(args[key]);
  return firstLine(firstString(args) ?? "");
}

const firstLine = (s) => {
  const line = String(s).split("\n").find((l) => l.trim()) ?? "";
  return line.length > 140 ? line.slice(0, 139) + "…" : line;
};

// Adds the complete lines in `text` to the feed. Bad lines are skipped, never thrown.
// A feed can describe a session this view cannot read: another agent publishes the same
// snapshot without a Pi session file. The chat then has no transcript, and falling back to the
// terminal's folder would read a different session's.
export const hasTranscript = (identity) =>
  typeof identity?.sessionFile === "string" && identity.sessionFile.endsWith(".jsonl");

export function ingest(feed, text) {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    ingestEntry(feed, entry);
  }
}

function ingestEntry(feed, e) {
  const id = e.id ?? `seq-${feed.seq}`;
  feed.seq++;
  const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
  switch (e.type) {
    case "session":
      feed.cwd = e.cwd ?? feed.cwd;
      return;
    case "model_change":
      feed.model = e.modelId ?? feed.model;
      feed.provider = e.provider ?? feed.provider;
      return;
    case "thinking_level_change":
      feed.thinking = e.thinkingLevel ?? feed.thinking;
      return;
    case "session_info":
      if (typeof e.name === "string") feed.name = e.name;
      return;
    case "custom":
      if (e.customType === WAKE_IDENTITY_TYPE && typeof e.data?.text === "string" && typeof e.data?.nonce === "string"
        && e.data.text.includes(e.data.nonce)) feed.wakes.add(e.data.text.trim());
      return;
    case "custom_message":
      if (e.display) {
        const t = textOf(e.content).trim();
        if (t) feed.items.push({ kind: "note", id, text: t, type: typeof e.customType === "string" ? e.customType : null });
      }
      return;
    case "compaction":
      if (typeof e.summary === "string") feed.items.push({ kind: "compaction", id, summary: e.summary, tokens: Number.isFinite(e.tokensBefore) ? e.tokensBefore : null });
      return;
    case "branch_summary":
      if (typeof e.summary === "string" && e.summary.trim()) feed.items.push({ kind: "branch", id, summary: e.summary });
      return;
    case "message":
      return ingestMessage(feed, id, e.message ?? {}, at);
    default:
      return;
  }
}

const PATCH_MAX = 200_000; // characters of a diff kept per edit

// pi's hideThinkingBlock for a session: its project settings (<cwd>/.pi/settings.json) over its
// agent dir's settings.json, as pi's SettingsManager merges them; false when neither says.
export function hideThinkingFrom(globalText, projectText) {
  const read = (t) => {
    try {
      const v = JSON.parse(t ?? "");
      return typeof v?.hideThinkingBlock === "boolean" ? v.hideThinkingBlock : undefined;
    } catch {
      return undefined;
    }
  };
  return read(projectText) ?? read(globalText) ?? false;
}

// pi's parseSkillBlock (core/agent-session.js): { name, content, message } or null.
export function skillBlock(text) {
  const m = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/.exec(String(text ?? ""));
  return m ? { name: m[1], content: m[3], message: m[4]?.trim() ?? "" } : null;
}

// "14:02" for an epoch ms, local time; null when unknown.
export function clock(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function ingestMessage(feed, id, m, at) {
  if (m.role === "user") {
    let t = textOf(m.content).trim();
    const time = clock(Number.isFinite(m.timestamp) ? m.timestamp : at);
    const sys = systemMessage(feed, t);
    if (sys) {
      feed.items.push({ kind: "note", id, text: sys.text || t, type: sys.type, label: sys.label, system: true, time });
      return;
    }
    // A skill invocation: the TUI draws its block as one "[skill] name" line and the typed
    // message, if any, as the user's own (pi's parseSkillBlock).
    const skill = skillBlock(t);
    if (skill) {
      feed.items.push({ kind: "skill", id: `${id}-skill`, name: skill.name, text: skill.content });
      t = skill.message;
    }
    if (t) feed.items.push({ kind: "user", id, text: t, time });
    return;
  }
  if (m.role === "assistant") {
    const blocks = [];
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c?.type === "text" && c.text?.trim()) blocks.push({ type: "text", text: c.text });
      else if (c?.type === "thinking" && (c.thinking?.trim() || c.redacted)) blocks.push({ type: "thinking", text: c.redacted ? "_(redacted)_" : c.thinking });
      else if (c?.type === "toolCall") {
        const call = { id: c.id, name: c.name ?? "tool", args: c.arguments ?? {}, summary: summarize(c.name, c.arguments), result: null };
        if (c.id) feed.tools.set(c.id, call);
        blocks.push({ type: "tool", call });
      }
    }
    const cost = Number(m.usage?.cost?.total) || 0;
    feed.total += cost;
    if (m.model) feed.model = m.model;
    const error = m.stopReason === "error" ? (m.errorMessage ?? "error") : m.stopReason === "aborted" ? "aborted" : null;
    const took = Number.isFinite(at) && Number.isFinite(m.timestamp) && at >= m.timestamp ? Math.round((at - m.timestamp) / 1000) : null;
    if (blocks.length || error || cost) feed.items.push({ kind: "assistant", id, blocks, cost, model: m.model ?? null, error, seconds: took });
    return;
  }
  if (m.role === "toolResult") {
    const call = feed.tools.get(m.toolCallId);
    const d = m.details && typeof m.details === "object" ? m.details : {};
    const result = {
      text: textOf(m.content),
      error: Boolean(m.isError),
      ms: Number.isFinite(m.durationMs) ? m.durationMs : null,
      patch: typeof d.patch === "string" ? d.patch.slice(0, PATCH_MAX) : null,
      agent: d.gentleAgents && typeof d.gentleAgents === "object" ? d.gentleAgents : null,
    };
    if (call) call.result = result;
    return;
  }
  // system, custom roles: not part of the visible conversation.
}

// Dollars as the artboard writes them: $3.42, $0.41; under a cent $0.0031; nothing $0.00.
export function money(n) {
  if (!n) return "$0.00";
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

// "claude-bridge/claude-opus-5-5" → "Opus 5.5"; anything else as given, without its provider.
export function prettyModel(id) {
  if (typeof id !== "string" || !id) return null;
  const bare = id.slice(id.lastIndexOf("/") + 1);
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(bare);
  if (!m) return bare;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

// "1.9s", "41s", "3m 12s".
export function seconds(ms) {
  if (!Number.isFinite(ms)) return null;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// A unified diff → { hunks: [{ header, rows: [{ kind: "c" | "a" | "d", ln, text }] }], added, deleted }.
// `ln` is the new file's line for context and additions, the old file's for deletions (artboard
// diff card, design/herdr-desktop/01-inspector.html l.433-441).
export function parsePatch(patch) {
  const out = { hunks: [], added: 0, deleted: 0 };
  if (typeof patch !== "string") return out;
  let hunk = null, oldLn = 0, newLn = 0;
  for (const line of patch.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      hunk = { header: line, rows: [] };
      out.hunks.push(hunk);
      oldLn = Number(h[1]);
      newLn = Number(h[2]);
      continue;
    }
    if (!hunk || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("\\")) continue;
    const sign = line[0], text = line.slice(1);
    if (sign === "+") { hunk.rows.push({ kind: "a", ln: newLn++, text }); out.added++; }
    else if (sign === "-") { hunk.rows.push({ kind: "d", ln: oldLn++, text }); out.deleted++; }
    else if (sign === " " || line === "") { hunk.rows.push({ kind: "c", ln: newLn++, text }); oldLn++; }
  }
  for (const k of out.hunks) while (k.rows.length && k.rows[k.rows.length - 1].kind === "c" && !k.rows[k.rows.length - 1].text) k.rows.pop();
  return out;
}
