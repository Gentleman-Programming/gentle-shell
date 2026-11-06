import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "../extensions/history/atomic-write.ts";
import {
  appendSessionCapture,
  ensureRegistryEntry,
  openSessionWriter,
  parseStoreLine,
  projectDir,
  projectHash,
  registryPath,
  sessionFilePath,
} from "../extensions/history/store.ts";

// Slice-1 concurrency/recovery coverage. The dev-suite multi-reader drain
// scenarios are re-expressed against the slice-1 surface (per-instance
// writers, parseStoreLine, atomic writes): parallel writers on one project
// dir, torn-line tolerance, and same-target atomic-write collisions. The
// drain/read ordering scenarios themselves arrive with the slice-2 reader.

const PROJECT_A = "/pi-history-test/project-a";
const PROJECT_B = "/pi-history-test/project-b";

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-multi-reader-"));
}

function storedTexts(file: string): string[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => (JSON.parse(l) as { text: string }).text);
}

// --- parallel writers ---

test("growth from a concurrent instance is visible on the next read", () => {
  const root = makeRoot();
  const a = openSessionWriter(root, PROJECT_A, "inst-a");
  appendSessionCapture(a, "first");
  const dirA = projectDir(root, PROJECT_A);
  assert.deepEqual(fs.readdirSync(dirA), ["inst-a.jsonl"]);

  // A second pi instance grows the SAME project dir through its OWN file;
  // neither writer reads or rewrites the other's bytes.
  const b = openSessionWriter(root, PROJECT_A, "inst-b");
  appendSessionCapture(b, "from-other-instance");

  assert.deepEqual(fs.readdirSync(dirA).sort(), [
    "inst-a.jsonl",
    "inst-b.jsonl",
  ]);
  assert.deepEqual(storedTexts(sessionFilePath(root, PROJECT_A, "inst-a")), [
    "first",
  ]);
  assert.deepEqual(storedTexts(sessionFilePath(root, PROJECT_A, "inst-b")), [
    "from-other-instance",
  ]);
  assert.equal(a.lineCount, 1);
  assert.equal(b.lineCount, 1);
});

test("interleaved captures from multiple writers never clobber each other", () => {
  const root = makeRoot();
  const writers = [
    openSessionWriter(root, PROJECT_A, "w0"),
    openSessionWriter(root, PROJECT_A, "w1"),
    openSessionWriter(root, PROJECT_A, "w2"),
  ];
  for (let i = 0; i < 10; i++) {
    for (let w = 0; w < writers.length; w++) {
      appendSessionCapture(writers[w], `w${w}-line-${i}`);
    }
  }
  const dir = projectDir(root, PROJECT_A);
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    "w0.jsonl",
    "w1.jsonl",
    "w2.jsonl",
  ]);
  for (let w = 0; w < writers.length; w++) {
    assert.equal(writers[w].lineCount, 10);
    assert.deepEqual(
      storedTexts(writers[w].filePath),
      Array.from({ length: 10 }, (_, i) => `w${w}-line-${i}`),
    );
  }
});

test("a high-volume burst on one writer keeps every line, in order", () => {
  const root = makeRoot();
  const writer = openSessionWriter(root, PROJECT_A, "burst");
  const expected: string[] = [];
  for (let i = 0; i < 100; i++) {
    const text = `burst-${i}`;
    expected.push(text);
    appendSessionCapture(writer, text, 1000 + i);
  }
  assert.equal(writer.lineCount, 100);
  const lines = fs.readFileSync(writer.filePath, "utf8").trim().split("\n");
  assert.equal(lines.length, 100);
  const parsed = lines.map((l) => JSON.parse(l) as { text: string; ts: number });
  assert.deepEqual(
    parsed.map((e) => e.text),
    expected,
  );
  assert.equal(parsed[42].ts, 1042);
});

// --- torn-line / crash recovery ---

test("torn and malformed lines parse to null (crash garbage never resurfaces)", () => {
  // A torn final line (process died mid-write) is a truncated JSON doc.
  const torn = JSON.stringify({ v: 1, text: "survivor" }).slice(0, 12);
  const malformed: string[] = [
    "",
    "{torn",
    torn,
    "not json at all",
    JSON.stringify([]),
    JSON.stringify("scalar"),
    JSON.stringify(null),
    JSON.stringify({ v: 1 }),
    JSON.stringify({ text: 42 }),
    JSON.stringify({ text: "   " }),
  ];
  for (const line of malformed) {
    assert.equal(parseStoreLine(line), null, JSON.stringify(line));
  }
  // Valid lines keep parsing: absent v defaults to 1, ts/v flow through.
  assert.deepEqual(parseStoreLine(JSON.stringify({ v: 1, text: "survivor" })), {
    v: 1,
    text: "survivor",
  });
  assert.deepEqual(parseStoreLine(JSON.stringify({ text: "y" })), {
    v: 1,
    text: "y",
  });
  assert.deepEqual(parseStoreLine(JSON.stringify({ v: 2, text: "x", ts: 7 })), {
    v: 2,
    text: "x",
    ts: 7,
  });
});

test("a torn final line is tolerated: skipped by readers, later appends continue", () => {
  const root = makeRoot();
  const writer = openSessionWriter(root, PROJECT_A, "torn");
  appendSessionCapture(writer, "before-crash");
  // Crash mid-write: a partial line lands WITHOUT its trailing newline.
  fs.appendFileSync(writer.filePath, `{"v":1,"text":"tor`, "utf8");
  // parseStoreLine skips the torn tail instead of throwing...
  assert.equal(parseStoreLine('{"v":1,"text":"tor'), null);
  // ...and the instance keeps capturing. The first append after a
  // newline-less torn tail merges with the fragment (one accepted lost
  // entry — the same crash window the design documents for lost writes);
  // the next full line parses cleanly again.
  appendSessionCapture(writer, "after-crash");
  appendSessionCapture(writer, "after-crash-2");
  assert.equal(writer.lineCount, 3);
  const lines = fs.readFileSync(writer.filePath, "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  assert.equal((JSON.parse(lines[0]) as { text: string }).text, "before-crash");
  assert.equal(parseStoreLine(lines[1]), null); // torn fragment + merged entry
  assert.equal(
    (JSON.parse(lines[2]) as { text: string }).text,
    "after-crash-2",
  );
});

// --- atomic-write collisions ---

test("rapid same-target atomic writes leave one valid document and no staging files", () => {
  const root = makeRoot();
  const target = path.join(root, "shared-state.json");
  for (let i = 0; i < 25; i++) {
    assert.equal(writeJsonAtomic(target, { writer: i }), true);
  }
  const final = JSON.parse(fs.readFileSync(target, "utf8")) as {
    writer: number;
  };
  assert.ok(final.writer >= 0 && final.writer <= 24);
  const leftovers = fs.readdirSync(root).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("interleaved registry updates from two instances keep both entries", () => {
  const root = makeRoot();
  for (let i = 0; i < 3; i++) {
    ensureRegistryEntry(root, PROJECT_A);
    ensureRegistryEntry(root, PROJECT_B);
  }
  const raw = JSON.parse(
    fs.readFileSync(registryPath(root), "utf8"),
  ) as Record<string, string>;
  assert.equal(Object.keys(raw).length, 2);
  assert.equal(raw[projectHash(PROJECT_A)], PROJECT_A);
  assert.equal(raw[projectHash(PROJECT_B)], PROJECT_B);
});
