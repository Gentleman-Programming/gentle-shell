// Gentle Tower web server: serves the built web app and the hub's floors.
// Closed by default: 127.0.0.1 only, a random port, a per-launch token on every
// request, and any Origin other than its own is refused. Read-only for now:
// actions come later and reuse Gentle Shell's own authority.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { readTowerSnapshots } from "./tower-hub.ts";

export interface TowerServerOptions {
	hubDir: string;
	webDir: string;
	token: string;
	port?: number;
	pollMs?: number;
}

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
	const sessionsBody = () => JSON.stringify({ sessions: readTowerSnapshots(options.hubDir) });
	let port = 0;

	const deny = (res: ServerResponse, status = 403) => { res.writeHead(status, { "Content-Type": "text/plain", ...SECURITY_HEADERS }); res.end(status === 404 ? "Not found" : "Forbidden"); };

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

	const handler = (req: IncomingMessage, res: ServerResponse) => {
		if (req.method !== "GET") return deny(res, 405);
		const origin = req.headers.origin;
		if (origin && origin !== `http://127.0.0.1:${port}`) return deny(res);
		// The token is the first path segment, so every relative request the app
		// makes (assets, lazy chunks, the API) carries it without cookies, which
		// browsers would share with every other port on 127.0.0.1.
		const raw = (req.url ?? "/").split("?")[0];
		const slash = raw.indexOf("/", 1);
		const head = slash === -1 ? raw.slice(1) : raw.slice(1, slash);
		if (!sameToken(head, options.token)) return deny(res);
		if (slash === -1) { res.writeHead(308, { Location: `/${head}/`, ...SECURITY_HEADERS }); return res.end(); }
		const rest = raw.slice(slash);
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

