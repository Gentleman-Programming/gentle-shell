import assert from "node:assert/strict";
import test from "node:test";
import { parseSddStatusCommandArgs } from "../lib/sdd-status.ts";

test("SDD status arguments preserve selected identity and JSON preference", () => {
	assert.deepEqual(parseSddStatusCommandArgs("alpha --json"), { changeName: "alpha", json: true });
	assert.deepEqual(parseSddStatusCommandArgs(" --json "), { changeName: undefined, json: true });
	assert.deepEqual(parseSddStatusCommandArgs(""), { changeName: undefined, json: false });
});
