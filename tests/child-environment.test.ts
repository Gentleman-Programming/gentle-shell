import assert from "node:assert/strict";
import test from "node:test";
import { inheritedSensitiveChildEnvironmentKeys } from "../lib/child-environment.ts";

// Sensitive child environment filtering: a child never inherits credentials
// unless its role declares them in `env_keep`.

/** Credential-shaped names (passwords, secrets, tokens, keys) are removed; the base environment survives. */
test("passwords, secrets, credentials, tokens, and keys are removed", () => {
	const environment = {
		PATH: "C:\\bin",
		HOME: "C:\\home",
		TOKENIZER_PATH: "C:\\tools\\tok",
		AWS_REGION: "us-east-1",
		DB_PASSWORD: "x",
		SQLSERVER_DB_PASSWORD: "x",
		GITHUB_PERSONAL_ACCESS_TOKEN: "x",
		GITHUB_TOKEN: "x",
		AWS_ACCESS_KEY_ID: "x",
		AWS_SECRET_ACCESS_KEY: "x",
		CONTEXT7_API_KEY: "x",
		MY_PRIVATE_KEY: "x",
		CLIENT_CREDENTIALS: "x",
	};
	assert.deepEqual(inheritedSensitiveChildEnvironmentKeys(environment), [
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"CLIENT_CREDENTIALS",
		"CONTEXT7_API_KEY",
		"DB_PASSWORD",
		"GITHUB_PERSONAL_ACCESS_TOKEN",
		"GITHUB_TOKEN",
		"MY_PRIVATE_KEY",
		"SQLSERVER_DB_PASSWORD",
	]);
});

/** Fragment matches inside longer words (TOKENIZER_PATH, SECRETARY_NAME) are not filtered. */
test("fragment matches inside longer words are not filtered", () => {
	const environment = { SECRETARY_NAME: "x", TOKENIZER_PATH: "x", COMPASS: "x" };
	assert.deepEqual(inheritedSensitiveChildEnvironmentKeys(environment), []);
});

/** Bare credential words (TOKEN, PASSWORD, API_KEY…) are always sensitive. */
test("exact credential words are always sensitive", () => {
	const environment = {
		TOKEN: "x",
		PASSWORD: "x",
		PASSWD: "x",
		SECRET: "x",
		API_KEY: "x",
		ACCESS_KEY: "x",
		PRIVATE_KEY: "x",
		SECRET_KEY: "x",
		CREDENTIALS: "x",
	};
	assert.deepEqual(inheritedSensitiveChildEnvironmentKeys(environment), [
		"ACCESS_KEY",
		"API_KEY",
		"CREDENTIALS",
		"PASSWD",
		"PASSWORD",
		"PRIVATE_KEY",
		"SECRET",
		"SECRET_KEY",
		"TOKEN",
	]);
});

/** Live credential channels (SSH agent socket, Docker auth) and credential-bearing database URLs are filtered; other generic URLs are not. */
test("live credential channels and credential-bearing database URLs are filtered, without broadening to other generic URLs", () => {
	const environment = {
		SSH_AUTH_SOCK: "x",
		DOCKER_AUTH_CONFIG: "x",
		DATABASE_URL: "x",
		NPM_CONFIG_REGISTRY: "x",
	};
	assert.deepEqual(inheritedSensitiveChildEnvironmentKeys(environment), [
		"DATABASE_URL",
		"DOCKER_AUTH_CONFIG",
		"SSH_AUTH_SOCK",
	]);
});

/** `env_keep` rescues declared names case-insensitively — including a filtered DATABASE_URL — and only those. */
test("env_keep rescues declared keys, case-insensitively, and only those", () => {
	const environment = {
		DB_SERVER: "x",
		SQLSERVER_DB_PASSWORD: "x",
		DATABASE_URL: "x",
		GITHUB_PERSONAL_ACCESS_TOKEN: "x",
	};
	assert.deepEqual(
		inheritedSensitiveChildEnvironmentKeys(environment, ["sqlserver_db_password", "DB_SERVER", "DATABASE_URL"]),
		["GITHUB_PERSONAL_ACCESS_TOKEN"],
	);
});

/** The filter is pure: the parent environment object is never mutated. */
test("filtering is pure: the parent environment object is never mutated", () => {
	const environment = { PATH: "x", DB_PASSWORD: "x" };
	const before = { ...environment };
	inheritedSensitiveChildEnvironmentKeys(environment);
	assert.deepEqual(environment, before);
});
