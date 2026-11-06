import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNativeReviewCli, NativeReviewCliV216 } from "../lib/native-review-cli.ts";

type Client = ReturnType<typeof createNativeReviewCli>;
type Executor = Parameters<typeof createNativeReviewCli>[0];
type BinaryResolver = NonNullable<Parameters<typeof createNativeReviewCli>[1]>;
type ModeRequest = Parameters<NonNullable<Client["reviewMode"]>>[0];

test("public mode clients snapshot scopes and reject requests without file or process effects", async (t) => {
	const factories: Array<(execute: Executor, binary: BinaryResolver) => Client> = [
		createNativeReviewCli,
		(execute, binary) => new NativeReviewCliV216(execute, binary),
	];

	for (const make of factories) {
		const root = mkdtempSync(join(tmpdir(), "gentle-rdd-scope-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const file = join(root, "state.json");
		writeFileSync(file, '{"global":"on","clone":""}\n');
		const hash = () => createHash("sha256").update(readFileSync(file)).digest("hex");
		let calls = 0;
		let writes = 0;
		let resolutions = 0;
		let cwdReads = 0;
		const argv: string[][] = [];
		const snapshot = () => ({ hash: hash(), calls, writes, resolutions, cwdReads });

		const execute: Executor = async (request) => {
			calls++;
			argv.push([...request.arguments]);
			const operation = request.arguments[2];
			const scopeIndex = request.arguments.indexOf("--scope");
			const scope = scopeIndex < 0 ? "both" : request.arguments[scopeIndex + 1];
			const state: Record<string, string> = JSON.parse(readFileSync(file, "utf8"));
			if (operation !== "status") {
				state[scope] = operation === "disable" ? "off" : scope === "global" ? "on" : "";
				writeFileSync(file, JSON.stringify(state));
				writes++;
			}
			const effective = state.clone === "off" || state.global === "off" ? "off" : "on";
			const source = state.clone === "off" ? "clone_local" : "global";
			return {
				stdout: JSON.stringify({
					schema: "gentle-ai.review-mode/v1",
					operation,
					scope,
					status: {
						schema: "gentle-ai.rdd-mode-status/v1",
						global: state.global,
						clone_local: state.clone,
						effective,
						source,
					},
				}),
				stderr: "",
				exitCode: 0,
				signal: null,
				timedOut: false,
				outputLimitExceeded: false,
			};
		};
		const client = make(execute, () => {
			resolutions++;
			return "/fixture/gentle-ai";
		});
		assert.ok(client.reviewMode);
		const mode = client.reviewMode.bind(client);

		for (const operation of ["enable", "disable", "status"] as const) {
			for (const scope of [false, 0, [], {}, "GLOBAL", "both", "clone ", null]) {
				const before = snapshot();
				const request = {
					operation,
					scope,
					get cwd() {
						cwdReads++;
						return process.cwd();
					},
				} as unknown as ModeRequest;
				await assert.rejects(() => mode(request), {
					name: "TypeError",
					message: "Native review mode scope must be clone or global",
				});
				assert.deepEqual(snapshot(), before);
			}
		}

		for (const scope of ["global", "clone"] as const) {
			const before = snapshot();
			const request: ModeRequest = {
				operation: "status",
				scope,
				get cwd() {
					cwdReads++;
					return process.cwd();
				},
			};
			await assert.rejects(() => mode(request), {
				name: "TypeError",
				message: "Native review mode scope is only valid for enable or disable",
			});
			assert.deepEqual(snapshot(), before);
		}

		for (const operation of ["disable", "enable"] as const) {
			for (const scope of [undefined, "clone", "global"] as const) {
				const request: {
					cwd: string;
					operation: "disable" | "enable" | "status";
					scope?: "clone" | "global" | "invalid";
				} = { cwd: process.cwd(), operation, ...(scope === undefined ? {} : { scope }) };
				const pending = mode(request as ModeRequest);
				request.operation = "status";
				request.scope = "invalid";
				const result = await pending;
				assert.equal(result.operation, operation);
				assert.equal(result.scope, scope ?? "clone");
				assert.deepEqual(argv.at(-1), [
					"review", "mode", operation, "--cwd", process.cwd(),
					"--scope", scope ?? "clone", "--json",
				]);
			}
		}

		const result = await mode({ cwd: process.cwd(), operation: "status" });
		assert.equal(result.scope, "both");
		assert.deepEqual(argv.at(-1), ["review", "mode", "status", "--cwd", process.cwd(), "--json"]);
		assert.deepEqual({ calls, writes, resolutions, cwdReads }, {
			calls: 7, writes: 6, resolutions: 7, cwdReads: 0,
		});
	}
});
