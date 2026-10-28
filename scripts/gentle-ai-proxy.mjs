// A corporate proxy is the only route to the internet for many operators, and
// npm already honours it, so the installer has to as well. The Gentle AI
// release asset is fetched with node:https, whose client ignores HTTPS_PROXY,
// HTTP_PROXY and NO_PROXY unless the process opts in, and Node only grew that
// opt-in in v24 (NODE_USE_ENV_PROXY / --use-env-proxy) while this package
// supports node >= 22.19.0. The tunnel below is the portable equivalent of
// that opt-in: it opens a CONNECT tunnel to the proxy and speaks TLS to the
// origin host through it, so the origin's own certificate still decides
// whether the connection is trusted and the proxy never sees the request.
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

// Both spellings are read because shells and CI runners disagree about the
// convention, and the lowercase form is what most corporate setups export.
const PROXY_ENV_BY_PROTOCOL = Object.freeze({
	"https:": Object.freeze(["HTTPS_PROXY", "https_proxy"]),
	"http:": Object.freeze(["HTTP_PROXY", "http_proxy"]),
});

const TRANSIENT_PROXY_STATUSES = Object.freeze([429, 500, 502, 503, 504]);

function proxyPort(proxy) {
	if (proxy.port !== "") return Number(proxy.port);
	return proxy.protocol === "https:" ? 443 : 80;
}

// URL.hostname keeps the brackets of an IPv6 literal, but a socket address
// and a TLS server name need the bare address, so the brackets come off here.
// The bare address stays the server name because dropping it would turn off
// the certificate identity check.
function proxyHost(proxy) {
	return proxy.hostname.replace(/^\[|\]$/g, "");
}

// A proxy value that is not a usable http(s) URL is ignored rather than
// allowed to break an install that would have reached the host directly.
function parseProxy(raw) {
	try {
		// A bare "host:port" is a proxy address, not a URL whose scheme is "host".
		const proxy = new URL(raw.includes("://") ? raw : `http://${raw}`);
		if (proxy.protocol !== "http:" && proxy.protocol !== "https:") return undefined;
		if (proxy.hostname === "") return undefined;
		// Credentials are percent-encoded in the URL and decoded when the
		// Proxy-Authorization header is built. Decoding them here rejects a
		// malformed value now, instead of failing later inside the tunnel.
		decodeURIComponent(proxy.username);
		decodeURIComponent(proxy.password);
		return proxy;
	} catch {
		return undefined;
	}
}

function splitHostPort(entry) {
	if (entry.startsWith("[")) {
		const end = entry.indexOf("]");
		if (end === -1) return { host: entry, port: undefined };
		const rest = entry.slice(end + 1);
		return { host: entry.slice(0, end + 1), port: rest.startsWith(":") ? rest.slice(1) : undefined };
	}
	const separator = entry.lastIndexOf(":");
	// More than one colon is a bare IPv6 address, which carries no port.
	if (separator === -1 || entry.indexOf(":") !== separator) return { host: entry, port: undefined };
	return { host: entry.slice(0, separator), port: entry.slice(separator + 1) };
}

function matchesNoProxy(target, entry) {
	if (entry === "*") return true;
	const { host: pattern, port } = splitHostPort(entry.toLowerCase());
	const host = target.hostname.toLowerCase();
	const targetPort = target.port !== "" ? target.port : target.protocol === "https:" ? "443" : "80";
	if (port !== undefined && port !== targetPort) return false;
	if (pattern.startsWith("*.")) {
		const base = pattern.slice(2);
		return host === base || host.endsWith(`.${base}`);
	}
	// A leading dot covers the domain and its subdomains; a bare domain is an
	// exact match, so one entry never silently exempts a whole namespace.
	if (pattern.startsWith(".")) {
		const base = pattern.slice(1);
		return host === base || host.endsWith(`.${base}`);
	}
	return host === pattern;
}

/**
 * The proxy that applies to `target`, or undefined when the target is reached
 * directly. HTTPS_PROXY answers for an https target and HTTP_PROXY is the
 * fallback, exactly as every other HTTP client on the platform resolves them,
 * and NO_PROXY always wins over both. A value that is not a usable proxy URL
 * is ignored, so a stray variable cannot break an install that would otherwise
 * reach the host directly.
 */
export function resolveProxyForTarget(target, env = process.env) {
	const url = target instanceof URL ? target : new URL(String(target));
	const noProxy = String(env.NO_PROXY ?? env.no_proxy ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
	if (noProxy.some((entry) => matchesNoProxy(url, entry))) return undefined;
	const primary = PROXY_ENV_BY_PROTOCOL[url.protocol] ?? [];
	const fallback = url.protocol === "https:" ? PROXY_ENV_BY_PROTOCOL["http:"] : [];
	for (const key of [...primary, ...fallback]) {
		const raw = env[key];
		if (typeof raw !== "string" || raw.trim() === "") continue;
		const proxy = parseProxy(raw.trim());
		if (proxy !== undefined) return proxy;
	}
	return undefined;
}

function tunnelAuthority(host, port) {
	return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/**
 * An https.Agent whose sockets are CONNECT tunnels to `proxy`. The origin host
 * is still verified by TLS over the tunnel, so the proxy cannot read the
 * request and cannot impersonate the release host without the origin's own
 * certificate chain failing the handshake.
 */
export function createProxyTunnelAgent(proxy, headerTimeoutMs = 10_000) {
	const agent = new https.Agent({ keepAlive: false });
	agent.createConnection = (options, callback) => {
		const host = options.host ?? options.hostname;
		const port = Number(options.port ?? 443);
		const authority = tunnelAuthority(host, port);
		const raw = net.connect({ host: proxyHost(proxy), port: proxyPort(proxy) });
		let channel = raw;
		let head = Buffer.alloc(0);
		let delivered = false;
		let timer;
		const closed = new Set();
		// The listener identity of each socket is kept so every one of them can
		// be detached again on completion, failure and teardown.
		const listeners = new Map();
		const onEnd = () => fail(Object.assign(new Error("Gentle AI download proxy closed before completing CONNECT headers"), { code: "ECONNRESET" }));
		const deliver = (error, secure) => {
			if (delivered) return;
			delivered = true;
			clearTimeout(timer);
			raw.off("connect", onConnect);
			for (const [socket, bound] of listeners) {
				// TLS queues an error while handling EOF, so the error handler
				// stays until teardown finishes and is removed with the close.
				if (error && !closed.has(socket)) socket.once("close", () => socket.off("error", bound.error));
				else socket.off("error", bound.error);
				socket.off("end", bound.end);
				socket.off("close", bound.close);
				socket.off("data", onData);
			}
			callback(error, secure);
		};
		function fail(error) {
			if (delivered) return;
			channel.destroy();
			raw.destroy();
			deliver(error, undefined);
		}
		const watch = (socket) => {
			const bound = {
				error: fail,
				end: onEnd,
				close: () => {
					closed.add(socket);
					onEnd();
				},
			};
			listeners.set(socket, bound);
			socket.on("error", bound.error);
			socket.on("end", bound.end);
			socket.on("close", bound.close);
			return bound;
		};
		// The request cannot enforce its deadline until this agent hands it a
		// socket. Bound TCP, proxy TLS and the CONNECT headers here instead.
		timer = setTimeout(() => fail(Object.assign(new Error("Gentle AI download proxy CONNECT timed out"), { code: "GENTLE_AI_DOWNLOAD_TIMEOUT" })), headerTimeoutMs);
		watch(raw);
		raw.once("connect", onConnect);
		function onConnect() {
			// A proxy reached over TLS speaks the same CONNECT protocol once its
			// own handshake is done, so the tunnel is written to whichever
			// channel is open.
			if (proxy.protocol === "https:") {
				channel = tls.connect({ socket: raw, servername: proxyHost(proxy) });
				watch(channel);
			}
			const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
			if (proxy.username !== "") {
				const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
				lines.push(`Proxy-Authorization: Basic ${Buffer.from(credentials).toString("base64")}`);
			}
			channel.write(`${lines.join("\r\n")}\r\n\r\n`);
			channel.on("data", onData);
		}
		function onData(chunk) {
			head = Buffer.concat([head, chunk]);
			const boundary = head.indexOf("\r\n\r\n");
			if (boundary === -1) return;
			channel.off("data", onData);
			const status = Number(head.subarray(0, head.indexOf("\r\n")).toString("latin1").split(" ")[1]);
			if (status !== 200) {
				// A proxy that is briefly overloaded answers like any other
				// transient HTTP failure, and the downloader's own retry rule
				// decides whether the attempt is worth repeating.
				const error = new Error(`Gentle AI download proxy refused the tunnel with status ${status}`);
				error.code = TRANSIENT_PROXY_STATUSES.includes(status) ? "GENTLE_AI_DOWNLOAD_TRANSIENT_HTTP" : "GENTLE_AI_DOWNLOAD_HTTP";
				fail(error);
				return;
			}
			// Bytes the proxy sent past the header block belong to the origin
			// stream and have to reach the TLS layer rather than be dropped.
			const remainder = head.subarray(boundary + 4);
			if (remainder.length > 0) channel.unshift(remainder);
			deliver(undefined, tls.connect({
				socket: channel,
				servername: options.servername ?? host,
				ALPNProtocols: options.ALPNProtocols ?? ["http/1.1"],
				...(options.rejectUnauthorized === undefined ? {} : { rejectUnauthorized: options.rejectUnauthorized }),
				...(options.ca === undefined ? {} : { ca: options.ca }),
				...(options.cert === undefined ? {} : { cert: options.cert }),
				...(options.key === undefined ? {} : { key: options.key }),
				...(options.passphrase === undefined ? {} : { passphrase: options.passphrase }),
			}));
		}
	};
	return agent;
}
