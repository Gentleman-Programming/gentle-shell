import assert from "node:assert/strict";
import { test } from "node:test";
import {
	PROJECT_TREE_MAX_FILES,
	buildProjectTree,
	createProjectTreeStore,
	flattenProjectTree,
	type ProjectTreeStatus,
} from "../lib/shell-file-tree.ts";

test("el árbol agrupa directorios y marca sólo lo que cambió", () => {
	const statuses = new Map<string, ProjectTreeStatus>([
		["src/extras/implementations/file-tree.ts", "modified"],
		["src/extras/new-file.ts", "untracked"],
	]);
	const roots = buildProjectTree(
		["src/extras/implementations/file-tree.ts", "src/extras/registry.ts", "README.md"],
		statuses,
	);
	const rows = flattenProjectTree(roots);

	assert.deepEqual(
		rows.map((row) => row.path),
		["src", "src/extras", "src/extras/implementations", "src/extras/implementations/file-tree.ts", "src/extras/new-file.ts", "src/extras/registry.ts", "README.md"],
	);
	const modified = rows.find((row) => row.path === "src/extras/implementations/file-tree.ts");
	assert.equal(modified?.status, "modified");
	const clean = rows.find((row) => row.path === "src/extras/registry.ts");
	assert.equal(clean?.status, "clean");
});

test("un directorio hereda el estado de sus hijos", () => {
	const roots = buildProjectTree(
		["src/extras/registry.ts"],
		new Map<string, ProjectTreeStatus>([["src/extras/registry.ts", "modified"]]),
	);
	const src = roots.find((row) => row.path === "src");
	assert.ok(src, "el directorio raíz existe");
	assert.equal(src?.status, "modified");
});

test("la caché lee git una vez y las filas salen sin volver a tocarlo", async () => {
	const store = createProjectTreeStore();
	let calls = 0;
	const runner = async (args: readonly string[]) => {
		calls += 1;
		assert.deepEqual(args, ["ls-files"]);
		return { stdout: "src/a.ts\nsrc/b.ts\nREADME.md\n", code: 0 };
	};

	store.setChanges("root", new Map<string, ProjectTreeStatus>([["src/a.ts", "modified"]]));
	await store.refresh("root", runner);
	assert.equal(calls, 1);

	const snapshot = store.snapshot("root");
	assert.equal(snapshot.tracked, 3);
	assert.equal(snapshot.rows.length, 4, "README, src y sus dos hijos");
	assert.equal(snapshot.rows.find((row) => row.path === "src/a.ts")?.status, "modified");

	// Leer la caché no vuelve a correr git.
	assert.equal(store.snapshot("root").rows.length, 4);
	assert.equal(calls, 1);
});

test("un archivo que el agente creó y no versionó aparece en el árbol", async () => {
	const store = createProjectTreeStore();
	const runner = async () => ({ stdout: "src/a.ts\n", code: 0 });
	store.setChanges("root", new Map<string, ProjectTreeStatus>([["src/nuevo.ts", "untracked"]]));
	await store.refresh("root", runner);

	const paths = store.snapshot("root").rows.map((row) => row.path);
	assert.ok(paths.includes("src/nuevo.ts"), "el archivo nuevo está en el árbol");
	assert.equal(store.snapshot("root").rows.find((row) => row.path === "src/nuevo.ts")?.status, "untracked");
});

test("un archivo borrado no aparece como si existiera", async () => {
	const store = createProjectTreeStore();
	const runner = async () => ({ stdout: "src/a.ts\n", code: 0 });
	store.setChanges("root", new Map<string, ProjectTreeStatus>([["src/borrado.ts", "deleted"]]));
	await store.refresh("root", runner);

	const paths = store.snapshot("root").rows.map((row) => row.path);
	assert.ok(!paths.includes("src/borrado.ts"), "lo borrado no se lista como archivo del proyecto");
});

test("un fallo de git deja la caché vacía sin romper la lectura", async () => {
	const store = createProjectTreeStore();
	await store.refresh("root", async () => ({ stdout: "", code: 1 }));
	assert.equal(store.snapshot("root").rows.length, 0);
});

test("el techo del proyecto es más alto que el de los cambios", () => {
	assert.ok(PROJECT_TREE_MAX_FILES >= 1000);
});

test("plegar un directorio en la caché oculta sus hijos y desplegarlo los restaura sin correr git", async () => {
	const store = createProjectTreeStore();
	let calls = 0;
	await store.refresh("root", async () => {
		calls += 1;
		return { stdout: "src/a.ts\nsrc/sub/b.ts\nREADME.md\n", code: 0 };
	});
	assert.equal(calls, 1);
	assert.deepEqual(
		store.snapshot("root").rows.map((row) => row.path),
		["src", "src/sub", "src/sub/b.ts", "src/a.ts", "README.md"],
	);
	assert.equal(store.toggleFold("root", "src"), true);
	assert.ok(store.foldedPaths("root").has("src"));
	const foldedRows = store.snapshot("root").rows;
	assert.deepEqual(
		foldedRows.map((row) => row.path),
		["src", "README.md"],
	);
	assert.equal(foldedRows[0]?.folded, true);
	assert.equal(store.toggleFold("root", "src"), false);
	assert.equal(store.foldedPaths("root").has("src"), false);
	assert.equal(store.snapshot("root").rows.length, 5);
	assert.equal(calls, 1);
});
