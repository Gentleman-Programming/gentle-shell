import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

// Reuse Pi's existing YAML dependency without adding a package dependency.
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { parseDocument } = piRequire("yaml");
const formUrl = new URL("../.github/ISSUE_TEMPLATE/feature_request.yml", import.meta.url);

function readForm() {
	const document = parseDocument(readFileSync(formUrl, "utf8"), { uniqueKeys: true });
	assert.deepEqual(document.errors, [], "the issue form must be valid, unambiguous YAML");
	return document.toJS();
}

test("feature request form has supported structure and only intake labels", () => {
	const form = readForm();
	assert.deepEqual(Object.keys(form).sort(), ["body", "description", "labels", "name"]);
	assert.equal(form.name, "Feature Request");
	assert.equal(typeof form.description, "string");
	assert.ok(form.description.trim().length > 0);
	// Exact allowlist also rejects approval, exception, and other privileged labels.
	assert.deepEqual(form.labels, ["enhancement", "status:needs-review"]);
	assert.ok(Array.isArray(form.body));
	assert.deepEqual(form.body.map((field) => field.id), [
		"preflight", "problem", "outcome", "alternatives", "context",
	]);
	for (const field of form.body) {
		assert.ok(["checkboxes", "textarea"].includes(field.type));
		assert.match(field.id, /^[a-zA-Z0-9_-]+$/);
		assert.equal(typeof field.attributes.label, "string");
		assert.ok(field.attributes.label.trim().length > 0);
		assert.deepEqual(Object.keys(field).sort(), field.type === "checkboxes"
			? ["attributes", "id", "type"]
			: ["attributes", "id", "type", "validations"]);
	}
});

test("duplicate and privacy affirmations are individually required", () => {
	const [preflight] = readForm().body;
	assert.equal(preflight.type, "checkboxes");
	assert.deepEqual(preflight.attributes.options, [
		{
			label: "I searched open and closed issues and did not find a request for this feature.",
			required: true,
		},
		{
			label: "I reviewed this request and removed credentials, tokens, private paths, hostnames, and other sensitive data.",
			required: true,
		},
	]);
});

test("feature questions require problem and outcome but keep alternatives and context optional", () => {
	const questions = readForm().body.slice(1);
	assert.deepEqual(questions.map((field) => ({
		type: field.type,
		label: field.attributes.label,
		validations: field.validations,
	})), [
		{ type: "textarea", label: "Problem or opportunity", validations: { required: true } },
		{ type: "textarea", label: "Proposed outcome", validations: { required: true } },
		{ type: "textarea", label: "Alternatives considered", validations: { required: false } },
		{ type: "textarea", label: "Additional context", validations: { required: false } },
	]);
});
