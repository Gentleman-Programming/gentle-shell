import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
// The generated module is the published contract hosts import, not lib/.
import { getProviderConfigs } from "../runtime/provider-configs.mjs";

function withRuntime(run: (runtime: ModelRuntime, authPath: string) => Promise<void>) {
	return async () => {
		const dir = mkdtempSync(join(tmpdir(), "provider-configs-"));
		const authPath = join(dir, "auth.json");
		const saved = process.env.NAN_API_KEY;
		delete process.env.NAN_API_KEY;
		try {
			const runtime = await ModelRuntime.create({ authPath, modelsPath: join(dir, "models.json") });
			await run(runtime, authPath);
		} finally {
			if (saved === undefined) delete process.env.NAN_API_KEY;
			else process.env.NAN_API_KEY = saved;
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

function secretInteraction(value: string) {
	const prompts: string[] = [];
	return {
		prompts,
		interaction: {
			signal: new AbortController().signal,
			notify() {},
			async prompt(p: { type: string }) {
				prompts.push(p.type);
				return value;
			},
		},
	};
}

test("getProviderConfigs lists the providers gentle-pi registers, starting with NaN", () => {
	assert.deepEqual(getProviderConfigs().map((provider) => provider.id), ["nan"]);
});

test("a runtime without extensions lists NaN as an unconfigured API-key provider once registered", withRuntime(async (runtime) => {
	assert.equal(runtime.getProviders().some((provider) => provider.id === "nan"), false);
	for (const provider of getProviderConfigs()) runtime.registerNativeProvider(provider);
	const nan = runtime.getProviders().find((provider) => provider.id === "nan");
	assert.ok(nan, "NaN must be listed after registration");
	assert.equal(typeof nan.auth?.apiKey?.login, "function");
	assert.equal(runtime.getProviderAuthStatus("nan").configured, false);
}));

test("signing in to NaN asks for a secret and stores it as /login does", withRuntime(async (runtime, authPath) => {
	for (const provider of getProviderConfigs()) runtime.registerNativeProvider(provider);
	const { prompts, interaction } = secretInteraction("  test-key  ");
	await runtime.login("nan", "api_key", interaction as never);
	assert.deepEqual(prompts, ["secret"]);
	assert.equal(runtime.getProviderAuthStatus("nan").configured, true);
	const stored = JSON.parse(readFileSync(authPath, "utf8"));
	assert.deepEqual(stored.nan, { type: "api_key", key: "test-key" });
}));

test("an empty NaN key is rejected and nothing is stored", withRuntime(async (runtime, authPath) => {
	for (const provider of getProviderConfigs()) runtime.registerNativeProvider(provider);
	const { interaction } = secretInteraction("   ");
	await assert.rejects(runtime.login("nan", "api_key", interaction as never), /NaN requires a non-empty API key/);
	assert.equal(runtime.getProviderAuthStatus("nan").configured, false);
	let stored: Record<string, unknown> = {};
	try {
		stored = JSON.parse(readFileSync(authPath, "utf8"));
	} catch {}
	assert.equal(stored.nan, undefined);
}));
