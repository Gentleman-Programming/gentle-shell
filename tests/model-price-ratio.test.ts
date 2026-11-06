import assert from "node:assert/strict";
import test from "node:test";
import { computeModelPriceRatio, modelRoutingLine, renderModelRoutingLine, type ModelCost, type ModelPriceLookup } from "../lib/model-price-ratio.ts";

// gentle-shell#1731 S3/AC3: the runtime computes the orchestrator/worker price
// ratio from catalog prices and renders it as one fact line; the model never
// estimates it.

const catalog: Record<string, ModelCost> = {
	"anthropic/fable": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
	"anthropic/opus": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"openai/mixed": { input: 3, output: 10, cacheRead: 0.3, cacheWrite: 0 },
	"local/free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	"odd/thirds": { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 },
	"odd/three": { input: 3, output: 3, cacheRead: 0, cacheWrite: 0 },
	"odd/seven": { input: 7, output: 7, cacheRead: 0, cacheWrite: 0 },
};
const lookup: ModelPriceLookup = (model) => catalog[`${model.provider}/${model.id}`];
const fable = { provider: "anthropic", id: "fable" };
const opus = { provider: "anthropic", id: "opus" };

test("renders the input, output, and blended ratio for an expensive orchestrator", () => {
	assert.equal(
		modelRoutingLine(fable, opus, lookup),
		"Model routing: orchestrator anthropic/fable costs 3.0x the worker anthropic/opus (input 3.0x, output 3.0x).",
	);
	const ratio = computeModelPriceRatio(fable, opus, lookup);
	assert.equal(ratio.kind, "known");
	if (ratio.kind === "known") {
		assert.equal(ratio.input, 3);
		assert.equal(ratio.output, 3);
		assert.equal(ratio.blended, 3);
	}
});

test("the blended ratio is the larger of the input and output ratios", () => {
	// fable/mixed: input 15/3 = 5x, output 75/10 = 7.5x.
	assert.equal(
		modelRoutingLine(fable, { provider: "openai", id: "mixed" }, lookup),
		"Model routing: orchestrator anthropic/fable costs 7.5x the worker openai/mixed (input 5.0x, output 7.5x).",
	);
});

test("the same model renders 1.0x", () => {
	assert.equal(
		modelRoutingLine(opus, opus, lookup),
		"Model routing: orchestrator anthropic/opus costs 1.0x the worker anthropic/opus (input 1.0x, output 1.0x).",
	);
});

test("a cheaper orchestrator renders a ratio below 1 normally", () => {
	assert.equal(
		modelRoutingLine(opus, fable, lookup),
		"Model routing: orchestrator anthropic/opus costs 0.3x the worker anthropic/fable (input 0.3x, output 0.3x).",
	);
});

test("ratios round to one decimal", () => {
	// 7/3 = 2.333..., 9/7 = 1.2857...
	assert.equal(
		modelRoutingLine({ provider: "odd", id: "seven" }, { provider: "odd", id: "three" }, lookup),
		"Model routing: orchestrator odd/seven costs 2.3x the worker odd/three (input 2.3x, output 2.3x).",
	);
	assert.equal(
		modelRoutingLine({ provider: "odd", id: "thirds" }, { provider: "odd", id: "seven" }, lookup),
		"Model routing: orchestrator odd/thirds costs 1.3x the worker odd/seven (input 1.3x, output 1.3x).",
	);
	assert.equal(renderModelRoutingLine({ kind: "known", orchestrator: "a/x", worker: "b/y", input: 2.95, output: 1.04, blended: 2.95 }),
		"Model routing: orchestrator a/x costs 3.0x the worker b/y (input 3.0x, output 1.0x).");
});

test("a provider-less model reference renders its bare id", () => {
	const bare: ModelPriceLookup = (model) => (model.id === "opus" ? catalog["anthropic/opus"] : undefined);
	assert.equal(
		modelRoutingLine({ provider: undefined, id: "opus" }, { provider: undefined, id: "opus" }, bare),
		"Model routing: orchestrator opus costs 1.0x the worker opus (input 1.0x, output 1.0x).",
	);
});

test("a missing orchestrator or worker model renders the unknown line", () => {
	assert.equal(modelRoutingLine(undefined, opus, lookup), "Model routing: price ratio unknown (orchestrator model unknown).");
	assert.equal(modelRoutingLine(fable, undefined, lookup), "Model routing: price ratio unknown (worker model unknown).");
});

test("a missing catalog price renders the unknown line naming the model", () => {
	assert.equal(
		modelRoutingLine(fable, { provider: "x", id: "unpriced" }, lookup),
		"Model routing: price ratio unknown (no catalog price for x/unpriced).",
	);
	assert.equal(
		modelRoutingLine({ provider: "x", id: "unpriced" }, opus, lookup),
		"Model routing: price ratio unknown (no catalog price for x/unpriced).",
	);
});

test("a zero or invalid input or output price renders the unknown line", () => {
	assert.equal(
		modelRoutingLine(fable, { provider: "local", id: "free" }, lookup),
		"Model routing: price ratio unknown (zero or invalid price for local/free).",
	);
	assert.equal(
		modelRoutingLine({ provider: "local", id: "free" }, opus, lookup),
		"Model routing: price ratio unknown (zero or invalid price for local/free).",
	);
	const broken: ModelPriceLookup = (model) => (model.id === "opus" ? { input: Number.NaN, output: 25, cacheRead: 0, cacheWrite: 0 } : catalog["anthropic/fable"]);
	assert.equal(modelRoutingLine(fable, opus, broken), "Model routing: price ratio unknown (zero or invalid price for anthropic/opus).");
	const negative: ModelPriceLookup = (model) => (model.id === "opus" ? { input: 5, output: -1, cacheRead: 0, cacheWrite: 0 } : catalog["anthropic/fable"]);
	assert.equal(modelRoutingLine(fable, opus, negative), "Model routing: price ratio unknown (zero or invalid price for anthropic/opus).");
});

test("a throwing price lookup never throws and renders the unknown line", () => {
	const throwing: ModelPriceLookup = () => {
		throw new Error("registry offline");
	};
	assert.equal(modelRoutingLine(fable, opus, throwing), "Model routing: price ratio unknown (price lookup failed).");
});
