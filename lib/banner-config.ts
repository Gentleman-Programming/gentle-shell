// The startup banner settings (`banner.json` in the Gentle config home): the
// shape, its defaults, and a synchronous strict reader and atomic writer. The
// banner extension (`extensions/startup-banner.ts`) keeps its async reads and
// re-exports these definitions; the Desktop `banner` config store uses the
// synchronous pair, because config writes check and write without awaiting.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type BannerColor = "pink" | "cyan" | "yellow" | "green";
export interface BannerConfig {
	showRose: boolean;
	showTextLogo: boolean;
	color: BannerColor;
}

export const DEFAULT_BANNER_CONFIG: BannerConfig = {
	showRose: true,
	showTextLogo: true,
	color: "pink",
};

export const BANNER_COLORS: BannerColor[] = ["pink", "cyan", "yellow", "green"];

export function bannerConfigPath(configHome: string): string {
	return join(configHome, "banner.json");
}

/** Exactly `{ showRose, showTextLogo, color }` with valid values; nothing else. */
export function isBannerConfig(value: unknown): value is BannerConfig {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	return keys.length === 3 && keys.every((key) => key === "showRose" || key === "showTextLogo" || key === "color")
		&& typeof record.showRose === "boolean" && typeof record.showTextLogo === "boolean" && BANNER_COLORS.includes(record.color as BannerColor);
}

export type BannerConfigRead = { status: "missing" } | { status: "invalid" } | { status: "valid"; config: BannerConfig };

/** Strict: a file that is not exactly a banner config is `invalid`, never repaired. */
export function readBannerConfigSync(configHome: string): BannerConfigRead {
	const path = bannerConfigPath(configHome);
	if (!existsSync(path)) return { status: "missing" };
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) return { status: "invalid" };
		const record = value as Record<string, unknown>;
		const config = { showRose: record.showRose, showTextLogo: record.showTextLogo, color: record.color };
		return isBannerConfig(config) ? { status: "valid", config } : { status: "invalid" };
	} catch {
		return { status: "invalid" };
	}
}

/** Replace `banner.json` atomically. */
export function writeBannerConfigSync(config: BannerConfig, configHome: string): void {
	if (!isBannerConfig(config)) throw new TypeError("Invalid banner config");
	const path = bannerConfigPath(configHome);
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		renameSync(temporary, path);
	} catch (error) {
		try { unlinkSync(temporary); } catch { /* the temporary file may not exist */ }
		throw error;
	}
}
