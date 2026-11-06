import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeReviewLastEventClosureV1 } from "../../runtime/review-integration-v2.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const fixturePath = join(ROOT, "tests", "fixtures", "devbinary", "last-event-capture-result-approved.captured.json");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const closure = decodeReviewLastEventClosureV1(fixture);

assert.equal(closure.operation, "review/capture-result");
assert.equal(closure.state, "approved");
assert.match(closure.storeRevision, /^sha256:[a-f0-9]{64}$/);
assert.notEqual(closure.operation, "review.finalize");
console.log("cross-lane last-event closure parity passed");
