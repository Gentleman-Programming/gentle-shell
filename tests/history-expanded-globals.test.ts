import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type PiHistoryGlobals,
  withExpandedHistoryGlobals,
} from "../extensions/history/selector-helpers.ts";

// withExpandedHistoryGlobals contract: optional hooks invoked via `?.` —
// expand exactly once BEFORE the run starts, trim exactly once in the
// finally (success and rejection alike), and the run's resolution passes
// through untouched. Fixtures track call order in one array so the
// before/after ordering and the call counts are pinned together.

function trackingGlobals(): { globals: PiHistoryGlobals; events: string[] } {
  const events: string[] = [];
  return {
    events,
    globals: {
      __piHistoryExpand: () => {
        events.push("expand");
      },
      __piHistoryTrim: () => {
        events.push("trim");
      },
    },
  };
}

test("expand runs once before the run; trim once after; the result passes through", async () => {
  const { globals, events } = trackingGlobals();
  let ran = 0;
  const value = await withExpandedHistoryGlobals(globals, async () => {
    // By the time the body executes, expand already ran — exactly once.
    ran += 1;
    assert.deepEqual(events, ["expand"]);
    return 42;
  });
  assert.equal(value, 42);
  assert.equal(ran, 1);
  assert.deepEqual(events, ["expand", "trim"]);
});

test("a rejected run still trims (finally) and the rejection propagates unchanged", async () => {
  const { globals, events } = trackingGlobals();
  const boom = new Error("boom");
  let caught: unknown;
  try {
    await withExpandedHistoryGlobals(globals, async () => {
      throw boom;
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, boom);
  assert.deepEqual(events, ["expand", "trim"]);
});

test("absent hooks are tolerated: the run executes with no throw", async () => {
  const empty: PiHistoryGlobals = {};
  const value = await withExpandedHistoryGlobals(empty, async () => "ok");
  assert.equal(value, "ok");
});
