#!/usr/bin/env node
// A stand-in for `gentle-shell --print` in the serve tests: it reads the prompt
// from stdin and answers by what the prompt asks for. No Pi, no model.

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
	if (prompt.startsWith("fail")) {
		process.stderr.write("no model configured\n");
		process.exit(3);
	}
	if (prompt.startsWith("hang")) {
		process.stdout.write("thinking…");
		setInterval(() => {}, 1000);
		return;
	}
	if (prompt.startsWith("big")) {
		process.stdout.write("x".repeat(64 * 1024));
		setInterval(() => {}, 1000);
		return;
	}
	process.stdout.write(`${JSON.stringify({ prompt, args: process.argv.slice(2), cwd: process.cwd(), interactiveHost: process.env.GENTLE_SHELL_INTERACTIVE_HOST ?? null })}\n`);
});
