import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractPromptsFromFile,
  listSessionFiles,
  MAX_PROMPT_CHARS,
} from "../extensions/history/session-scan.ts";

/**
 * WU1a fixtures (AC-S1-1..6): synthetic v3 session JSONL written to OS temp
 * dirs — the module under test is fs-only and takes the file path as a
 * parameter. Object lines serialize compactly (pi's JSONL shape); raw
 * strings land verbatim for corrupt-line fixtures.
 */
function writeSessionFile(lines: Array<object | string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-scan-"));
  const file = path.join(dir, "session.jsonl");
  const serialized = lines
    .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
    .join("\n");
  fs.writeFileSync(file, `${serialized}\n`, "utf8");
  return file;
}

/**
 * WU1b fixtures (AC-S1-8..9): a synthetic pi sessions root whose shape
 * mirrors ~/.pi/agent/sessions — encoded-cwd directories holding top-level
 * jsonl session files.
 */
function makeSessionsRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "session-scan-root-"));
}

function writeFileAt(filePath: string, lines: Array<object | string>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const serialized = lines
    .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
    .join("\n");
  fs.writeFileSync(filePath, `${serialized}\n`, "utf8");
}

function sessionHeader(overrides: Record<string, unknown> = {}): object {
  return {
    type: "session",
    version: 3,
    timestamp: "2026-01-15T10:00:00.000Z",
    id: "session-1",
    cwd: "/tmp/project",
    ...overrides,
  };
}

function userTextEntry(
  text: string,
  options: { messageTimestamp?: number; entryTimestamp?: string } = {},
): object {
  const message: Record<string, unknown> = { role: "user", content: text };
  if (options.messageTimestamp !== undefined) {
    message.timestamp = options.messageTimestamp;
  }
  const entry: Record<string, unknown> = {
    type: "message",
    id: "entry-1",
    parentId: null,
    message,
  };
  if (options.entryTimestamp !== undefined) {
    entry.timestamp = options.entryTimestamp;
  }
  return entry;
}

test("extracts exactly the user text block with the message ms-epoch ts (AC-S1-1)", () => {
  const user = {
    type: "message",
    id: "m1",
    parentId: null,
    timestamp: "2026-01-15T10:00:01.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "hello from the user" }],
      timestamp: 1768468801123,
    },
  };
  const assistant = {
    type: "message",
    id: "m2",
    parentId: "m1",
    timestamp: "2026-01-15T10:00:02.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "assistant reply" }],
    },
  };
  const toolResult = {
    type: "message",
    id: "m3",
    parentId: "m2",
    timestamp: "2026-01-15T10:00:03.000Z",
    message: {
      role: "toolResult",
      content: [{ type: "text", text: "tool output" }],
    },
  };
  const file = writeSessionFile([sessionHeader(), user, assistant, toolResult]);
  const result = extractPromptsFromFile(file);
  assert.equal(result.prompts.length, 1);
  assert.deepEqual(result.prompts[0], {
    text: "hello from the user",
    ts: 1768468801123,
  });
  assert.equal(result.skippedLines, 0);
});

test("excludes every non-prompt entry type and role; the valid user entry still extracts (AC-S1-2)", () => {
  // compaction / custom_message / custom carry a nested "role":"user" so the
  // substring gate HITS and the parsed type rule must reject them — the gate
  // never decides membership. The role exclusions below gate-miss instead.
  const exclusions = [
    {
      type: "compaction",
      message: { role: "user", content: "compacted summary" },
    },
    { type: "branch_summary", summary: "branched from main" },
    { type: "custom", customType: "state_snapshot", data: { role: "user" } },
    {
      type: "custom_message",
      message: { role: "user", content: "custom message text" },
    },
    { type: "label", name: "checkpoint" },
    { type: "session_info", version: 3 },
    { type: "model_change", message: { role: "assistant", content: "switch" } },
    { type: "thinking_level_change", level: "high" },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "reply" }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        content: [{ type: "text", text: "output" }],
      },
    },
    {
      type: "message",
      message: {
        role: "bashExecution",
        content: [{ type: "text", text: "ls -la" }],
      },
    },
  ];
  const file = writeSessionFile([
    sessionHeader(),
    userTextEntry("real prompt"),
    ...exclusions,
  ]);
  const result = extractPromptsFromFile(file);
  assert.equal(result.prompts.length, 1);
  assert.equal(result.prompts[0].text, "real prompt");
  assert.equal(result.skippedLines, 0);
});

test("skips empty, whitespace-only, and images-only user content; neighbors still extract (AC-S1-3)", () => {
  const entries = [
    userTextEntry("real text before"),
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "image", source: { type: "base64", data: "img" } }],
      },
    },
    { type: "message", message: { role: "user", content: "" } },
    { type: "message", message: { role: "user", content: "   \n\t  " } },
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "  \t " }] },
    },
    userTextEntry("real text after"),
  ];
  const file = writeSessionFile([sessionHeader(), ...entries]);
  const result = extractPromptsFromFile(file);
  assert.deepEqual(
    result.prompts.map((prompt) => prompt.text),
    ["real text before", "real text after"],
  );
  assert.equal(result.skippedLines, 0);
});

test("ts precedence: message ms beats entry ISO; ISO alone; header ts; file mtime; NaN hops tolerated (AC-S1-4)", () => {
  // (a) message ms-epoch beats entry ISO
  const a = writeSessionFile([
    sessionHeader(),
    userTextEntry("a", {
      messageTimestamp: 1700000000123,
      entryTimestamp: "2023-11-14T22:13:19.000Z",
    }),
  ]);
  assert.equal(extractPromptsFromFile(a).prompts[0].ts, 1700000000123);

  // (b) entry ISO only
  const b = writeSessionFile([
    sessionHeader(),
    userTextEntry("b", { entryTimestamp: "2024-03-01T09:30:00.000Z" }),
  ]);
  assert.equal(
    extractPromptsFromFile(b).prompts[0].ts,
    Date.parse("2024-03-01T09:30:00.000Z"),
  );

  // (c) neither present → header timestamp
  const c = writeSessionFile([sessionHeader(), userTextEntry("c")]);
  assert.equal(
    extractPromptsFromFile(c).prompts[0].ts,
    Date.parse("2026-01-15T10:00:00.000Z"),
  );

  // NaN tolerance at the entry-ISO hop: garbage entry timestamp falls through
  const garbage = writeSessionFile([
    sessionHeader(),
    userTextEntry("g", { entryTimestamp: "not-a-timestamp" }),
  ]);
  assert.equal(
    extractPromptsFromFile(garbage).prompts[0].ts,
    Date.parse("2026-01-15T10:00:00.000Z"),
  );

  // final fallback: unparseable header timestamp → the file mtime
  const before = Date.now() - 5;
  const mtimeFile = writeSessionFile([
    sessionHeader({ timestamp: "garbage" }),
    userTextEntry("m"),
  ]);
  const after = Date.now() + 5000;
  const ts = extractPromptsFromFile(mtimeFile).prompts[0].ts;
  assert.ok(Number.isFinite(ts));
  assert.ok(ts >= before && ts <= after);
});

test("corrupt lines are skipped, counted, and never fatal (AC-S1-5)", () => {
  const file = writeSessionFile([
    sessionHeader(),
    userTextEntry("one"),
    '{"type":"message","message":{"role":"user"',
    userTextEntry("two"),
    '{broken json with "role":"user" inside}',
    userTextEntry("three"),
    'not json "role":"user" at all',
    ",{oops",
  ]);
  const result = extractPromptsFromFile(file);
  assert.deepEqual(
    result.prompts.map((prompt) => prompt.text),
    ["one", "two", "three"],
  );
  // The three corrupt gate-hit lines count; the gate-missed corrupt line is
  // skipped by the prefilter without ever being parsed or counted.
  assert.equal(result.skippedLines, 3);
});

test("bad-header aborts yield zero entries without throwing (AC-S1-6)", () => {
  const emptyResult = { prompts: [], skippedLines: 0 };

  // first line missing: an empty file
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-scan-"));
  const emptyFile = path.join(emptyDir, "session.jsonl");
  fs.writeFileSync(emptyFile, "", "utf8");
  assert.deepEqual(extractPromptsFromFile(emptyFile), emptyResult);

  // unparseable first line
  const unparseable = writeSessionFile([
    "{not json at all",
    userTextEntry("ignored"),
  ]);
  assert.deepEqual(extractPromptsFromFile(unparseable), emptyResult);

  // first line type is not session
  const wrongType = writeSessionFile([
    { type: "compaction", version: 3 },
    userTextEntry("ignored"),
  ]);
  assert.deepEqual(extractPromptsFromFile(wrongType), emptyResult);

  // version >= 4
  const futureVersion = writeSessionFile([
    sessionHeader({ version: 4 }),
    userTextEntry("ignored"),
  ]);
  assert.deepEqual(extractPromptsFromFile(futureVersion), emptyResult);

  // non-numeric version is rejected without coercion
  const stringVersion = writeSessionFile([
    sessionHeader({ version: "3" }),
    userTextEntry("ignored"),
  ]);
  assert.deepEqual(extractPromptsFromFile(stringVersion), emptyResult);
});

test("boundaries: header-only file, blank padding lines, gate hits that fail the parsed rule (triangulation)", () => {
  const emptyResult = { prompts: [], skippedLines: 0 };

  // header-only file: admitted, zero prompts, zero skips
  const headerOnly = writeSessionFile([sessionHeader()]);
  assert.deepEqual(extractPromptsFromFile(headerOnly), emptyResult);

  // trailing and interior blank lines never parse (gate economy)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-scan-"));
  const padded = path.join(dir, "session.jsonl");
  fs.writeFileSync(
    padded,
    JSON.stringify(sessionHeader()) +
      "\n\n" +
      JSON.stringify(userTextEntry("padded")) +
      "\n\n",
    "utf8",
  );
  const paddedResult = extractPromptsFromFile(padded);
  assert.equal(paddedResult.prompts.length, 1);
  assert.equal(paddedResult.prompts[0].text, "padded");
  assert.equal(paddedResult.skippedLines, 0);

  // a gate hit whose parsed shape fails the extraction rule is silently
  // dropped — the gate alone never decides membership
  const gateHit = writeSessionFile([
    sessionHeader(),
    {
      type: "custom",
      payload: { role: "user", content: "nested user literal" },
    },
  ]);
  assert.deepEqual(extractPromptsFromFile(gateHit), emptyResult);
});

test("gate safety: escaped quotes extract exactly, misses never parse, the gate never decides membership (AC-S1-8)", () => {
  const root = makeSessionsRoot();
  const cwdDir = path.join(root, "--tmp-project--");

  // Escaped quotes beside the role field and inside text values: the raw
  // "role":"user" literal survives serialization, the gate hits, and
  // JSON.parse decodes the escapes to the exact text.
  writeFileAt(path.join(cwdDir, "escaped.jsonl"), [
    sessionHeader(),
    {
      type: "message",
      message: {
        content: '"leading quote right before the role field',
        role: "user",
      },
    },
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: 'block with "quoted" words' }],
      },
    },
  ]);

  // Sentinel lines WITHOUT the user-role literal: if the gate ever parsed
  // them, JSON.parse would throw and skippedLines would count them — a zero
  // skip count proves the miss path never parses.
  writeFileAt(path.join(cwdDir, "sentinel.jsonl"), [
    sessionHeader(),
    "{definitely not json and no role literal",
    userTextEntry("real prompt after sentinels"),
    "{another broken line, still no literal",
  ]);

  // A gate hit that fails the parsed extraction rule is silently dropped:
  // the parsed rule, not the substring, decides membership.
  writeFileAt(path.join(cwdDir, "gate-only.jsonl"), [
    sessionHeader(),
    {
      type: "custom",
      message: { role: "user", content: "gate hits, rule rejects" },
    },
  ]);

  const prompts: string[] = [];
  let skippedLines = 0;
  const files = listSessionFiles(root);
  assert.equal(files.length, 3);
  for (const file of files) {
    const result = extractPromptsFromFile(file);
    for (const prompt of result.prompts) prompts.push(prompt.text);
    skippedLines += result.skippedLines;
  }
  assert.ok(prompts.includes('"leading quote right before the role field'));
  assert.ok(prompts.includes('block with "quoted" words'));
  assert.ok(prompts.includes("real prompt after sentinels"));
  assert.ok(!prompts.includes("gate hits, rule rejects"));
  assert.equal(skippedLines, 0);
});

test("v1/v2 legacy tolerance: no id/parentId, weak timestamps resolve through the fallback chain (AC-S1-9)", () => {
  const root = makeSessionsRoot();
  const cwdDir = path.join(root, "--legacy-project--");

  // version-1 header; entries carry no id and no parentId
  writeFileAt(path.join(cwdDir, "legacy-v1.jsonl"), [
    { type: "session", version: 1, timestamp: "2025-06-01T08:00:00.000Z" },
    {
      type: "message",
      timestamp: "2025-06-01T09:00:00.000Z",
      message: { role: "user", content: "legacy with entry iso" },
    },
    {
      type: "message",
      message: { role: "user", content: "legacy bare" },
    },
  ]);

  // neither entry nor header timestamp usable → the file mtime is the tail
  const before = Date.now() - 5_000;
  writeFileAt(path.join(cwdDir, "legacy-mtime.jsonl"), [
    { type: "session", version: 2, timestamp: "garbage" },
    { type: "message", message: { role: "user", content: "legacy mtime" } },
  ]);
  const after = Date.now() + 5_000;

  const byText = new Map<string, number>();
  for (const file of listSessionFiles(root)) {
    for (const prompt of extractPromptsFromFile(file).prompts) {
      byText.set(prompt.text, prompt.ts);
    }
  }
  assert.equal(byText.size, 3);
  assert.equal(
    byText.get("legacy with entry iso"),
    Date.parse("2025-06-01T09:00:00.000Z"),
  );
  assert.equal(
    byText.get("legacy bare"),
    Date.parse("2025-06-01T08:00:00.000Z"),
  );
  const mtimeTs = byText.get("legacy mtime");
  if (mtimeTs === undefined) {
    throw new Error("legacy mtime entry did not extract");
  }
  assert.ok(Number.isFinite(mtimeTs));
  assert.ok(mtimeTs >= before && mtimeTs <= after);
});

test("multi-block content joins text blocks with a single space, trimmed; string content passes as-is (AC-S1-10)", () => {
  const multi = writeSessionFile([
    sessionHeader(),
    {
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: "first part" },
          { type: "image", source: { type: "base64", data: "img" } },
          { type: "text", text: "second part" },
        ],
      },
    },
  ]);
  const multiResult = extractPromptsFromFile(multi);
  assert.equal(multiResult.prompts.length, 1);
  assert.equal(multiResult.prompts[0].text, "first part second part");

  // the assembly is trimmed at its ends; the raw join keeps inner spacing
  const padded = writeSessionFile([
    sessionHeader(),
    {
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: "  padded  " },
          { type: "text", text: "tail  " },
        ],
      },
    },
  ]);
  const paddedResult = extractPromptsFromFile(padded);
  assert.equal(paddedResult.prompts[0].text, "padded   tail");

  // plain-string content extracts as-is (WU1a behavior preserved)
  const plain = writeSessionFile([
    sessionHeader(),
    userTextEntry("plain string content"),
  ]);
  assert.equal(
    extractPromptsFromFile(plain).prompts[0].text,
    "plain string content",
  );
});

test("length guard: at MAX_PROMPT_CHARS extracts, strictly above skips uniformly and silently (AC-S1-11)", () => {
  const atMax = "a".repeat(MAX_PROMPT_CHARS);
  const over = "b".repeat(MAX_PROMPT_CHARS + 1);
  const file = writeSessionFile([
    sessionHeader(),
    userTextEntry("short entry"),
    { type: "message", message: { role: "user", content: atMax } },
    { type: "message", message: { role: "user", content: over } },
  ]);
  const result = extractPromptsFromFile(file);
  assert.deepEqual(
    result.prompts.map((prompt) => prompt.text),
    ["short entry", atMax],
  );
  // the oversized skip is uniform and silent — not a corruption count
  assert.equal(result.skippedLines, 0);
});

test("WU1b triangulation: exact length boundary, sorted determinism across runs, empty-root fail-open", () => {
  // the boundary is exact: MAX_PROMPT_CHARS extracts, one unit more skips
  const exact = "x".repeat(MAX_PROMPT_CHARS);
  const boundary = writeSessionFile([
    sessionHeader(),
    { type: "message", message: { role: "user", content: exact } },
    {
      type: "message",
      message: { role: "user", content: "y".repeat(MAX_PROMPT_CHARS + 1) },
    },
  ]);
  const boundaryResult = extractPromptsFromFile(boundary);
  assert.deepEqual(
    boundaryResult.prompts.map((prompt) => prompt.text),
    [exact],
  );
  assert.equal(boundaryResult.skippedLines, 0);

  // two runs return identical sorted absolute paths (deterministic order)
  const root = makeSessionsRoot();
  writeFileAt(path.join(root, "--bbb--", "b.jsonl"), [
    sessionHeader(),
    userTextEntry("b"),
  ]);
  writeFileAt(path.join(root, "--aaa--", "a.jsonl"), [
    sessionHeader(),
    userTextEntry("a"),
  ]);
  const first = listSessionFiles(root);
  const second = listSessionFiles(root);
  assert.deepEqual(first, second);
  assert.deepEqual(first, [
    path.join(root, "--aaa--", "a.jsonl"),
    path.join(root, "--bbb--", "b.jsonl"),
  ]);

  // a sessions root with no cwd directories yields an empty list, no throw
  assert.deepEqual(listSessionFiles(makeSessionsRoot()), []);
});

test("a nonexistent path yields the empty result without throwing (triangulation)", () => {
  const missing = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "session-scan-")),
    "does-not-exist.jsonl",
  );
  assert.deepEqual(extractPromptsFromFile(missing), {
    prompts: [],
    skippedLines: 0,
  });
});

test("a header with NO timestamp field (parseHeader NaN branch) plus timestamp-less messages falls back to the file mtime", () => {
  // Distinct from the garbage-header-timestamp case already covered: here
  // the header carries no timestamp key at all, so parseHeader returns NaN
  // and resolveTimestamp falls all the way through to the file mtime.
  const before = Date.now() - 5;
  const file = writeSessionFile([
    { type: "session", version: 3 },
    userTextEntry("no ts anywhere"),
  ]);
  const after = Date.now() + 5000;
  const result = extractPromptsFromFile(file);
  assert.equal(result.prompts.length, 1);
  assert.equal(result.prompts[0].text, "no ts anywhere");
  const ts = result.prompts[0].ts;
  assert.ok(Number.isFinite(ts));
  assert.ok(ts >= before && ts <= after);
});
