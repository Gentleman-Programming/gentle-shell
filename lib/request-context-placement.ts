// Placement of saved request-context messages (cost-speed-painpoints S15, P1 and P1b).
//
// A hook that adds a hidden message to one model request and saves it with
// `pi.sendMessage(..., { triggerTurn: false })` keeps the request list
// append-only only if the saved copy sits where the request carried it. Pi 1.5.2
// appends a message sent while streaming only once the turn ends, after the
// assistant reply and its tool results, so the saved copy lands later. Each such
// message therefore records the message it followed and its own timestamp
// (`details: { after, at }`), and `placePersistedMessages` moves every saved copy
// back to that spot on later requests: request k+1 then starts with exactly the
// messages of request k, and the provider's prompt cache keeps its prefix.
// Pure: no pi imports.

/** Where a saved message sat in the request that first carried it: right after `after`, with timestamp `at`. */
export type PersistedPlacement = { after: string; at: number };

type Placed = { role?: unknown; customType?: unknown; timestamp?: unknown; details?: unknown };

/** A message's position key: stable across requests, since Pi never rewrites a stored message. */
export function requestMessagePosition(message: Placed | undefined): string {
	return message === undefined ? "" : `${String(message.role)}|${String(message.customType ?? "")}|${String(message.timestamp ?? "")}`;
}

function placement(message: Placed, types: ReadonlySet<string>): PersistedPlacement | undefined {
	if (message.role !== "custom" || typeof message.customType !== "string" || !types.has(message.customType)) return undefined;
	const details = message.details as Partial<PersistedPlacement> | undefined;
	return typeof details?.after === "string" && typeof details.at === "number" ? { after: details.after, at: details.at } : undefined;
}

/**
 * Moves each saved custom message of `types` back to where its request carried
 * it, with that request's timestamp, so consecutive requests stay append-only.
 * Returns `undefined` when nothing moved. A message whose predecessor is gone
 * (compacted away) or that carries no placement (saved by an earlier version)
 * stays put. A message is only ever placed right after an earlier one, so the
 * leading message keeps its place.
 */
export function placePersistedMessages<T>(messages: readonly T[], types: ReadonlySet<string>): T[] | undefined {
	let list: T[] | undefined;
	const current = () => list ?? messages;
	for (let index = 0; index < current().length; index++) {
		const message = current()[index] as Placed;
		const where = placement(message, types);
		if (where === undefined) continue;
		let target = index - 1;
		while (target >= 0 && requestMessagePosition(current()[target] as Placed) !== where.after) target--;
		if (target < 0 || (target === index - 1 && message.timestamp === where.at)) continue;
		list ??= [...messages];
		list.splice(index, 1);
		list.splice(target + 1, 0, { ...message, timestamp: where.at } as T);
	}
	return list;
}
