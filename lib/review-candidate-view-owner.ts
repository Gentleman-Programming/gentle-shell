import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { conservativeOwnerDeathProofV1 } from "./review-lock.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOOT_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export interface CandidateViewOwner {
	version: 1;
	uuid: string;
	token: string;
	pid: number;
	host: string | null;
	root: string;
	commonDir: string;
}
type Git = (args: readonly string[]) => string;
export type WindowsAclAuthority = (path: string) => void;

let testingWindowsAclAuthority: WindowsAclAuthority | undefined;
export function setWindowsAclAuthorityForTesting(authority?: WindowsAclAuthority): void {
	testingWindowsAclAuthority = authority;
}

const WINDOWS_SYSTEM = "S-1-5-18";
const WINDOWS_ADMINISTRATORS = "S-1-5-32-544";
const WINDOWS_SYSTEM_DIRECTORY = "\\\\?\\GLOBALROOT\\SystemRoot\\System32";

function windowsSystemExecutable(name: "whoami.exe" | "icacls.exe" | "WindowsPowerShell\\v1.0\\powershell.exe"): string {
	try {
		return realpathSync.native(join(WINDOWS_SYSTEM_DIRECTORY, name));
	} catch {
		throw new Error("Windows system executable is unavailable");
	}
}

function windowsUserSid(): string {
	const output = execFileSync(windowsSystemExecutable("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", timeout: 5000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	const matches = output.match(/S-\d+(?:-\d+)+/gi) ?? [];
	if (matches.length !== 1) throw new Error("Windows user SID is unavailable");
	return matches[0]!.toUpperCase();
}

function windowsLocalAdministratorSid(): string {
	const script = "$ErrorActionPreference='Stop';$descriptor=New-Object System.Security.AccessControl.RawSecurityDescriptor 'D:(A;;FA;;;LA)';$descriptor.DiscretionaryAcl[0].SecurityIdentifier.Value";
	const systemRoot = dirname(dirname(windowsSystemExecutable("whoami.exe")));
	const output = execFileSync(windowsSystemExecutable("WindowsPowerShell\\v1.0\\powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 5000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, SystemRoot: systemRoot } });
	const matches = output.match(/S-\d+(?:-\d+)+/gi) ?? [];
	if (matches.length !== 1 || !isWindowsSid(matches[0]!)) throw new Error("Windows local Administrator SID is unavailable");
	return matches[0]!.toUpperCase();
}

function windowsDacl(path: string): string {
	const archive = `.gentle-ai-acl-${randomUUID()}.txt`;
	const archivePath = join(dirname(path), archive);
	try {
		execFileSync(windowsSystemExecutable("icacls.exe"), [path, "/save", archive, "/c"], { cwd: dirname(path), encoding: "utf8", timeout: 5000, maxBuffer: 16384, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		const sddl = readFileSync(archivePath, "utf16le").match(/D:[^\r\n]+/)?.[0];
		if (sddl === undefined) throw new Error("Windows DACL is unavailable");
		return sddl;
	} finally {
		try { unlinkSync(archivePath); } catch {}
	}
}

export type WindowsDaclValidationReason = "protection" | "ace-count" | "ace-shape" | "ace-type" | "ace-flags" | "ace-rights" | "ace-reserved-fields" | "ace-trustee" | "ace-duplicate";
export type WindowsDaclTrusteeClassification = "OW" | "CO" | "BU" | "AU" | "WD" | "LA" | "sid" | "other" | "missing";

export class WindowsDaclValidationError extends Error {
	readonly reason: WindowsDaclValidationReason;
	readonly trustee?: WindowsDaclTrusteeClassification;
	constructor(reason: WindowsDaclValidationReason, trustee?: WindowsDaclTrusteeClassification) {
		super(`Windows DACL validation failed: ${reason}${trustee === undefined ? "" : ` (${trustee})`}`);
		this.name = "WindowsDaclValidationError";
		this.reason = reason;
		this.trustee = trustee;
	}
}

export type WindowsOwnerClassification = "user" | "system" | "administrators" | "sid" | "other" | "missing";

export class WindowsOwnerValidationError extends Error {
	readonly owner: WindowsOwnerClassification;
	constructor(owner: WindowsOwnerClassification = "missing") {
		super(`Windows owner validation failed (${owner})`);
		this.name = "WindowsOwnerValidationError";
		this.owner = owner;
	}
}

function classifyWindowsTrustee(value: string | undefined): WindowsDaclTrusteeClassification {
	const trustee = value?.toUpperCase() ?? "";
	if (["OW", "CO", "BU", "AU", "WD", "LA"].includes(trustee)) return trustee as WindowsDaclTrusteeClassification;
	if (isWindowsSid(trustee)) return "sid";
	return trustee === "" ? "missing" : "other";
}

function isWindowsSid(value: string): boolean {
	return /^S-\d+(?:-\d+)+$/i.test(value);
}

export function validatePrivateWindowsDacl(dacl: string, user: string, protectedDacl: boolean, localAdministratorSid?: string): void {
	if (protectedDacl && !dacl.startsWith("D:P")) throw new WindowsDaclValidationError("protection");
	const trustees = new Map([[user.toUpperCase(), "user"], [WINDOWS_SYSTEM, "system"], ["SY", "system"], [WINDOWS_ADMINISTRATORS, "administrators"], ["BA", "administrators"]]);
	if (isWindowsSid(user) && localAdministratorSid !== undefined && isWindowsSid(localAdministratorSid) && user.toUpperCase() === localAdministratorSid.toUpperCase()) trustees.set("LA", "user");
	const aces = [...dacl.matchAll(/\(([^()]*)\)/g)].map((match) => match[1]!.split(";"));
	const expectedFlags = protectedDacl ? "OICI" : "ID";
	const granted = new Set<string>();
	for (const ace of aces) {
		const trustee = trustees.get(ace[5]?.toUpperCase() ?? "");
		if (ace.length !== 6) throw new WindowsDaclValidationError("ace-shape");
		if (ace[0] !== "A") throw new WindowsDaclValidationError("ace-type");
		if (ace[1] !== expectedFlags) throw new WindowsDaclValidationError("ace-flags");
		if (ace[2] !== "FA") throw new WindowsDaclValidationError("ace-rights");
		if (ace[3] !== "" || ace[4] !== "") throw new WindowsDaclValidationError("ace-reserved-fields");
		if (trustee === undefined) throw new WindowsDaclValidationError("ace-trustee", classifyWindowsTrustee(ace[5]));
		if (granted.has(trustee)) throw new WindowsDaclValidationError("ace-duplicate");
		granted.add(trustee);
	}
	if (granted.size !== 3) throw new WindowsDaclValidationError("ace-count");
}

export function validatePrivateWindowsOwner(owner: string | undefined, user: string): void {
	const normalizedOwner = owner?.toUpperCase();
	// Owners implicitly control a DACL, so accept only principals that the exact DACL already grants full control.
	if (normalizedOwner === undefined) throw new WindowsOwnerValidationError("missing");
	if (!isWindowsSid(user) || !isWindowsSid(normalizedOwner)) throw new WindowsOwnerValidationError(isWindowsSid(normalizedOwner) ? "sid" : "other");
	if (normalizedOwner === user.toUpperCase()) return;
	if (normalizedOwner === WINDOWS_SYSTEM) return;
	if (normalizedOwner === WINDOWS_ADMINISTRATORS) return;
	throw new WindowsOwnerValidationError("sid");
}

interface WindowsAclIdentity {
	user: string;
	localAdministrator: string;
}

type WindowsObjectKind = "file" | "directory";

function windowsAclIdentity(): WindowsAclIdentity {
	return { user: windowsUserSid(), localAdministrator: windowsLocalAdministratorSid() };
}

function windowsOwnerSid(path: string, kind: WindowsObjectKind): string {
	if (path.length === 0 || path.length > 32767 || path.includes("\0")) throw new WindowsOwnerValidationError();
	const script = kind === "file"
		? "$ErrorActionPreference='Stop';$acl=[System.IO.File]::GetAccessControl($env:GENTLE_PI_CANDIDATE_OWNER_PATH,[System.Security.AccessControl.AccessControlSections]::Owner);$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value"
		: "$ErrorActionPreference='Stop';$acl=[System.IO.Directory]::GetAccessControl($env:GENTLE_PI_CANDIDATE_OWNER_PATH,[System.Security.AccessControl.AccessControlSections]::Owner);$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value";
	const systemRoot = dirname(dirname(windowsSystemExecutable("whoami.exe")));
	let output: string;
	try {
		output = execFileSync(windowsSystemExecutable("WindowsPowerShell\\v1.0\\powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 5000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, SystemRoot: systemRoot, GENTLE_PI_CANDIDATE_OWNER_PATH: path } });
	} catch {
		throw new WindowsOwnerValidationError();
	}
	const matches = output.match(/S-\d+(?:-\d+)+/gi) ?? [];
	if (matches.length !== 1 || !isWindowsSid(matches[0]!)) throw new WindowsOwnerValidationError();
	return matches[0]!.toUpperCase();
}

export function assertTrustedWindowsOwner(path: string, kind: WindowsObjectKind): void {
	validatePrivateWindowsOwner(windowsOwnerSid(path, kind), windowsUserSid());
}

function assertPrivateWindowsDacl(path: string, kind: WindowsObjectKind, protectedDacl: boolean, identity: WindowsAclIdentity = windowsAclIdentity()): void {
	validatePrivateWindowsOwner(windowsOwnerSid(path, kind), identity.user);
	validatePrivateWindowsDacl(windowsDacl(path), identity.user, protectedDacl, identity.localAdministrator);
}

function enforcePrivateWindowsDacl(path: string, identity: WindowsAclIdentity = windowsAclIdentity()): void {
	validatePrivateWindowsOwner(windowsOwnerSid(path, "directory"), identity.user);
	const { user, localAdministrator } = identity;
	const sddl = `D:P(A;OICI;FA;;;${user})(A;OICI;FA;;;${WINDOWS_SYSTEM})(A;OICI;FA;;;${WINDOWS_ADMINISTRATORS})`;
	const script = "$ErrorActionPreference='Stop';$acl=New-Object System.Security.AccessControl.DirectorySecurity;$acl.SetSecurityDescriptorSddlForm($env:GENTLE_PI_CANDIDATE_ACL_SDDL,[System.Security.AccessControl.AccessControlSections]::Access);[System.IO.Directory]::SetAccessControl($env:GENTLE_PI_CANDIDATE_ACL_PATH,$acl)";
	const systemRoot = dirname(dirname(windowsSystemExecutable("whoami.exe")));
	execFileSync(windowsSystemExecutable("WindowsPowerShell\\v1.0\\powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 5000, maxBuffer: 16384, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, SystemRoot: systemRoot, GENTLE_PI_CANDIDATE_ACL_PATH: path, GENTLE_PI_CANDIDATE_ACL_SDDL: sddl } });
	assertPrivateWindowsDacl(path, "directory", true, identity);
}

function privateWindowsDacl(path: string, kind: WindowsObjectKind, protectedDacl: boolean, enforce = false): void {
	if (testingWindowsAclAuthority !== undefined) return testingWindowsAclAuthority(path);
	if (enforce) enforcePrivateWindowsDacl(path);
	else assertPrivateWindowsDacl(path, kind, protectedDacl);
}

function privateWindowsCandidateOwnerBoundary(commonDir: string, enforce = false): void {
	const boundary = [commonDir, join(commonDir, "gentle-ai"), join(commonDir, "gentle-ai", "candidate-views")];
	if (testingWindowsAclAuthority !== undefined) {
		for (const path of boundary) testingWindowsAclAuthority(path);
		return;
	}
	const identity = windowsAclIdentity();
	if (enforce) {
		for (const path of boundary) validatePrivateWindowsOwner(windowsOwnerSid(path, "directory"), identity.user);
		for (const path of boundary) enforcePrivateWindowsDacl(path, identity);
		return;
	}
	for (const path of boundary) assertPrivateWindowsDacl(path, "directory", true, identity);
}

// A hostname or a repository-local nonce cannot prove that a PID is local.
// Bind to the kernel boot and, on Linux, its PID namespace. Unsupported or
// unavailable provenance disables reclamation (including across reboots).
function localHost(): string | null {
	try {
		if (process.platform === "darwin") {
			const boot = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: 1000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] }).trim();
			if (BOOT_UUID.test(boot)) return `darwin:${boot.toLowerCase()}`;
		}
		if (process.platform === "linux") {
			const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			const namespace = readlinkSync("/proc/self/ns/pid");
			if (BOOT_UUID.test(boot) && /^pid:\[\d+\]$/.test(namespace)) return `linux:${boot}:${namespace}`;
		}
	} catch { /* No remote/PID-only fallback. */ }
	return null;
}

export function samePath(path: string, expected: string, platform: NodeJS.Platform): boolean {
	if (platform !== "win32") return path === expected;
	const canonical = (value: string): string => {
		try {
			return realpathSync.native(value).replaceAll("\\", "/").toLowerCase();
		} catch {
			return join(realpathSync.native(dirname(value)), basename(value)).replaceAll("\\", "/").toLowerCase();
		}
	};
	return canonical(path) === canonical(expected);
}

function directory(path: string, privateMode = false, platform: NodeJS.Platform = process.platform): string {
	const stat = lstatSync(path);
	const uid = process.getuid?.();
	if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(path), path, platform) ||
		(privateMode && platform !== "win32" && (uid === undefined || stat.uid !== uid || (stat.mode & 0o077) !== 0))) throw new Error("Unsafe candidate owner directory");
	if (privateMode && platform === "win32") privateWindowsDacl(path, "directory", true);
	return `${stat.dev}:${stat.ino}`;
}

export function assertCandidateOwnerParent(commonDir: string, platform: NodeJS.Platform = process.platform): string {
	directory(commonDir, false, platform);
	const control = join(commonDir, "gentle-ai");
	directory(control, false, platform);
	const parent = join(commonDir, "gentle-ai", "candidate-views");
	directory(parent, false, platform);
	if (platform === "win32") privateWindowsCandidateOwnerBoundary(commonDir);
	else directory(parent, true, platform);
	return parent;
}

export function prepareCandidateOwnerParent(commonDir: string, platform: NodeJS.Platform = process.platform): string {
	directory(commonDir, false, platform);
	const control = join(commonDir, "gentle-ai");
	directory(control, false, platform);
	const parent = join(commonDir, "gentle-ai", "candidate-views");
	directory(parent, false, platform);
	if (platform === "win32") {
		privateWindowsCandidateOwnerBoundary(commonDir, true);
		return parent;
	}
	return assertCandidateOwnerParent(commonDir, platform);
}

function regular(path: string, privateMode = false, platform: NodeJS.Platform = process.platform): string {
	const stat = lstatSync(path);
	const uid = process.getuid?.();
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !samePath(realpathSync(path), path, platform) || stat.size > 16384 ||
		(privateMode && platform !== "win32" && (uid === undefined || stat.uid !== uid || (stat.mode & 0o777) !== 0o600))) throw new Error("Unsafe candidate owner file");
	if (privateMode && platform === "win32") privateWindowsDacl(path, "file", false);
	return `${stat.dev}:${stat.ino}`;
}

function syncDirectory(path: string): void {
	// Windows does not permit fsync on directory handles; the marker file itself
	// remains fsynced before this platform-specific no-op.
	if (process.platform === "win32") return;
	const fd = openSync(path, "r");
	try { fsyncSync(fd); } finally { closeSync(fd); }
}

function removeExactPrivateFile(path: string, identity: string, platform: NodeJS.Platform): void {
	try {
		if (regular(path, true, platform) !== identity) return;
		unlinkSync(path);
		syncDirectory(dirname(path));
	} catch { /* An unproven or replaced file survives. */ }
}

function exclusiveFile(path: string, content: string, platform: NodeJS.Platform = process.platform, rollbackOnFailure = false): string {
	let identity: string | undefined;
	try {
		const fd = openSync(path, "wx", 0o600);
		try {
			identity = regular(path, true, platform);
			writeFileSync(fd, content);
			fsyncSync(fd);
		} finally { closeSync(fd); }
		syncDirectory(dirname(path));
		return identity;
	} catch (error) {
		if (rollbackOnFailure && identity !== undefined) removeExactPrivateFile(path, identity, platform);
		throw error;
	}
}

function markerPath(root: string): string { return `${root}.owner.json`; }

export function createCandidateOwner(commonDir: string, root: string, platform: NodeJS.Platform = process.platform): CandidateViewOwner {
	const parent = assertCandidateOwnerParent(commonDir, platform);
	const uuid = basename(root);
	if (!UUID.test(uuid) || root !== join(parent, uuid) || lstatSync(root, { throwIfNoEntry: false })) throw new Error("Unsafe candidate owner root");
	const owner: CandidateViewOwner = { version: 1, uuid, token: randomUUID(), pid: process.pid, host: localHost(), root, commonDir };
	// Any write/fsync failure aborts creation BEFORE Git can register the view.
	const marker = markerPath(root);
	let markerIdentity: string | undefined;
	try {
		markerIdentity = exclusiveFile(marker, JSON.stringify(owner), platform, true);
		syncDirectory(dirname(parent));
		syncDirectory(commonDir);
	} catch (error) {
		if (markerIdentity !== undefined) removeExactPrivateFile(marker, markerIdentity, platform);
		throw error;
	}
	return Object.freeze(owner);
}

function readOwner(commonDir: string, root: string, platform: NodeJS.Platform = process.platform): CandidateViewOwner {
	const parent = assertCandidateOwnerParent(commonDir, platform);
	if (!UUID.test(basename(root)) || root !== join(parent, basename(root))) throw new Error("Candidate owner escaped parent");
	regular(markerPath(root), true, platform);
	const owner = JSON.parse(readFileSync(markerPath(root), "utf8")) as CandidateViewOwner;
	if (!owner || Object.keys(owner).sort().join(",") !== "commonDir,host,pid,root,token,uuid,version" || owner.version !== 1 ||
		owner.uuid !== basename(root) || !UUID.test(owner.token) || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
		owner.root !== root || owner.commonDir !== commonDir || !(owner.host === null || typeof owner.host === "string")) throw new Error("Malformed candidate owner");
	return owner;
}

function dead(owner: CandidateViewOwner): boolean {
	return owner.host !== null && owner.host === localHost() && conservativeOwnerDeathProofV1({
		pid: owner.pid, token: owner.token, owner_hash: "", repository_id: owner.commonDir, authority_id: owner.uuid,
	});
}

function registration(root: string, commonDir: string, git: Git, platform: NodeJS.Platform = process.platform): string {
	const rows = git(["worktree", "list", "--porcelain", "-z"]).split("\0\0");
	const matching = rows.filter((row) => {
		const worktree = row.split("\0")[0];
		return worktree !== undefined && worktree.startsWith("worktree ") && samePath(worktree.slice(9), root, platform);
	});
	if (matching.length !== 1 || matching[0]!.split("\0").some((field) => /^(locked|prunable)( |$)/.test(field))) throw new Error("Candidate registration is ambiguous");
	const gitFile = join(root, ".git");
	regular(gitFile);
	const pointer = readFileSync(gitFile, "utf8");
	if (!pointer.startsWith("gitdir: ") || !pointer.endsWith("\n")) throw new Error("Unsafe candidate Git pointer");
	const admin = pointer.slice(8, -1);
	if (!samePath(dirname(admin), join(commonDir, "worktrees"), platform)) throw new Error("Candidate admin escaped common directory");
	directory(join(commonDir, "worktrees"));
	directory(admin);
	regular(join(admin, "gitdir"));
	regular(join(admin, "commondir"));
	const gitdir = readFileSync(join(admin, "gitdir"), "utf8");
	if (!gitdir.endsWith("\n") || !samePath(gitdir.slice(0, -1), gitFile, platform) ||
		!samePath(resolve(admin, readFileSync(join(admin, "commondir"), "utf8").trim()), commonDir, platform)) throw new Error("Candidate Git backlinks changed");
	return matching[0]! + pointer;
}

export function removeCandidateOwner(owner: CandidateViewOwner, git: Git, makeWritable: (root: string) => void, orphan = false, platform: NodeJS.Platform = process.platform): void {
	const { root, commonDir } = owner;
	const parent = assertCandidateOwnerParent(commonDir, platform);
	const expected = JSON.stringify(owner);
	const parentIdentity = directory(parent, true, platform);
	const markerIdentity = regular(markerPath(root), true, platform);
	const checkOwner = (): void => {
		if (directory(parent, true, platform) !== parentIdentity || regular(markerPath(root), true, platform) !== markerIdentity ||
			JSON.stringify(readOwner(commonDir, root, platform)) !== expected || (orphan ? !dead(owner) : owner.pid !== process.pid)) throw new Error("Candidate ownership changed");
	};
	checkOwner();
	const lock = `${root}.reaper-lock`;
	const token = randomUUID();
	exclusiveFile(lock, token); // EEXIST is final; unknown/stale locks are never stolen.
	const lockIdentity = regular(lock, true, platform);
	const checkLock = (): void => {
		if (regular(lock, true, platform) !== lockIdentity || readFileSync(lock, "utf8") !== token) throw new Error("Candidate reaper lock changed");
	};
	try {
		checkOwner();
		const identity = [directory(parent, true, platform), directory(root), regular(markerPath(root), true, platform)];
		const registered = registration(root, commonDir, git, platform);
		checkOwner();
		checkLock();
		makeWritable(root);
		// Git and chmod are race boundaries: repeat path, owner, lock, and exact
		// registration proofs immediately before asking Git to remove this root.
		if (registration(root, commonDir, git, platform) !== registered ||
			JSON.stringify([directory(parent, true, platform), directory(root), regular(markerPath(root), true, platform)]) !== JSON.stringify(identity)) throw new Error("Candidate cleanup identity changed");
		checkOwner();
		checkLock();
		git(["worktree", "remove", "--force", root]);
		// Git failure or incomplete removal must never trigger recursive rm.
		if (lstatSync(root, { throwIfNoEntry: false }) || git(["worktree", "list", "--porcelain", "-z"]).split("\0\0").some((row) => {
			const worktree = row.split("\0")[0];
			return worktree !== undefined && worktree.startsWith("worktree ") && samePath(worktree.slice(9), root, platform);
		})) throw new Error("Candidate removal is incomplete");
		checkOwner();
		checkLock();
		unlinkSync(markerPath(root));
		syncDirectory(parent);
	} finally {
		// Only release this exact lock, even when the deletion itself failed.
		try { assertCandidateOwnerParent(commonDir, platform); checkLock(); unlinkSync(lock); syncDirectory(parent); } catch {}
	}
}

export function sweepCandidateOwners(commonDir: string, git: Git, makeWritable: (root: string) => void, platform: NodeJS.Platform = process.platform): void {
	try {
		const parent = assertCandidateOwnerParent(commonDir, platform);
		for (const name of readdirSync(parent)) {
			if (!name.endsWith(".owner.json")) continue;
			try {
				const owner = readOwner(commonDir, join(parent, name.slice(0, -11)), platform);
				if (dead(owner)) removeCandidateOwner(owner, git, makeWritable, true, platform);
			} catch { /* Unknown, legacy, unsafe, unregistered, and contended entries survive. */ }
		}
	} catch { /* Startup/materialization sweeps are best-effort; never create a store. */ }
}
