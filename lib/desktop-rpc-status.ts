// Gentle Desktop package-status slice: the pure contract shared by the Desktop
// bridge (`lib/desktop-status-service.ts`) and the status owner in
// `extensions/gentle-ai.ts` (the same facts `/gentle:status` prints).
//
// The owner answers through a versioned event/adapter, like the review and
// stats seams; this module validates its answer and keeps the Desktop shape
// free of paths, command hints, and display text. `/gentle:doctor` is not part
// of it: the doctor is interactive and can change things.

export const DESKTOP_STATUS_METHODS = ["get_status"] as const;
/** Package status is an explicit read: this slice advertises no event. */
export const DESKTOP_STATUS_EVENTS = [] as const;

export const DESKTOP_STATUS_SERVICE_SCHEMA = "gentle-pi.desktop-status-service/v1";
export const DESKTOP_STATUS_SERVICE_CHANNEL = "gentle:desktop:status-service";

export const INVALID_STATUS_PARAMS = { code: "invalid_request", message: "Invalid status parameters" } as const;
export const STATUS_UNAVAILABLE = { code: "status_unavailable", message: "Package status unavailable" } as const;

export type DevBinaryState = "inactive" | "active" | "invalid";
export type RoutingState = "missing" | "invalid" | "valid";

export interface DesktopAssetStatus {
	/** Managed package assets missing or different from the packaged copy. */
	stale: number;
	/** Installed files the user replaced; preserved, not drift. */
	userOverrides: number;
	/** Active non-builtin agents shadowing package agents. */
	activeAgentOverrides: number;
}

/** The `get_status` answer. */
export interface DesktopPackageStatus {
	package: "active";
	odd: "active";
	persona: "gentleman" | "neutral";
	/** The `gentle-ai` dev-binary override; `sha256Prefix` only while active (16 hex). */
	devBinary: { state: DevBinaryState; sha256Prefix: string | null };
	assets: { delegation: DesktopAssetStatus; review: DesktopAssetStatus };
	modelConfig: { global: "present" | "missing"; routing: RoutingState };
	/** `warning` exactly when `/gentle:status` would warn. */
	severity: "info" | "warning";
}

export type DesktopStatusOwnerRead = { kind: "status"; status: DesktopPackageStatus } | { kind: "unavailable" };

export interface DesktopStatusService {
	readonly schema: typeof DESKTOP_STATUS_SERVICE_SCHEMA;
	read(): Promise<DesktopStatusOwnerRead>;
	dispose(): void;
}

export function isDesktopStatusServiceShape(value: unknown): value is DesktopStatusService {
	if (!value || typeof value !== "object") return false;
	const service = value as Partial<DesktopStatusService>;
	return service.schema === DESKTOP_STATUS_SERVICE_SCHEMA && typeof service.read === "function" && typeof service.dispose === "function";
}

/** `get_status` params: an empty object. */
export function parseStatusParams(params: Record<string, unknown>): { ok: true } | { error: { code: string; message: string } } {
	return Object.keys(params).length === 0 ? { ok: true } : { error: INVALID_STATUS_PARAMS };
}

/** The severity rule of `/gentle:status`, shared so both answers agree. */
export function packageStatusSeverity(status: Omit<DesktopPackageStatus, "severity">): "info" | "warning" {
	const assets = [status.assets.delegation, status.assets.review];
	return status.modelConfig.routing === "invalid" || status.devBinary.state !== "inactive" || assets.some((asset) => asset.stale > 0 || asset.activeAgentOverrides > 0)
		? "warning"
		: "info";
}

const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parseAssets(value: unknown): DesktopAssetStatus | undefined {
	if (!record(value) || !count(value.stale) || !count(value.userOverrides) || !count(value.activeAgentOverrides)) return undefined;
	return { stale: value.stale, userOverrides: value.userOverrides, activeAgentOverrides: value.activeAgentOverrides };
}

/** Re-validates an owner answer field by field; anything else is `undefined`. */
export function parseDesktopPackageStatus(value: unknown): DesktopPackageStatus | undefined {
	if (!record(value) || value.package !== "active" || value.odd !== "active") return undefined;
	if (value.persona !== "gentleman" && value.persona !== "neutral") return undefined;
	const dev = value.devBinary;
	if (!record(dev) || (dev.state !== "inactive" && dev.state !== "active" && dev.state !== "invalid")) return undefined;
	const prefix = dev.state === "active" && typeof dev.sha256Prefix === "string" && /^[0-9a-f]{16}$/.test(dev.sha256Prefix) ? dev.sha256Prefix : null;
	if (!record(value.assets)) return undefined;
	const delegation = parseAssets(value.assets.delegation);
	const review = parseAssets(value.assets.review);
	if (!delegation || !review) return undefined;
	const models = value.modelConfig;
	if (!record(models) || (models.global !== "present" && models.global !== "missing")) return undefined;
	if (models.routing !== "missing" && models.routing !== "invalid" && models.routing !== "valid") return undefined;
	const status: Omit<DesktopPackageStatus, "severity"> = {
		package: "active",
		odd: "active",
		persona: value.persona as DesktopPackageStatus["persona"],
		devBinary: { state: dev.state as DevBinaryState, sha256Prefix: prefix },
		assets: { delegation, review },
		modelConfig: { global: models.global as "present" | "missing", routing: models.routing as RoutingState },
	};
	return { ...status, severity: packageStatusSeverity(status) };
}
