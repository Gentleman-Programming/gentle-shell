import assert from "node:assert/strict";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

// gentle-shell #55 / #57 / #125: the reply language is inferred every turn,
// never stored, so the persona prompt itself must say how to infer it. The
// rule lives on the single existing language-match bullet (the concept-level
// duplication guard allows exactly one), so these tests read the rendered
// prompt rather than a second rule.

for (const persona of ["gentleman", "neutral"] as const) {
	test(`[${persona}] the reply language follows the user's latest message, never a Spanish default (#125, #57)`, () => {
		const prompt = __testing.buildGentlePrompt(persona);
		assert.match(prompt, /Always respond in the same language the user writes in\./);
		assert.match(
			prompt,
			/latest message, never by earlier context or a compaction summary/,
			`${persona} prompt must judge the reply language by the user's latest message, so a compaction summary cannot flip it (#57)`,
		);
		assert.match(
			prompt,
			/never default to Spanish: a message in English gets a reply in English/,
			`${persona} prompt must forbid a Spanish default, so an English message never gets a Spanish reply (#125)`,
		);
	});
}

test("[neutral] the voseo prohibition covers regular and irregular forms, not only four irregular verbs (#55)", () => {
	const prompt = __testing.buildGentlePrompt("neutral");
	assert.match(prompt, /Do NOT use voseo/);
	assert.match(prompt, /regular or irregular: use tú or usted forms, never vos forms/);
	for (const pair of ["ajustas, not ajustás", "vives, not vivís", "mira, not mirá", "haz, not hacé"]) {
		assert.ok(prompt.includes(pair), `neutral prompt must name the voseo replacement "${pair}"`);
	}
});

test("[gentleman] Spanish replies keep Rioplatense voseo and get no neutral-only rule", () => {
	const prompt = __testing.buildGentlePrompt("gentleman");
	assert.match(prompt, /When the user writes Spanish, answer in natural Rioplatense Spanish with voseo\./);
	assert.match(prompt, /Language: natural Rioplatense Spanish with voseo when the user writes Spanish\./);
	assert.doesNotMatch(prompt, /never vos forms/, "gentleman prompt must not inherit the neutral voseo prohibition");
});
