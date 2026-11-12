import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DESKTOP_RPC_COMMAND,
	DESKTOP_RPC_WIDGET,
	DesktopRpcRouter,
	type DesktopRpcDomain,
	type DesktopRpcPublish,
} from "../lib/desktop-rpc.ts";
import {
	DESKTOP_CONFIG_METHODS,
	DesktopConfigBridge,
} from "../lib/desktop-rpc-config.ts";
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
	// Permission control always delegates to the existing Gentle AI session owner;
	// config reads delegate to the existing store owners. Neither has a store of
	// its own.
	const permissions = new DesktopPermissionBridge(pi);
	const config = new DesktopConfigBridge();
	const domain: DesktopRpcDomain = (method, params) => {
		const outcome = config.handle(method, params);
		return outcome === undefined ? permissions.handle(method, params) : outcome;
	};
	const router = new DesktopRpcRouter(
		["capabilities", "get_snapshot", ...DESKTOP_CONFIG_METHODS, ...DESKTOP_PERMISSION_METHODS],
		[DESKTOP_PERMISSION_EVENT],
		() => config.snapshotState(),
		domain,
	);

	pi.on("session_start", (_event, ctx) => {
		permissions.reset();
		config.reset();
		router.stop();
		if (!isInteractiveRpcHost(ctx.mode)) return;
		router.start(publisher(ctx));
	});

	pi.on("session_shutdown", () => {
		permissions.reset();
		config.reset();
		router.stop();
	});

	pi.registerCommand(DESKTOP_RPC_COMMAND, {
		description: "Handle a versioned Gentle Desktop RPC request",
		async handler(args, ctx) {
			if (!isInteractiveRpcHost(ctx.mode)) return;
			permissions.attach(ctx);
			config.attach(ctx);
			await router.handle(args);
		},
	});
}
