// Temporary diagnostic: the Windows Gentle AI source build from the pnpm 11 store location.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const store = join(process.env.PNPM_HOME, "store");
const found = [];
const walk = (dir, depth) => {
	if (depth > 9) return;
	let entries = [];
	try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const full = join(dir, entry.name);
		if (entry.name === "gentle-pi" && full.includes("node_modules")) {
			try { if (statSync(join(full, "scripts", "gentle-ai-installer.mjs")).isFile()) found.push(full); } catch {}
		} else walk(full, depth + 1);
	}
};
walk(store, 0);
console.log(`PACKAGES ${JSON.stringify(found)}`);
for (const root of found) {
	console.log(`ROOT length=${root.length} ${root}`);
	const mod = await import(pathToFileURL(join(root, "scripts", "gentle-ai-installer.mjs")).href);
	try {
		console.log("RESULT", JSON.stringify(await mod.installGentleAi()));
	} catch (error) {
		for (let e = error, n = 0; e && n < 6; e = e.cause, n++) {
			console.log(`CAUSE${n} ${e.code ?? ""} ${e.message}`);
			for (const key of ["stderr", "stdout"]) if (e[key]) console.log(`CAUSE${n}.${key} ${String(e[key]).slice(-4000)}`);
		}
	}
}
