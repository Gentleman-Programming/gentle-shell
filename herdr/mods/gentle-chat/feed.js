// Turns Gentle Shell (pi) session JSONL lines into chat items. Pure: no host calls.
//
// Items:
//   { kind: "user", id, text }
//   { kind: "assistant", id, blocks: [{ type: "text", text } | { type: "thinking", text }
//       | { type: "tool", call }], cost, model, error }
//   { kind: "note", id, text }        (a custom message the session displays)
// Tool calls: { id, name, args, summary, result: null | { text, error } } kept in `feed.tools`
// so a later toolResult line fills in the card that is already drawn.

export function createFeed() {
  return { items: [], tools: new Map(), model: null, provider: null, thinking: null, name: null, total: 0, cwd: null, seq: 0 };
}

const textOf = (content) =>
  typeof content === "string"
    ? content
    : (content ?? []).filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n");

// The first meaningful line of a tool's arguments: the usual keys first, else compact JSON.
export function summarize(args) {
  if (args == null) return "";
  if (typeof args === "string") return firstLine(args);
  for (const key of ["command", "path", "file_path", "pattern", "query", "url", "prompt", "task", "description"]) {
    if (typeof args[key] === "string" && args[key].trim()) return firstLine(args[key]);
  }
  return firstLine(JSON.stringify(args));
}

const firstLine = (s) => {
  const line = String(s).split("\n").find((l) => l.trim()) ?? "";
  return line.length > 140 ? line.slice(0, 139) + "…" : line;
};

// Adds the complete lines in `text` to the feed. Bad lines are skipped, never thrown.
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
    case "custom_message":
      if (e.display) {
        const t = textOf(e.content).trim();
        if (t) feed.items.push({ kind: "note", id, text: t });
      }
      return;
    case "message":
      return ingestMessage(feed, id, e.message ?? {});
    default:
      return;
  }
}

function ingestMessage(feed, id, m) {
  if (m.role === "user") {
    const t = textOf(m.content).trim();
    if (t) feed.items.push({ kind: "user", id, text: t });
    return;
  }
  if (m.role === "assistant") {
    const blocks = [];
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c?.type === "text" && c.text?.trim()) blocks.push({ type: "text", text: c.text });
      else if (c?.type === "thinking" && (c.thinking?.trim() || c.redacted)) blocks.push({ type: "thinking", text: c.redacted ? "_(redacted)_" : c.thinking });
      else if (c?.type === "toolCall") {
        const call = { id: c.id, name: c.name ?? "tool", args: c.arguments ?? {}, summary: summarize(c.arguments), result: null };
        if (c.id) feed.tools.set(c.id, call);
        blocks.push({ type: "tool", call });
      }
    }
    const cost = Number(m.usage?.cost?.total) || 0;
    feed.total += cost;
    if (m.model) feed.model = m.model;
    const error = m.stopReason === "error" ? (m.errorMessage ?? "error") : m.stopReason === "aborted" ? "aborted" : null;
    if (blocks.length || error || cost) feed.items.push({ kind: "assistant", id, blocks, cost, model: m.model ?? null, error });
    return;
  }
  if (m.role === "toolResult") {
    const call = feed.tools.get(m.toolCallId);
    const result = { text: textOf(m.content), error: Boolean(m.isError) };
    if (call) call.result = result;
    return;
  }
  // system, custom roles: not part of the visible conversation.
}

// Dollars, short: $0.25, $0.0031, $12.40.
export function money(n) {
  if (!n) return "$0";
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}
