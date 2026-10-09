import { lstatSync, readFileSync, realpathSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { artifactFor, verifiedDownload, compatibleEngine, launchWizard } from "./installer-downloads.mjs";

export const windowsNodeFloor = ">=24.3.0";
const maxExpandedBytes = 128 * 1024 * 1024;

/** Validate the whole namespace, including implicit parents, before any writes.
 * Windows paths are case-insensitive here even on portable fixture hosts.
 */
export function validateWindowsEntries(entries) {
	if (!Array.isArray(entries) || entries.length === 0 || entries.length > 50000) throw new Error("Unsafe archive entry count");
	const explicit = new Set();
	const namespace = new Map();
	for (const entry of entries) {
		if (typeof entry.name !== "string" || entry.link || entry.name.includes("\\")) throw new Error("Unsafe archive entry");
		const name = entry.directory && entry.name.endsWith("/") ? entry.name.slice(0, -1) : entry.name;
		const parts = name.split("/");
		if (parts.some((part) => !part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f\x7f]/.test(part) || /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part))) {
			throw new Error("Unsafe archive path");
		}
		const key = name.toLowerCase();
		if (explicit.has(key)) throw new Error("Unsafe duplicate archive path");
		explicit.add(key);
		for (let index = 1; index <= parts.length; index += 1) {
			const path = parts.slice(0, index).join("/");
			const directory = index < parts.length || Boolean(entry.directory);
			const previous = namespace.get(path.toLowerCase());
			if (previous && (previous.path !== path || previous.directory !== directory)) throw new Error("Unsafe archive alias");
			namespace.set(path.toLowerCase(), { path, directory });
		}
	}
}

// Complete known npm cmd-shim template. EndLocal restores PATH/PATHEXT before
// the child starts; no Node flags or extra environment assignments are accepted.
const shimStart = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\`;
export function proveWindowsWrapper(text) {
	if (typeof text !== "string") throw new Error("Unknown pnpm wrapper");
	const normalized = text.replaceAll("\r\n", "\n");
	for (const entry of ["node_modules\\pnpm\\bin\\pnpm.cjs", "node_modules\\pnpm\\bin\\pnpm.mjs"]) {
		if (normalized === `${shimStart}${entry}" %*\n`) {
			return { entry, localNode: "node.exe", fallbackNode: "node", flags: [], environment: "inherited" };
		}
	}
	throw new Error("Unknown pnpm wrapper; refusing execution or replacement");
}

function regular(path) {
	try { const info = lstatSync(path); return info.isFile() && !info.isSymbolicLink(); }
	catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function exists(path) {
	try { lstatSync(path); return true; }
	catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
export function windowsProcessCheck(command, args, env) {
	// Owned direct children only, not a tree/global kill. Descendant-held stdio
	// is outside this guarantee. Never execute .cmd through a command interpreter.
	if (/\.(?:cmd|bat)$/i.test(command)) throw new Error("Unproven command interpreter target");
	const result = spawnSync(command, args, { env, shell: false, encoding: "utf8", timeout: 15000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true });
	if (result.error || result.status !== 0) throw new Error("Windows prerequisite process failed");
	return result.stdout.trim();
}

/** Bounded fixture model of the fixed native predicate, not an ACL evaluator.
 * ReadAndExecute + Synchronize are harmless for this mutation boundary. Only
 * distant existing directories may also allow sibling CreateDirectories (4).
 * Effective inherited ACEs are checked again on every actual path component.
 */
export function windowsAclRuleUnsafe({ rights, depth, allow = true, inheritOnly = false, trusted = false }) {
	if (!Number.isInteger(rights) || rights < 0 || rights > 0xffffffff || !Number.isInteger(depth) || depth < 0) throw new Error("Unknown Windows ACL fixture");
	if (!allow || inheritOnly || trusted) return false;
	const allowedRights = depth >= 2 ? 0x1200ad : 0x1200a9;
	return (rights & ~allowedRights) !== 0;
}

// Fixed stock PowerShell intrinsics, not a loaded/evaluated PS script. Paths
// travel only as environment data. Managed constraints/denials fail closed.
// ACLs are read through .NET, never Get-Acl: a PowerShell 7 parent's PSModulePath
// makes Windows PowerShell 5.1 fail to autoload Microsoft.PowerShell.Security.
// An intentional rejection prints one fixed `unsafe:<role>-<check>` code (the role
// of the component, never its path); any other exception still exits nonzero.
const aclCheck = String.raw`
$ErrorActionPreference = 'Stop';
try {
  if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'policy' };
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
  $trusted = @($me, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');
  $path = [IO.Path]::GetFullPath($env:GENTLE_WINDOWS_CHECK);
  $depth = 0;
  while ($path) {
    $role = 'ancestor'; if ($depth -eq 0) { $role = 'target' } elseif ($depth -eq 1) { $role = 'parent' };
    $item = Get-Item -LiteralPath $path -Force;
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ($role + '-reparse') };
    if ($item.PSIsContainer) { $acl = [IO.Directory]::GetAccessControl($path) } else { $acl = [IO.File]::GetAccessControl($path) };
    if ($trusted -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw ($role + '-owner') };
    $allowedRights = 0x1200a9; if ($depth -ge 2) { $allowedRights = 0x1200ad };
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq 'Allow' -and -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and ([long]$rule.FileSystemRights -band (-bnot [long]$allowedRights)) -and $trusted -notcontains $rule.IdentityReference.Value) { throw ($role + '-acl-mask') };
    };
    $parent = [IO.Directory]::GetParent($path);
    if ($null -eq $parent) { break }; $path = $parent.FullName; $depth++;
  };
  'safe'
} catch { if ($_.Exception.Message -cmatch '^(policy|(target|parent|ancestor)-(reparse|owner|acl-mask))$') { 'unsafe:' + $_.Exception.Message } else { throw } }
`;
const storageChecks = /^(?:policy|(?:target|parent|ancestor)-(?:reparse|owner|acl-mask))$/;
/** Only exact `safe` passes. A fixed rejection code is kept as `check`; any other
 * output is rejected without carrying its text.
 */
export function windowsStorageEvidence(output) {
	if (output === "safe") return;
	const check = typeof output === "string" && output.startsWith("unsafe:") ? output.slice(7) : "";
	throw Object.assign(new Error("Windows ACL evidence rejected"), storageChecks.test(check) ? { check } : {});
}
export function verifyWindowsStorage(path, env, processAdapter = windowsProcessCheck) {
	if (process.platform !== "win32") throw new Error("Native Windows storage verification unavailable");
	if (!win32.isAbsolute(path) || path.startsWith("\\\\")) throw new Error("Unsafe Windows storage path");
	// Windows process.env is case-insensitive, but a copied environment is not.
	const systemRoot = env.SystemRoot ?? Object.entries(env).find(([key]) => key.toLowerCase() === "systemroot")?.[1];
	windowsStorageEvidence(processAdapter(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", aclCheck], { ...env, GENTLE_WINDOWS_CHECK: path }));
}

/** Strict bounded tar reader: no system tar, archive links or archive execution.
 * Unsupported GNU/PAX extensions stop rather than extract using guessed semantics.
 */
export function readWindowsPnpmArchive(bytes) {
	const tar = gunzipSync(bytes, { maxOutputLength: maxExpandedBytes });
	const entries = [];
	let offset = 0;
	let ended = false;
	const text = (block, start, length) => {
		const value = block.subarray(start, start + length);
		const zero = value.indexOf(0);
		const data = zero === -1 ? value : value.subarray(0, zero);
		const result = data.toString("utf8");
		if (!Buffer.from(result).equals(data)) throw new Error("Unsafe tar text encoding");
		return result;
	};
	const octal = (value) => {
		if (!/^[0-7]+$/.test(value.trim())) throw new Error("Unsafe tar number");
		return Number.parseInt(value.trim(), 8);
	};
	while (offset + 512 <= tar.length) {
		const block = tar.subarray(offset, offset + 512);
		if (block.every((value) => value === 0)) {
			if (tar.length < offset + 1024 || !tar.subarray(offset).every((value) => value === 0)) throw new Error("Unsafe tar termination");
			ended = true;
			break;
		}
		const expected = octal(text(block, 148, 8));
		let checksum = 0;
		for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 32 : block[index];
		if (checksum !== expected || text(block, 257, 6) !== "ustar") throw new Error("Unsafe tar header");
		const size = octal(text(block, 124, 12));
		const prefix = text(block, 345, 155);
		const name = `${prefix ? `${prefix}/` : ""}${text(block, 0, 100)}`;
		const type = block[156];
		if (![0, 48, 53].includes(type) || text(block, 157, 100) || (type === 53 && size !== 0)) throw new Error("Unsafe tar entry type");
		const next = offset + 512 + Math.ceil(size / 512) * 512;
		if (next > tar.length) throw new Error("Unsafe truncated tar");
		entries.push({ name, directory: type === 53, bytes: tar.subarray(offset + 512, offset + 512 + size) });
		if (entries.length > 50000) throw new Error("Unsafe tar entry count");
		offset = next;
	}
	if (!ended) throw new Error("Unsafe tar termination");
	validateWindowsEntries(entries);
	if (entries.some((entry) => !entry.name.startsWith("package/") && entry.name !== "package")) throw new Error("Unsafe pnpm package root");
	return entries;
}

function findWindowsCommand(env, name = "pnpm") {
	// Alternate CMD cwd-search policy is not silently flattened into our model.
	if (Object.keys(env).some((key) => key.toLowerCase() === "nodefaultcurrentdirectoryinexepath")) throw new Error("Unknown Windows cwd-search semantics");
	const value = (name) => Object.entries(env).find(([key]) => key.toLowerCase() === name)?.[1];
	const path = value("path");
	const pathExt = value("pathext");
	if (typeof path !== "string" || typeof pathExt !== "string") throw new Error("Unknown Windows PATH/PATHEXT");
	const extensions = pathExt.toLowerCase().split(";");
	// .cpl is known because Windows PowerShell 5.1 appends it for its children, and
	// bootstrap.cmd starts this helper from there. Known is not accepted: a .cpl (or
	// any non-.cmd wrapper / non-.exe Node) found first still fails closed below.
	if (!extensions.length || new Set(extensions).size !== extensions.length || extensions.some((extension) => !/^\.(com|exe|bat|cmd|vbs|vbe|js|jse|wsf|wsh|msc|cpl)$/.test(extension))) throw new Error("Unknown Windows PATHEXT semantics");
	// CMD ignores empty entries (a trailing `;` is the Windows default); every
	// other non-absolute, quoted or UNC entry still fails closed.
	for (const directory of [process.cwd(), ...path.split(";").filter((entry) => entry !== "")]) {
		if (!win32.isAbsolute(directory) || directory.startsWith("\\\\") || directory.includes('"')) throw new Error("Unknown Windows PATH");
		// CMD searches cwd too. An extensionless/other target must block rather
		// than be silently skipped; honor the wrapper's inherited PATHEXT order.
		if (exists(join(directory, name))) throw new Error("Unknown extensionless Windows prerequisite");
		for (const extension of extensions) {
			const command = join(directory, `${name}${extension}`);
			if (exists(command)) return command;
		}
	}
	return null;
}
function proveCli(node, entry, metadata, env, processAdapter) {
	const version = processAdapter(node, ["--version"], env);
	if (metadata.name !== "pnpm" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(metadata.version) || !compatibleEngine(windowsNodeFloor, version) || !compatibleEngine(metadata.engines?.node, version)) {
		throw new Error("Windows pnpm engine or identity rejected");
	}
	if (processAdapter(node, [entry, "--version"], env) !== metadata.version) throw new Error("Windows pnpm version rejected");
	for (const capability of ["add", "bin"]) {
		if (!/(?:^|[\s,])--global(?:[\s,=]|$)/.test(processAdapter(node, [entry, "help", capability], env))) throw new Error("Windows pnpm global capability rejected");
	}
}

/** Returns a direct invocation, NOT a fabricated npm/pnpm executable shim.
 * T4 must call command + prefix with shell:false and retain this child env.
 * `onStep` receives fixed phase names for diagnostics only; it never alters checks.
 */
export async function ensureWindowsPnpm({ tools, env, node = process.execPath, adapters = {}, onStep = () => {} }) {
	const processAdapter = adapters.process ?? windowsProcessCheck;
	const storage = adapters.storage ?? verifyWindowsStorage;
	onStep("pnpm-discovery");
	const existing = (adapters.findCommand ?? findWindowsCommand)(env);
	if (existing) {
		onStep("wrapper-storage");
		storage(existing, env);
		onStep("wrapper");
		if (!/\.cmd$/i.test(existing) || !regular(existing)) throw new Error("Unknown pnpm wrapper; refusing replacement");
		const proof = proveWindowsWrapper(readFileSync(existing, "utf8"));
		const directory = dirname(existing);
		const entry = join(directory, ...proof.entry.split("\\"));
		const localNode = join(directory, proof.localNode);
		// npm cmd-shim selects its sibling node.exe before PATH node. Preserve it.
		onStep("node-discovery");
		const selectedNode = exists(localNode) ? localNode : (adapters.findNode ?? ((env) => findWindowsCommand(env, "node")))(env);
		if (!selectedNode || !/\.exe$/i.test(selectedNode)) throw new Error("Unknown wrapper-selected Node");
		const metadataPath = join(directory, "node_modules", "pnpm", "package.json");
		for (const [step, path] of [["node-storage", selectedNode], ["entry-storage", entry], ["metadata-storage", metadataPath]]) {
			onStep(step);
			storage(path, env);
			if (!regular(path)) throw new Error("Unsafe pnpm wrapper target");
		}
		onStep("package");
		const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
		if (metadata.bin?.pnpm !== `bin/${proof.entry.endsWith("pnpm.cjs") ? "pnpm.cjs" : "pnpm.mjs"}`) throw new Error("Windows pnpm package target rejected");
		onStep("cli-proof");
		proveCli(selectedNode, entry, metadata, env, processAdapter);
		return { acquired: false, env, command: selectedNode, prefix: [entry] };
	}
	onStep("tools-check");
	storage(tools, env);
	if (!lstatSync(tools).isDirectory() || realpathSync(tools) !== resolve(tools)) throw new Error("Unsafe Windows tools");
	const destination = join(tools, "pnpm");
	if (exists(destination)) throw new Error("Conflicting Windows pnpm destination");
	onStep("download");
	const bytes = await verifiedDownload("pnpm", adapters);
	onStep("archive");
	const entries = readWindowsPnpmArchive(bytes);
	const pin = artifactFor("pnpm");
	const packageEntry = entries.find((entry) => entry.name === "package/package.json" && !entry.directory);
	const metadata = packageEntry && JSON.parse(packageEntry.bytes.toString("utf8"));
	if (!metadata || metadata.name !== pin.name || metadata.version !== pin.version || metadata.engines?.node !== pin.engine || metadata.bin?.pnpm !== "bin/pnpm.mjs") throw new Error("Windows pnpm pin metadata rejected");
	if (!entries.some((entry) => entry.name === "package/bin/pnpm.mjs" && !entry.directory)) throw new Error("Windows pnpm entry missing");
	let owned = false;
	onStep("publish");
	try {
		mkdirSync(destination); // atomic no-clobber claim under the verified private root
		owned = true;
		storage(destination, env);
		for (const entry of entries) {
			const path = join(destination, ...entry.name.split("/"));
			if (entry.directory) mkdirSync(path, { recursive: true });
			else {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, entry.bytes, { flag: "wx" });
			}
		}
		const entry = join(destination, "package", "bin", "pnpm.mjs");
		proveCli(node, entry, metadata, env, processAdapter);
		return { acquired: true, env, command: node, prefix: [entry] };
	} catch {
		if (owned) rmSync(destination, { recursive: true, force: true });
		throw new Error("Windows pnpm acquisition failed; no installation completed");
	}
}

// Fixed, non-sensitive helper diagnostics. Every explicit check on this path has
// one code; the step names the phase. Anything else, including fs, JSON or spawn
// errors, reports `unexpected-<step>`. No path, SID or exception text is copied.
const helperSteps = new Set(["bundle", "tools-storage", "pnpm-discovery", "wrapper-storage", "wrapper", "node-discovery", "node-storage", "entry-storage",
	"metadata-storage", "package", "cli-proof", "tools-check", "download", "archive", "publish", "launch"]);
const helperRejections = new Map(Object.entries({
	"Windows bootstrap requires native Windows": "native-unavailable",
	"Native Windows storage verification unavailable": "native-unavailable",
	"Required wizard bundle file missing": "bundle-missing",
	"Windows repository prerequisite rejected": "prerequisite",
	"Unsafe Windows storage path": "unsafe-path",
	"Windows ACL evidence rejected": "acl-evidence",
	"Unknown Windows cwd-search semantics": "cwd-search",
	"Unknown Windows PATH/PATHEXT": "path-missing",
	"Unknown Windows PATHEXT semantics": "pathext",
	"Unknown Windows PATH": "path-entry",
	"Unknown extensionless Windows prerequisite": "extensionless",
	"Unknown pnpm wrapper; refusing replacement": "wrapper-unknown",
	"Unknown pnpm wrapper": "wrapper-unproven",
	"Unknown pnpm wrapper; refusing execution or replacement": "wrapper-unproven",
	"Unknown wrapper-selected Node": "wrapper-node",
	"Unsafe pnpm wrapper target": "wrapper-target",
	"Windows pnpm package target rejected": "package-target",
	"Windows pnpm engine or identity rejected": "pnpm-engine",
	"Windows pnpm version rejected": "pnpm-version",
	"Windows pnpm global capability rejected": "pnpm-capability",
	"Windows prerequisite process failed": "process-failed",
	"Unproven command interpreter target": "interpreter",
	"Unsafe Windows tools": "unsafe-tools",
	"Conflicting Windows pnpm destination": "pnpm-conflict",
	"Windows pnpm pin metadata rejected": "pnpm-pin",
	"Windows pnpm entry missing": "pnpm-entry",
	"Windows pnpm acquisition failed; no installation completed": "acquisition",
	"Future wizard entry is missing; no live wizard is available": "wizard-missing",
	"Wizard child could not start": "wizard-start",
	"Wizard child failed": "wizard-exit",
}));
const archiveRejection = /^Unsafe (?:tar|archive|duplicate archive|truncated tar|pnpm package root)\b/;
export function windowsBootstrapReason(error, step) {
	if (!helperSteps.has(step)) throw new Error("Unknown Windows bootstrap step");
	const message = error instanceof Error ? error.message : undefined;
	const check = error instanceof Error && storageChecks.test(error.check ?? "") ? error.check : undefined;
	const code = check ?? helperRejections.get(message) ?? (archiveRejection.test(message ?? "") ? "archive" : undefined);
	return code ? `${code} (${step})` : `unexpected-${step}`;
}

export async function bootstrapWindows({ bundle, tools, env }) {
	let step = "bundle";
	try {
		if (process.platform !== "win32") throw new Error("Windows bootstrap requires native Windows");
		for (const file of ["package.json", "bin/gentle-shell-install.mjs", "scripts/installer-downloads.mjs", "scripts/installer-windows.mjs", "scripts/installer-windows-artifacts.json"]) {
			if (!regular(join(bundle, file))) throw new Error("Required wizard bundle file missing");
		}
		const metadata = JSON.parse(readFileSync(join(bundle, "package.json"), "utf8"));
		if (!compatibleEngine(windowsNodeFloor, process.versions.node) || !compatibleEngine(metadata.engines?.node, process.versions.node) || metadata.packageManager !== `pnpm@${artifactFor("pnpm").version}`) throw new Error("Windows repository prerequisite rejected");
		step = "tools-storage";
		verifyWindowsStorage(tools, env);
		const result = await ensureWindowsPnpm({ tools, env, onStep: (next) => { step = next; } });
		// Fixed data handoff for the future T5 entry. No caller-controlled command text.
		step = "launch";
		await launchWizard({ bundle, env: { ...result.env, GENTLE_INSTALL_PNPM_NODE: result.command, GENTLE_INSTALL_PNPM_ENTRY: result.prefix[0] } });
	} catch (error) {
		throw Object.assign(new Error("Windows bootstrap rejected"), { reason: windowsBootstrapReason(error, step) });
	}
}
