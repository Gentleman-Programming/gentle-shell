#!/usr/bin/env node
// A stand-in for gentle-term-host in the serve tests: the same protocol
// (JSON Lines, base64 data) over a Unix socket or, with --tcp, loopback TCP
// with a token in <state-dir>/term-host.json and an `auth` line first; plain
// pipes instead of PTYs and the raw output ring as the "snapshot". It
// records its arguments in <state-dir>/argv.json so a test can check how
// serve started it.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const tcp = args.includes("--tcp");
const socketPath = flag("--socket");
const stateDir = flag("--state-dir");
if (!socketPath && !tcp) { console.error("--socket or --tcp is required"); process.exit(2); }
if (tcp && !stateDir) { console.error("--tcp needs --state-dir"); process.exit(2); }
if (stateDir) {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(stateDir, "argv.json"), JSON.stringify(args));
}
const portFile = tcp ? join(stateDir, "term-host.json") : undefined;
const token = randomBytes(32).toString("hex");
const RING = 2 * 1024 * 1024;
const terms = new Map();

function emit(term, event) {
	for (const conn of term.attached) conn.send({ ...event, term: term.id });
}

function open(msg) {
	const argv = Array.isArray(msg.argv) ? msg.argv : [process.env.SHELL || "/bin/sh", "-l"];
	const id = `t_${randomBytes(6).toString("hex")}`;
	const child = spawn(argv[0], argv.slice(1), { cwd: msg.cwd, env: { ...process.env, ...msg.env, TERM: "xterm-256color" }, stdio: ["pipe", "pipe", "pipe"] });
	const term = { id, child, cwd: msg.cwd, argv, cols: msg.cols, rows: msg.rows, title: "", alive: true, exitCode: undefined, createdAt: Date.now(), ring: Buffer.alloc(0), offset: 0, attached: new Set() };
	const out = (chunk) => {
		term.offset += chunk.length;
		term.ring = Buffer.concat([term.ring, chunk]);
		if (term.ring.length > RING) term.ring = term.ring.subarray(term.ring.length - RING);
		emit(term, { ev: "output", offset: term.offset, data: chunk.toString("base64") });
	};
	child.stdout.on("data", out);
	child.stderr.on("data", out);
	child.stdin.on("error", () => {});
	child.on("close", (code, signal) => {
		term.alive = false;
		term.exitCode = code ?? (signal ? 128 : null);
		emit(term, { ev: "exit", code: term.exitCode });
		term.attached.clear();
	});
	terms.set(id, term);
	return { term: id, pid: child.pid };
}

function handle(conn, msg) {
	const term = typeof msg.term === "string" ? terms.get(msg.term) : undefined;
	const needTerm = () => { if (!term) throw { code: "not_found", message: "no such term" }; return term; };
	switch (msg.op) {
		case "hello": return { protocol: 1, version: "fake", pid: process.pid };
		case "open": return open(msg);
		case "list": return { terms: [...terms.values()].map((t) => ({ term: t.id, pid: t.child.pid, cwd: t.cwd, argv: t.argv, cols: t.cols, rows: t.rows, title: t.title, alive: t.alive, ...(t.alive ? {} : { exitCode: t.exitCode }), createdAt: t.createdAt, offset: t.offset })) };
		case "write": {
			const t = needTerm();
			if (!t.alive) throw { code: "exited", message: "the term exited" };
			t.child.stdin.write(Buffer.from(msg.data, "base64"));
			return {};
		}
		case "resize": {
			const t = needTerm();
			if (!t.alive) throw { code: "exited", message: "the term exited" };
			if (t.cols !== msg.cols || t.rows !== msg.rows) {
				t.cols = msg.cols;
				t.rows = msg.rows;
				conn.after(() => emit(t, { ev: "resized", cols: t.cols, rows: t.rows }));
			}
			return {};
		}
		case "close": {
			const t = needTerm();
			terms.delete(t.id);
			t.child.kill("SIGHUP");
			setTimeout(() => t.child.kill("SIGKILL"), 3000).unref();
			return {};
		}
		case "forget": {
			const t = needTerm();
			if (t.alive) throw { code: "alive", message: "the term still runs" };
			terms.delete(t.id);
			return {};
		}
		case "attach": {
			const t = needTerm();
			const start = t.offset - t.ring.length;
			const resume = typeof msg.from === "number" && msg.from >= start && msg.from <= t.offset;
			if (!t.alive) {
				conn.after(() => conn.send({ ev: "exit", term: t.id, code: t.exitCode }));
				return { offset: t.offset, snapshot: t.ring.toString("base64") };
			}
			t.attached.add(conn);
			conn.terms.add(t);
			if (resume) {
				if (msg.from < t.offset) conn.after(() => conn.send({ ev: "output", term: t.id, offset: t.offset, data: t.ring.subarray(msg.from - start).toString("base64") }));
				return { offset: msg.from };
			}
			return { offset: t.offset, snapshot: t.ring.toString("base64") };
		}
		case "detach": {
			const t = needTerm();
			t.attached.delete(conn);
			return {};
		}
		case "shutdown":
			conn.after(() => {
				for (const t of terms.values()) t.child.kill("SIGKILL");
				rmSync(portFile ?? socketPath, { force: true });
				process.exit(0);
			});
			return {};
		default: throw { code: "bad_request", message: `unknown op ${msg.op}` };
	}
}

if (socketPath) rmSync(socketPath, { force: true });
const server = createServer((socket) => {
	let buffered = "";
	let authed = !tcp;
	const queued = [];
	const conn = {
		terms: new Set(),
		send: (msg) => { if (!socket.destroyed) socket.write(`${JSON.stringify(msg)}\n`); },
		after: (fn) => queued.push(fn),
	};
	socket.on("data", (chunk) => {
		buffered += chunk.toString("utf8");
		let nl;
		while ((nl = buffered.indexOf("\n")) !== -1) {
			const line = buffered.slice(0, nl);
			buffered = buffered.slice(nl + 1);
			let msg;
			try { msg = JSON.parse(line); } catch { msg = undefined; }
			if (!authed) {
				if (msg?.op !== "auth" || msg.token !== token) {
					socket.end(`${JSON.stringify({ id: msg?.id ?? null, ok: false, error: { code: "unauthorized", message: "authenticate first" } })}\n`);
					return;
				}
				authed = true;
				conn.send({ id: msg.id, ok: true });
				continue;
			}
			if (msg === undefined) { conn.send({ id: null, ok: false, error: { code: "bad_request", message: "not JSON" } }); continue; }
			try {
				conn.send({ ...handle(conn, msg), id: msg.id, ok: true });
			} catch (error) {
				conn.send({ id: msg.id, ok: false, error: { code: error.code ?? "error", message: error.message ?? String(error) } });
			}
			for (const fn of queued.splice(0)) fn();
		}
	});
	socket.on("error", () => {});
	socket.on("close", () => { for (const t of conn.terms) t.attached.delete(conn); });
});
if (tcp) {
	server.listen(0, "127.0.0.1", () => {
		const temp = `${portFile}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify({ port: server.address().port, token, pid: process.pid })}\n`, { mode: 0o600 });
		renameSync(temp, portFile);
	});
} else {
	server.listen(socketPath, () => chmodSync(socketPath, 0o600));
}
