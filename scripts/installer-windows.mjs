import { lstatSync, readdirSync, readFileSync, realpathSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, extname, join, parse, resolve, win32 } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { artifactFor, verifiedDownload, compatibleEngine, launchWizard, pinnedPnpmCompatible } from "./installer-downloads.mjs";

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

// Complete Windows command shims, exactly as their generators write them (CRLF
// read as LF; `\0` marks the one target, a path without quotes or `%`):
// - npm cmd-shim 4.1-8 and 9 (npm global bins, such as `npm install -g pnpm`;
//   github.com/npm/cmd-shim tap snapshots): a JS target run by the shim's
//   sibling node.exe, else `node` from PATH, or a native target run as it is.
//   EndLocal restores PATH/PATHEXT before the child starts.
// - pnpm's @zkochan/cmd-shim 9 (pnpm 10-12 global bins from `pnpm add -g`,
//   `pnpm setup` and `pnpm self-update`): the same two kinds, or a JS target run
//   by the absolute node.exe pnpm names. pnpm's optional NODE_PATH block only
//   extends module lookup and is not reproduced.
// - npm's own npm.cmd that Node.js ships (npm 6-9, and 10-11 with npm-prefix.js):
//   node as above, then the npm-cli.js under npm's global prefix when one is there.
// No Node flags, extra environment assignments or other commands are accepted.
const npmHead = "@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n";
const npmProgram = `${npmHead}\nIF EXIST "%dp0%\\node.exe" (\n  SET "_prog=%dp0%\\node.exe"\n) ELSE (\n  SET "_prog=node"\n`;
const pnpmJs = "@IF EXIST \"%~dp0\\node.exe\" (\n  \"%~dp0\\node.exe\"  \"\0\" %*\n) ELSE (\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\n  node  \"\0\" %*\n)\n";
const nodeNpm = (prefix) => `:: Created by npm, please don't edit manually.\n@ECHO OFF\n\nSETLOCAL\n\nSET "NODE_EXE=%~dp0\\node.exe"\nIF NOT EXIST "%NODE_EXE%" (\n  SET "NODE_EXE=node"\n)\n\n${prefix === "prefix-js" ? "SET \"NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js\"\n" : ""}` +
	`SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"\nFOR /F "delims=" %%F IN ('CALL "%NODE_EXE%" ${prefix === "prefix-js" ? "\"%NPM_PREFIX_JS%\"" : "\"%NPM_CLI_JS%\" prefix -g"}') DO (\n` +
	"  SET \"NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js\"\n)\nIF EXIST \"%NPM_PREFIX_NPM_CLI_JS%\" (\n  SET \"NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%\"\n)\n\n\"%NODE_EXE%\" \"%NPM_CLI_JS%\" %*\n";
const npmTemplates = [
	["entry", `${npmProgram}  SET PATHEXT=%PATHEXT:;.JS;=;%\n)\n\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\\0" %*\n`],
	["entry", `${npmProgram})\n\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\\0" %*\n`],
	["exe", `${npmHead}"%dp0%\\\0"   %*\n`],
];
const pnpmHeader = /^@SETLOCAL\n(?:@IF NOT DEFINED NODE_PATH \(\n {2}@SET "NODE_PATH=([^"\n]*)"\n\) ELSE \(\n {2}@SET "NODE_PATH=\1;%NODE_PATH%"\n\)\n)?/;
/** The value at every `\0` of template, when text is exactly that template. */
function filled(text, template) {
	const [head, next] = template.split("\0");
	if (!text.startsWith(head)) return null;
	const value = text.slice(head.length, text.indexOf(next, head.length));
	return /^[^"%\x00-\x1f]+$/.test(value) && template.replaceAll("\0", value) === text ? value : null;
}
/** A shim target: relative to the shim's directory, or absolute on a local drive. */
function shimPath(value, relative) {
	if (value === null) return null;
	if (!relative) return /^[A-Za-z]:\\/.test(value) ? value : null;
	return value.startsWith("\\") || /^[A-Za-z]:/.test(value) ? null : value;
}
/** What a complete known Windows command shim runs, read from its text and never
 * executed: { exe } a native target; { entry, node } a JS entry run by node (an
 * absolute node.exe, or null: the shim's sibling node.exe, else `node` from
 * PATH); or { npm } for Node.js's own npm.cmd ("prefix-js" or "prefix-g": how it
 * asks for npm's global prefix). Targets are relative to the shim's directory
 * (backslashes) or absolute. Anything else is null.
 */
export function windowsShim(text) {
	if (typeof text !== "string" || /\r(?!\n)/.test(text)) return null;
	const normalized = text.replaceAll("\r\n", "\n");
	for (const prefix of ["prefix-js", "prefix-g"]) if (normalized === nodeNpm(prefix)) return { npm: prefix };
	for (const [kind, template] of npmTemplates) {
		const target = shimPath(filled(normalized, template), true);
		if (target) return kind === "exe" ? { exe: target } : { entry: target, node: null };
	}
	const header = pnpmHeader.exec(normalized);
	if (!header) return null;
	const rest = normalized.slice(header[0].length);
	const target = (quoted) => (quoted?.startsWith("%~dp0\\") ? shimPath(quoted.slice(6), true) : shimPath(quoted, false));
	const javascript = /^@IF EXIST "%~dp0\\node\.exe" \(\n {2}"%~dp0\\node\.exe" {2}"(%~dp0\\[^"%\x00-\x1f]+|[^"%\x00-\x1f]+)" %\*\n/.exec(rest);
	if (javascript && rest === pnpmJs.replaceAll("\0", javascript[1]) && target(javascript[1])) return { entry: target(javascript[1]), node: null };
	const pinned = /^@"([A-Za-z]:\\[^"%\x00-\x1f]*\\node\.exe)" {2}"(%~dp0\\[^"%\x00-\x1f]+|[^"%\x00-\x1f]+)" %\*\n$/i.exec(rest);
	if (pinned && target(pinned[2])) return { entry: target(pinned[2]), node: pinned[1] };
	const native = /^@"(%~dp0\\[^"%\x00-\x1f]+|[^"%\x00-\x1f]+)" {3}%\*\n$/.exec(rest);
	return native && target(native[1]) ? { exe: target(native[1]) } : null;
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
	// A neutral cwd: inside a project (the bundle itself), pnpm 11 reports, and may
	// fetch, the version that project's packageManager pins instead of its own.
	const result = spawnSync(command, args, { cwd: parse(command).root || undefined, env, shell: false, encoding: "utf8", timeout: 15000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true });
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
// A walk rejection appends `|` and the base64 of the UTF-8 text
// `<component>|<SID>|<account>|<rights>` (fields after the path may be empty):
// the folder, the principal and the rights that failed, for user-facing guidance.
const aclCheck = String.raw`
$ErrorActionPreference = 'Stop';
$detail = '';
try {
  if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'policy' };
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
  $trusted = @($me, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');
  $account = { param($sid) try { $sid.Translate([Security.Principal.NTAccount]).Value } catch { '' } };
  $path = [IO.Path]::GetFullPath($env:GENTLE_WINDOWS_CHECK);
  $depth = 0;
  while ($path) {
    $role = 'ancestor'; if ($depth -eq 0) { $role = 'target' } elseif ($depth -eq 1) { $role = 'parent' };
    $item = Get-Item -LiteralPath $path -Force;
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $detail = $path + '|||'; throw ($role + '-reparse') };
    if ($item.PSIsContainer) { $acl = [IO.Directory]::GetAccessControl($path) } else { $acl = [IO.File]::GetAccessControl($path) };
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]);
    if ($trusted -notcontains $owner.Value) { $detail = $path + '|' + $owner.Value + '|' + (& $account $owner) + '|'; throw ($role + '-owner') };
    $allowedRights = 0x1200a9; if ($depth -ge 2) { $allowedRights = 0x1200ad };
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq 'Allow' -and -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and ([long]$rule.FileSystemRights -band (-bnot [long]$allowedRights)) -and $trusted -notcontains $rule.IdentityReference.Value) {
        $detail = $path + '|' + $rule.IdentityReference.Value + '|' + (& $account $rule.IdentityReference) + '|0x' + ([int]$rule.FileSystemRights).ToString('X8'); throw ($role + '-acl-mask') };
    };
    $parent = [IO.Directory]::GetParent($path);
    if ($null -eq $parent) { break }; $path = $parent.FullName; $depth++;
  };
  'safe'
} catch { if ($_.Exception.Message -cmatch '^(policy|(target|parent|ancestor)-(reparse|owner|acl-mask))$') { 'unsafe:' + $_.Exception.Message + $(if ($detail) { '|' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($detail)) } else { '' }) } else { throw } }
`;
// S6 notice: the same walk over many paths in one launch, for the plan's notice
// about reused tools in folders another account can change. The paths travel as
// one environment value joined by `|`, which no Windows path holds. One line per
// path, in order: `safe`, a walk rejection exactly as above, or `unknown` for any
// other error on that path (such as an owner that denies READ_CONTROL). A policy
// denial prints only `unsafe:policy`.
const aclCheckMany = String.raw`
$ErrorActionPreference = 'Stop';
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { 'unsafe:policy'; exit 0 };
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$trusted = @($me, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');
$account = { param($sid) try { $sid.Translate([Security.Principal.NTAccount]).Value } catch { '' } };
foreach ($start in $env:GENTLE_WINDOWS_CHECKS.Split('|')) {
  $detail = '';
  try {
    $path = [IO.Path]::GetFullPath($start);
    $depth = 0;
    while ($path) {
      $role = 'ancestor'; if ($depth -eq 0) { $role = 'target' } elseif ($depth -eq 1) { $role = 'parent' };
      $item = Get-Item -LiteralPath $path -Force;
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $detail = $path + '|||'; throw ($role + '-reparse') };
      if ($item.PSIsContainer) { $acl = [IO.Directory]::GetAccessControl($path) } else { $acl = [IO.File]::GetAccessControl($path) };
      $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]);
      if ($trusted -notcontains $owner.Value) { $detail = $path + '|' + $owner.Value + '|' + (& $account $owner) + '|'; throw ($role + '-owner') };
      $allowedRights = 0x1200a9; if ($depth -ge 2) { $allowedRights = 0x1200ad };
      foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and ([long]$rule.FileSystemRights -band (-bnot [long]$allowedRights)) -and $trusted -notcontains $rule.IdentityReference.Value) {
          $detail = $path + '|' + $rule.IdentityReference.Value + '|' + (& $account $rule.IdentityReference) + '|0x' + ([int]$rule.FileSystemRights).ToString('X8'); throw ($role + '-acl-mask') };
      };
      $parent = [IO.Directory]::GetParent($path);
      if ($null -eq $parent) { break }; $path = $parent.FullName; $depth++;
    };
    'safe'
  } catch { if ($_.Exception.Message -cmatch '^(target|parent|ancestor)-(reparse|owner|acl-mask)$') { 'unsafe:' + $_.Exception.Message + $(if ($detail) { '|' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($detail)) } else { '' }) } else { 'unknown' } }
};
`;
const storageChecks = /^(?:policy|(?:target|parent|ancestor)-(?:reparse|owner|acl-mask))$/;
const untrustedStorage = /^(?:target|parent|ancestor)-(?:reparse|owner|acl-mask)$/;
const storageOutput = /^unsafe:([a-z-]+)(?:\|([A-Za-z0-9+/]+={0,2}))?$/;
/** The decoded walk detail, or null when it is not exactly that shape. */
function storageDetail(encoded) {
	const text = Buffer.from(encoded, "base64").toString("utf8");
	if (Buffer.from(text, "utf8").toString("base64") !== encoded || /[\x00-\x1f\x7f]/.test(text)) return null;
	const [path, sid, account, rights, ...rest] = text.split("|");
	if (rest.length > 0 || rights === undefined || !win32.isAbsolute(path) || (sid !== "" && !/^S-1-\d+(?:-\d+)*$/.test(sid)) ||
		(rights !== "" && !/^0x[0-9A-F]{8}$/.test(rights))) return null;
	return { at: path, ...(sid ? { sid } : {}), ...(account ? { account } : {}), ...(rights ? { rights } : {}) };
}
/** Only exact `safe` passes. A fixed rejection code is kept as `check`, and a
 * well-formed walk detail as `detail` ({ at, sid?, account?, rights? }); any other
 * output is rejected without carrying its text.
 */
export function windowsStorageEvidence(output) {
	if (output === "safe") return;
	const match = typeof output === "string" ? storageOutput.exec(output) : null;
	const detail = match?.[2] === undefined ? undefined : storageDetail(match[2]);
	const known = match !== null && storageChecks.test(match[1]) && detail !== null && (detail === undefined || untrustedStorage.test(match[1]));
	throw Object.assign(new Error("Windows ACL evidence rejected"), known ? { check: match[1], ...(detail ? { detail } : {}) } : {});
}
function windowsPowerShell(env, script, data, processAdapter) {
	// Windows process.env is case-insensitive, but a copied environment is not.
	const systemRoot = env.SystemRoot ?? Object.entries(env).find(([key]) => key.toLowerCase() === "systemroot")?.[1];
	return processAdapter(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { ...env, ...data });
}
export function verifyWindowsStorage(path, env, processAdapter = windowsProcessCheck) {
	if (process.platform !== "win32") throw new Error("Native Windows storage verification unavailable");
	if (!win32.isAbsolute(path) || path.startsWith("\\\\")) throw new Error("Unsafe Windows storage path");
	windowsStorageEvidence(windowsPowerShell(env, aclCheck, { GENTLE_WINDOWS_CHECK: path }, processAdapter));
}

/** Walks every path (local drive paths, never holding `|`) in one Windows
 * PowerShell launch (aclCheckMany). Returns one entry per path, in order: null
 * when it passes, { check: "unchecked", at } when its walk failed for another
 * reason (it could not be checked), else what failed,
 * { check, at?, sid?, account?, rights? }. A policy denial, a result count that
 * does not match, or any other line rejects the whole result; nothing to walk
 * launches nothing.
 */
export function verifyWindowsStorageMany(paths, env, { processAdapter = windowsProcessCheck, platform = process.platform } = {}) {
	if (platform !== "win32") throw new Error("Native Windows storage verification unavailable");
	if (paths.some((path) => typeof path !== "string" || !/^[A-Za-z]:\\/.test(path) || /[|\x00-\x1f]/.test(path))) throw new Error("Unsafe Windows storage path");
	if (paths.length === 0) return [];
	const rejected = () => new Error("Windows ACL evidence rejected");
	const lines = windowsPowerShell(env, aclCheckMany, { GENTLE_WINDOWS_CHECKS: paths.join("|") }, processAdapter).split(/\r?\n/);
	if (lines.length !== paths.length) throw rejected();
	return lines.map((line, index) => {
		if (line === "safe") return null;
		if (line === "unknown") return { check: "unchecked", at: paths[index] };
		const match = storageOutput.exec(line);
		const detail = match?.[2] === undefined ? undefined : storageDetail(match[2]);
		if (!match || !untrustedStorage.test(match[1]) || detail === null) throw rejected();
		return { check: match[1], ...(detail ?? {}) };
	});
}

// S6: the wizard's PNPM_HOME on Windows. pnpm runs and persists binaries there,
// so it gets the same walk as the bootstrap's tools directory before consent.
export const privatePnpmHome = Object.freeze({ directory: ".pnpm", marker: ".gentle-shell-pnpm-home", text: "gentle-pi private pnpm home", temp: "tmp" });
const hostHomeFs = Object.freeze({
	/** "missing", "directory" or "file" (neither a link), or "other". */
	kind(path) {
		let info;
		try { info = lstatSync(path); }
		catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return "missing"; throw error; }
		if (info.isSymbolicLink()) return "other";
		return info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
	},
	entries: (path) => readdirSync(path),
	readText: (path) => readFileSync(path, "utf8"),
});
function windowsEnv(env, name) {
	const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
	return key === undefined ? undefined : env[key];
}

/** Which PNPM_HOME the wizard may use, decided before any probe runs:
 * - a PNPM_HOME the user set, or pnpm's default `%LOCALAPPDATA%\pnpm`, that passes
 *   the walk: { available: true, path, source: "user" | "default" };
 * - a default that fails it while holding nothing (absent or an empty directory):
 *   the private `%USERPROFILE%\.pnpm`, which must pass the walk too and be absent,
 *   empty or marked as created by this flow:
 *   { available: true, path, source: "private", rejected: { path, check, at, sid?, account?, rights? } };
 * - otherwise a blocker: { available: true, path, source, untrusted, installed?, private? }.
 * The walk covers the folder (or its nearest existing ancestor when it is absent)
 * and its `bin` when present. Null when PNPM_HOME is unknowable, as for
 * pnpmGlobalBin. Policy denials and unexpected errors throw.
 */
export function windowsPnpmHome({ env, storage = verifyWindowsStorage, fs = hostHomeFs }) {
	const absolute = (value) => typeof value === "string" && win32.isAbsolute(value) && !value.startsWith("\\\\");
	const normal = (value) => win32.normalize(value).replace(/(.)[\\/]+$/, "$1");
	const walk = (home) => {
		let target = home;
		while (fs.kind(target) === "missing") {
			const parent = win32.dirname(target);
			if (parent === target) throw new Error("Unknown Windows PNPM_HOME");
			target = parent;
		}
		const bin = win32.join(home, "bin");
		for (const path of target === home && fs.kind(bin) === "directory" ? [home, bin] : [target]) {
			try {
				storage(path, env);
			} catch (error) {
				if (!untrustedStorage.test(error?.check ?? "")) throw error;
				return { check: error.check, at: path, ...(error.detail ?? {}) };
			}
		}
		return null;
	};
	// "absent", "empty", "marked" (this flow created it) or "used" (anything else).
	const contents = (home) => {
		const kind = fs.kind(home);
		if (kind === "missing") return "absent";
		if (kind !== "directory") return "used";
		if (fs.entries(home).length === 0) return "empty";
		const marker = win32.join(home, privatePnpmHome.marker);
		return fs.kind(marker) === "file" && fs.readText(marker) === privatePnpmHome.text ? "marked" : "used";
	};
	const set = windowsEnv(env, "PNPM_HOME");
	if (set !== undefined) {
		if (!absolute(set)) return null;
		const path = normal(set);
		const untrusted = walk(path);
		return { available: true, path, source: "user", ...(untrusted ? { untrusted } : {}) };
	}
	const local = windowsEnv(env, "LOCALAPPDATA");
	if (!absolute(local)) return null;
	const path = normal(win32.join(local, "pnpm"));
	const untrusted = walk(path);
	if (!untrusted) return { available: true, path, source: "default" };
	const blocked = { available: true, path, source: "default", untrusted };
	// Never moved, deleted or adopted: anything already there is an installation.
	if (!["absent", "empty"].includes(contents(path))) return { ...blocked, installed: true };
	const profile = windowsEnv(env, "USERPROFILE");
	if (!absolute(profile)) return blocked;
	const own = normal(win32.join(profile, privatePnpmHome.directory));
	if (contents(own) === "used") return { ...blocked, private: { path: own, foreign: true } };
	const ownUntrusted = walk(own);
	if (ownUntrusted) return { ...blocked, private: { path: own, untrusted: ownUntrusted } };
	return { available: true, path: own, source: "private", rejected: { path, ...untrusted } };
}

/** The wizard's environment and PNPM_HOME decision (windowsPnpmHome): a private
 * PNPM_HOME is set for this process's children only (childEnvironment adds pnpm's
 * own folders there). A walk that cannot finish is { available: null, failed: true }:
 * preflight then blocks.
 */
export function windowsWizardEnvironment({ env, ...adapters }) {
	let pnpmHome;
	try {
		pnpmHome = windowsPnpmHome({ env, ...adapters });
	} catch {
		return { env, pnpmHome: { available: null, failed: true } };
	}
	if (pnpmHome?.source !== "private") return { env, pnpmHome };
	return { env: { ...env, PNPM_HOME: pnpmHome.path }, pnpmHome };
}

// The private PNPM_HOME, after consent: created, or an empty one adopted, with the
// bootstrap claim's protected DACL (owner and FullControl for the invoking SID,
// SYSTEM and Administrators only), read back, then marked. A marked one is kept
// as it is. Anything else is `foreign` and never changed. Either way its `tmp`
// folder (the children's TEMP/TMP) is created inside it, inheriting that DACL.
const pnpmHomeClaim = String.raw`
$ErrorActionPreference = 'Stop';
$target = $null; $created = $false;
try {
  if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'policy' };
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User;
  $target = [IO.Path]::GetFullPath($env:GENTLE_WINDOWS_PNPM_HOME); if ($target.StartsWith('\')) { throw 'foreign' };
  $marker = Join-Path $target '.gentle-shell-pnpm-home'; $result = 'claimed';
  if (Test-Path -LiteralPath $target) {
    $item = Get-Item -LiteralPath $target -Force; if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'foreign' };
    if (@(Get-ChildItem -LiteralPath $target -Force).Count -ne 0) {
      if (-not (Test-Path -LiteralPath $marker)) { throw 'foreign' };
      $file = Get-Item -LiteralPath $marker -Force;
      if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Get-Content -LiteralPath $marker -Raw) -ne 'gentle-pi private pnpm home') { throw 'foreign' };
      $result = 'kept';
    };
  } else { $null = New-Item -ItemType Directory -Path $target; $created = $true };
  if ($result -eq 'claimed') {
    $acl = New-Object Security.AccessControl.DirectorySecurity; $acl.SetOwner($me); $acl.SetAccessRuleProtection($true,$false);
    foreach ($sid in @($me.Value,'S-1-5-18','S-1-5-32-544')) {
      $identity = New-Object Security.Principal.SecurityIdentifier($sid);
      $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule);
    }; [IO.Directory]::SetAccessControl($target,$acl);
    $verified = [IO.Directory]::GetAccessControl($target); if (-not $verified.AreAccessRulesProtected) { throw 'protected-dacl' };
    if ($verified.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $me.Value) { throw 'private-owner' };
    foreach ($rule in $verified.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { if ($rule.AccessControlType -ne 'Allow' -or @($me.Value,'S-1-5-18','S-1-5-32-544') -notcontains $rule.IdentityReference.Value) { throw 'private-ace' } };
    $null = New-Item -ItemType File -Path $marker -Value 'gentle-pi private pnpm home';
  };
  $temp = Join-Path $target 'tmp';
  if (Test-Path -LiteralPath $temp) { $folder = Get-Item -LiteralPath $temp -Force; if (-not $folder.PSIsContainer -or ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'foreign' } } else { $null = New-Item -ItemType Directory -Path $temp };
  $result
} catch {
  if ($created) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue };
  if ($_.Exception.Message -cmatch '^(policy|foreign|protected-dacl|private-owner|private-ace)$') { 'unsafe:' + $_.Exception.Message } else { throw }
}
`;
/** Claims the private PNPM_HOME (pnpmHomeClaim), then walks it and its `tmp`
 * folder like any storage. Returns "claimed" or "kept"; anything else throws.
 */
export function ensureWindowsPnpmHome(home, env, { processAdapter = windowsProcessCheck, storage = verifyWindowsStorage, platform = process.platform } = {}) {
	if (platform !== "win32") throw new Error("Native Windows storage verification unavailable");
	if (!win32.isAbsolute(home) || home.startsWith("\\\\")) throw new Error("Unsafe Windows storage path");
	const output = windowsPowerShell(env, pnpmHomeClaim, { GENTLE_WINDOWS_PNPM_HOME: home }, processAdapter);
	if (output !== "claimed" && output !== "kept") {
		const check = /^unsafe:(policy|foreign|protected-dacl|private-owner|private-ace)$/.exec(output)?.[1];
		throw Object.assign(new Error("Windows PNPM_HOME claim rejected"), check ? { check } : {});
	}
	storage(home, env);
	storage(win32.join(home, privatePnpmHome.temp), env);
	return output;
}

// The same claim for another private folder (the bundled install's prefix): only
// the folder, its marker file and the marker text differ, and they travel as
// environment data like every other path.
const privateFolderClaim = [["$env:GENTLE_WINDOWS_PNPM_HOME", "$env:GENTLE_WINDOWS_PRIVATE_FOLDER"],
	["'.gentle-shell-pnpm-home'", "$env:GENTLE_WINDOWS_PRIVATE_MARKER"], ["'gentle-pi private pnpm home'", "$env:GENTLE_WINDOWS_PRIVATE_TEXT"]]
	.reduce((script, [from, to]) => {
		if (!script.includes(from)) throw new Error("Windows private folder claim template changed");
		return script.replaceAll(from, to);
	}, pnpmHomeClaim);
/** ensureWindowsPnpmHome for another private folder, marked with `marker`
 * (a `.name` file) holding `text`. Returns "claimed" or "kept"; anything else,
 * including a non-empty unmarked folder, throws.
 */
export function ensureWindowsPrivateFolder(folder, env, { marker, text, processAdapter = windowsProcessCheck, storage = verifyWindowsStorage, platform = process.platform }) {
	if (platform !== "win32") throw new Error("Native Windows storage verification unavailable");
	if (!win32.isAbsolute(folder) || folder.startsWith("\\\\")) throw new Error("Unsafe Windows storage path");
	if (!/^\.[a-z][a-z-]*$/.test(marker) || !/^[a-z][a-z -]*$/.test(text)) throw new Error("Unsafe Windows private folder marker");
	const output = windowsPowerShell(env, privateFolderClaim, { GENTLE_WINDOWS_PRIVATE_FOLDER: folder, GENTLE_WINDOWS_PRIVATE_MARKER: marker, GENTLE_WINDOWS_PRIVATE_TEXT: text }, processAdapter);
	if (output !== "claimed" && output !== "kept") {
		const check = /^unsafe:(policy|foreign|protected-dacl|private-owner|private-ace)$/.exec(output)?.[1];
		throw Object.assign(new Error("Windows private folder claim rejected"), check ? { check } : {});
	}
	storage(folder, env);
	storage(win32.join(folder, privatePnpmHome.temp), env);
	return output;
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

/** The inherited PATHEXT, validated and lowercased, in order. */
function pathExtensions(env) {
	const pathExt = Object.entries(env).find(([key]) => key.toLowerCase() === "pathext")?.[1];
	if (typeof pathExt !== "string") throw new Error("Unknown Windows PATH/PATHEXT");
	// Validate before lowercasing: case folding can map non-ASCII (U+212A KELVIN SIGN)
	// onto ASCII and make a different name look like a known extension.
	const entries = pathExt.split(";");
	if (entries.some((extension) => !/^\.[A-Za-z0-9]+$/.test(extension))) throw new Error("Unknown Windows PATHEXT semantics");
	const extensions = entries.map((extension) => extension.toLowerCase());
	// Any well-formed extension is resolved in its PATHEXT place, like CMD does:
	// Windows PowerShell 5.1 appends .CPL, Python adds .PY and .PYW (#1978), other
	// runtimes add their own. Resolved is not accepted: a .cpl, .py (or any
	// non-.cmd wrapper / non-.exe Node) found first still fails closed below.
	if (!extensions.length || new Set(extensions).size !== extensions.length || extensions.some((extension) => !/^\.[a-z0-9]+$/.test(extension))) throw new Error("Unknown Windows PATHEXT semantics");
	return extensions;
}
function findWindowsCommand(env, name = "pnpm") {
	// Alternate CMD cwd-search policy is not silently flattened into our model.
	if (Object.keys(env).some((key) => key.toLowerCase() === "nodefaultcurrentdirectoryinexepath")) throw new Error("Unknown Windows cwd-search semantics");
	const path = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1];
	if (typeof path !== "string") throw new Error("Unknown Windows PATH/PATHEXT");
	const extensions = pathExtensions(env);
	// CMD ignores empty entries (a trailing `;` is the Windows default); every
	// other non-absolute, quoted or UNC entry still fails closed.
	for (const directory of [process.cwd(), ...path.split(";").filter((entry) => entry !== "")]) {
		if (!win32.isAbsolute(directory) || directory.startsWith("\\\\") || directory.includes('"')) throw new Error("Unknown Windows PATH");
		// CMD searches cwd too; honor the wrapper's inherited PATHEXT order.
		for (const extension of extensions) {
			const command = join(directory, `${name}${extension}`);
			if (exists(command)) return command;
		}
		// npm, pnpm, Volta and mise write an extensionless Git Bash script beside
		// each .cmd shim, and CMD runs the PATHEXT match in that directory. An
		// extensionless/other target alone must block rather than be silently skipped.
		if (exists(join(directory, name))) throw new Error("Unknown extensionless Windows prerequisite");
	}
	return null;
}
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// Not pnpm: Corepack's pnpm.js behind npm's or pnpm's cmd-shim, and mise's file-mode
// shim (`mise x -- pnpm %*`, or the older `mise x -- %*`; github.com/jdx/mise src/shims.rs).
const corepackEntry = /(?:^|\\)node_modules\\corepack\\dist\\pnpm\.js$/i;
const miseFileShim = /^@echo off(\r?\n)setlocal\1mise x -- (?:pnpm )?%\*\1$/;
function proveGlobal(command, prefix, env, processAdapter) {
	for (const capability of ["add", "bin"]) {
		if (!/(?:^|[\s,])--global(?:[\s,=]|$)/.test(processAdapter(command, [...prefix, "help", capability], env))) throw new Error("Windows pnpm global capability rejected");
	}
}
function proveCli(node, entry, metadata, env, processAdapter) {
	const version = processAdapter(node, ["--version"], env);
	if (metadata.name !== "pnpm" || !STABLE.test(metadata.version) || !compatibleEngine(windowsNodeFloor, version) || !compatibleEngine(metadata.engines?.node, version)) {
		throw new Error("Windows pnpm engine or identity rejected");
	}
	if (processAdapter(node, [entry, "--version"], env) !== metadata.version) throw new Error("Windows pnpm version rejected");
	proveGlobal(node, [entry], env, processAdapter);
}

/** Returns a direct invocation, NOT a fabricated npm/pnpm executable shim.
 * T4 must call command + prefix with shell:false and retain this child env.
 * `onStep` receives fixed phase names for diagnostics only; it never alters checks.
 * The pnpm found is a known shim (windowsShim) of pnpm's own JS entry, run by
 * the Node that shim selects, or a native pnpm.exe (pnpm's installer and
 * `pnpm setup`, @pnpm/exe, pnpm 12, a Volta or mise shim), directly or as a
 * shim's target (an extensionless target resolves through PATHEXT, and only an
 * .exe first match counts); the package.json beside that exe must name pnpm and
 * its version must be what the exe reports.
 * One whose stable version is of another major or older than the pin is left as
 * it is: the verified pnpm is acquired instead. So is one whose wrapper, Node,
 * entry, metadata or exe fails the reparse/owner/ACL walk (a %LOCALAPPDATA%
 * another principal may write): it never runs, like an untrusted user Node in
 * bootstrap.cmd. A pnpm.exe without pnpm's package.json beside it (a standalone
 * or Volta/mise shim exe), Corepack's pnpm.cmd and mise's file shim are not
 * proven pnpm and count as no pnpm at all: never run, the verified pnpm is
 * acquired. Policy denials and unknown evidence still refuse.
 */
export async function ensureWindowsPnpm({ tools, env, node = process.execPath, adapters = {}, onStep = () => {} }) {
	const processAdapter = adapters.process ?? windowsProcessCheck;
	const storage = adapters.storage ?? verifyWindowsStorage;
	onStep("pnpm-discovery");
	const existing = (adapters.findCommand ?? findWindowsCommand)(env);
	// Thrown only to fall through to acquisition; never escapes.
	const notPnpm = new Error("Not a proven pnpm");
	// Only storage checks carry a role code (and notPnpm); everything else keeps stopping.
	if (existing) try {
		onStep("wrapper-storage");
		storage(existing, env);
		onStep("wrapper");
		const extension = extname(existing).toLowerCase();
		if (![".cmd", ".exe"].includes(extension) || !regular(existing)) throw new Error("Unknown pnpm wrapper; refusing replacement");
		const text = extension === ".cmd" ? readFileSync(existing, "utf8") : null;
		if (text !== null && miseFileShim.test(text)) throw notPnpm;
		const shim = extension === ".exe" ? { exe: parse(existing).base } : windowsShim(text);
		if (shim?.entry !== undefined && corepackEntry.test(shim.entry)) throw notPnpm;
		const directory = dirname(existing);
		const target = (path) => (win32.isAbsolute(path) ? path : join(directory, ...path.split("\\")));
		const entry = shim?.entry === undefined ? null : target(shim.entry);
		const file = entry && parse(entry).base;
		const packageDirectory = entry && dirname(dirname(entry));
		// Only pnpm's own bin entry, <...>\node_modules\pnpm\bin\pnpm.(cjs|mjs).
		const pnpmEntry = entry !== null && /^pnpm\.[cm]js$/.test(file) && parse(dirname(entry)).base === "bin" &&
			parse(packageDirectory).base === "pnpm" && parse(dirname(packageDirectory)).base === "node_modules";
		if (shim?.exe === undefined && !pnpmEntry) throw new Error("Unknown pnpm wrapper; refusing execution or replacement");
		if (pnpmEntry) {
			// npm cmd-shim selects its sibling node.exe before PATH node. Preserve it.
			onStep("node-discovery");
			const localNode = join(directory, "node.exe");
			const selectedNode = shim.node ?? (exists(localNode) ? localNode : (adapters.findNode ?? ((env) => findWindowsCommand(env, "node")))(env));
			if (!selectedNode || !/\.exe$/i.test(selectedNode)) throw new Error("Unknown wrapper-selected Node");
			const metadataPath = join(packageDirectory, "package.json");
			for (const [step, path] of [["node-storage", selectedNode], ["entry-storage", entry], ["metadata-storage", metadataPath]]) {
				onStep(step);
				storage(path, env);
				if (!regular(path)) throw new Error("Unsafe pnpm wrapper target");
			}
			onStep("package");
			const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
			if (metadata.bin?.pnpm !== `bin/${file}`) throw new Error("Windows pnpm package target rejected");
			if (metadata.name !== "pnpm" || !STABLE.test(metadata.version ?? "") || pinnedPnpmCompatible(metadata.version)) {
				onStep("cli-proof");
				proveCli(selectedNode, entry, metadata, env, processAdapter);
				return { acquired: false, env, command: selectedNode, prefix: [entry] };
			}
		} else {
			// @pnpm/exe hard-links its binary under both names; the shim may name either.
			// CMD resolves an extensionless target through PATHEXT, in order.
			let exe = target(shim.exe);
			if (extname(exe) === "") exe = pathExtensions(env).map((candidate) => `${exe}${candidate}`).find(exists) ?? exe;
			const metadataPath = join(dirname(exe), "package.json");
			onStep("exe-storage");
			storage(exe, env);
			if (!/\.exe$/i.test(exe) || !regular(exe)) throw new Error("Unsafe pnpm wrapper target");
			if (!exists(metadataPath)) throw notPnpm;
			storage(metadataPath, env);
			if (!regular(metadataPath)) throw new Error("Unsafe pnpm wrapper target");
			const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
			if (metadata.name !== "pnpm" && !/^@pnpm\//.test(metadata.name ?? "")) throw notPnpm;
			// A standalone pnpm embeds its own Node runtime: it must report its package's version.
			onStep("exe-proof");
			const version = processAdapter(exe, ["--version"], env);
			if (!STABLE.test(version) || version !== metadata.version) throw new Error("Windows pnpm version rejected");
			if (pinnedPnpmCompatible(version)) {
				proveGlobal(exe, [], env, processAdapter);
				return { acquired: false, env, command: exe, prefix: [] };
			}
		}
	} catch (error) {
		if (error !== notPnpm && !untrustedStorage.test(error?.check ?? "")) throw error;
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
	"metadata-storage", "package", "cli-proof", "exe-storage", "exe-proof", "tools-check", "download", "archive", "publish", "launch"]);
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
		// A native pnpm.exe is handed off as the command itself, a JS entry with its Node.
		const handoff = result.prefix.length === 0 ? { GENTLE_INSTALL_PNPM_COMMAND: result.command }
			: { GENTLE_INSTALL_PNPM_NODE: result.command, GENTLE_INSTALL_PNPM_ENTRY: result.prefix[0] };
		const inherited = Object.entries(result.env).filter(([key]) => !/^GENTLE_INSTALL_PNPM_(?:NODE|ENTRY|COMMAND)$/i.test(key));
		await launchWizard({ bundle, env: { ...Object.fromEntries(inherited), ...handoff } });
	} catch (error) {
		throw Object.assign(new Error("Windows bootstrap rejected"), { reason: windowsBootstrapReason(error, step) });
	}
}
