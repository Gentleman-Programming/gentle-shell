// Gentle Tower web server: serves the built web app and the hub's floors.
// Closed by default: 127.0.0.1 only, a random port, a per-launch token on every
// request, and any Origin other than its own is refused. Read-only for now:
// actions come later and reuse Gentle Shell's own authority.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { readLiveTowerSnapshots as readTowerSnapshots } from "./tower-hub.ts";
import { readPresenceFloors } from "./tower-presence.ts";
import { createHash } from "node:crypto";
import { parseTowerAction, TOWER_ACTION_MAX_BYTES, writeTowerAction } from "./tower-actions.ts";

export interface TowerServerOptions {
	hubDir: string;
	webDir: string;
	token: string;
	port?: number;
	pollMs?: number;
	/** Local Engram HTTP API for the read-only memory window. */
	engramUrl?: string;
	/** Peer presence registries: every live session shows, detailed or basic. */
	presenceDirs?: readonly string[];
	now?: () => number;
	/** Opens a new Gentle Shell session (a floor) in a project already in the tower. */
	onNewFloor?: (cwd: string, prompt?: string) => Promise<void>;
}

const ARTIFACT_TYPES: Record<string, string> = { ".md": "text/plain; charset=utf-8", ".markdown": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".mmd": "text/plain; charset=utf-8", ".mermaid": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
const MEMORY_MAX_BYTES = 512 * 1024;

export interface TowerServer {
	host: "127.0.0.1";
	port: number;
	url: string;
	close(): Promise<void>;
}

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
	".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ico": "image/x-icon",
};
const SECURITY_HEADERS = {
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Cache-Control": "no-store",
	"Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
};

function sameToken(given: string | null | undefined, token: string): boolean {
	if (!given) return false;
	const a = Buffer.from(given), b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}

export function startTowerServer(options: TowerServerOptions): Promise<TowerServer> {
	const webRoot = realpathSync(options.webDir);
	const clients = new Set<ServerResponse>();
	let lastBody = "";
	const now = options.now ?? Date.now;
	// Detailed floors (tower extension) win; every other live session joins as a basic floor.
	const LIVE = new Set(["queued", "running", "waiting"]);
	/** A snapshot this much older than the heartbeat has stopped updating. */
	const STALE_SNAPSHOT_MS = 60_000;
	const allSessions = () => {
		// Finished helpers never show, even if a session still runs an older publisher.
		const detailed = readTowerSnapshots(options.hubDir).map((s) => ({ ...s, subagents: s.subagents.filter((a) => LIVE.has(a.status)) }));
		if (!options.presenceDirs?.length) return detailed;
		const presence = new Map(readPresenceFloors(options.presenceDirs, now()).map((f) => [f.sessionHash, f]));
		const known = new Set<string>();
		for (const s of detailed) {
			const hash = createHash("sha256").update(s.sessionId).digest("hex");
			known.add(hash);
			// Only a snapshot that stopped updating gives way to the heartbeat's live helpers;
			// a recent one keeps its own, which carry spend and progress the heartbeat lacks.
			const p = presence.get(hash);
			if (p && p.updatedAt - s.updatedAt > STALE_SNAPSHOT_MS) s.subagents = p.subagents;
		}
		const basic = [...presence.values()].filter((f) => !known.has(f.sessionHash)).map(({ sessionHash: _h, ...f }) => f);
		return [...detailed, ...basic];
	};
	const sessionsBody = () => JSON.stringify({ sessions: allSessions() });
	let port = 0;

	const MESSAGES: Record<number, string> = { 400: "Bad request", 404: "Not found", 405: "Method not allowed", 413: "Too large", 500: "Server error", 502: "Engram unavailable" };
	const deny = (res: ServerResponse, status = 403) => { if (res.headersSent) return; res.writeHead(status, { "Content-Type": "text/plain", ...SECURITY_HEADERS }); res.end(MESSAGES[status] ?? "Forbidden"); };

	const serveStatic = (res: ServerResponse, pathname: string) => {
		let decoded: string;
		try { decoded = decodeURIComponent(pathname); } catch { return deny(res, 400); }
		if (decoded.includes("\0")) return deny(res, 400);
		const wanted = resolve(webRoot, "." + (decoded === "/" ? "/index.html" : decoded));
		let real: string;
		try { real = realpathSync(wanted); } catch { return deny(res, 404); }
		if (real !== webRoot && !real.startsWith(webRoot + sep)) return deny(res, 404);
		try {
			if (!statSync(real).isFile()) return deny(res, 404);
			res.writeHead(200, { "Content-Type": TYPES[extname(real)] ?? "application/octet-stream", ...SECURITY_HEADERS });
			res.end(readFileSync(real));
		} catch { deny(res, 404); }
	};

	const receiveAction = (req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		let size = 0, over = false;
		req.on("data", (c: Buffer) => { size += c.length; if (size > TOWER_ACTION_MAX_BYTES) { over = true; } else chunks.push(c); });
		req.on("end", () => {
			if (over) return deny(res, 413);
			let action;
			try { action = parseTowerAction(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { action = undefined; }
			if (!action) return deny(res, 400);
			if (action.type === "new-floor") {
				// Never an arbitrary folder: only a project that already has a floor.
				if (!options.onNewFloor || !allSessions().some((s) => s.project.cwd === action.project)) return deny(res, 403);
				options.onNewFloor(action.project, action.prompt).then(
					() => { res.writeHead(202, { "Content-Type": "application/json", ...SECURITY_HEADERS }); res.end("{}"); },
					() => deny(res, 500));
				return;
			}
			// Only a floor that publishes its own snapshot has a session reading its inbox.
			if (!readTowerSnapshots(options.hubDir).some((s) => s.sessionId === action.sessionId)) return deny(res, 404);
			try {
				const id = writeTowerAction(options.hubDir, action);
				res.writeHead(202, { "Content-Type": "application/json", ...SECURITY_HEADERS });
				res.end(JSON.stringify({ id }));
			} catch { deny(res, 500); }
		});
	};

	// Only a file the session itself wrote (it is in its own list), reached
	// directly: a symlink that points elsewhere is refused.
	const serveArtifact = (res: ServerResponse, sessionId: string | null, wanted: string | null) => {
		const session = readTowerSnapshots(options.hubDir).find((x) => x.sessionId === sessionId);
		if (!session || !wanted || !session.artifacts?.some((a) => a.path === wanted)) return deny(res, 404);
		try {
			const real = realpathSync(wanted);
			if (real !== realpathSync(dirname(wanted)) + sep + basename(wanted)) return deny(res, 404);
			const st = statSync(real);
			const type = ARTIFACT_TYPES[extname(real).toLowerCase()];
			if (!st.isFile() || !type || st.size > ARTIFACT_MAX_BYTES) return deny(res, 404);
			res.writeHead(200, { "Content-Type": type, ...SECURITY_HEADERS, "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:" });
			res.end(readFileSync(real));
		} catch { deny(res, 404); }
	};

	const proxyMemory = async (res: ServerResponse, kind: string, query: URLSearchParams) => {
		if (!options.engramUrl) return deny(res, 404);
		const project = query.get("project") ?? "";
		const q = (query.get("q") ?? "").slice(0, 200);
		if (!project || project.length > 200 || (kind === "search" && !q)) return deny(res, 400);
		const target = kind === "search"
			? `${options.engramUrl}/search?${new URLSearchParams({ q, project, limit: "40" })}`
			: `${options.engramUrl}/review?${new URLSearchParams({ project, limit: "40" })}`;
		try {
			const r = await fetch(target, { signal: AbortSignal.timeout(4000) });
			const body = await r.text();
			if (!r.ok || body.length > MEMORY_MAX_BYTES) return deny(res, 502);
			JSON.parse(body);
			res.writeHead(200, { "Content-Type": "application/json", ...SECURITY_HEADERS });
			res.end(body);
		} catch { deny(res, 502); }
	};

	const handler = (req: IncomingMessage, res: ServerResponse) => {
		if (req.method !== "GET" && req.method !== "POST") return deny(res, 405);
		const origin = req.headers.origin;
		if (origin && origin !== `http://127.0.0.1:${port}`) return deny(res);
		// A browser always sends Origin on POST; a missing one is not our page.
		if (req.method === "POST" && !origin) return deny(res);
		// The token is the first path segment, so every relative request the app
		// makes (assets, lazy chunks, the API) carries it without cookies, which
		// browsers would share with every other port on 127.0.0.1.
		const raw = (req.url ?? "/").split("?")[0];
		const slash = raw.indexOf("/", 1);
		const head = slash === -1 ? raw.slice(1) : raw.slice(1, slash);
		if (!sameToken(head, options.token)) return deny(res);
		if (slash === -1) { res.writeHead(308, { Location: `/${head}/`, ...SECURITY_HEADERS }); return res.end(); }
		const rest = raw.slice(slash);
		if (rest === "/api/action") {
			if (req.method !== "POST") return deny(res, 405);
			return receiveAction(req, res);
		}
		if (req.method !== "GET") return deny(res, 405);
		const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
		if (rest === "/api/artifact") return serveArtifact(res, query.get("session"), query.get("path"));
		if (rest === "/api/memory/search" || rest === "/api/memory/review") return void proxyMemory(res, rest.slice("/api/memory/".length), query);
		if (rest === "/api/sessions") {
			res.writeHead(200, { "Content-Type": "application/json", ...SECURITY_HEADERS });
			return res.end(sessionsBody());
		}
		if (rest === "/api/events") {
			res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive", ...SECURITY_HEADERS });
			res.write(`data: ${sessionsBody()}\n\n`);
			clients.add(res);
			req.on("close", () => clients.delete(res));
			return;
		}
		serveStatic(res, rest);
	};

	const server = createServer(handler);
	const poll = setInterval(() => {
		if (clients.size === 0) return;
		const body = sessionsBody();
		if (body === lastBody) return;
		lastBody = body;
		for (const c of clients) c.write(`data: ${body}\n\n`);
	}, options.pollMs ?? 700);
	poll.unref();

	return new Promise((resolveStart, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, "127.0.0.1", () => {
			const addr = server.address();
			port = typeof addr === "object" && addr ? addr.port : 0;
			lastBody = sessionsBody();
			resolveStart({
				host: "127.0.0.1",
				port,
				url: `http://127.0.0.1:${port}/${options.token}/`,
				close: () => new Promise<void>((done) => {
					clearInterval(poll);
					for (const c of clients) c.end();
					clients.clear();
					server.close(() => done());
					server.closeAllConnections?.();
				}),
			});
		});
	});
}

