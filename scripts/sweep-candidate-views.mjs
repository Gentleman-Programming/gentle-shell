// Internal one-shot helper. Keep all synchronous ownership/reclamation guards in
// this process instead of duplicating them as asynchronous security code.
import { isAbsolute } from "node:path";
import { CandidateViewRegistry } from "../lib/review-candidate-view.ts";

const cwd = process.argv[2];
if (process.argv.length !== 3 || !cwd || !isAbsolute(cwd)) {
	process.stderr.write("Expected one absolute repository directory.\n");
	process.exitCode = 1;
} else {
	// Soft bounds: finish the current guarded removal before checking the next
	// marker. Do not kill this process halfway through a Git/chmod race boundary.
	const result = new CandidateViewRegistry().sweepOrphans(cwd, { maxOwners: 4, budgetMs: 5000 });
	process.stdout.write(JSON.stringify(result ?? {
		examined: 0, remaining: 0, failed: 0, budgetExceeded: false, unavailable: true,
	}) + "\n");
}
