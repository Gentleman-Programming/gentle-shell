import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ChildMessenger, type IpcEndpoint } from "../lib/agents-messaging.ts";

const registeredChildren = new WeakSet<ExtensionAPI>();

interface ParentMessageToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	terminate?: boolean;
}

export function ownedChildIpc(env: NodeJS.ProcessEnv, candidate: IpcEndpoint | undefined): IpcEndpoint | undefined {
	if (env.GENTLE_PI_AGENTS_CHILD !== "1" || !env.GENTLE_PI_AGENTS_OWNED_IPC || !candidate || typeof candidate.send !== "function" || typeof candidate.on !== "function") return undefined;
	return candidate;
}

export function registerChildMessaging(pi: ExtensionAPI, ipc: IpcEndpoint): void {
	if (registeredChildren.has(pi)) return;
	const messenger = new ChildMessenger(ipc);
	pi.registerTool({
		name: "subagent_parent_message",
		label: "Agent parent message",
		description: "Send a bounded notification or correlated query to this subagent's parent.",
		parameters: { type: "object", additionalProperties: false, required: ["message"], properties: { kind: { type: "string", enum: ["notification", "query"] }, message: { type: "string" } } } as never,
		async execute(_id, params): Promise<ParentMessageToolResult> {
			const input = params as { kind?: unknown; message?: unknown };
			if (typeof input.message !== "string") throw new Error("parent messages require text");
			if (input.kind === undefined || input.kind === "notification") {
				await messenger.notify(input.message);
				return { content: [{ type: "text", text: "Notification accepted by the parent." }], details: {} };
			}
			if (input.kind !== "query") throw new Error("parent messages require notification or query kind");
			const reply = await messenger.query(input.message);
			return { content: [{ type: "text", text: reply }], details: { reply } };
		},
	});
	registeredChildren.add(pi);
}

export function createChildParentMessageExtension(
	env: NodeJS.ProcessEnv = process.env,
	candidate: IpcEndpoint | undefined = process.send ? process as unknown as IpcEndpoint : undefined,
): (pi: ExtensionAPI) => void {
	return (pi) => {
		const ipc = ownedChildIpc(env, candidate);
		if (ipc) registerChildMessaging(pi, ipc);
	};
}

export default function childParentMessageExtension(pi: ExtensionAPI): void {
	createChildParentMessageExtension()(pi);
}
