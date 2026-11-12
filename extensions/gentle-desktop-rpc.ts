import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DESKTOP_RPC_COMMAND,
	DESKTOP_RPC_WIDGET,
	DesktopRpcRouter,
	type DesktopRpcPublish,
} from "../lib/desktop-rpc.ts";
import {
	DESKTOP_PERMISSION_EVENT,
	DESKTOP_PERMISSION_METHODS,
	DesktopPermissionBridge,
} from "../lib/desktop-rpc-permissions.ts";
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
	// Permission control always delegates to the existing Gentle AI session owner.
	const permissions = new DesktopPermissionBridge(pi);
	const router = new DesktopRpcRouter(
		["capabilities", "get_snapshot", ...DESKTOP_PERMISSION_METHODS],
		[DESKTOP_PERMISSION_EVENT],
		() => ({}),
		(method, params) => permissions.handle(method, params),
	);

	pi.on("session_start", (_event, ctx) => {
		permissions.reset();
		router.stop();
		if (!isInteractiveRpcHost(ctx.mode)) return;
		router.start(publisher(ctx));
	});

	pi.on("session_shutdown", () => {
		permissions.reset();
		router.stop();
	});

	pi.registerCommand(DESKTOP_RPC_COMMAND, {
		description: "Handle a versioned Gentle Desktop RPC request",
		async handler(args, ctx) {
			if (!isInteractiveRpcHost(ctx.mode)) return;
			permissions.attach(ctx);
			await router.handle(args);
		},
	});
}
