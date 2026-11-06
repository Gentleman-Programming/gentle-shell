import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

class Input extends PassThrough {
  isTTY = true;
  isRaw: boolean;
  rawChanges: boolean[] = [];
  constructor(raw = false) {
    super();
    this.isRaw = raw;
  }
  setRawMode(raw: boolean) {
    this.isRaw = raw;
    this.rawChanges.push(raw);
    return this;
  }
}

class Output extends Writable {
  isTTY = true;
  columns = 80;
  text = "";
  attempts = "";
  fail = false;
  write(chunk: any, encoding?: any, callback?: any): boolean {
    this.attempts += chunk.toString();
    return super.write(chunk, encoding, callback);
  }
  _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
    this.text += chunk.toString();
    callback(this.fail ? new Error("output unavailable") : undefined);
  }
}

const offer = { current: "1.2.3", latest: "1.3.0", notesUrl: "https://example.test/releases/v1.3.0" };
const plain = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

async function start(options: { raw?: boolean; columns?: number; color?: boolean; offer?: typeof offer; fail?: boolean } = {}) {
  const { promptStartupUpdate } = await import("../lib/gentle-shell-update-panel.ts");
  const input = new Input(options.raw);
  const output = new Output();
  output.columns = options.columns ?? 80;
  output.fail = options.fail ?? false;
  const result = promptStartupUpdate(options.offer ?? offer, { input, output, color: options.color ?? false });
  return { input, output, result };
}

function restored(input: Input, output: Output, raw = false) {
  assert.equal(input.isRaw, raw);
  for (const event of ["data", "end", "error", "close"]) assert.equal(input.listenerCount(event), 0, event);
  assert.equal(output.listenerCount("error"), 0);
  assert.match(output.attempts, /\x1b\[\?25h/);
  assert.doesNotMatch(output.text, /\x1b\[\?1049|\x1b\[2J/);
}

test("safe Enter shows release details and confirms Not now", async () => {
  const { input, output, result } = await start();
  input.write("\r");
  assert.equal(await result, "skip");
  const text = plain(output.text);
  for (const value of ["Gentle Shell", "1.2.3 -> 1.3.0", offer.notesUrl, "Update now (gentle-shell upgrade)", "> 2. Not now", "Skip this version"]) {
    assert.ok(text.includes(value), value);
  }
  restored(input, output);
});

test("arrows select update and omit, including split escape sequences", async () => {
  for (const [arrow, choice] of [["A", "update"], ["B", "omit"]] as const) {
    const { input, output, result } = await start();
    input.write("\x1b");
    input.write("[");
    input.write(arrow);
    input.write("\r");
    assert.equal(await result, choice);
    restored(input, output);
  }
});

test("1/2/3 select without confirming until Enter", async () => {
  for (const [key, choice] of [["1", "update"], ["2", "skip"], ["3", "omit"]] as const) {
    const { input, output, result } = await start();
    let settled = false;
    result.then(() => { settled = true; });
    input.write(key);
    await Promise.resolve();
    assert.equal(settled, false);
    input.write("\n");
    assert.equal(await result, choice);
    restored(input, output);
  }
});

test("Escape skips and restores a pre-existing raw terminal", async () => {
  const { input, output, result } = await start({ raw: true });
  input.write("\x1b");
  assert.equal(await result, "skip");
  restored(input, output, true);
});

test("Ctrl+C cancels even after selecting update", async () => {
  const { input, output, result } = await start();
  input.write("1\x03");
  assert.equal(await result, "cancel");
  restored(input, output);
});

test("EOF skips without confirming a selected update", async () => {
  const { input, output, result } = await start();
  input.write("1");
  input.end();
  assert.equal(await result, "skip");
  restored(input, output);
});

test("narrow rendering bounds untrusted strings and removes terminal controls", async () => {
  for (const columns of [1, 5, 18]) {
    const { input, output, result } = await start({ columns, offer: {
      current: "1.2.3\x1b[2J\nBAD\x07",
      latest: "新".repeat(10000),
      notesUrl: "https://example.test/\x1b]0;ATTACK\x07" + "x".repeat(10000),
    } });
    input.write("\r");
    assert.equal(await result, "skip");
    const text = plain(output.text);
    assert.doesNotMatch(text, /\x1b|\x07|ATTACK/);
    assert.ok(output.text.length < 6000);
    // Wide characters occupy two cells; all lines fit the actual terminal.
    for (const line of text.split(/\r?\n/)) {
      const cells = [...line].reduce((n, char) => n + (char === "新" ? 2 : 1), 0);
      assert.ok(cells <= columns, `${columns}: ${JSON.stringify(line)}`);
    }
    restored(input, output);
  }
});

test("rose color is optional and redraw touches only panel lines", async () => {
  const { input, output, result } = await start({ color: true });
  input.write("1\r");
  assert.equal(await result, "update");
  assert.match(output.text, /\x1b\[38;2;255;118;195m/);
  assert.match(output.text, /\x1b\[\d+A/);
  assert.match(output.text, /\x1b\[2K/);
  restored(input, output);
});

test("output failure rejects after restoring raw mode and listeners", async () => {
  const { input, output, result } = await start({ fail: true });
  await assert.rejects(result, /output unavailable/);
  restored(input, output);
});

test("input failure rejects after terminal cleanup", async () => {
  const { input, output, result } = await start();
  input.emit("error", new Error("input unavailable"));
  await assert.rejects(result, /input unavailable/);
  restored(input, output);
});
