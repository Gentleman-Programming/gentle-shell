import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveVimPolicy, writeVimPolicy } from "../lib/vim-policy.ts";

test("vim preference defaults off, persists strictly, and fails closed on malformed input", () => {
	const home = mkdtempSync(join(tmpdir(), "gentle-vim-"));
	const options = { gentlePiConfigHome: home };
	assert.equal(resolveVimPolicy(options).policy, "off");
	assert.equal(resolveVimPolicy(options).source, "default");
	writeVimPolicy("on", options);
	assert.equal(resolveVimPolicy(options).policy, "on");
	assert.equal(JSON.parse(readFileSync(join(home, "vim.json"), "utf8")).schema, "gentle-pi.vim/v1");
	writeFileSync(join(home, "vim.json"), '{"schema":"gentle-pi.vim/v1","policy":"on","extra":true}');
	assert.equal(resolveVimPolicy(options).policy, "off");
	assert.equal(resolveVimPolicy(options).malformed, true);
});
