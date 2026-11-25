// Authentication for `gentle-shell serve`: one-time pairing codes, per-device
// bearer tokens stored only as hashes in an owner-only file, short-lived
// single-use stream tickets for EventSource (which cannot send headers), and
// the local admin token the CLI reads from the owner-only server file.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const SERVE_SCOPES = ["sessions:read", "sessions:operate", "terminal", "admin"] as const;
export type ServeScope = (typeof SERVE_SCOPES)[number];
export const DEFAULT_PAIR_SCOPES: readonly ServeScope[] = ["sessions:read", "sessions:operate", "terminal"];

export const SERVE_AUTH_LIMITS = {
	pairingCodeTtlMs: 5 * 60_000,
	ticketTtlMs: 60_000,
	/** Failed `POST /api/pair` attempts allowed per window, across all callers. */
	pairFailures: 10,
	pairFailureWindowMs: 60_000,
	/** Live pairing codes and tickets held at once; the oldest is dropped past this. */
	maxCodes: 16,
	maxTickets: 256,
	maxDevices: 64,
	deviceNameChars: 64,
	/** `lastUsedAt` is persisted at most this often per device. */
	lastUsedPersistMs: 60_000,
};

const DEVICES_SCHEMA = "gentle-shell.serve.devices/v1";
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: no I, L, O, U

export function isServeScope(value: unknown): value is ServeScope {
	return typeof value === "string" && (SERVE_SCOPES as readonly string[]).includes(value);
}

export function hashSecret(secret: string): Buffer {
	return createHash("sha256").update(secret, "utf8").digest();
}

/** Constant-time over equal-length digests, so neither length nor content leaks. */
export function sameSecret(given: string | undefined | null, expected: string): boolean {
	if (typeof given !== "string" || given.length === 0) return false;
	return timingSafeEqual(hashSecret(given), hashSecret(expected));
}

function matchesHash(given: Buffer, storedHex: string): boolean {
	const stored = Buffer.from(storedHex, "hex");
	return stored.length === given.length && timingSafeEqual(stored, given);
}

export interface DeviceRecord {
	id: string;
	name: string;
	scopes: ServeScope[];
	/** sha256 of the token, hex. The token itself is never stored. */
	tokenHash: string;
	createdAt: string;
	lastUsedAt?: string;
}

export type PublicDevice = Omit<DeviceRecord, "tokenHash">;

export interface Principal {
	/** "local" for the CLI's admin token; a device id otherwise. */
	deviceId: string;
	name: string;
	scopes: readonly ServeScope[];
}

export function hasScope(principal: Principal, scope: ServeScope): boolean {
	return principal.scopes.includes(scope);
}

/** Normalizes a typed code: case-insensitive, separators ignored, O/I/L read as 0/1/1. */
export function normalizePairingCode(code: string): string {
	return code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

function newPairingCode(): string {
	const bytes = randomBytes(8);
	let out = "";
	for (const b of bytes) out += CODE_ALPHABET[b & 31];
	return `${out.slice(0, 4)}-${out.slice(4)}`;
}

function writePrivateJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
	renameSync(temp, path);
	try { chmodSync(path, 0o600); } catch { /* Windows: ACLs, not modes */ }
}

function parseDevices(text: string): DeviceRecord[] {
	const parsed = JSON.parse(text) as { schema?: unknown; devices?: unknown };
	if (parsed?.schema !== DEVICES_SCHEMA || !Array.isArray(parsed.devices)) throw new Error("unrecognized devices file");
	return parsed.devices.filter((d): d is DeviceRecord => !!d && typeof d === "object"
		&& typeof d.id === "string" && typeof d.name === "string" && typeof d.tokenHash === "string" && /^[0-9a-f]{64}$/.test(d.tokenHash)
		&& typeof d.createdAt === "string" && Array.isArray(d.scopes) && d.scopes.every(isServeScope));
}

/** Reads the devices file; a missing file is no devices. */
export function readDevicesFile(path: string): DeviceRecord[] {
	if (!existsSync(path)) return [];
	return parseDevices(readFileSync(path, "utf8"));
}

export function writeDevicesFile(path: string, devices: readonly DeviceRecord[]): void {
	writePrivateJson(path, { schema: DEVICES_SCHEMA, devices });
}

export function publicDevice(device: DeviceRecord): PublicDevice {
	const { tokenHash: _hash, ...rest } = device;
	return rest;
}

interface PairingCode {
	scopes: ServeScope[];
	expiresAt: number;
}

interface Ticket {
	principal: Principal;
	sessionId: string;
	expiresAt: number;
}

export type RedeemResult =
	| { device: PublicDevice; token: string }
	| { error: "invalid_code" | "rate_limited" | "too_many_devices" };

export interface ServeAuthOptions {
	devicesFile: string;
	adminToken: string;
	now?: () => number;
	limits?: Partial<typeof SERVE_AUTH_LIMITS>;
}

export class ServeAuth {
	private readonly devicesFile: string;
	private readonly adminToken: string;
	private readonly now: () => number;
	private readonly limits: typeof SERVE_AUTH_LIMITS;
	private devices: DeviceRecord[];
	/** Keyed by the code's hash, so a lookup never compares the code itself. */
	private readonly codes = new Map<string, PairingCode>();
	private readonly tickets = new Map<string, Ticket>();
	private readonly persistedUse = new Map<string, number>();
	private readonly revokeListeners: Array<(deviceId: string) => void> = [];
	private failures: number[] = [];

	constructor(options: ServeAuthOptions) {
		this.devicesFile = options.devicesFile;
		this.adminToken = options.adminToken;
		this.now = options.now ?? Date.now;
		this.limits = { ...SERVE_AUTH_LIMITS, ...options.limits };
		this.devices = readDevicesFile(this.devicesFile);
	}

	onRevoke(listener: (deviceId: string) => void): void {
		this.revokeListeners.push(listener);
	}

	/** Resolves a bearer token: the local admin token, or a paired device's. */
	authenticate(token: string | undefined): Principal | undefined {
		if (!token) return undefined;
		if (sameSecret(token, this.adminToken)) return { deviceId: "local", name: "local", scopes: SERVE_SCOPES };
		const digest = hashSecret(token);
		let found: DeviceRecord | undefined;
		// Every stored hash is compared, so the time taken does not depend on which one matched.
		for (const device of this.devices) if (matchesHash(digest, device.tokenHash)) found = device;
		if (!found) return undefined;
		this.touch(found);
		return { deviceId: found.id, name: found.name, scopes: [...found.scopes] };
	}

	private touch(device: DeviceRecord): void {
		const now = this.now();
		device.lastUsedAt = new Date(now).toISOString();
		const last = this.persistedUse.get(device.id) ?? 0;
		if (now - last < this.limits.lastUsedPersistMs) return;
		this.persistedUse.set(device.id, now);
		try { this.save(); } catch { /* usage time is advisory; auth never fails on it */ }
	}

	private save(): void {
		writeDevicesFile(this.devicesFile, this.devices);
	}

	mintPairingCode(scopes: readonly ServeScope[] = DEFAULT_PAIR_SCOPES): { code: string; expiresAt: number; scopes: ServeScope[] } {
		this.prune();
		const code = newPairingCode();
		const entry = { scopes: [...new Set(scopes)], expiresAt: this.now() + this.limits.pairingCodeTtlMs };
		this.codes.set(hashSecret(normalizePairingCode(code)).toString("hex"), entry);
		while (this.codes.size > this.limits.maxCodes) this.codes.delete(this.codes.keys().next().value!);
		return { code, ...entry };
	}

	/** Single use: the code is gone after the first attempt that names it, success or not. */
	redeem(code: unknown, name: unknown): RedeemResult {
		this.prune();
		const now = this.now();
		this.failures = this.failures.filter((t) => now - t < this.limits.pairFailureWindowMs);
		if (this.failures.length >= this.limits.pairFailures) return { error: "rate_limited" };
		const key = typeof code === "string" && code.length <= 32 ? hashSecret(normalizePairingCode(code)).toString("hex") : undefined;
		const entry = key === undefined ? undefined : this.codes.get(key);
		if (!entry || key === undefined) {
			this.failures.push(now);
			return { error: "invalid_code" };
		}
		this.codes.delete(key);
		if (this.devices.length >= this.limits.maxDevices) return { error: "too_many_devices" };
		const token = `gss_${randomBytes(32).toString("base64url")}`;
		const device: DeviceRecord = {
			id: `dev_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
			name: cleanDeviceName(name),
			scopes: entry.scopes,
			tokenHash: hashSecret(token).toString("hex"),
			createdAt: new Date(now).toISOString(),
		};
		this.devices.push(device);
		this.save();
		return { device: publicDevice(device), token };
	}

	listDevices(): PublicDevice[] {
		return this.devices.map(publicDevice);
	}

	/** Takes effect at once: the token stops working, its tickets die and listeners close its streams. */
	revoke(deviceId: string): boolean {
		const before = this.devices.length;
		this.devices = this.devices.filter((d) => d.id !== deviceId);
		if (this.devices.length === before) return false;
		this.save();
		for (const [key, ticket] of this.tickets) if (ticket.principal.deviceId === deviceId) this.tickets.delete(key);
		for (const listener of this.revokeListeners) listener(deviceId);
		return true;
	}

	mintTicket(principal: Principal, sessionId: string): { ticket: string; expiresAt: number } {
		this.prune();
		const ticket = randomBytes(24).toString("base64url");
		const expiresAt = this.now() + this.limits.ticketTtlMs;
		this.tickets.set(hashSecret(ticket).toString("hex"), { principal, sessionId, expiresAt });
		while (this.tickets.size > this.limits.maxTickets) this.tickets.delete(this.tickets.keys().next().value!);
		return { ticket, expiresAt };
	}

	/** Single use and bound to one session. */
	redeemTicket(ticket: string | null | undefined, sessionId: string): Principal | undefined {
		if (!ticket || ticket.length > 64) return undefined;
		this.prune();
		const key = hashSecret(ticket).toString("hex");
		const entry = this.tickets.get(key);
		if (!entry) return undefined;
		this.tickets.delete(key);
		return entry.sessionId === sessionId ? entry.principal : undefined;
	}

	private prune(): void {
		const now = this.now();
		for (const [key, entry] of this.codes) if (entry.expiresAt <= now) this.codes.delete(key);
		for (const [key, entry] of this.tickets) if (entry.expiresAt <= now) this.tickets.delete(key);
	}
}

export function cleanDeviceName(name: unknown): string {
	const text = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
	return (text || "device").slice(0, SERVE_AUTH_LIMITS.deviceNameChars);
}

/** Parses `--scope` values: comma lists, repeated flags; unknown names are an error. */
export function parseScopes(values: readonly string[]): { scopes: ServeScope[] } | { error: string } {
	const scopes: ServeScope[] = [];
	for (const value of values.flatMap((v) => v.split(","))) {
		const scope = value.trim();
		if (!scope) continue;
		if (!isServeScope(scope)) return { error: `unknown scope "${scope}" (expected ${SERVE_SCOPES.join(", ")})` };
		if (!scopes.includes(scope)) scopes.push(scope);
	}
	return scopes.length === 0 ? { error: "--scope needs at least one scope" } : { scopes };
}
