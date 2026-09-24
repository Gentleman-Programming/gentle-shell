import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { FIXED_WINDOWS_POWERSHELL } from "../lib/windows-session-transport.ts";

const fixture = fileURLToPath(new URL("fixtures/windows-session-compile.ps1", import.meta.url));
const runtime = fileURLToPath(new URL("../runtime/windows-session-transport.ps1", import.meta.url));
const execFileAsync = promisify(execFile);
const maxOutputBytes = 4096;
const maxErrors = 8;
const maxLocation = 1_000_000;

type CompilerEntry = Readonly<{ code: string; line: number; column: number }>;
type CompilerOutcome = "not-compiled" | "compile-success" | "compile-errors";
type CompilerControl = Readonly<{
	kind: "windows-session-csharp-compile-control";
	success: boolean;
	sourceExtracted: boolean;
	stage: "completed" | "source-parse" | "source-contract" | "compile" | "control-failure";
	outcome: CompilerOutcome;
	errorlist: readonly CompilerEntry[];
	warnings?: readonly CompilerEntry[];
}>;

function isCompilerEntry(value: unknown): value is CompilerEntry {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const entry = value as Record<string, unknown>;
	return Object.keys(entry).sort().join(",") === "code,column,line"
		&& typeof entry.code === "string" && /^CS[0-9]{4}(?![\s\S])/.test(entry.code)
		&& typeof entry.line === "number" && Number.isInteger(entry.line) && entry.line >= 0 && entry.line <= maxLocation
		&& typeof entry.column === "number" && Number.isInteger(entry.column) && entry.column >= 0 && entry.column <= maxLocation;
}
function isCompilerEntries(value: unknown): value is CompilerEntry[] {
	return Array.isArray(value) && value.length > 0 && value.length <= maxErrors && value.every(isCompilerEntry);
}
function compilerStage(value: unknown): CompilerControl["stage"] | undefined {
	switch (value) {
		case "completed": case "source-parse": case "source-contract": case "compile": case "control-failure": return value;
		default: return undefined;
	}
}
function compilerOutcome(value: unknown): CompilerOutcome | undefined {
	switch (value) {
		case "not-compiled": case "compile-success": case "compile-errors": return value;
		default: return undefined;
	}
}

export function parseCompilerControl(stdout: string): CompilerControl | undefined {
	if (Buffer.byteLength(stdout, "utf8") > maxOutputBytes || !stdout.endsWith("\n")) return undefined;
	const lines = stdout.slice(0, -1).split("\n");
	if (lines.length !== 1 || lines[0].length === 0) return undefined;
	let value: unknown;
	try { value = JSON.parse(lines[0]); } catch { return undefined; }
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const allowed = new Set(["kind", "success", "sourceExtracted", "stage", "outcome", "errorlist", "warnings"]);
	if (Object.keys(record).some((key) => !allowed.has(key))
		|| record.kind !== "windows-session-csharp-compile-control"
		|| typeof record.success !== "boolean"
		|| typeof record.sourceExtracted !== "boolean"
		|| compilerStage(record.stage) === undefined
		|| compilerOutcome(record.outcome) === undefined
		|| !Array.isArray(record.errorlist) || record.errorlist.length > maxErrors || !record.errorlist.every(isCompilerEntry)) return undefined;
	const warnings = record.warnings;
	const stage = compilerStage(record.stage);
	const outcome = compilerOutcome(record.outcome);
	if (stage === undefined || outcome === undefined) return undefined;
	const compileSuccess = outcome === "compile-success" && record.sourceExtracted && record.success && stage === "completed" && record.errorlist.length === 0;
	const compileErrors = outcome === "compile-errors" && record.sourceExtracted && !record.success && stage === "compile" && record.errorlist.length > 0;
	const notCompiledStage = (stage === "source-parse" && !record.sourceExtracted)
		|| (stage === "source-contract" && !record.sourceExtracted)
		|| stage === "control-failure";
	const notCompiled = outcome === "not-compiled" && !record.success && record.errorlist.length === 0 && warnings === undefined && notCompiledStage;
	if (!compileSuccess && !compileErrors && !notCompiled) return undefined;
	const base: Omit<CompilerControl, "warnings"> = {
		kind: "windows-session-csharp-compile-control",
		success: record.success,
		sourceExtracted: record.sourceExtracted,
		stage,
		outcome,
		errorlist: Object.freeze([...record.errorlist]),
	};
	if (warnings === undefined) return Object.freeze(base);
	if (!isCompilerEntries(warnings)) return undefined;
	return Object.freeze({ ...base, warnings: Object.freeze([...warnings]) });
}

function control(value: Record<string, unknown>): string {
	return `${JSON.stringify({ kind: "windows-session-csharp-compile-control", success: false, sourceExtracted: true, stage: "compile", outcome: "compile-errors", errorlist: [{ code: "CS1002", line: 12, column: 3 }], ...value })}\n`;
}

test("Windows bootstrap CSharp compile control parser accepts only consistent bounded records", () => {
	const parsed = parseCompilerControl(control({}));
	assert.ok(parsed);
	assert.equal(parsed.outcome, "compile-errors");
	assert.equal(parsed.success, false);
	assert.equal(parsed.errorlist.length, 1);
	for (const malformed of [
		"null\n",
		"[]\n",
		"{}\n",
		control({ unexpected: true }),
		control({ outcome: "compile-success" }),
		control({ sourceExtracted: false }),
		control({ stage: "source-parse" }),
		control({ stage: "source-contract", outcome: "not-compiled", errorlist: [] }),
		control({ stage: "control-failure" }),
		control({ errorlist: [] }),
		control({ errorlist: Array.from({ length: maxErrors + 1 }, () => ({ code: "CS1002", line: 1, column: 1 })) }),
		control({ errorlist: [{ code: "cs1002", line: 1, column: 1 }] }),
		control({ errorlist: [{ code: "CS1002\n", line: 1, column: 1 }] }),
		control({ errorlist: [{ code: "CS1002\r\n", line: 1, column: 1 }] }),
		control({ errorlist: [{ code: "CS1002", line: 1.5, column: 1 }] }),
		control({ errorlist: [{ code: "CS1002", line: -1, column: 1 }] }),
		control({ errorlist: [{ code: "CS1002", line: maxLocation + 1, column: 1 }] }),
		control({ errorlist: [{ code: "CS1002", line: 1, column: -1 }] }),
		control({ errorlist: [{ code: "CS1002", line: 1, column: 1.5 }] }),
		control({ errorlist: [{ code: "CS1002", line: 1, column: maxLocation + 1 }] }),
		`${control({}).trimEnd()}\nextra\n`,
		control({}).trimEnd(),
		`${"x".repeat(maxOutputBytes)}\n`,
	]) assert.equal(parseCompilerControl(malformed), undefined);
	assert.equal(parseCompilerControl('{"kind":"windows-session-csharp-compile-control","success":false,"sourceExtracted":false,"stage":"source-contract","outcome":"not-compiled","errorlist":[]}\n')?.outcome, "not-compiled");
});

test("Windows bootstrap pinned enumeration has no unreachable post-loop return", async () => {
	const source = await readFile(runtime, "utf8");
	const start = source.indexOf("static string[] EnumeratePinned(IntPtr directory)");
	const end = source.indexOf("public static int EnumeratePresence()", start);
	assert.ok(start >= 0 && end > start, "source guard: pinned enumeration bounds were not found");
	const enumeration = source.slice(start, end);
	assert.equal((enumeration.match(/return names\.ToArray\(\);/g) ?? []).length, 1, "source guard: the infinite enumeration loop must not have a post-loop return");
});

test("Windows bootstrap CSharp compile control source guard uses an owned created temp root", async () => {
	const source = await readFile(fixture, "utf8");
	assert.match(source, /\[System\.Management\.Automation\.Language\.Parser\]::ParseFile\(/);
	assert.match(source, /\[Microsoft\.CSharp\.CSharpCodeProvider\]::new\(\)/);
	assert.match(source, /CompileAssemblyFromSource\(/);
	assert.match(source, /GenerateInMemory\s*=\s*\$true/);
	assert.match(source, /ReferencedAssemblies\.Add\("System\.dll"\)/);
	assert.match(source, /ReferencedAssemblies\.Add\("System\.Core\.dll"\)/);
	const createRoot = source.indexOf("CreateDirectory($tempRoot)");
	const createCollection = source.indexOf("TempFileCollection]::new($tempRoot, $false)");
	assert.ok(createRoot >= 0 && createRoot < createCollection, "source guard: fixture creates its owned temp root before CodeDom receives it");
	assert.match(source, /\$provider\.Dispose\(\)/);
	assert.match(source, /\$tempFiles\.Dispose\(\)/);
	assert.doesNotMatch(source, /Invoke-Expression|\bInvoke-Command\b|\.\s+\$\w+|\[WindowsSessionBootstrap\]::/);
});

test("Windows bootstrap CSharp compile control reports comparison outcome", { skip: process.platform !== "win32", timeout: 40_000 }, async (t) => {
	let result: { stdout: string; stderr: string };
	try {
		// execFile resolves only after its owned child has exited and its stdio is closed.
		result = await execFileAsync(FIXED_WINDOWS_POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", fixture, "-SourcePath", runtime], { shell: false, windowsHide: true, timeout: 30_000, maxBuffer: maxOutputBytes });
	} catch (error: unknown) {
		const captured = error as Readonly<{ stdout?: string; stderr?: string }>;
		result = { stdout: captured.stdout ?? "", stderr: captured.stderr ?? "" };
	}
	assert.equal(result.stderr, "", "compile control emitted non-JSON diagnostics");
	const parsed = parseCompilerControl(result.stdout);
	assert.ok(parsed, "compile control did not return a valid bounded result");
	t.diagnostic(JSON.stringify({ outcome: parsed.outcome, success: parsed.success, errorlist: parsed.errorlist, warnings: parsed.warnings }));
	assert.equal(parsed.sourceExtracted, true, "compile control did not extract the Add-Type literal");
	assert.ok(parsed.outcome === "compile-success" || parsed.outcome === "compile-errors", "compile control did not complete compilation");
});
