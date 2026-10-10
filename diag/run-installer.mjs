// Temporary diagnostic: run a package's Gentle AI installer and print the whole cause chain.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.argv[2];
console.log(`ROOT length=${root.length} ${root}`);
const mod = await import(pathToFileURL(join(root, "scripts", "gentle-ai-installer.mjs")).href);
try {
	console.log("RESULT", JSON.stringify(await mod.installGentleAi()));
} catch (error) {
	for (let e = error, n = 0; e && n < 8; e = e.cause, n++) {
		console.log(`CAUSE${n} ${e.code ?? ""} ${e.message}`);
		for (const key of ["stderr", "stdout"]) if (e[key]) console.log(`CAUSE${n}.${key} ${String(e[key]).slice(-5000)}`);
	}
}
