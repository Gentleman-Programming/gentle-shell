import { calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";

// pi-claude-bridge serves Claude Code on a Claude subscription and registers every
// model with a zero price, so each turn it records costs $0. Pricing those turns at
// the Anthropic list price gives the API-equivalent spend: what the same tokens would
// cost on the API, not what the subscription bills.
export const CLAUDE_BRIDGE_PROVIDER = "claude-bridge";
const LIST_PRICE_PROVIDER = "anthropic";

type CatalogCost = Model<never>["cost"];
type PricedMessage = { role?: unknown; provider?: unknown; model?: unknown; usage?: Usage };

/** Returns a copy of a zero-cost claude-bridge assistant message priced from the
 * catalog, or undefined when the message is not one or the catalog has no price. */
export function priceBridgeMessage<T extends PricedMessage>(
	message: T,
	findCost: (provider: string, modelId: string) => CatalogCost | undefined,
): T | undefined {
	if (message.role !== "assistant" || message.provider !== CLAUDE_BRIDGE_PROVIDER || typeof message.model !== "string") return undefined;
	const usage = message.usage;
	// A bridge that reports its own cost wins.
	if (!usage?.cost || usage.cost.total !== 0) return undefined;
	const cost = findCost(LIST_PRICE_PROVIDER, message.model);
	if (!cost) return undefined;
	const priced: Usage = { ...usage, cost: { ...usage.cost } };
	calculateCost({ cost } as Model<never>, priced);
	return { ...message, usage: priced };
}
