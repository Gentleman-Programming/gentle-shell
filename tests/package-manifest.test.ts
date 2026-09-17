import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { applyModelConfig } from "../extensions/gentle-ai.ts";
import { resolveGentlePiAgentHome } from "../lib/agent-home.ts";
import { getPackageAssetOwner, installPackageAssets, installSddAssets, type PackageAssetOwner } from "../lib/sdd-preflight.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANAGED_EXEMPLAR_FILE = "gentle-ai-explore.md";
const RETIRED_REFUTER_FILE = "review-refuter.md";
const REVIEW_RISK_FILE = "review-risk.md";
const V013_REVIEW_RISK_FIXTURE = join(
	PACKAGE_ROOT,
	"tests",
	"fixtures",
	"v0.13",
	"assets",
	"agents",
	REVIEW_RISK_FILE,
);
const V013_MANAGED_ASSETS = join(
	PACKAGE_ROOT,
	"assets",
	"migrations",
	"managed-assets-v0.13.json",
);
const V014_REVIEW_RISK_FIXTURE = join(
	PACKAGE_ROOT,
	"tests",
	"fixtures",
	"v0.14",
	"assets",
	"agents",
	REVIEW_RISK_FILE,
);
const V014_MANAGED_ASSETS = join(
	PACKAGE_ROOT,
	"assets",
	"migrations",
	"managed-assets-v0.14.json",
);
// gentle-pi#311 P5: the managed-asset installer mechanism tests use
// gentle-ai-explore.md as their exemplar (packaged, absent from the v0.13
// manifest) after review-refuter.md was retired together with every
// Pi-authored adversarial review verdict.
const MANAGED_EXEMPLAR_TOOLS = ["read", "grep", "find", "codegraph"];
const RETIRED_ADVERSARIAL_AGENTS = ["review-refuter.md", "review-validator.md"];

interface ManagedAssetsManifest {
	schemaVersion: number;
	assets: Record<string, string>;
}

interface LegacyManagedAssetsManifest extends ManagedAssetsManifest {
	packageVersion: string;
}

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

interface PackageJsonPiManifest {
	extensions?: string[];
}

interface PackageJson {
	version?: string;
	files?: string[];
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	bundledDependencies?: string[];
	bundleDependencies?: string[];
	repository?: {
		type?: string;
		url?: string;
	};
	pi?: PackageJsonPiManifest;
}

function readPackageJson(): PackageJson {
	const rawPackageJson = readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8");

	try {
		return JSON.parse(rawPackageJson) as PackageJson;
	} catch (error) {
		throw new Error("package.json must contain valid JSON", { cause: error });
	}
}

test("technical reference declares the tested Pi minimum required for agent_settled", () => {
	const manifest = readPackageJson();
	assert.equal(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"], ">=0.85.1");
	assert.equal(manifest.devDependencies?.["@earendil-works/pi-coding-agent"], "0.85.1");
	const reference = readFileSync(join(PACKAGE_ROOT, "docs", "readme-reference.md"), "utf8");
	assert.match(reference, /Pi 0\.85\.1 or newer/);
	assert.match(reference, /agent_settled/);
	assert.match(readFileSync(join(PACKAGE_ROOT, "README.md"), "utf8"), /\]\(docs\/readme-reference\.md(?:#[^)]+)?\)/);
});

test("package manifest has no obsolete native activation build surface", () => {
	const packageJson = readPackageJson();
	const manifest = JSON.stringify(packageJson);

	assert.ok(!packageJson.files?.includes("native/"), "package must not ship the obsolete native addon directory");
	assert.ok(!packageJson.scripts?.["native:build"], "package must not expose an obsolete native build script");
	assert.doesNotMatch(manifest, /build-native-addon|gentle_review_native|review-native-fence/i);
	assert.doesNotMatch(packageJson.scripts?.prepack ?? "", /native:build/);
	assert.doesNotMatch(packageJson.scripts?.prepublishOnly ?? "", /native:build/);
});

test("package verification names the native review runtime boundary and packaged fixtures", () => {
	const verifier = readFileSync(join(PACKAGE_ROOT, "scripts", "verify-package-files.mjs"), "utf8");
	const manifest = readPackageJson();

	assert.ok(manifest.files?.includes("lib/"), "the published package must include the native review runtime module directory");
	assert.ok(manifest.files?.includes("runtime/"), "the published package must include generated JavaScript runtime modules");
	assert.match(verifier, /"lib\/native-review-cli\.ts"/, "package verification must require the native review adapter from the packaged runtime");
	assert.match(verifier, /"runtime\/native-review-cli\.mjs"/, "package verification must require the generated native review adapter");
	assert.match(verifier, /build-runtime-modules\.mjs.*--check/s, "package verification must reject generated-runtime drift");
	assert.match(verifier, /"tests\/fixtures\/native-review-cli\/v2\.1\.3\/start\.json"/, "package verification must retain the pinned native decoder fixture");
	assert.match(
		readFileSync(join(PACKAGE_ROOT, "extensions", "gentle-ai.ts"), "utf8"),
		/createNativeReviewCli\(\)/,
		"the production extension must construct its native client from the packaged runtime module",
	);
});

test("npm publication is bound to the exact package tag and triggering commit", () => {
	const workflow = readFileSync(join(PACKAGE_ROOT, ".github", "workflows", "publish.yml"), "utf8");
	const releaseSkill = readFileSync(join(PACKAGE_ROOT, "skills", "release", "SKILL.md"), "utf8");
	const packageJson = readPackageJson();
	const dispatchBlock = workflow.match(
		/^ {2}workflow_dispatch:\n([\s\S]*?)^\npermissions:/m,
	)?.[1];
	assert.ok(dispatchBlock);
	const inputNames = [
		...dispatchBlock.matchAll(/^ {6}([A-Za-z0-9_-]+):$/gm),
	].map((match) => match[1]);

	assert.match(workflow, /on:\n\s+workflow_dispatch:\s*\n/);
	assert.deepEqual(inputNames, ["tag"], "the trusted workflow must expose exactly one caller input");
	assert.match(workflow, /inputs:\n\s+tag:/, "the trusted main workflow must accept only the release tag");
	assert.match(workflow, /RELEASE_TAG: \$\{\{ inputs\.tag \}\}/);
	assert.doesNotMatch(workflow, /checkout-ref|dist-tag.*inputs|inputs\.(?!tag)/, "the release workflow must not accept checkout or dist-tag inputs");
	assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/, "checkout must use the immutable event SHA");
	assert.match(workflow, /persist-credentials: false/, "the release checkout must not retain GitHub credentials");
	assert.match(workflow, /DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/);
	assert.match(workflow, /\$\{DEFAULT_BRANCH\}" != "main"/);
	assert.match(workflow, /\$\{GITHUB_REF\}" != "refs\/heads\/main"/);
	assert.match(workflow, /\$\{GITHUB_REF_TYPE\}" != "branch"/);
	assert.match(workflow, /Release tag is not exact vSemVer/);
	assert.match(workflow, /git ls-remote origin[\s\S]*"refs\/heads\/main"[\s\S]*"refs\/tags\/\$\{tag\}"/);
	assert.match(workflow, /git fetch --atomic --no-tags origin/);
	assert.match(workflow, /refs\/heads\/main:refs\/remotes\/origin\/release-main/);
	assert.match(workflow, /refs\/tags\/\$\{tag\}:refs\/release-verification\/tag/);
	assert.match(workflow, /git cat-file -t refs\/release-verification\/tag/);
	assert.match(workflow, /git checkout --detach "\$\{tag_commit\}"/);
	assert.match(workflow, /git rev-parse "\$\{GITHUB_SHA\}\^\{commit\}"/);
	assert.match(workflow, /git rev-parse ['"]HEAD\^\{commit\}['"]/);
	assert.match(workflow, /Reverify protected release authority and publish/);
	assert.match(workflow, /Release authority changed after verification/);
	assert.match(workflow, /id-token: write/, "trusted publishing requires OIDC");
	assert.match(workflow, /node-version: "24"/, "trusted publishing must use a supported Node.js version");
	assert.match(workflow, /const minimum = \[11, 5, 1\]/, "trusted publishing must reject npm versions below 11.5.1");
	assert.match(workflow, /packageJson\.repository\?\.type !== expectedRepository\.type/);
	assert.match(workflow, /packageJson\.repository\?\.url !== expectedRepository\.url/);
	assert.deepEqual(
		packageJson.repository,
		{
			type: "git",
			url: "git+https://github.com/Gentleman-Programming/gentle-shell.git",
		},
		"trusted publishing requires the exact case-sensitive npm repository identity",
	);
	assert.match(workflow, /npm publish --provenance --access public/);
	assert.doesNotMatch(workflow, /pnpm publish|--no-git-checks|NODE_AUTH_TOKEN/);

	assert.match(releaseSkill, /tag="v\$\{version\}"/);
	assert.match(releaseSkill, /release_sha="\$\(git rev-parse 'origin\/main\^\{commit\}'\)"/);
	assert.match(releaseSkill, /git rev-parse "\$\{tag\}\^\{commit\}"/);
	assert.match(releaseSkill, /git fetch --no-tags origin "refs\/tags\/\$\{tag\}"/);
	assert.match(releaseSkill, /gh release create "\$\{tag\}"[\s\S]*--verify-tag/);
	assert.match(releaseSkill, /--ref main/);
	assert.match(releaseSkill, /-f tag="\$\{tag\}"/);
	assert.match(releaseSkill, /trusted OIDC with provenance/);
	assert.doesNotMatch(releaseSkill, /--ref "\$\{tag\}"|-f dist-tag=/);
});

test("Pi delivery relay is absent from the packaged extension", () => {
	const extension = readFileSync(join(PACKAGE_ROOT, "extensions", "gentle-ai.ts"), "utf8");

	assert.doesNotMatch(extension, /review-publication-gate/);
});

test("generated runtime modules and packed-package checks are deterministic", () => {
	const packageJson = readPackageJson();
	const generator = readFileSync(join(PACKAGE_ROOT, "scripts", "build-runtime-modules.mjs"), "utf8");
	const packedRunner = readFileSync(join(PACKAGE_ROOT, "scripts", "test-packed-runner.mjs"), "utf8");
	const ci = readFileSync(join(PACKAGE_ROOT, ".github", "workflows", "ci.yml"), "utf8");
	assert.equal(packageJson.scripts?.["build:runtime-modules"], "node scripts/build-runtime-modules.mjs --write");
	assert.equal(packageJson.scripts?.["check:runtime-modules"], "node scripts/build-runtime-modules.mjs --check");
	assert.equal(packageJson.scripts?.["test:packed-package"], "node scripts/test-packed-runner.mjs");
	assert.match(packageJson.scripts?.prepublishOnly ?? "", /pnpm run test:packed-package/);
	assert.match(ci, /pnpm run check:runtime-modules/);
	assert.match(ci, /pnpm run test:packed-package/);
	assert.match(generator, /Generated by scripts\/build-runtime-modules\.mjs/);
	const ordinaryPostinstall = readNamedFunction(packedRunner, "testHookedPackedRunner");
	assert.match(ordinaryPostinstall, /\["install"[^\]]*"--ignore-scripts=false"/s, "ordinary packed install must explicitly enable postinstall");
	assert.doesNotMatch(ordinaryPostinstall, /\["install"[^\]]*"--ignore-scripts"(?!\=false)/s);
	for (const name of [
		"testSdkLifecyclePackedSession",
		"testWindowsStartupTimingPackedHelper",
		"testWindowsStartupTimingEnvironmentExperiment",
		"testUnhookedPackedImports",
	]) {
		const isolatedInstall = readNamedFunction(packedRunner, name);
		assert.match(isolatedInstall, /\["install"[^\]]*"--ignore-scripts"(?!\=false)/s, `${name} must isolate installation scripts`);
		assert.doesNotMatch(isolatedInstall, /\["install"[^\]]*"--ignore-scripts=false"/s, `${name} must not enable postinstall`);
	}
	const windowsNpmInvocation = readNamedFunction(packedRunner, "windowsNpmInvocation");
	const runNpmWithEnv = readNamedFunction(packedRunner, "runNpmWithEnv");
	assert.match(windowsNpmInvocation, /execFileSync\("where\.exe", \["npm"\]/);
	assert.match(windowsNpmInvocation, /return \{ file: process\.execPath, prefix: \[installedCli\] \}/);
	assert.match(windowsNpmInvocation, /return \{ file: path, prefix: \[\] \}/);
	assert.match(windowsNpmInvocation, /could not resolve npm-cli\.js without a command shell/);
	assert.doesNotMatch(windowsNpmInvocation, /ComSpec|cmd\.exe/);
	assert.match(runNpmWithEnv, /execFileSync\(invocation\.file, \[\.\.\.invocation\.prefix, \.\.\.arguments_\]/);
	assert.match(runNpmWithEnv, /\.\.\.options, env/);
	assert.doesNotMatch(packedRunner, /shell\s*:\s*true/);
	assert.match(packedRunner, /review", "capabilities", "--contract", "gentle-ai\.review-integration\/v2"/);
	assert.doesNotMatch(packedRunner, /git-commit-transaction|transaction runner/i);
});

test("package manifest ships and runs the checked-in package-local Gentle AI installer", () => {
	const packageJson = readPackageJson();
	const verifier = readFileSync(join(PACKAGE_ROOT, "scripts", "verify-package-files.mjs"), "utf8");
	const reference = readFileSync(join(PACKAGE_ROOT, "docs", "readme-reference.md"), "utf8");

	assert.equal(packageJson.scripts?.postinstall, "node scripts/install-gentle-ai.mjs");
	assert.match(reference, /run `node scripts\/install-gentle-ai\.mjs`/, "missing-binary recovery documentation must use the package postinstall entrypoint");
	assert.match(reference, /installed `gentle-pi` package directory/, "recovery documentation must name the package working directory");
	assert.match(reference, /if `GENTLE_PI_SKIP_GENTLE_AI_INSTALL` is set, remove or unset it before/i, "recovery documentation must prevent the installer skip from repeating");
	assert.ok(packageJson.files?.includes("scripts/"));
	assert.match(verifier, /"scripts\/install-gentle-ai\.mjs"/);
	assert.match(verifier, /"scripts\/gentle-ai-installer\.mjs"/);
	assert.match(verifier, /"lib\/gentle-ai-binary\.ts"/);
});

test("package manifest installs pi-pretty through a wrapper without bundling native optional dependencies", () => {
	const packageJson = readPackageJson();

	assert.equal(
		packageJson.dependencies?.["@heyhuynhgiabuu/pi-pretty"],
		"0.6.27",
		"gentle-pi must install the tested pi-pretty version containing the model-visible result integrity fix",
	);
	assert.ok(
		packageJson.pi?.extensions?.includes("./extensions"),
		"gentle-pi must load packaged extension wrappers",
	);
	assert.ok(
		!packageJson.pi?.extensions?.includes(
			"./node_modules/@heyhuynhgiabuu/pi-pretty/dist/index.js",
		),
		"gentle-pi must not reference pnpm-unportable nested node_modules paths",
	);
	const piPrettyWrapperPath = join(PACKAGE_ROOT, "extensions", "pi-pretty.ts");
	assert.ok(
		existsSync(piPrettyWrapperPath),
		"gentle-pi must expose pi-pretty through a packaged wrapper extension",
	);
	const piPrettyWrapper = readFileSync(piPrettyWrapperPath, "utf8");
	assert.match(
		piPrettyWrapper,
		/import\("@heyhuynhgiabuu\/pi-pretty"\)/,
		"the wrapper must use the compiled-runtime-safe ESM loader",
	);
	assert.doesNotMatch(
		piPrettyWrapper,
		/requireFromRealPackage\("@heyhuynhgiabuu\/pi-pretty"\)/,
		"the wrapper must not resolve the pi-pretty package root through createRequire",
	);
	assert.ok(
		existsSync(join(PACKAGE_ROOT, "extensions", "quiet-tools.ts")),
		"gentle-pi must expose quiet built-in tool rendering through a packaged extension",
	);
	assert.ok(
		!packageJson.bundledDependencies?.includes("@heyhuynhgiabuu/pi-pretty"),
		"pi-pretty must not be bundled because its native optional dependencies are platform-specific",
	);
	assert.ok(
		!packageJson.bundleDependencies?.includes("@heyhuynhgiabuu/pi-pretty"),
		"pi-pretty must not be bundled because its native optional dependencies are platform-specific",
	);
});

test("package verification binds the published Gentle AI v3.1.0 runtime pin", () => {
	const installer = readFileSync(join(PACKAGE_ROOT, "scripts", "gentle-ai-installer.mjs"), "utf8");
	const binary = readFileSync(join(PACKAGE_ROOT, "lib", "gentle-ai-binary.ts"), "utf8");
	const verifier = readFileSync(join(PACKAGE_ROOT, "scripts", "verify-package-files.mjs"), "utf8");

	assert.match(installer, /INSTALLER_VERSION = "3\.1\.0"/);
	assert.match(installer, /GENTLE_AI_WINDOWS_SOURCE_PACKAGE.*GENTLE_AI_WINDOWS_SOURCE_MODULE/);
	assert.match(installer, /GENTLE_AI_WINDOWS_SOURCE_MODULE_CHECKSUM = "h1:CrZlui5N8\/RSmxvn\/7usKe6q1EvRt7y6dyfEwjstmJw="/);
	assert.match(installer, /GOTOOLCHAIN: "local"/);
	assert.match(installer, /GOSUMDB: "sum\.golang\.org"/);
	assert.match(binary, /GENTLE_AI_VERSION = INSTALLER_VERSION/);
	assert.match(binary, /GO_SUMDB_SOURCE_BUILD/);
	assert.match(binary, /GENTLE_AI_WINDOWS_SOURCE_MODULE_CHECKSUM/);
	assert.match(verifier, /v3\.1\.0/);
});


function readAgentFrontmatter(file: string): string {
	const source = readFileSync(file, "utf8");
	const match = source.match(/^---\n([\s\S]*?)\n---/);
	assert.ok(match, `${file} must have frontmatter`);
	return match[1];
}

function readAgentDefinition(file: string): {
	name: string;
	source: string;
	tools: string[];
} {
	const source = readFileSync(file, "utf8");
	const frontmatter = readAgentFrontmatter(file);
	const name = frontmatter.match(/^name:\s*(\S+)$/m)?.[1];
	assert.ok(name, `${file} must declare a frontmatter name`);
	const toolsBlock = frontmatter.match(
		/^tools:\n(?: {2}- "\*": false\n)?((?: {2}- [\w-]+\n?)+)/m,
	)?.[1];
	assert.ok(toolsBlock, `${file} must declare a YAML tool list`);
	const tools = [...toolsBlock.matchAll(/^ {2}- ([\w-]+)$/gm)].map(
		(match) => match[1],
	);

	return { name, source, tools };
}

function readTextContract(source: string, heading: string): string {
	const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = source.match(
		new RegExp(`^## ${escapedHeading}\\n[\\s\\S]*?\\n\\x60\\x60\\x60text\\n([\\s\\S]*?)\\n\\x60\\x60\\x60`, "m"),
	);
	assert.ok(match, `${heading} must include a text contract block`);
	return match[1];
}

function contractFields(contract: string, indentation = 0): string[] {
	const prefix = " ".repeat(indentation);
	return contract
		.split("\n")
		.flatMap((line) => {
			const match = line.match(new RegExp(`^${prefix}([a-z_]+):`));
			return match ? [match[1]] : [];
		});
}

function nestedContractFields(contract: string, parent: string): string[] {
	const lines = contract.split("\n");
	const parentIndexes = lines.flatMap((line, index) =>
		line.startsWith(`${parent}:`) ? [index] : [],
	);
	assert.equal(parentIndexes.length, 1, `${parent} must appear exactly once at top level`);

	const tail = lines.slice(parentIndexes[0] + 1);
	const relativeEnd = tail.findIndex((line) => /^\S/.test(line));
	const nestedBlock = relativeEnd === -1 ? tail : tail.slice(0, relativeEnd);

	return contractFields(nestedBlock.join("\n"), 2);
}

function readNamedFunction(source: string, name: string): string {
	const fileName = "test-packed-runner.mjs";
	const options: ts.CompilerOptions = {
		allowJs: true,
		noLib: true,
		noResolve: true,
		target: ts.ScriptTarget.Latest,
	};
	const host = ts.createCompilerHost(options, true);
	host.getSourceFile = (requested, languageVersion) =>
		requested === fileName
			? ts.createSourceFile(requested, source, languageVersion, true, ts.ScriptKind.JS)
			: undefined;
	host.fileExists = (requested) => requested === fileName;
	host.readFile = (requested) => requested === fileName ? source : undefined;
	host.getCurrentDirectory = () => ".";
	host.writeFile = () => {};
	const program = ts.createProgram([fileName], options, host);
	const sourceFile = program.getSourceFile(fileName);
	assert.ok(sourceFile, "packed runner source must be available to the in-memory compiler host");
	assert.equal(program.getSyntacticDiagnostics(sourceFile).length, 0, "packed runner source must have no syntactic diagnostics");
	const declarations = sourceFile.statements.filter(
		(statement): statement is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(statement) && statement.name?.text === name,
	);
	assert.equal(declarations.length, 1, `packed runner must define exactly one top-level ${name}`);
	const declaration = declarations[0];
	assert.ok(declaration.body, `${name} must have a complete function body`);
	assert.ok(declaration.body.end > declaration.body.pos, `${name} must have a non-empty function body`);
	return source.slice(declaration.getStart(sourceFile), declaration.end);
}

test("readNamedFunction fails closed for missing, duplicate, and incomplete declarations", () => {
	assert.equal(readNamedFunction("function target() { return 1; }\nfunction neighbor() { return 2; }\n", "target"), "function target() { return 1; }");
	assert.throws(() => readNamedFunction("const target = () => {};\n", "target"), /exactly one top-level target/);
	assert.throws(() => readNamedFunction("function target() {}\nfunction target() {}\n", "target"), /exactly one top-level target/);
	assert.throws(() => readNamedFunction("function target() {\n", "target"), /packed runner source must have no syntactic diagnostics/);
	assert.throws(() => readNamedFunction("function target() {}\nfunction neighbor( {}\n", "target"), /packed runner source must have no syntactic diagnostics/);
});

function readMarkdownSection(source: string, heading: string): string {
	const lines = source.split(/\r?\n/);
	const matches = lines.flatMap((line, index) => {
		const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
		return match?.[2] === heading
			? [{ index, level: match[1].length }]
			: [];
	});
	assert.equal(matches.length, 1, `Markdown must contain exactly one ${heading} section`);

	const [{ index: start, level }] = matches;
	const relativeEnd = lines.slice(start + 1).findIndex((line) => {
		const match = line.match(/^(#{1,6})\s+/);
		return match !== null && match[1].length <= level;
	});
	const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd;

	return lines.slice(start + 1, end).join("\n").trim();
}

function assertWorkerFallbackRouting(section: string, sectionName: string): void {
	const boundedWriterPolicy = section.match(
		/For bounded multi-file writes,[\s\S]*?(?=\n\n|\n\s*\d+\.|$)/,
	)?.[0];
	assert.ok(boundedWriterPolicy, `${sectionName} must define bounded writer routing`);

	const preferred = boundedWriterPolicy.indexOf("`gentle-ai-worker`");
	const configuredFallback = boundedWriterPolicy.indexOf("user-configured `worker`");
	const nativeFallback = boundedWriterPolicy.indexOf("native `Agent`");

	assert.ok(preferred >= 0, `${sectionName} must reference exact gentle-ai-worker name`);
	assert.ok(
		configuredFallback > preferred,
		`${sectionName} must prefer the package-owned worker before a user-configured worker`,
	);
	assert.ok(
		nativeFallback > configuredFallback,
		`${sectionName} must place native Agent after both named worker definitions`,
	);
	assert.match(
		boundedWriterPolicy,
		/If neither (?:worker )?definition exists[^.]*native `Agent`[^.]*even when `subagent_\*` tools are available\./,
		`${sectionName} must choose native Agent when neither worker definition exists`,
	);
	assert.match(
		section,
		/If no delegation mechanism is available, stop/,
		`${sectionName} must stop when delegation is impossible`,
	);
}

test("Markdown section extraction isolates policy text from sibling sections", () => {
	const markdown = [
		"# Agent",
		"## Context contract",
		"context-only policy",
		"### Context detail",
		"nested context policy",
		"## Tool safety",
		"tool-only policy",
	].join("\n");

	const context = readMarkdownSection(markdown, "Context contract");

	assert.match(context, /context-only policy/);
	assert.match(context, /nested context policy/);
	assert.doesNotMatch(context, /tool-only policy/);
});

test("packaged agents use YAML list syntax for tool allowlists", () => {
	const agentsDir = join(PACKAGE_ROOT, "assets", "agents");
	const agentFiles = readdirSync(agentsDir).flatMap((entry) =>
		entry.endsWith(".md") ? [join(agentsDir, entry)] : [],
	);

	assert.ok(agentFiles.length > 0, "gentle-pi must ship packaged agents");

	for (const file of agentFiles) {
		const frontmatter = readAgentFrontmatter(file);
		assert.doesNotMatch(
			frontmatter,
			/^tools:\s*[^\n,]+(?:,\s*[^\n,]+)+$/m,
			`${file} must not use comma-separated inline tools; pi-subagents expects a YAML list`,
		);
		assert.match(
			frontmatter,
			/^tools:\n(?: {2}- "\*": false\n)?(?: {2}- [\w-]+\n?)+/m,
			`${file} must declare tools as a YAML list`,
		);
	}
});

// The Pi child-session tool registry exposes `find` for filesystem discovery
// and has no `glob` or `webfetch` builtin (see tests/runtime-harness.mjs and
// the working builtin `reviewer` canary in issue #62). A packaged agent that
// declares a name the runtime cannot resolve does not fail loudly: the SDK
// silently drops it and the child starts with a reduced allowlist, so the
// agent reports itself blocked instead of naming the missing tool.
const UNSUPPORTED_CHILD_SESSION_TOOLS = ["glob", "webfetch"];

test("packaged agents declare only tool names a Pi child session can resolve", () => {
	const agentsDir = join(PACKAGE_ROOT, "assets", "agents");
	const agentFiles = readdirSync(agentsDir).flatMap((entry) =>
		entry.endsWith(".md") ? [join(agentsDir, entry)] : [],
	);

	assert.ok(agentFiles.length > 0, "gentle-pi must ship packaged agents");

	for (const file of agentFiles) {
		const { tools } = readAgentDefinition(file);
		for (const unsupported of UNSUPPORTED_CHILD_SESSION_TOOLS) {
			assert.ok(
				!tools.includes(unsupported),
				`${file} declares ${unsupported}, which no Pi child session exposes; use find for discovery`,
			);
		}
	}
});

function withIsolatedAssetHome(run: (agentHome: string) => void): void {
	const temporary = mkdtempSync(join(tmpdir(), "gentle-asset-owners-"));
	const previous = process.env.GENTLE_PI_AGENT_HOME;
	try {
		process.env.GENTLE_PI_AGENT_HOME = temporary;
		run(temporary);
	} finally {
		if (previous === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previous;
		rmSync(temporary, { recursive: true, force: true });
	}
}

function installedAssetManifest(agentHome: string): ManagedAssetsManifest {
	return JSON.parse(readFileSync(join(agentHome, "gentle-ai", "managed-assets.json"), "utf8"));
}

test("selective delegation installation owns only generic agents", () => {
	withIsolatedAssetHome((agentHome) => {
		const result = installPackageAssets(agentHome, false, ["delegation"]);
		assert.deepEqual(Object.keys(installedAssetManifest(agentHome).assets).sort(), [
			"agents/gentle-ai-explore.md",
			"agents/gentle-ai-verify.md",
			"agents/gentle-ai-worker.md",
		]);
		assert.deepEqual(result, { agents: 3, chains: 0, support: 0, skipped: 0 });
		assert.deepEqual(readdirSync(join(agentHome, "agents")).sort(), [
			"gentle-ai-explore.md", "gentle-ai-verify.md", "gentle-ai-worker.md",
		]);
		assert.equal(existsSync(join(agentHome, "chains")), false);
		assert.equal(existsSync(join(agentHome, "gentle-ai", "support")), false);
	});
});

test("selective installation retires only assets belonging to the selected owner", () => {
	withIsolatedAssetHome((agentHome) => {
		installSddAssets(agentHome, false);
		const manifestPath = join(agentHome, "gentle-ai", "managed-assets.json");
		const manifest = installedAssetManifest(agentHome);
		for (const name of RETIRED_ADVERSARIAL_AGENTS) {
			writeFileSync(join(agentHome, "agents", name), "Previously managed review agent\n");
			manifest.assets[`agents/${name}`] = sha256("Previously managed review agent\n");
		}
		writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
		for (const owner of ["delegation", "sdd"] as const) {
			installPackageAssets(agentHome, true, [owner]);
			assert.deepEqual(installedAssetManifest(agentHome), manifest);
			for (const name of RETIRED_ADVERSARIAL_AGENTS) {
				assert.equal(readFileSync(join(agentHome, "agents", name), "utf8"), "Previously managed review agent\n");
			}
		}
		writeFileSync(join(agentHome, "agents", "review-validator.md"), "User-modified retired agent\n");
		installPackageAssets(agentHome, false, ["review"]);
		assert.equal(existsSync(join(agentHome, "agents", "review-refuter.md")), false);
		assert.equal(readFileSync(join(agentHome, "agents", "review-validator.md"), "utf8"), "User-modified retired agent\n");
		for (const name of RETIRED_ADVERSARIAL_AGENTS) {
			assert.equal(installedAssetManifest(agentHome).assets[`agents/${name}`], undefined);
		}
	});
});

const EXPECTED_OWNER_ASSETS: Record<PackageAssetOwner, readonly string[]> = {
	delegation: [
		"agents/gentle-ai-explore.md", "agents/gentle-ai-verify.md", "agents/gentle-ai-worker.md",
	],
	review: [
		"agents/jd-fix-agent.md", "agents/jd-judge-a.md", "agents/jd-judge-b.md",
		"agents/review-readability.md", "agents/review-reliability.md",
		"agents/review-resilience.md", "agents/review-risk.md", "chains/4r-review.chain.md",
	],
	sdd: [
		"agents/sdd-apply.md", "agents/sdd-archive.md", "agents/sdd-design.md",
		"agents/sdd-explore.md", "agents/sdd-init.md", "agents/sdd-onboard.md",
		"agents/sdd-proposal.md", "agents/sdd-remediate.md", "agents/sdd-research.md", "agents/sdd-spec.md",
		"agents/sdd-status.md", "agents/sdd-tasks.md", "agents/sdd-verify.md",
		"chains/sdd-full.chain.md", "chains/sdd-plan.chain.md", "chains/sdd-verify.chain.md",
		"gentle-ai/support/sdd-status-contract.md", "gentle-ai/support/strict-tdd-verify.md",
		"gentle-ai/support/strict-tdd.md",
	],
};

function assetFileKeys(root: string, prefix = ""): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
		const key = `${prefix}${entry.name}`;
		return entry.isDirectory() ? assetFileKeys(join(root, entry.name), `${key}/`) : [key];
	}).sort();
}

for (const owner of Object.keys(EXPECTED_OWNER_ASSETS) as PackageAssetOwner[]) {
	test(`selective ${owner} installation covers its catalog without cross-owner files`, () => {
		withIsolatedAssetHome((agentHome) => {
			const expected = [...EXPECTED_OWNER_ASSETS[owner]].sort();
			installPackageAssets(agentHome, false, [owner]);
			assert.deepEqual(Object.keys(installedAssetManifest(agentHome).assets).sort(), expected);
			assert.deepEqual(assetFileKeys(agentHome), [...expected, "gentle-ai/managed-assets.json"].sort());
			for (const key of expected) {
				assert.equal(getPackageAssetOwner(key), owner);
				const source = join(PACKAGE_ROOT, "assets", key.replace(/^gentle-ai\//, ""));
				assert.equal(readFileSync(join(agentHome, key), "utf8"), readFileSync(source, "utf8"));
			}
			const counts = installPackageAssets(agentHome, false, [owner, owner]);
			assert.deepEqual(counts, { agents: 0, chains: 0, support: 0, skipped: expected.length });
		});
	});
}

test("legacy all-assets installation covers every packaged file with explicit ownership", () => {
	const packaged = ["agents", "chains", "support"].flatMap(group =>
		assetFileKeys(join(PACKAGE_ROOT, "assets", group), group === "support" ? "gentle-ai/support/" : `${group}/`),
	).sort();
	assert.deepEqual(packaged, Object.values(EXPECTED_OWNER_ASSETS).flat().sort());
	for (const key of packaged) assert.notEqual(getPackageAssetOwner(key), undefined, key);
	for (const key of ["agents/sdd-new.md", "gentle-ai/support/new.md", "toString", "__proto__"]) {
		assert.equal(getPackageAssetOwner(key), undefined, "unknown assets must not default to SDD");
	}
	withIsolatedAssetHome((agentHome) => {
		assert.deepEqual(installSddAssets(agentHome, false), { agents: 23, chains: 4, support: 3, skipped: 0 });
		assert.deepEqual(Object.keys(installedAssetManifest(agentHome).assets).sort(), packaged);
		assert.deepEqual(installSddAssets(agentHome, false), { agents: 0, chains: 0, support: 0, skipped: 30 });
		assert.deepEqual(installSddAssets(agentHome, true), { agents: 23, chains: 4, support: 3, skipped: 0 });
	});
});

test("selective refresh preserves unselected ownership and selected user changes after an all-assets install", () => {
	withIsolatedAssetHome((agentHome) => {
		installSddAssets(agentHome, false);
		const manifest = installedAssetManifest(agentHome);
		const selectedUserKey = "agents/gentle-ai-explore.md";
		const unselectedUserKey = "agents/sdd-apply.md";
		for (const key of [selectedUserKey, unselectedUserKey, "agents/custom.md"]) {
			writeFileSync(join(agentHome, key), "User-authored instructions\n");
		}
		const before = new Map(assetFileKeys(agentHome).map(key => [key, readFileSync(join(agentHome, key), "utf8")]));
		assert.deepEqual(installPackageAssets(agentHome, true, ["delegation"]), { agents: 2, chains: 0, support: 0, skipped: 1 });
		delete manifest.assets[selectedUserKey];
		assert.deepEqual(installedAssetManifest(agentHome), manifest);
		for (const [key, content] of before) {
			if (key !== "gentle-ai/managed-assets.json") assert.equal(readFileSync(join(agentHome, key), "utf8"), content, key);
		}
		const manifestBytes = readFileSync(join(agentHome, "gentle-ai", "managed-assets.json"), "utf8");
		assert.deepEqual(installPackageAssets(agentHome, true, []), { agents: 0, chains: 0, support: 0, skipped: 0 });
		assert.equal(readFileSync(join(agentHome, "gentle-ai", "managed-assets.json"), "utf8"), manifestBytes);
	});
});

test("selective review migration adopts only untouched legacy copies and preserves routing", () => {
	for (const edited of [false, true]) {
		withIsolatedAssetHome((agentHome) => {
			mkdirSync(join(agentHome, "agents"));
			const legacy = readFileSync(V014_REVIEW_RISK_FIXTURE, "utf8")
				.replace("name: review-risk\n", "name: review-risk\nmodel: custom/model\nthinking: high\n")
				+ (edited ? "\nUser review restrictions.\n" : "");
			const target = join(agentHome, "agents", REVIEW_RISK_FILE);
			writeFileSync(target, legacy);
			installPackageAssets(agentHome, true, ["delegation"]);
			assert.equal(readFileSync(target, "utf8"), legacy);
			assert.equal(installedAssetManifest(agentHome).assets["agents/review-risk.md"], undefined);
			const result = installPackageAssets(agentHome, true, ["review"]);
			const actual = readFileSync(target, "utf8");
			const manifest = installedAssetManifest(agentHome);
			assert.equal(result.skipped, edited ? 1 : 0);
			if (edited) {
				assert.equal(actual, legacy);
				assert.equal(manifest.assets["agents/review-risk.md"], undefined);
			} else {
				assert.notEqual(actual, legacy);
				assert.match(actual, /model: custom\/model\nthinking: high/);
				assert.equal(manifest.assets["agents/review-risk.md"], sha256(actual));
			}
			assert.equal(existsSync(join(agentHome, "agents", "sdd-apply.md")), false);
			assert.equal(existsSync(join(agentHome, "gentle-ai", "support")), false);
		});
	}
});

test("unowned legacy research migrates by exact normalized hash, preserving routing and user edits", () => {
	// Historical bytes must not be reconstructed from the evolving current agent.
	const legacy = readFileSync(join(PACKAGE_ROOT, "tests/fixtures/legacy/sdd-research-v2.5.0.md"), "utf8");
	const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "assets", "migrations", "managed-assets-v2.5.0.json"), "utf8"));
	assert.equal(sha256(legacy), manifest.assets["agents/sdd-research.md"], "fixture reconstruction must match observed old package bytes");
	const temporary = mkdtempSync(join(tmpdir(), "gentle-research-migration-"));
	const previous = process.env.GENTLE_PI_AGENT_HOME;
	try {
		for (const edited of [false, true]) {
			const agentHome = join(temporary, edited ? "edited" : "legacy");
			process.env.GENTLE_PI_AGENT_HOME = agentHome;
			mkdirSync(join(agentHome, "agents"), { recursive: true });
			const target = join(agentHome, "agents", "sdd-research.md");
			const routed = legacy.replace("name: sdd-research\n", "name: sdd-research\nmodel: custom/model\nthinking: high\n") + (edited ? "\nUser research restrictions.\n" : "");
			writeFileSync(target, routed);
			installSddAssets(temporary, true);
			const actual = readFileSync(target, "utf8");
			if (edited) assert.equal(actual, routed);
			else {
				assert.match(actual, /  - fetch_content/);
				assert.match(actual, /model: custom\/model\nthinking: high/);
				const ownership = JSON.parse(readFileSync(join(agentHome, "gentle-ai", "managed-assets.json"), "utf8"));
				assert.equal(ownership.assets["agents/sdd-research.md"], sha256(actual));
				installSddAssets(temporary, true);
				assert.equal(readFileSync(target, "utf8"), actual, "subsequent refresh keeps adopted model routing");
			}
		}
	} finally {
		if (previous === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previous;
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("the retired Pi adversarial role agents are not packaged", () => {
	// gentle-pi#311 P5: the refuter and targeted validator verdicts execute
	// through Go-owned pi processes via provider-rendered self-contained
	// vectors; the Pi-authored agent definitions must stay deleted.
	for (const retired of RETIRED_ADVERSARIAL_AGENTS) {
		assert.ok(!existsSync(join(PACKAGE_ROOT, "assets", "agents", retired)), `${retired} must stay deleted`);
	}
});

test("forced package installation preserves same-path user-authored agents and separate shadows, including on retired asset paths", () => {
	// The user-authored file below sits on the RETIRED review-refuter.md path:
	// this also pins that gentle-pi#311 P5 asset retirement deletes only
	// hash-proven package-managed copies, never user content.
	const temporaryAgentHome = mkdtempSync(join(tmpdir(), "gentle-pi-refuter-home-"));
	const temporaryProject = mkdtempSync(join(tmpdir(), "gentle-pi-refuter-project-"));
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	const samePathUserAgent = join(temporaryAgentHome, "agents", RETIRED_REFUTER_FILE);
	const userShadow = join(temporaryAgentHome, "subagents", RETIRED_REFUTER_FILE);
	const projectOverride = join(temporaryProject, ".pi", "agents", RETIRED_REFUTER_FILE);
	const userAgentSource = [
		"---",
		"name: review-refuter",
		"tools:",
		"  - read",
		"  - bash",
		"---",
		"user-authored permission policy",
		"",
	].join("\n");

	try {
		process.env.GENTLE_PI_AGENT_HOME = temporaryAgentHome;
		mkdirSync(dirname(projectOverride), { recursive: true });
		writeFileSync(projectOverride, "project override must stay\n");
		mkdirSync(dirname(userShadow), { recursive: true });
		writeFileSync(userShadow, "user shadow must stay\n");
		mkdirSync(dirname(samePathUserAgent), { recursive: true });
		writeFileSync(samePathUserAgent, userAgentSource);

		installSddAssets(temporaryProject, true);

		assert.deepEqual(
			readFileSync(samePathUserAgent),
			Buffer.from(userAgentSource),
			"force refresh must not claim a same-path user agent by filename",
		);
		assert.equal(
			readFileSync(projectOverride, "utf8"),
			"project override must stay\n",
			"package refresh must preserve explicit project overrides",
		);
		assert.equal(
			readFileSync(userShadow, "utf8"),
			"user shadow must stay\n",
			"package refresh must preserve separate user shadows",
		);
	} finally {
		if (previousAgentHome === undefined) {
			delete process.env.GENTLE_PI_AGENT_HOME;
		} else {
			process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		}
		rmSync(temporaryAgentHome, { recursive: true, force: true });
		rmSync(temporaryProject, { recursive: true, force: true });
	}
});

test("v0.13 ownership evidence is bundled and matches the self-contained upgrade fixture", () => {
	const legacyManifest = JSON.parse(
		readFileSync(V013_MANAGED_ASSETS, "utf8"),
	) as LegacyManagedAssetsManifest;
	const legacyReviewRisk = readFileSync(V013_REVIEW_RISK_FIXTURE, "utf8");

	assert.equal(legacyManifest.packageVersion, "0.13.0");
	assert.equal(
		legacyManifest.assets[`agents/${REVIEW_RISK_FILE}`],
		sha256(legacyReviewRisk),
		"published migration evidence must fingerprint the exact v0.13 package asset",
	);
});

test("v0.14 ownership evidence is bundled and matches the self-contained bounded-review fixture", () => {
	const legacyManifest = JSON.parse(
		readFileSync(V014_MANAGED_ASSETS, "utf8"),
	) as LegacyManagedAssetsManifest;
	const legacyReviewRisk = readFileSync(V014_REVIEW_RISK_FIXTURE, "utf8");

	assert.equal(legacyManifest.packageVersion, "0.14.0");
	assert.equal(
		legacyManifest.assets[`agents/${REVIEW_RISK_FILE}`],
		sha256(legacyReviewRisk),
		"migration evidence must fingerprint the exact pre-transaction v0.14 asset",
	);
});

test("first forced sync migrates untouched v0.13 assets, preserves routing, and owns new assets", () => {
	const temporaryAgentHome = mkdtempSync(join(tmpdir(), "gentle-pi-v013-upgrade-"));
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	const installedReviewRisk = join(temporaryAgentHome, "agents", REVIEW_RISK_FILE);
	const installedExemplar = join(temporaryAgentHome, "agents", MANAGED_EXEMPLAR_FILE);
	const managedAssetsManifest = join(
		temporaryAgentHome,
		"gentle-ai",
		"managed-assets.json",
	);
	const legacySource = readFileSync(V013_REVIEW_RISK_FIXTURE, "utf8");
	const routedLegacySource = legacySource.replace(
		"description: R1 Risk reviewer — security, privilege boundaries, data exposure, dependency risks, and merge-blocking vulnerabilities.\n",
		"description: R1 Risk reviewer — security, privilege boundaries, data exposure, dependency risks, and merge-blocking vulnerabilities.\nmodel: private/legacy-model\nthinking: xhigh\n",
	);

	try {
		process.env.GENTLE_PI_AGENT_HOME = temporaryAgentHome;
		mkdirSync(dirname(installedReviewRisk), { recursive: true });
		writeFileSync(installedReviewRisk, routedLegacySource);
		assert.equal(existsSync(managedAssetsManifest), false, "v0.13 had no ownership manifest");

		installSddAssets(PACKAGE_ROOT, true);

		const migrated = readFileSync(installedReviewRisk, "utf8");
		const currentPackageSource = readFileSync(
			join(PACKAGE_ROOT, "assets", "agents", REVIEW_RISK_FILE),
			"utf8",
		);
		assert.notEqual(migrated, routedLegacySource, "the stale v0.13 review contract must refresh");
		assert.match(migrated, /^model: private\/legacy-model$/m);
		assert.match(migrated, /^thinking: xhigh$/m);
		assert.equal(
			migrated.replace(/^model: .*\n|^thinking: .*\n/gm, ""),
			currentPackageSource,
			"migration must update the package body without losing user routing",
		);
		assert.equal(
			readFileSync(installedExemplar, "utf8"),
			readFileSync(join(PACKAGE_ROOT, "assets", "agents", MANAGED_EXEMPLAR_FILE), "utf8"),
			"an asset missing from v0.13 must install normally",
		);

		const manifest = JSON.parse(
			readFileSync(managedAssetsManifest, "utf8"),
		) as ManagedAssetsManifest;
		assert.equal(manifest.assets[`agents/${REVIEW_RISK_FILE}`], sha256(migrated));
		assert.equal(
			manifest.assets[`agents/${MANAGED_EXEMPLAR_FILE}`],
			sha256(readFileSync(installedExemplar, "utf8")),
		);

		const userEditedMigration = migrated.replace(
			"Run this selected lens exactly once against the supplied `initial_review_tree`.",
			"Run this selected lens exactly once against the supplied `initial_review_tree` with a user-authored note.",
		);
		assert.notEqual(userEditedMigration, migrated, "the fixture must exercise post-migration drift");
		writeFileSync(installedReviewRisk, userEditedMigration);
		installSddAssets(PACKAGE_ROOT, true);
		assert.deepEqual(
			readFileSync(installedReviewRisk),
			Buffer.from(userEditedMigration),
			"exact full-content ownership must protect edits made after migration",
		);
		const postEditManifest = JSON.parse(
			readFileSync(managedAssetsManifest, "utf8"),
		) as ManagedAssetsManifest;
		assert.equal(postEditManifest.assets[`agents/${REVIEW_RISK_FILE}`], undefined);
	} finally {
		if (previousAgentHome === undefined) {
			delete process.env.GENTLE_PI_AGENT_HOME;
		} else {
			process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		}
		rmSync(temporaryAgentHome, { recursive: true, force: true });
	}
});

test("first forced sync migrates untouched v0.14 review contracts and preserves routing", () => {
	const temporaryAgentHome = mkdtempSync(join(tmpdir(), "gentle-pi-v014-upgrade-"));
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	const installedReviewRisk = join(temporaryAgentHome, "agents", REVIEW_RISK_FILE);
	const legacySource = readFileSync(V014_REVIEW_RISK_FIXTURE, "utf8");
	const routedLegacySource = legacySource.replace(
		"description: R1 Risk reviewer — security, privilege boundaries, data exposure, dependency risks, and merge-blocking vulnerabilities.\n",
		"description: R1 Risk reviewer — security, privilege boundaries, data exposure, dependency risks, and merge-blocking vulnerabilities.\nmodel: private/v014-model\nthinking: high\n",
	);

	try {
		process.env.GENTLE_PI_AGENT_HOME = temporaryAgentHome;
		mkdirSync(dirname(installedReviewRisk), { recursive: true });
		writeFileSync(installedReviewRisk, routedLegacySource);

		installSddAssets(PACKAGE_ROOT, true);

		const migrated = readFileSync(installedReviewRisk, "utf8");
		assert.notEqual(migrated, routedLegacySource);
		assert.match(migrated, /^model: private\/v014-model$/m);
		assert.match(migrated, /^thinking: high$/m);
		assert.match(migrated, /initial_review_tree/);
		assert.doesNotMatch(migrated, /Full 4R runs at most two complete sweeps per lens/);
		const currentPackageSource = readFileSync(
			join(PACKAGE_ROOT, "assets", "agents", REVIEW_RISK_FILE),
			"utf8",
		);
		assert.equal(
			migrated.replace(/^model: .*\n|^thinking: .*\n/gm, ""),
			currentPackageSource,
		);
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		rmSync(temporaryAgentHome, { recursive: true, force: true });
	}
});

test("first forced sync preserves a body-edited v0.13 asset byte-for-byte", () => {
	const temporaryAgentHome = mkdtempSync(join(tmpdir(), "gentle-pi-v013-edited-"));
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	const installedReviewRisk = join(temporaryAgentHome, "agents", REVIEW_RISK_FILE);
	const editedLegacySource = readFileSync(V013_REVIEW_RISK_FIXTURE, "utf8").replace(
		"Find security risks; do not fix them.",
		"Find security risks; preserve this user-authored body edit.",
	);

	try {
		process.env.GENTLE_PI_AGENT_HOME = temporaryAgentHome;
		mkdirSync(dirname(installedReviewRisk), { recursive: true });
		writeFileSync(installedReviewRisk, editedLegacySource);

		installSddAssets(PACKAGE_ROOT, true);

		assert.deepEqual(readFileSync(installedReviewRisk), Buffer.from(editedLegacySource));
		const manifest = JSON.parse(
			readFileSync(join(temporaryAgentHome, "gentle-ai", "managed-assets.json"), "utf8"),
		) as ManagedAssetsManifest;
		assert.equal(manifest.assets[`agents/${REVIEW_RISK_FILE}`], undefined);
	} finally {
		if (previousAgentHome === undefined) {
			delete process.env.GENTLE_PI_AGENT_HOME;
		} else {
			process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		}
		rmSync(temporaryAgentHome, { recursive: true, force: true });
	}
});

test("forced package installation refreshes an asset recorded as package-managed", () => {
	const temporaryAgentHome = mkdtempSync(join(tmpdir(), "gentle-pi-malformed-refuter-"));
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	const installedExemplar = join(temporaryAgentHome, "agents", MANAGED_EXEMPLAR_FILE);
	const managedAssetsManifest = join(
		temporaryAgentHome,
		"gentle-ai",
		"managed-assets.json",
	);
	const previousPackageSource =
		"---\nname: gentle-ai-explore\ntools:\n  - read\n  - bash\n---\nprevious package version\n";
	const routedPreviousPackageSource = previousPackageSource.replace(
		"name: gentle-ai-explore\n",
		"name: gentle-ai-explore\nmodel: openai/previous-package\nthinking: high\n",
	);

	try {
		process.env.GENTLE_PI_AGENT_HOME = temporaryAgentHome;
		installSddAssets(PACKAGE_ROOT, true);
		assert.ok(existsSync(installedExemplar), "a missing package asset must install");
		assert.ok(
			existsSync(managedAssetsManifest),
			"the installer must record ownership independently from the filename",
		);

		const manifest = JSON.parse(
			readFileSync(managedAssetsManifest, "utf8"),
		) as ManagedAssetsManifest;
		writeFileSync(installedExemplar, routedPreviousPackageSource);
		manifest.assets[`agents/${MANAGED_EXEMPLAR_FILE}`] = sha256(
			routedPreviousPackageSource,
		);
		writeFileSync(managedAssetsManifest, JSON.stringify(manifest, null, 2));

		installSddAssets(PACKAGE_ROOT, true);

		const refreshed = readAgentDefinition(installedExemplar);
		assert.deepEqual(refreshed.tools, MANAGED_EXEMPLAR_TOOLS);
		assert.doesNotMatch(refreshed.source, /^  - bash$/m);
	} finally {
		if (previousAgentHome === undefined) {
			delete process.env.GENTLE_PI_AGENT_HOME;
		} else {
			process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		}
		rmSync(temporaryAgentHome, { recursive: true, force: true });
	}
});

function assertManagedAgentUserEditIsPreserved(
	editLabel: string,
	editSource: (source: string) => string,
): void {
	const temporaryAgentHome = mkdtempSync(join(tmpdir(), "gentle-pi-managed-edit-"));
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	const installedExemplar = join(temporaryAgentHome, "agents", MANAGED_EXEMPLAR_FILE);
	const managedAssetsManifest = join(
		temporaryAgentHome,
		"gentle-ai",
		"managed-assets.json",
	);

	try {
		process.env.GENTLE_PI_AGENT_HOME = temporaryAgentHome;
		installSddAssets(PACKAGE_ROOT, true);
		const installedSource = readFileSync(installedExemplar, "utf8");
		const userEditedSource = editSource(installedSource);
		assert.notEqual(userEditedSource, installedSource, `${editLabel} must alter the asset`);
		writeFileSync(installedExemplar, userEditedSource);

		installSddAssets(PACKAGE_ROOT, true);

		assert.deepEqual(
			readFileSync(installedExemplar),
			Buffer.from(userEditedSource),
			`${editLabel} must invalidate ownership and survive force refresh byte-for-byte`,
		);
		const manifest = JSON.parse(
			readFileSync(managedAssetsManifest, "utf8"),
		) as ManagedAssetsManifest;
		assert.equal(
			manifest.assets[`agents/${MANAGED_EXEMPLAR_FILE}`],
			undefined,
			`${editLabel} must remove package ownership`,
		);
	} finally {
		if (previousAgentHome === undefined) {
			delete process.env.GENTLE_PI_AGENT_HOME;
		} else {
			process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		}
		rmSync(temporaryAgentHome, { recursive: true, force: true });
	}
}

test("forced package installation preserves a model-only edit to a managed agent", () => {
	assertManagedAgentUserEditIsPreserved("a model-only user edit", (source) =>
		source.replace(
			"name: gentle-ai-explore\n",
			"name: gentle-ai-explore\nmodel: private/user-model\n",
		),
	);
});

test("forced package installation preserves a thinking-only edit to a managed agent", () => {
	assertManagedAgentUserEditIsPreserved("a thinking-only user edit", (source) =>
		source.replace(
			"name: gentle-ai-explore\n",
			"name: gentle-ai-explore\nthinking: xhigh\n",
		),
	);
});

test("forced package installation preserves an ordinary body edit to a managed agent", () => {
	assertManagedAgentUserEditIsPreserved("an ordinary body edit", (source) =>
		source.replace(
			"You are the read-only explorer for generic non-SDD work.",
			"Preserve this user-authored body change. You are the read-only explorer for generic non-SDD work.",
		),
	);
});

test("package model assignment keeps only package-managed agents owned", () => {
	const temporaryAgentHome = mkdtempSync(join(tmpdir(), "gentle-pi-model-ownership-"));
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	const installedExemplar = join(temporaryAgentHome, "agents", MANAGED_EXEMPLAR_FILE);
	const userAgent = join(temporaryAgentHome, "agents", "user-router.md");
	const managedAssetsManifest = join(
		temporaryAgentHome,
		"gentle-ai",
		"managed-assets.json",
	);
	const userAgentSource = "---\nname: user-router\n---\nuser-owned body\n";

	try {
		process.env.GENTLE_PI_AGENT_HOME = temporaryAgentHome;
		installSddAssets(PACKAGE_ROOT, true);
		writeFileSync(userAgent, userAgentSource);

		applyModelConfig(PACKAGE_ROOT, {
			"gentle-ai-explore": { model: "package/selected-model", thinking: "high" },
			"user-router": { model: "user/selected-model", thinking: "low" },
		});

		const routedExemplar = readFileSync(installedExemplar, "utf8");
		const routedUserAgent = readFileSync(userAgent, "utf8");
		assert.match(routedExemplar, /^model: package\/selected-model$/m);
		assert.match(routedExemplar, /^thinking: high$/m);
		assert.match(routedUserAgent, /^model: user\/selected-model$/m);
		assert.match(routedUserAgent, /^thinking: low$/m);

		const manifest = JSON.parse(
			readFileSync(managedAssetsManifest, "utf8"),
		) as ManagedAssetsManifest;
		assert.equal(
			manifest.assets[`agents/${MANAGED_EXEMPLAR_FILE}`],
			sha256(routedExemplar),
			"package-controlled routing must update the managed asset hash coherently",
		);
		assert.equal(
			manifest.assets["agents/user-router.md"],
			undefined,
			"routing an arbitrary user agent must not relabel it as package-owned",
		);

		installSddAssets(PACKAGE_ROOT, true);
		assert.equal(
			readFileSync(installedExemplar, "utf8"),
			readFileSync(join(PACKAGE_ROOT, "assets", "agents", MANAGED_EXEMPLAR_FILE), "utf8"),
			"a routed package-managed agent must remain eligible for package refresh",
		);
		assert.equal(
			readFileSync(userAgent, "utf8"),
			routedUserAgent,
			"package refresh must preserve the routed arbitrary user agent",
		);
	} finally {
		if (previousAgentHome === undefined) {
			delete process.env.GENTLE_PI_AGENT_HOME;
		} else {
			process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		}
		rmSync(temporaryAgentHome, { recursive: true, force: true });
	}
});

test("jd-fix-agent packaged allowlist includes write tools", () => {
	const frontmatter = readAgentFrontmatter(
		join(PACKAGE_ROOT, "assets", "agents", "jd-fix-agent.md"),
	);

	for (const tool of ["read", "edit", "write", "bash"]) {
		assert.match(frontmatter, new RegExp(`^  - ${tool}$`, "m"));
	}
});

test("sdd-explore packages its CodeGraph-enabled exploration allowlist", () => {
	const agentPath = join(PACKAGE_ROOT, "assets", "agents", "sdd-explore.md");
	const { name, tools } = readAgentDefinition(agentPath);

	assert.equal(name, "sdd-explore");
	assert.deepEqual(tools, [
		"read",
		"grep",
		"find",
		"codegraph",
		"edit",
		"write",
		"mem_save",
	]);
});

test("gentle-ai-worker packages the exact scoped writer contract", () => {
	const agentsDir = join(PACKAGE_ROOT, "assets", "agents");
	const agentPath = join(agentsDir, "gentle-ai-worker.md");
	assert.ok(existsSync(agentPath), "gentle-pi must package gentle-ai-worker.md");
	for (const genericName of ["worker.md", "generic-writer.md"]) {
		assert.ok(
			!existsSync(join(agentsDir, genericName)),
			`the package-owned writer must not use collision-prone ${genericName}`,
		);
	}

	const { name, source, tools } = readAgentDefinition(agentPath);
	assert.equal(name, "gentle-ai-worker");
	assert.deepEqual(tools, [
		"read",
		"grep",
		"find",
		"edit",
		"write",
		"bash",
		"mem_save",
	]);
	assert.ok(
		tools.every((tool) => !tool.startsWith("subagent_")),
		"a subagent must not be able to delegate",
	);
	assert.ok(!tools.includes("glob"), "the unsupported glob tool must not return");

	const interactionContract = readMarkdownSection(source, "Interaction contract");
	assert.doesNotMatch(
		interactionContract,
		/```text/,
		"the interaction section must not define a second normative envelope",
	);
	assert.match(interactionContract, /stop editing/i);
	assert.match(interactionContract, /full schema in the Return contract/);
	assert.match(interactionContract, /`status: interaction_required`/);
	assert.match(interactionContract, /nested `interaction_required` payload/);

	const returnContract = readTextContract(source, "Return contract");
	assert.deepEqual(contractFields(returnContract), [
		"status",
		"summary",
		"files_changed",
		"tdd_evidence",
		"validation",
		"risks",
		"review_focus",
		"skill_resolution",
		"interaction_required",
	]);
	assert.deepEqual(nestedContractFields(returnContract, "interaction_required"), [
		"question",
		"reason",
		"options",
		"unblock_response",
	]);
	assert.match(
		returnContract,
		/skill_resolution: paths-injected \| paths-invalid \| none/,
	);
	assert.equal(
		(source.match(/```text/g) ?? []).length,
		1,
		"the Return contract must be the single authoritative full handoff schema",
	);
	assert.doesNotMatch(source, /fallback-(?:registry|path)/);

	const returnContractSection = readMarkdownSection(source, "Return contract");
	assert.match(
		returnContractSection,
		/Use `skill_resolution: paths-invalid` only when the parent injected one or more exact skill paths and any supplied path cannot be read/,
	);
	assert.match(
		returnContractSection,
		/With `skill_resolution: paths-invalid`, keep `status: blocked`/,
	);

	const contextContract = readMarkdownSection(source, "Context contract");
	assert.match(contextContract, /pre-existing untracked targets explicitly listed by the parent/);
	assert.match(contextContract, /new files required by the delegated task/);
	assert.match(contextContract, /derived candidate set the human can approve or narrow/);
	assert.match(contextContract, /never an open request for the human to author paths or globs/);
	assert.match(interactionContract, /closed set the human can approve, decline, or select from/);
	assert.match(interactionContract, /never ask the human to author paths, globs, identifiers, or commands as free text/);

	const implementationRules = readMarkdownSection(source, "Implementation rules");
	assert.match(implementationRules, /`blocked` only for a non-human technical blocker/);

	const toolSafety = readMarkdownSection(source, "Tool safety");
	assert.match(toolSafety, /sensitive files/);
	assert.match(toolSafety, /stage, commit, push, publish/);

	const memorySafety = readMarkdownSection(source, "Memory safety");
	assert.match(memorySafety, /secrets, credentials, personal data/);
	assert.match(memorySafety, /raw untrusted repository/);

	const testDiscipline = readMarkdownSection(source, "Test discipline");
	assert.match(testDiscipline, /Strict TDD is active/);
	assert.match(testDiscipline, /not active/);
	assert.match(
		testDiscipline,
		/Broad suites, builds, formatters, or linters may run only when explicitly authorized by the parent\./,
	);
	assert.match(testDiscipline, /Keep every command exact and verify its scope before execution\./);
	assert.doesNotMatch(testDiscipline, /clearly required by the repository contract/);
});

test("installSddAssets installs gentle-ai-worker with a loader-compatible scoped identity", () => {
	const temporaryAgentHome = mkdtempSync(join(tmpdir(), "gentle-pi-agent-home-"));
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;

	try {
		process.env.GENTLE_PI_AGENT_HOME = temporaryAgentHome;
		installSddAssets(PACKAGE_ROOT, true);

		const installedAgentsDir = join(temporaryAgentHome, "agents");
		const installedAgentPath = join(installedAgentsDir, "gentle-ai-worker.md");
		assert.ok(existsSync(installedAgentPath), "the production installer must install gentle-ai-worker.md");
		for (const genericName of ["worker.md", "generic-writer.md"]) {
			assert.ok(
				!existsSync(join(installedAgentsDir, genericName)),
				`the installer must not create collision-prone ${genericName}`,
			);
		}

		const { name, source, tools } = readAgentDefinition(installedAgentPath);
		const normalizedRuntimeIdentity = name.trim().toLowerCase();
		assert.equal(normalizedRuntimeIdentity, "gentle-ai-worker");
		assert.deepEqual(tools, [
			"read",
			"grep",
			"find",
			"edit",
			"write",
			"bash",
			"mem_save",
		]);
		assert.doesNotMatch(
			readAgentFrontmatter(installedAgentPath),
			/^package\s*:/m,
			"package frontmatter must not alter external loader identity",
		);
		assert.doesNotMatch(source, /^name:\s*(?:worker|generic-writer)$/m);
	} finally {
		if (previousAgentHome === undefined) {
			delete process.env.GENTLE_PI_AGENT_HOME;
		} else {
			process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		}
		rmSync(temporaryAgentHome, { recursive: true, force: true });
	}

	assert.equal(process.env.GENTLE_PI_AGENT_HOME, previousAgentHome);
	assert.ok(
		!existsSync(temporaryAgentHome),
		"the integration test must delete only its temporary agent home",
	);
});

test("agent home resolver centralizes Gentle and Pi agent-dir precedence", () => {
	const explicitGentleHome = mkdtempSync(join(tmpdir(), "gentle-pi-resolver-explicit-"));
	const piAgentDir = mkdtempSync(join(tmpdir(), "gentle-pi-resolver-pi-dir-"));

	try {
		assert.equal(
			resolveGentlePiAgentHome({
				GENTLE_PI_AGENT_HOME: explicitGentleHome,
				PI_CODING_AGENT_DIR: piAgentDir,
			}),
			explicitGentleHome,
		);
		assert.equal(resolveGentlePiAgentHome({ PI_CODING_AGENT_DIR: piAgentDir }), piAgentDir);
		assert.equal(resolveGentlePiAgentHome({}), join(homedir(), ".pi", "agent"));
		assert.equal(
			resolveGentlePiAgentHome({ GENTLE_PI_AGENT_HOME: "", PI_CODING_AGENT_DIR: piAgentDir }),
			piAgentDir,
			"an empty explicit override falls through like Pi Subagents does",
		);
		assert.equal(
			resolveGentlePiAgentHome({ PI_CODING_AGENT_DIR: "" }),
			join(homedir(), ".pi", "agent"),
			"an empty PI_CODING_AGENT_DIR falls through like Pi Subagents does",
		);
	} finally {
		rmSync(explicitGentleHome, { recursive: true, force: true });
		rmSync(piAgentDir, { recursive: true, force: true });
	}
});

test("asset installation uses PI_CODING_AGENT_DIR as the Pi agent home when no explicit Gentle override is set", () => {
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
	const temporaryPiAgentDir = mkdtempSync(join(tmpdir(), "gentle-pi-agent-dir-"));
	const explicitGentleHome = mkdtempSync(join(tmpdir(), "gentle-pi-explicit-home-"));

	try {
		delete process.env.GENTLE_PI_AGENT_HOME;
		process.env.PI_CODING_AGENT_DIR = temporaryPiAgentDir;

		installSddAssets(PACKAGE_ROOT, true);

		const installedPath = join(temporaryPiAgentDir, "agents", "gentle-ai-explore.md");
		assert.ok(existsSync(installedPath), "managed agents must install where Pi Subagents reads global definitions");
		assert.deepEqual(readAgentDefinition(installedPath).tools, MANAGED_EXEMPLAR_TOOLS);
		assert.ok(
			!existsSync(join(explicitGentleHome, "agents", "gentle-ai-explore.md")),
			"the explicit override fixture must still be untouched before it is selected",
		);

		process.env.GENTLE_PI_AGENT_HOME = explicitGentleHome;
		installSddAssets(PACKAGE_ROOT, true);
		assert.ok(
			existsSync(join(explicitGentleHome, "agents", "gentle-ai-explore.md")),
			"GENTLE_PI_AGENT_HOME remains the explicit test/operator override",
		);
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
		rmSync(temporaryPiAgentDir, { recursive: true, force: true });
		rmSync(explicitGentleHome, { recursive: true, force: true });
	}
});

test("global model routing uses PI_CODING_AGENT_DIR for package-installed agents", () => {
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
	const temporaryPiAgentDir = mkdtempSync(join(tmpdir(), "gentle-pi-model-agent-dir-"));
	const temporaryProject = mkdtempSync(join(tmpdir(), "gentle-pi-model-project-"));

	try {
		delete process.env.GENTLE_PI_AGENT_HOME;
		process.env.PI_CODING_AGENT_DIR = temporaryPiAgentDir;
		installSddAssets(PACKAGE_ROOT, true);

		const result = applyModelConfig(temporaryProject, {
			"gentle-ai-explore": { model: "provider/model", thinking: "high" },
		});

		assert.equal(result.updated, 2);
		const config = JSON.parse(readFileSync(join(temporaryPiAgentDir, "subagents.json"), "utf8"));
		assert.deepEqual(config.model_profiles["gentle-ai-explore"], {
			model: "provider/model",
			effort: "high",
		});
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
		rmSync(temporaryPiAgentDir, { recursive: true, force: true });
		rmSync(temporaryProject, { recursive: true, force: true });
	}
});

test("normal and forced installation copy generic agents with complete role contracts", () => {
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	const expectedTools = {
		"gentle-ai-explore": ["read", "grep", "find", "codegraph"],
		"gentle-ai-verify": ["read", "grep", "find", "bash"],
	} as const;

	try {
		for (const force of [false, true]) {
			const temporaryAgentHome = mkdtempSync(join(tmpdir(), "gentle-pi-generic-agents-"));
			process.env.GENTLE_PI_AGENT_HOME = temporaryAgentHome;
			try {
				installSddAssets(PACKAGE_ROOT, force);

				for (const [name, tools] of Object.entries(expectedTools)) {
					const packagedPath = join(PACKAGE_ROOT, "assets", "agents", `${name}.md`);
					const installedPath = join(temporaryAgentHome, "agents", `${name}.md`);
					const { name: installedName, source, tools: installedTools } = readAgentDefinition(installedPath);
					assert.equal(source, readFileSync(packagedPath, "utf8"));
					assert.equal(installedName, name);
					assert.deepEqual(installedTools, tools);
					assert.match(source, /generic non-SDD work/);
					assert.match(source, /Do not (?:fix findings, delegate to child agents|delegate to child agents, commit)/);
					if (name === "gentle-ai-explore") {
						assert.match(source, /cwd-scoped `codegraph` tool/);
						assert.match(source, /never ask it to target another path/);
						assert.match(source, /sole permitted mutation/);
						assert.match(source, /all tracked files, source files, and other project content remain read-only/);
						assert.match(source, /CodeGraph reports that it is unavailable or fails/);
						assert.match(source, /Do not use that fallback before CodeGraph is unavailable or fails/);
					}
					assert.match(source, /Do not (?:edit, write|edit, write, or fix findings)/);
					assert.match(source, /compressed (?:handoff|evidence handoff)/);
					assert.match(source, /Do not use SDD phase protocols or review lenses\./);
					if (name === "gentle-ai-verify") {
						assert.match(source, /exact test, build, or lint commands explicitly authorized by the parent/);
						assert.match(source, /only outputs the parent explicitly identified as expected/);
						assert.match(source, /unexpected mutation as a blocker/);
						assert.match(source, /do not clean it up or fix it/);
					}
				}
			} finally {
				rmSync(temporaryAgentHome, { recursive: true, force: true });
			}
		}
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
	}
});

test("bounded implementation routing uses the same explicit fallback in both policy sections", () => {
	const routing = readFileSync(
		join(PACKAGE_ROOT, "assets", "orchestrator-delegation.md"),
		"utf8",
	);
	const simpleDelegation = readMarkdownSection(routing, "2. Simple Delegation");
	const mandatoryDelegation = readMarkdownSection(routing, "Mandatory Delegation Triggers");

	assertWorkerFallbackRouting(simpleDelegation, "Simple Delegation");
	assertWorkerFallbackRouting(mandatoryDelegation, "Mandatory Delegation Triggers");
	assert.doesNotMatch(
		routing,
		/non-normative compatibility quotation|former wording is retained|no-runtime inline exception|superseded by the stop requirement/,
		"model-facing routing must not retain contradictory dead prose",
	);
	assert.doesNotMatch(
		routing,
		/`generic-writer`/,
		"routing must not revive the collision-prone generic package name",
	);
});

test("orchestrator routes generic roles without static RDD lens routing", () => {
	for (const file of ["orchestrator.md", "orchestrator-delegation.md"]) {
		const routing = readFileSync(join(PACKAGE_ROOT, "assets", file), "utf8");
		assert.match(routing, /generic non-SDD exploration[\s\S]*`gentle-ai-explore`/);
		assert.match(
			routing,
			/bounded (?:non-SDD )?(?:implementation|multi-file writes)[\s\S]*`gentle-ai-worker`/,
		);
		assert.match(routing, /generic non-SDD (?:technical )?verification[\s\S]*`gentle-ai-verify`/);
		assert.match(routing, /SDD roles stay inside SDD|Use `sdd-explore` and `sdd-verify` only inside SDD/);
		assert.match(routing, /(?:truly local )?read-only check(?:ing)? of (?:known )?1[-–]3 known files|1[-–]3-file read-only check/);
		assert.match(routing, /(?:verification that |verification commands →).*executes? or delegates?|executing\/delegating verification commands/);
		assert.match(routing, /missing(?: or |\/)unusable[\s\S]*native `Agent`[\s\S]*(?:the )?same read-only/);
		assert.match(routing, /report (?:the )?fallback/);
		assert.doesNotMatch(routing, /review lenses? (?:inside|only inside)|review lens routing/i);
	}

	const core = readFileSync(join(PACKAGE_ROOT, "assets", "orchestrator.md"), "utf8");
	assert.match(core, /injects the mirrored provider-bundle review execution contract/);
	assert.match(core, /this package invents no lifecycle instructions/);
});

test("pi-pretty wrapper uses cached ESM loading for compiled and pnpm symlink installs", () => {
	const wrapper = readFileSync(
		join(PACKAGE_ROOT, "extensions", "pi-pretty.ts"),
		"utf8",
	);

	assert.doesNotMatch(wrapper, /realpathSync|createRequire/);
	assert.match(wrapper, /piPrettyExtensionPromise/);
	assert.match(wrapper, /import\("@heyhuynhgiabuu\/pi-pretty"\)/);
	assert.match(wrapper, /PI_PRETTY_SUPPRESSED_TOOL_NAMES/);
	assert.match(wrapper, /quietToolsEnabled/);
});

test("Gentle Shell v3.2.0 package and runtime stop before publication", () => {
	const packageJson = readPackageJson();
	assert.equal(packageJson.version, "3.2.0", "the release manifest must remain explicitly pinned to v3.2.0");
	assert.equal(
		packageJson.scripts?.test,
		"node --experimental-strip-types --test tests/*.test.ts && pnpm run check:provider-contract && pnpm run test:harness",
	);
	assert.ok(packageJson.files?.includes("assets/"));
	assert.ok(packageJson.files?.includes("contracts/"));

	const verifier = readFileSync(join(PACKAGE_ROOT, "scripts", "verify-package-files.mjs"), "utf8");
	// gentle-pi#311 P5: the retired adversarial role agents must not be pinned
	// as required package files, while the append-only migration history stays.
	assert.doesNotMatch(verifier, /assets\/agents\/review-refuter\.md/);
	assert.doesNotMatch(verifier, /assets\/agents\/review-validator\.md/);
	assert.match(verifier, /assets\/migrations\/managed-assets-v0\.13\.json/);
	assert.match(verifier, /assets\/migrations\/managed-assets-v0\.14\.json/);

	const runtime = readFileSync(join(PACKAGE_ROOT, "extensions", "gentle-ai.ts"), "utf8");
	assert.doesNotMatch(runtime, /execFileSync\("git", \["(?:commit|push|tag)"/);
	assert.doesNotMatch(runtime, /execFileSync\("(?:npm|pnpm)", \["publish"/);
});

test("bounded review keeps the Judgment Day skill contract at canon metadata version 1.7", () => {
	const frontmatter = readAgentFrontmatter(
		join(PACKAGE_ROOT, "skills", "judgment-day", "SKILL.md"),
	);

	assert.match(frontmatter, /^  version: "1\.7"$/m);
	assert.doesNotMatch(frontmatter, /^  version: "1\.4"$/m);
});

test("technical reference documents dynamic Gentle AI RDD ownership and the installed permission boundary", () => {
	const reference = readFileSync(join(PACKAGE_ROOT, "docs", "readme-reference.md"), "utf8");
	for (const clause of [
		"Gentle AI dynamically supplies runtime-specific RDD instructions",
		"does not define an RDD lifecycle",
		"Dangerous-command safety remains independent and authoritative.",
		"package-managed isolated installation",
		"Project and user overrides may shadow a package asset",
	]) {
		assert.ok(reference.includes(clause), `technical reference missing dynamic RDD clause: ${clause}`);
	}
	assert.doesNotMatch(reference, /New ordinary review uses compact `gentle_review` `start -> finalize -> validate`\./);
});


test("package verification explicitly requires the managed remediation actor", () => {
	assert.match(readFileSync(join(PACKAGE_ROOT, "scripts/verify-package-files.mjs"), "utf8"), /assets\/agents\/sdd-remediate\.md/);
});

test("SDD installation retires owned sync but preserves modified copies and unrelated owners", () => {
	withIsolatedAssetHome((agentHome) => {
		installSddAssets(agentHome, false);
		const path = join(agentHome, "agents/sdd-sync.md");
		const manifestPath = join(agentHome, "gentle-ai/managed-assets.json");
		const legacy = "Previously managed sync executor\n";
		const manifest = installedAssetManifest(agentHome);
		manifest.assets["agents/sdd-sync.md"] = sha256(legacy);
		writeFileSync(path, legacy);
		writeFileSync(manifestPath, JSON.stringify(manifest));
		installPackageAssets(agentHome, true, ["delegation"]);
		assert.equal(readFileSync(path, "utf8"), legacy);
		installPackageAssets(agentHome, true, ["sdd"]);
		assert.equal(existsSync(path), false);
		assert.equal(installedAssetManifest(agentHome).assets["agents/sdd-sync.md"], undefined);
		writeFileSync(path, "User-modified sync instructions\n");
		writeFileSync(manifestPath, JSON.stringify(manifest));
		installPackageAssets(agentHome, true, ["sdd"]);
		assert.equal(readFileSync(path, "utf8"), "User-modified sync instructions\n");
		assert.equal(installedAssetManifest(agentHome).assets["agents/sdd-sync.md"], undefined);
	});
});
