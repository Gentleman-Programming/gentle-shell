// gentle-shell#1731: the orchestrator/worker price ratio is a runtime fact.
// The harness renders it as one line computed from catalog prices, so the
// model routes implementation by a number it never has to estimate.

export interface ModelIdentity {
	provider: string | undefined;
	id: string;
}

/** Catalog price in USD per 1M tokens, as Pi's model registry reports it. */
export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export type ModelPriceLookup = (model: ModelIdentity) => ModelCost | undefined;

export type ModelPriceRatio =
	| { kind: "known"; orchestrator: string; worker: string; input: number; output: number; blended: number }
	| { kind: "unknown"; reason: string };

function label(model: ModelIdentity): string {
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

function validPrice(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function computeModelPriceRatio(
	orchestrator: ModelIdentity | undefined,
	worker: ModelIdentity | undefined,
	lookup: ModelPriceLookup,
): ModelPriceRatio {
	if (!orchestrator) return { kind: "unknown", reason: "orchestrator model unknown" };
	if (!worker) return { kind: "unknown", reason: "worker model unknown" };
	const prices: ModelCost[] = [];
	for (const model of [orchestrator, worker]) {
		let cost: ModelCost | undefined;
		try {
			cost = lookup(model);
		} catch {
			return { kind: "unknown", reason: "price lookup failed" };
		}
		if (!cost) return { kind: "unknown", reason: `no catalog price for ${label(model)}` };
		if (!validPrice(cost.input) || !validPrice(cost.output)) return { kind: "unknown", reason: `zero or invalid price for ${label(model)}` };
		prices.push(cost);
	}
	const [orchestratorCost, workerCost] = prices;
	const input = orchestratorCost.input / workerCost.input;
	const output = orchestratorCost.output / workerCost.output;
	// The blended ratio is the larger of the two. Catalogs usually keep input
	// and output prices proportional, so both agree; when they diverge, the
	// session's token mix is unknown up front, and the dimension where the
	// orchestrator is relatively pricier is the one delegation saves on.
	return { kind: "known", orchestrator: label(orchestrator), worker: label(worker), input, output, blended: Math.max(input, output) };
}

// Rounds half up at one decimal; toFixed alone misrounds values
// such as 2.95 because of their binary representation.
function times(value: number): string {
	return `${(Math.round(value * 10) / 10).toFixed(1)}x`;
}

export function renderModelRoutingLine(ratio: ModelPriceRatio): string {
	if (ratio.kind === "unknown") return `Model routing: price ratio unknown (${ratio.reason}).`;
	return `Model routing: orchestrator ${ratio.orchestrator} costs ${times(ratio.blended)} the worker ${ratio.worker} (input ${times(ratio.input)}, output ${times(ratio.output)}).`;
}

/** The harness fact line. Never throws: any failure renders the unknown line. */
export function modelRoutingLine(
	orchestrator: ModelIdentity | undefined,
	worker: ModelIdentity | undefined,
	lookup: ModelPriceLookup,
): string {
	try {
		return renderModelRoutingLine(computeModelPriceRatio(orchestrator, worker, lookup));
	} catch {
		return renderModelRoutingLine({ kind: "unknown", reason: "price ratio failed" });
	}
}
