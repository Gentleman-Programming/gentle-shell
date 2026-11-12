import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DESKTOP_RPC_COMMAND,
	DESKTOP_RPC_WIDGET,
	DesktopRpcRouter,
	type DesktopRpcPublish,
} from "../lib/desktop-rpc.ts";
import { isInteractiveRpcHost } from "../lib/rpc-host.ts";

function publisher(ctx: ExtensionContext): DesktopRpcPublish {
	return (line) => {
		try {
			ctx.ui.setWidget(DESKTOP_RPC_WIDGET, [line]);
		} catch {
			throw new Error("Desktop RPC transport unavailable");
		}
	};
}

export default function desktopRpc(pi: ExtensionAPI) {
	const router = new DesktopRpcRouter();

	pi.on("session_start", (_event, ctx) => {
		router.stop();
		if (!isInteractiveRpcHost(ctx.mode)) return;
		router.start(publisher(ctx));
	});

	pi.on("session_shutdown", () => router.stop());

	pi.registerCommand(DESKTOP_RPC_COMMAND, {
		description: "Handle a versioned Gentle Desktop RPC request",
		async handler(args, ctx) {
			if (!isInteractiveRpcHost(ctx.mode)) return;
			router.handle(args);
		},
	});
}
