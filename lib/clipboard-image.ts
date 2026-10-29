import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { getNativeClipboard, type NativeClipboard } from "@earendil-works/pi-tui";

// Clipboard image reader for the prompt's attachment chips (gentle-shell#2464).
// Pi reads the same backends but does not export its reader, and its handler
// writes the image to a temp file and inserts the path. This reader keeps the
// bytes in memory and returns null whenever Pi's own handler should decide
// instead: no image, an unsupported format, or files copied in a file manager.

export interface ClipboardImage {
	bytes: Uint8Array;
	mimeType: string;
}

/** Resolves to stdout, or undefined when the command is missing, fails, or times out. */
export type ClipboardCommandRunner = (command: string, args: readonly string[], options?: { timeoutMs?: number }) => Promise<Buffer | undefined>;

export interface ClipboardImageOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	run?: ClipboardCommandRunner;
	native?: () => NativeClipboard | undefined;
	procVersion?: () => string | undefined;
}

export const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const LIST_TIMEOUT_MS = 1000;
const READ_TIMEOUT_MS = 5000;
const POWERSHELL_TIMEOUT_MS = 10_000;
const MAX_CLIPBOARD_BYTES = 64 * 1024 * 1024;

// Encodes the Windows clipboard image as PNG on stdout, so nothing touches disk.
const POWERSHELL_SCRIPT = [
	"Add-Type -AssemblyName System.Windows.Forms",
	"Add-Type -AssemblyName System.Drawing",
	"$img = [System.Windows.Forms.Clipboard]::GetImage()",
	"if (-not $img) { exit 0 }",
	"$ms = New-Object System.IO.MemoryStream",
	"$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
	"[Convert]::ToBase64String($ms.ToArray())",
].join("; ");

export const runClipboardCommand: ClipboardCommandRunner = (command, args, options) => new Promise((resolve) => {
	execFile(command, [...args], { encoding: "buffer", timeout: options?.timeoutMs ?? READ_TIMEOUT_MS, maxBuffer: MAX_CLIPBOARD_BYTES, windowsHide: true }, (error, stdout) => {
		resolve(error ? undefined : stdout);
	});
});

/** Identify a supported image by its signature, never by a clipboard-declared type. */
export function sniffImageMimeType(bytes: Uint8Array): string | undefined {
	const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
	if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
	if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
	if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
	return undefined;
}

export function isWsl(env: NodeJS.ProcessEnv, procVersion: () => string | undefined = readProcVersion): boolean {
	if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
	return /microsoft|wsl/i.test(procVersion() ?? "");
}

function readProcVersion(): string | undefined {
	try { return readFileSync("/proc/version", "utf8"); } catch { return undefined; }
}

function supported(bytes: Uint8Array | null): ClipboardImage | null {
	if (!bytes || bytes.length === 0) return null;
	const mimeType = sniffImageMimeType(bytes);
	return mimeType ? { bytes, mimeType } : null;
}

// A failed read is "backend unavailable", exactly as Pi treats it, so the next backend still runs.
function supportedRead(bytes: Buffer | undefined): ClipboardImage | null | undefined {
	return bytes === undefined ? undefined : supported(bytes);
}

function preferredImageType(listing: Buffer): string | undefined {
	const types = listing.toString("utf8").split(/\r?\n/).map((type) => type.trim()).filter(Boolean);
	return SUPPORTED_IMAGE_MIME_TYPES.find((wanted) => types.some((type) => type.split(";")[0]?.trim().toLowerCase() === wanted));
}

// undefined: backend unavailable, try the next one. null: backend answered, no usable image.
async function viaWlPaste(run: ClipboardCommandRunner): Promise<ClipboardImage | null | undefined> {
	const listing = await run("wl-paste", ["--list-types"], { timeoutMs: LIST_TIMEOUT_MS });
	if (listing === undefined) return undefined;
	const type = preferredImageType(listing);
	if (!type) return null;
	return supportedRead(await run("wl-paste", ["--type", type, "--no-newline"]));
}

async function viaXclip(run: ClipboardCommandRunner): Promise<ClipboardImage | null | undefined> {
	const listing = await run("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], { timeoutMs: LIST_TIMEOUT_MS });
	if (listing === undefined) return undefined;
	const type = preferredImageType(listing);
	if (!type) return null;
	return supportedRead(await run("xclip", ["-selection", "clipboard", "-t", type, "-o"]));
}

async function viaPowerShell(run: ClipboardCommandRunner): Promise<ClipboardImage | null> {
	const output = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", POWERSHELL_SCRIPT], { timeoutMs: POWERSHELL_TIMEOUT_MS });
	const base64 = output?.toString("utf8").trim();
	if (!base64) return null;
	return supported(new Uint8Array(Buffer.from(base64, "base64")));
}

// Files copied in a file manager stay Pi's: it pastes their paths.
async function hasCopiedFiles(native: NativeClipboard | undefined): Promise<boolean> {
	const files = await native?.getFilePaths?.().catch(() => undefined);
	return Boolean(files && files.length > 0);
}

async function viaNative(native: NativeClipboard | undefined): Promise<ClipboardImage | null> {
	if (!native) return null;
	return supported((await native.getImage().catch(() => undefined)) ?? null);
}

/**
 * Read a supported image from the clipboard, mirroring Pi's backend order:
 * Wayland, then X11, then the Windows clipboard on WSL, then the native
 * clipboard. Returns null when Pi's own paste handler should run instead.
 */
export async function readClipboardImage(options: ClipboardImageOptions = {}): Promise<ClipboardImage | null> {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const run = options.run ?? runClipboardCommand;
	const native = options.native ?? getNativeClipboard;
	if (env.TERMUX_VERSION) return null;
	try {
		const nativeClipboard = native();
		if (await hasCopiedFiles(nativeClipboard)) return null;
		if (platform !== "linux") return await viaNative(nativeClipboard);
		const wsl = isWsl(env, options.procVersion);
		let image: ClipboardImage | null | undefined;
		if (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === "wayland" || wsl) image = await viaWlPaste(run);
		if (image === undefined) image = await viaXclip(run);
		// The Linux clipboard never receives Windows screenshots (Win+Shift+S).
		if (!image && wsl) image = (await viaPowerShell(run)) ?? image;
		if (image === undefined) image = await viaNative(nativeClipboard);
		return image ?? null;
	} catch {
		return null;
	}
}
