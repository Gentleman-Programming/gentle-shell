import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendSessionCapture,
  ensureRegistryEntry,
  openSessionWriter,
  registryPath,
} from "../extensions/history/store.ts";

// Prompt history can hold anything pasted into the composer, so its files are
// private (0600) and the directories it creates are owner-only (0700), the
// same convention as the package's other state files. POSIX modes only.
const posix = process.platform !== "win32";

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

test("history store creates private files and owner-only directories", { skip: !posix }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "history-private-mode-"));
  const root = path.join(base, "history");
  const cwd = path.join(base, "project");
  const previous = process.umask(0o022);
  try {
    ensureRegistryEntry(root, cwd);
    const writer = openSessionWriter(root, cwd, "instance-1");
    appendSessionCapture(writer, "token: example-secret-value");

    assert.equal(mode(root), 0o700, "history root directory");
    assert.equal(mode(registryPath(root)), 0o600, "registry file");
    assert.equal(mode(path.dirname(writer.filePath)), 0o700, "project directory");
    assert.equal(mode(writer.filePath), 0o600, "session capture file");
  } finally {
    process.umask(previous);
    fs.rmSync(base, { recursive: true, force: true });
  }
});
