import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { applySavedModelConfig } from "./gentle-ai.ts";
import { ensureSddPreflight, installPackageAssets } from "../lib/sdd-preflight.ts";
type ExtensionAPI = any;

const CONFIG_REL_PATH = "openspec/config.yaml";
const MAX_SCAN_FILES = 20_000;
const IGNORED_DIRS = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"vendor",
	"dist",
	"build",
	"target",
	"coverage",
	".next",
	".nuxt",
	".turbo",
	".cache",
	"__pycache__",
]);

interface PackageJson {
	name?: string;
	type?: string;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

interface CommandInfo {
	scope: string;
	command: string;
	framework: string;
}

interface Detection {
	projectName: string;
	stack: string[];
	packageManagers: string[];
	markers: string[];
	evidence: string[];
	testCommand?: string;
	testFramework?: string;
	coverageCommand?: string;
	lintCommand?: string;
	typecheckCommand?: string;
	formatCommand?: string;
	commands: {
		unit: CommandInfo[];
		integration: CommandInfo[];
		e2e: CommandInfo[];
		coverage: CommandInfo[];
		lint: CommandInfo[];
		typecheck: CommandInfo[];
		format: CommandInfo[];
	};
}

function yamlString(value: string): string {
	return JSON.stringify(value);
}

function escapeBlockScalar(value: string): string {
	return value
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function hasFile(cwd: string, rel: string): boolean {
	return existsSync(join(cwd, rel));
}

function walkProject(cwd: string): string[] {
	const out: string[] = [];
	const stack = [cwd];
	while (stack.length > 0 && out.length < MAX_SCAN_FILES) {
		const dir = stack.pop()!;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (out.length >= MAX_SCAN_FILES) break;
			if (entry.isDirectory()) {
				if (!IGNORED_DIRS.has(entry.name)) stack.push(join(dir, entry.name));
				continue;
			}
			if (entry.isFile()) out.push(relative(cwd, join(dir, entry.name)));
		}
	}
	return out.sort();
}

function deps(pkg: PackageJson | undefined): Set<string> {
	return new Set([
		...Object.keys(pkg?.dependencies ?? {}),
		...Object.keys(pkg?.devDependencies ?? {}),
		...Object.keys(pkg?.peerDependencies ?? {}),
	]);
}

function detectPackageManagerAt(
	cwd: string,
	relDir: string,
): string | undefined {
	const base = join(cwd, relDir);
	if (existsSync(join(base, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(base, "yarn.lock"))) return "yarn";
	if (existsSync(join(base, "bun.lockb")) || existsSync(join(base, "bun.lock")))
		return "bun";
	if (existsSync(join(base, "package-lock.json"))) return "npm";
	if (existsSync(join(base, "package.json"))) return "npm";
	return undefined;
}

function commandInScope(scope: string, command: string): string {
	return scope === "." ? command : `cd ${scope} && ${command}`;
}

function runScript(pm: string | undefined, script: string): string {
	if (pm === "yarn") return `yarn ${script}`;
	if (pm === "bun") return `bun run ${script}`;
	return `${pm ?? "npm"} run ${script}`;
}

function scriptCommand(
	pm: string | undefined,
	scripts: Record<string, string> | undefined,
	candidates: string[],
): { name: string; command: string } | undefined {
	if (!scripts) return undefined;
	for (const name of candidates) {
		if (!scripts[name]) continue;
		const command =
			name === "test" && pm !== "bun"
				? `${pm ?? "npm"} test`
				: runScript(pm, name);
		return { name, command };
	}
	return undefined;
}

function addUnique(list: CommandInfo[], command: CommandInfo): void {
	if (
		list.some(
			(item) =>
				item.scope === command.scope && item.command === command.command,
		)
	)
		return;
	list.push(command);
}

function addMarker(detection: Detection, marker: string): void {
	if (!detection.markers.includes(marker)) detection.markers.push(marker);
}

function addStack(detection: Detection, stack: string): void {
	if (!detection.stack.includes(stack)) detection.stack.push(stack);
}

function addEvidence(detection: Detection, evidence: string): void {
	if (!detection.evidence.includes(evidence)) detection.evidence.push(evidence);
}

interface GenericHint {
	marker: string;
	stack: string;
	testCommand?: string;
	framework?: string;
}

const GENERIC_HINTS: GenericHint[] = [
	{
		marker: "mix.exs",
		stack: "Elixir",
		testCommand: "mix test",
		framework: "ExUnit",
	},
	{
		marker: "rebar.config",
		stack: "Erlang",
		testCommand: "rebar3 eunit",
		framework: "EUnit",
	},
	{
		marker: "gleam.toml",
		stack: "Gleam",
		testCommand: "gleam test",
		framework: "gleam test",
	},
	{
		marker: "deno.json",
		stack: "Deno",
		testCommand: "deno test",
		framework: "deno test",
	},
	{
		marker: "deno.jsonc",
		stack: "Deno",
		testCommand: "deno test",
		framework: "deno test",
	},
	{
		marker: "Gemfile",
		stack: "Ruby",
		testCommand: "bundle exec rake test",
		framework: "Ruby test task",
	},
	{
		marker: "composer.json",
		stack: "PHP",
		testCommand: "composer test",
		framework: "Composer test script",
	},
	{
		marker: "pom.xml",
		stack: "Java/Maven",
		testCommand: "mvn test",
		framework: "Maven test",
	},
	{
		marker: "build.gradle",
		stack: "Java/Gradle",
		testCommand: "./gradlew test",
		framework: "Gradle test",
	},
	{
		marker: "build.gradle.kts",
		stack: "Java/Kotlin Gradle",
		testCommand: "./gradlew test",
		framework: "Gradle test",
	},
	{
		marker: "pubspec.yaml",
		stack: "Dart/Flutter",
		testCommand: "dart test",
		framework: "Dart test",
	},
	{
		marker: "dune-project",
		stack: "OCaml",
		testCommand: "dune runtest",
		framework: "Dune runtest",
	},
	{
		marker: "shard.yml",
		stack: "Crystal",
		testCommand: "crystal spec",
		framework: "Crystal spec",
	},
	{
		marker: "stack.yaml",
		stack: "Haskell",
		testCommand: "stack test",
		framework: "Stack test",
	},
];

function setPrimaryTest(
	detection: Detection,
	command: CommandInfo,
	prefer = false,
): void {
	if (!detection.testCommand || prefer) {
		detection.testCommand = command.command;
		detection.testFramework = command.framework;
	}
}

function packageDirs(files: string[]): string[] {
	const dirs = files
		.filter((file) => basename(file) === "package.json")
		.map((file) => (dirname(file) === "." ? "." : dirname(file)));
	return [...new Set(dirs)].sort(
		(a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
	);
}

function filesInScope(files: string[], scope: string): string[] {
	if (scope === ".") return files;
	const prefix = `${scope}/`;
	return files
		.filter((file) => file.startsWith(prefix))
		.map((file) => file.slice(prefix.length));
}

function detectNodePackage(
	cwd: string,
	files: string[],
	scope: string,
	detection: Detection,
): void {
	const pkg = readJson<PackageJson>(join(cwd, scope, "package.json"));
	if (!pkg) return;
	const scopedFiles = filesInScope(files, scope);
	const pm = detectPackageManagerAt(cwd, scope);
	if (pm && !detection.packageManagers.includes(pm))
		detection.packageManagers.push(pm);
	addStack(
		detection,
		pkg.type === "module" ? "Node.js/TypeScript ESM" : "Node.js/TypeScript",
	);
	if (pkg.name && detection.projectName === basename(cwd))
		detection.projectName = pkg.name;
	addMarker(
		detection,
		scope === "." ? "package.json" : `${scope}/package.json`,
	);
	if (existsSync(join(cwd, scope, "tsconfig.json")))
		addMarker(detection, `${scope === "." ? "" : `${scope}/`}tsconfig.json`);
	if (pm)
		addMarker(
			detection,
			`${scope === "." ? "" : `${scope}/`}${pm} package manager`,
		);

	const allDeps = deps(pkg);
	if (allDeps.has("react")) addStack(detection, "React");
	if (allDeps.has("next")) addStack(detection, "Next.js");
	if (allDeps.has("vue")) addStack(detection, "Vue");
	if (allDeps.has("svelte")) addStack(detection, "Svelte");
	if (allDeps.has("@earendil-works/pi-coding-agent"))
		addStack(detection, "Pi extension package");

	let unit = scriptCommand(pm, pkg.scripts, [
		"test:run",
		"test",
		"vitest",
		"jest",
		"unit",
	]);
	if (!unit) {
		if (
			allDeps.has("vitest") ||
			scopedFiles.some((file) => /^vitest\.config\./.test(basename(file)))
		) {
			unit = { name: "vitest", command: runScript(pm, "vitest") };
		} else if (
			allDeps.has("jest") ||
			scopedFiles.some((file) => /^jest\.config\./.test(basename(file)))
		) {
			unit = { name: "jest", command: runScript(pm, "jest") };
		}
	}
	if (unit) {
		const framework =
			allDeps.has("vitest") || /vitest/i.test(unit.command)
				? "Vitest"
				: allDeps.has("jest") || /jest/i.test(unit.command)
					? "Jest"
					: "package script";
		const info = {
			scope,
			command: commandInScope(scope, unit.command),
			framework,
		};
		addUnique(detection.commands.unit, info);
		setPrimaryTest(detection, info);
	}

	const integration = scriptCommand(pm, pkg.scripts, [
		"test:integration",
		"integration",
	]);
	if (integration)
		addUnique(detection.commands.integration, {
			scope,
			command: commandInScope(scope, integration.command),
			framework: "package integration script",
		});
	if (allDeps.has("@testing-library/react") || allDeps.has("supertest")) {
		const framework = allDeps.has("supertest")
			? "Supertest"
			: "Testing Library";
		if (unit)
			addUnique(detection.commands.integration, {
				scope,
				command: commandInScope(scope, unit.command),
				framework,
			});
	}

	let e2e = scriptCommand(pm, pkg.scripts, [
		"test:e2e",
		"e2e",
		"playwright",
		"cypress",
	]);
	if (!e2e) {
		if (
			allDeps.has("@playwright/test") ||
			allDeps.has("playwright") ||
			scopedFiles.some((file) => /^playwright\.config\./.test(basename(file)))
		) {
			e2e = { name: "playwright", command: "npx playwright test" };
		} else if (
			allDeps.has("cypress") ||
			scopedFiles.some((file) => /^cypress\.config\./.test(basename(file)))
		) {
			e2e = { name: "cypress", command: "npx cypress run" };
		}
	}
	if (e2e) {
		const framework = /cypress/i.test(e2e.command) ? "Cypress" : "Playwright";
		addUnique(detection.commands.e2e, {
			scope,
			command: commandInScope(scope, e2e.command),
			framework,
		});
	}

	const coverage = scriptCommand(pm, pkg.scripts, [
		"test:coverage",
		"coverage",
	]);
	if (coverage)
		addUnique(detection.commands.coverage, {
			scope,
			command: commandInScope(scope, coverage.command),
			framework: "coverage",
		});
	const lint = scriptCommand(pm, pkg.scripts, [
		"lint",
		"lint:check",
		"check:lint",
	]);
	if (lint)
		addUnique(detection.commands.lint, {
			scope,
			command: commandInScope(scope, lint.command),
			framework: "linter",
		});
	const typecheck = scriptCommand(pm, pkg.scripts, [
		"typecheck",
		"type-check",
		"check:types",
	]);
	if (typecheck)
		addUnique(detection.commands.typecheck, {
			scope,
			command: commandInScope(scope, typecheck.command),
			framework: "type checker",
		});
	const format = scriptCommand(pm, pkg.scripts, [
		"format",
		"format:check",
		"fmt",
		"prettier",
	]);
	if (format)
		addUnique(detection.commands.format, {
			scope,
			command: commandInScope(scope, format.command),
			framework: "formatter",
		});
}

function detectNode(cwd: string, files: string[], detection: Detection): void {
	const dirs = packageDirs(files);
	if (dirs.length === 0 && files.some((file) => /\.[cm]?[tj]sx?$/.test(file)))
		addStack(detection, "Node.js/TypeScript");
	for (const dir of dirs) detectNodePackage(cwd, files, dir, detection);
}

function detectGo(cwd: string, files: string[], detection: Detection): void {
	if (!hasFile(cwd, "go.mod")) return;
	addStack(detection, "Go");
	addMarker(detection, "go.mod");
	const info = { scope: ".", command: "go test ./...", framework: "go test" };
	addUnique(detection.commands.unit, info);
	setPrimaryTest(detection, info);
	if (files.some((file) => file.endsWith("_test.go")))
		addUnique(detection.commands.integration, {
			scope: ".",
			command: "go test ./...",
			framework: "Go integration tests where present",
		});
	addUnique(detection.commands.coverage, {
		scope: ".",
		command: "go test -cover ./...",
		framework: "go coverage",
	});
}

function detectRust(cwd: string, detection: Detection): void {
	if (!hasFile(cwd, "Cargo.toml")) return;
	addStack(detection, "Rust");
	addMarker(detection, "Cargo.toml");
	const info = { scope: ".", command: "cargo test", framework: "cargo test" };
	addUnique(detection.commands.unit, info);
	setPrimaryTest(detection, info);
}

function detectPython(
	cwd: string,
	files: string[],
	detection: Detection,
): void {
	const hasPython =
		hasFile(cwd, "pyproject.toml") ||
		hasFile(cwd, "requirements.txt") ||
		hasFile(cwd, "pytest.ini") ||
		files.some((file) => file.endsWith(".py"));
	if (!hasPython) return;
	addStack(detection, "Python");
	for (const marker of ["pyproject.toml", "requirements.txt", "pytest.ini"]) {
		if (hasFile(cwd, marker)) addMarker(detection, marker);
	}
	if (
		files.some(
			(file) =>
				file.startsWith("tests/") ||
				file.endsWith("_test.py") ||
				basename(file) === "conftest.py",
		)
	) {
		const info = { scope: ".", command: "pytest", framework: "pytest" };
		addUnique(detection.commands.unit, info);
		setPrimaryTest(detection, info);
	}
}

function detectGenericHints(
	cwd: string,
	files: string[],
	detection: Detection,
): void {
	for (const hint of GENERIC_HINTS) {
		if (!hasFile(cwd, hint.marker)) continue;
		addStack(detection, hint.stack);
		addMarker(detection, hint.marker);
		addEvidence(
			detection,
			`${hint.stack} manifest detected via ${hint.marker}`,
		);
		if (hint.testCommand && hint.framework) {
			const info = {
				scope: ".",
				command: hint.testCommand,
				framework: hint.framework,
			};
			addUnique(detection.commands.unit, info);
			setPrimaryTest(detection, info);
		}
	}

	const testFiles = files.filter(
		(file) =>
			/(^|\/)(test|tests|spec|specs)(\/|$)/i.test(file) ||
			/[._-](test|spec)\.[^/]+$/i.test(file),
	);
	if (testFiles.length > 0) {
		addEvidence(
			detection,
			`Test-like files detected (${testFiles.length}); examples: ${testFiles.slice(0, 5).join(", ")}`,
		);
	}
	if (detection.stack.length === 0)
		addStack(detection, "Unclassified software project");
}

function detectMakefile(cwd: string, detection: Detection): void {
	const makefile = ["Makefile", "makefile"].find((file) => hasFile(cwd, file));
	if (!makefile) return;
	addMarker(detection, makefile);
	let content = "";
	try {
		content = readFileSync(join(cwd, makefile), "utf8");
	} catch {
		return;
	}
	if (/^test:/m.test(content)) {
		const info = {
			scope: ".",
			command: "make test",
			framework: "pytest via Makefile",
		};
		addUnique(detection.commands.unit, info);
		setPrimaryTest(detection, info, true);
	}
	if (/^coverage:/m.test(content))
		addUnique(detection.commands.coverage, {
			scope: ".",
			command: "make coverage",
			framework: "coverage",
		});
	if (/^lint:/m.test(content))
		addUnique(detection.commands.lint, {
			scope: ".",
			command: "make lint",
			framework: "linter",
		});
	if (/^(fmt|format):/m.test(content))
		addUnique(detection.commands.format, {
			scope: ".",
			command: /^fmt:/m.test(content) ? "make fmt" : "make format",
			framework: "formatter",
		});
}

function detectProject(cwd: string): Detection {
	const files = walkProject(cwd);
	const detection: Detection = {
		projectName: basename(cwd),
		stack: [],
		packageManagers: [],
		markers: [],
		evidence: [],
		commands: {
			unit: [],
			integration: [],
			e2e: [],
			coverage: [],
			lint: [],
			typecheck: [],
			format: [],
		},
	};
	detectNode(cwd, files, detection);
	detectGo(cwd, files, detection);
	detectRust(cwd, detection);
	detectPython(cwd, files, detection);
	detectGenericHints(cwd, files, detection);
	detectMakefile(cwd, detection);
	if (hasFile(cwd, ".github/workflows")) addMarker(detection, "GitHub Actions");
	detection.coverageCommand = detection.commands.coverage[0]?.command;
	detection.lintCommand = detection.commands.lint[0]?.command;
	detection.typecheckCommand = detection.commands.typecheck[0]?.command;
	detection.formatCommand = detection.commands.format[0]?.command;
	return detection;
}

function commandSummary(commands: CommandInfo[]): string {
	if (commands.length === 0) return "none";
	return commands
		.map((command) => `${command.framework} (${command.command})`)
		.join("; ");
}

function renderContext(detection: Detection): string {
	const lines = [
		`${detection.projectName} is a ${detection.stack.length > 0 ? detection.stack.join(", ") : "software"} project.`,
		`Detected markers: ${detection.markers.length > 0 ? detection.markers.join(", ") : "none"}.`,
	];
	if (detection.packageManagers.length > 0)
		lines.push(`Package managers: ${detection.packageManagers.join(", ")}.`);
	if (detection.evidence.length > 0)
		lines.push(`Additional evidence: ${detection.evidence.join("; ")}.`);
	if (detection.testCommand)
		lines.push(`Primary test command: ${detection.testCommand}.`);
	else
		lines.push(
			"No reliable test runner was detected; verify testing manually before enabling strict TDD.",
		);
	lines.push(`Unit tests: ${commandSummary(detection.commands.unit)}.`);
	lines.push(
		`Integration tests: ${commandSummary(detection.commands.integration)}.`,
	);
	lines.push(`E2E tests: ${commandSummary(detection.commands.e2e)}.`);
	return lines.join("\n");
}

function pushCommandList(
	lines: string[],
	indent: string,
	commands: CommandInfo[],
): void {
	if (commands.length === 0) {
		lines.push(`${indent}[]`);
		return;
	}
	for (const command of commands) {
		lines.push(`${indent}- scope: ${yamlString(command.scope)}`);
		lines.push(`${indent}  command: ${yamlString(command.command)}`);
		lines.push(`${indent}  framework: ${yamlString(command.framework)}`);
	}
}

function renderConfig(detection: Detection): string {
	const strictTdd = Boolean(detection.testCommand);
	const testCommand = detection.testCommand ?? "";
	const today = new Date().toISOString().slice(0, 10);
	const context = renderContext(detection);
	const unitLayer = detection.commands.unit
		.map((command) => command.framework)
		.join(", ");
	const integrationLayer = detection.commands.integration
		.map((command) => command.framework)
		.join(", ");
	const e2eLayer = detection.commands.e2e
		.map((command) => command.framework)
		.join(", ");
	const lines = [
		`strict_tdd: ${strictTdd}`,
		"context: |",
		escapeBlockScalar(context),
		"rules:",
		"  proposal:",
		"    require_problem_statement: true",
		"  spec:",
		"    require_acceptance_criteria: true",
		"  design:",
		"    require_tradeoffs: true",
		"  tasks:",
		"    protect_review_workload: true",
		"  apply:",
		`    test_command: ${yamlString(testCommand)}`,
		"  verify:",
		`    test_command: ${yamlString(testCommand)}`,
		"testing:",
		`  detected: ${yamlString(today)}`,
		"  runner:",
		`    command: ${yamlString(testCommand)}`,
		`    framework: ${yamlString(detection.testFramework ?? "")}`,
		"  layers:",
		`    unit: ${yamlString(unitLayer)}`,
		`    integration: ${yamlString(integrationLayer)}`,
		`    e2e: ${yamlString(e2eLayer)}`,
		"  commands:",
		"    unit:",
	];
	pushCommandList(lines, "      ", detection.commands.unit);
	lines.push("    integration:");
	pushCommandList(lines, "      ", detection.commands.integration);
	lines.push("    e2e:");
	pushCommandList(lines, "      ", detection.commands.e2e);
	lines.push("  coverage:");
	lines.push(`    command: ${yamlString(detection.coverageCommand ?? "")}`);
	lines.push("    commands:");
	pushCommandList(lines, "      ", detection.commands.coverage);
	lines.push("quality:");
	lines.push(`  lint: ${yamlString(detection.lintCommand ?? "")}`);
	lines.push("  lint_commands:");
	pushCommandList(lines, "    ", detection.commands.lint);
	lines.push(`  typecheck: ${yamlString(detection.typecheckCommand ?? "")}`);
	lines.push("  typecheck_commands:");
	pushCommandList(lines, "    ", detection.commands.typecheck);
	lines.push(`  format: ${yamlString(detection.formatCommand ?? "")}`);
	lines.push("  format_commands:");
	pushCommandList(lines, "    ", detection.commands.format);
	lines.push("");
	return lines.join("\n");
}

function ensureOpenSpecDirs(cwd: string): void {
	mkdirSync(join(cwd, "openspec", "specs"), { recursive: true });
	mkdirSync(join(cwd, "openspec", "changes", "archive"), { recursive: true });
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("gentle-sdd-init", {
		description:
			"Auto-detect project stack and bootstrap openspec/config.yaml for SDD.",
		handler: async (_args: unknown, ctx: any) => {
			const prefs = await ensureSddPreflight(ctx, { pi, installAssets: (cwd) => installPackageAssets(cwd, true, ["sdd"]), applyModelConfig: () => applySavedModelConfig(ctx) }, { promptFields: [] });

			const detection = detectProject(ctx.cwd);
			const testSummary = detection.testCommand
				? `strict TDD enabled with \`${detection.testCommand}\``
				: "strict TDD disabled because no test runner was detected";
			const layerSummary = `unit: ${detection.commands.unit.length}, integration: ${detection.commands.integration.length}, e2e: ${detection.commands.e2e.length}`;

			const shouldCreateOpenSpec =
				prefs.artifactStore === "openspec" ||
				prefs.artifactStore === "hybrid";
			if (!shouldCreateOpenSpec) {
				ctx.ui.notify(
					`SDD initialized for ${prefs.artifactStore}: detected ${detection.stack.join(", ") || "project"}; ${testSummary}; tests found: ${layerSummary}.`,
					"info",
				);
				return;
			}

			const configPath = join(ctx.cwd, CONFIG_REL_PATH);
			if (existsSync(configPath)) {
				ctx.ui.notify(
					`${CONFIG_REL_PATH} already exists. Edit it manually or remove it before re-running /gentle-sdd-init.`,
					"warning",
				);
				return;
			}

			ensureOpenSpecDirs(ctx.cwd);
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(configPath, renderConfig(detection));

			ctx.ui.notify(
				`Wrote ${CONFIG_REL_PATH}: detected ${detection.stack.join(", ") || "project"}; ${testSummary}; tests found: ${layerSummary}.`,
				"info",
			);
		},
	});
}
