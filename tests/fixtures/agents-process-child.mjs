import { spawn } from "node:child_process";

const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);"], { stdio: ["ignore", "pipe", "ignore"] });
descendant.stdout.once("data", () => {
	console.log(`DESCENDANT:${descendant.pid}`);
	if (process.env.AGENTS_PROCESS_CHILD_EXIT_AFTER_READY === "1") process.exit(0);
});
process.on("SIGTERM", () => {
	if (process.env.AGENTS_PROCESS_CHILD_EXIT_ON_TERM === "1") process.exit(0);
});
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	for (const line of chunk.split("\n")) {
		if (!line) continue;
		try {
			const command = JSON.parse(line);
			process.stdout.write(`${JSON.stringify({ type: "response", id: command.id, success: true })}\n`);
		} catch {
			// Ignore malformed input; the runner owns the RPC protocol.
		}
	}
});
setInterval(() => {}, 1000);
