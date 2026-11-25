#!/usr/bin/env node
// A stand-in for `gentle-shell --mode rpc` in the serve tests: it speaks Pi's
// JSONL RPC on stdin/stdout (responses, a Desktop RPC widget answer, dialogs)
// plus a few `fake_*` commands that let tests drive framing, bursts, exits and
// the Desktop events of a host tool call (as if the agent had called the tool).
// No Pi, no model.

let buffer = "";
let dialogs = 0;
const out = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const respond = (cmd, data, success = true) => out({ ...(cmd.id === undefined ? {} : { id: cmd.id }), type: "response", command: cmd.type, success, ...(success ? { data } : { error: data }) });

function handle(cmd) {
	switch (cmd.type) {
		case "get_state":
			return respond(cmd, { sessionId: "fake-session", isStreaming: false, messageCount: 0, cwd: process.cwd(), interactiveHost: process.env.GENTLE_SHELL_INTERACTIVE_HOST ?? null, args: process.argv.slice(2) });
		case "prompt": {
			const message = String(cmd.message ?? "");
			if (!message.startsWith("/gentle:desktop ")) return respond(cmd, { disposition: "started" });
			const request = JSON.parse(message.slice("/gentle:desktop ".length));
			if (request.method === "refuse") return respond(cmd, "refused", false);
			respond(cmd, { disposition: "handled" });
			if (request.method === "never") return;
			const answer = { schema: request.schema, kind: "response", requestId: request.requestId, ok: true, data: { method: request.method, params: request.params } };
			return out({ type: "extension_ui_request", id: `w-${request.requestId}`, method: "setWidget", widgetKey: "gentle-desktop-rpc", widgetLines: [JSON.stringify(answer)] });
		}
		case "extension_ui_response":
			return out({ type: "fake_dialog_answer", id: cmd.id, value: cmd.value ?? null, cancelled: cmd.cancelled ?? false });
		case "fake_dialog":
			dialogs += 1;
			respond(cmd, { dialog: `dlg-${dialogs}` });
			return out({ type: "extension_ui_request", id: `dlg-${dialogs}`, method: "select", title: "Pick one", options: ["a", "b"], ...(cmd.timeout ? { timeout: cmd.timeout } : {}) });
		case "fake_burst": {
			const pad = "x".repeat(cmd.size ?? 10);
			for (let n = 0; n < (cmd.count ?? 1); n += 1) out({ type: "fake_event", n, pad });
			return respond(cmd, { sent: cmd.count ?? 1 });
		}
		case "fake_trickle": {
			// Records keep coming after the response, as during a turn: `count` of them, one every `everyMs`.
			let n = 0;
			const timer = setInterval(() => {
				out({ type: "fake_event", tick: n });
				n += 1;
				if (n >= (cmd.count ?? 1)) clearInterval(timer);
			}, cmd.everyMs ?? 10);
			return respond(cmd, {});
		}
		case "fake_unicode":
			// U+2028/U+2029 stay raw inside the JSON string: they must not split the record.
			process.stdout.write(`{"type":"fake_event","text":"a\u2028b\u2029c"}\r\n`);
			return respond(cmd, {});
		case "fake_split": {
			const line = JSON.stringify({ type: "fake_event", split: true });
			process.stdout.write(line.slice(0, 7));
			setTimeout(() => { process.stdout.write(`${line.slice(7)}\nnot json\n`); respond(cmd, {}); }, 30);
			return;
		}
		case "fake_exit":
			out({ type: "fake_event", bye: true });
			if (cmd.afterMs) respond(cmd, {});
			return void setTimeout(() => process.exit(cmd.code ?? 0), cmd.afterMs ?? 10);
		case "fake_host_call":
		case "fake_host_cancel": {
			respond(cmd, {});
			const data = cmd.type === "fake_host_call" ? { callId: cmd.callId, provider: cmd.provider, tool: cmd.tool ?? "phone_camera", args: cmd.args ?? {} } : { callId: cmd.callId };
			const event = { schema: "gentle-shell.desktop-rpc/v1", kind: "event", seq: 1, event: cmd.type === "fake_host_call" ? "host_tool_call" : "host_tool_cancel", data };
			return out({ type: "extension_ui_request", id: `w-${cmd.type}-${cmd.callId}`, method: "setWidget", widgetKey: "gentle-desktop-rpc", widgetLines: [JSON.stringify(event)] });
		}
		case "fake_silent":
			return; // never answers
		default:
			return respond(cmd, `Unknown command: ${cmd.type}`, false);
	}
}

process.stdin.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	let lf;
	while ((lf = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, lf);
		buffer = buffer.slice(lf + 1);
		if (!line.trim()) continue;
		try {
			handle(JSON.parse(line));
		} catch (error) {
			out({ type: "response", command: "parse", success: false, error: String(error) });
		}
	}
});
process.stdin.on("end", () => process.exit(0));
process.stderr.write("fake pi ready\n");
