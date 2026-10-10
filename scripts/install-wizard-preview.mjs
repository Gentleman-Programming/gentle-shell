#!/usr/bin/env node
// Development preview for the browser installation wizard.
//
// Starts the REAL local host (createInstallerServer) with the real assets, but
// with fake inventories and a fake runner: it never runs host probes, package
// managers, downloads or installs. Use it to develop and visually check the UI:
//
//   node scripts/install-wizard-preview.mjs --scenario=terminal --step-ms=600
//
// Then open the printed one-time session URL. Not part of the installer entry.

import { fileURLToPath, pathToFileURL } from "node:url";
import { planPreflight, requirements } from "./installer-preflight.mjs";
import { createInstallerServer } from "./installer-server.mjs";

const BIN = "/home/you/.local/share/pnpm/bin";
const baseInventory = Object.freeze({
	platform: "linux",
	arch: "x64",
	node: { available: true, version: "24.21.0", usable: true, persistent: true, npm: true },
	pnpm: { available: true, version: "11.1.1", usable: true, compatible: true, persistent: true },
	pi: { available: false },
	shell: { available: false },
	gentleAi: { available: false },
	go: { available: false },
	globalBin: { available: true, path: BIN, writable: true, onPath: true },
	setup: false,
});
// A machine that only has the bootstrap's temporary Node and pnpm, with no pnpm bin on PATH.
const freshInventory = Object.freeze({
	...baseInventory,
	node: { available: true, version: "24.21.0", usable: true, persistent: false, npm: false },
	pnpm: { available: true, version: "11.1.1", usable: true, compatible: true, persistent: false },
	globalBin: { ...baseInventory.globalBin, onPath: false },
});
// An earlier run installed the pinned stack, but its setup and `pnpm setup` did not finish.
const recoveryInventory = Object.freeze({
	...baseInventory,
	pi: { available: true, version: "1.0.0", usable: true },
	shell: { available: true, version: requirements.shell, usable: true, global: true },
	gentleAi: { available: true, version: requirements.gentleAi, usable: true, compatible: true },
	globalBin: { ...baseInventory.globalBin, onPath: false },
	setup: { available: true, recoverable: true },
});
const checks = ["check-npm", "check-global-bin", "check-existing-stack"];
const install = ["install-global", "verify-global-list", "verify-shell-bin", "verify-gentle-ai", "shell-setup"];
const persistence = ["persist-node", "persist-package-managers", "verify-persistent-runtime", "check-npm", "configure-npm-prefix"];

// Each scenario mirrors the runner's fixed step order for its plan.
const scenarios = Object.freeze({
	ready: { inventories: [baseInventory], steps: [...checks, ...install], result: { outcome: "ready" } },
	terminal: {
		inventories: [freshInventory],
		steps: ["check-global-bin", "check-existing-stack", ...persistence, ...install, "persist-path"],
		result: { outcome: "terminal-action-required", action: "open-new-terminal", npmPrefix: "configured" },
	},
	blocked: {
		inventories: [baseInventory],
		steps: ["check-npm", "check-global-bin"],
		result: { outcome: "blocked", reason: "existing-stack" },
	},
	failed: {
		inventories: [freshInventory],
		steps: ["check-global-bin", "check-existing-stack", ...persistence],
		result: { outcome: "failed", failedStep: "install-global" },
	},
	// The first plan goes stale before install (the PATH was fixed meanwhile): the host
	// answers 409 plan-changed and the wizard must show the new plan and ask again.
	"plan-changed": { inventories: [freshInventory, baseInventory], steps: [...checks, ...install], result: { outcome: "ready" } },
	recovery: {
		inventories: [recoveryInventory],
		steps: ["check-npm", "check-global-bin", "check-recoverable-stack", ...install.slice(1), "persist-path"],
		result: { outcome: "terminal-action-required", action: "open-new-terminal" },
	},
	preflight: {
		inventories: [{ ...baseInventory, node: { available: true, version: "18.20.0", usable: true, persistent: true, npm: true },
			gentleAi: { available: true, version: "1.0.0", usable: true, compatible: false } }],
		steps: [],
		result: { outcome: "blocked", reason: "preflight-blocked" },
	},
});
export const scenarioNames = Object.freeze(Object.keys(scenarios));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fake collectPlan/runInstall for a scenario; nothing touches the machine. */
export function previewScenario(name, { stepMs = 600 } = {}) {
	const scenario = scenarios[name];
	if (!scenario) throw new Error(`Unknown scenario "${name}". Use one of: ${scenarioNames.join(", ")}`);
	let collected = 0;
	return {
		collectPlan: async () => {
			const inventory = structuredClone(scenario.inventories[Math.min(collected, scenario.inventories.length - 1)]);
			collected += 1;
			await sleep(Math.min(stepMs, 400));
			return { inventory, plan: planPreflight(inventory) };
		},
		runInstall: async (_request, log) => {
			const completed = [];
			for (const step of scenario.steps) {
				await sleep(stepMs);
				completed.push(step);
				log({ step, status: "done" });
			}
			await sleep(stepMs);
			const { result } = scenario;
			if (result.outcome === "blocked") log({ step: "gate", status: "blocked", reason: result.reason });
			if (result.outcome === "failed") log({ step: result.failedStep, status: "failed" });
			return { ...result, completed };
		},
	};
}

/** Starts the real host on 127.0.0.1 with a fake scenario. Returns { host, url }. */
export async function startPreview({ scenario = "ready", stepMs = 600, log = console.log } = {}) {
	const fake = previewScenario(scenario, { stepMs });
	const host = createInstallerServer({
		assetsDir: fileURLToPath(new URL("../assets/install-wizard/", import.meta.url)),
		collectPlan: fake.collectPlan,
		runInstall: fake.runInstall,
	});
	const { url } = await host.listen();
	log(`Gentle Shell wizard preview (scenario: ${scenario}). Fake plan and fake installer: nothing is installed.`);
	log(`Open this one-time link (expires in 2 minutes):\n  ${url}`);
	return { host, url };
}

function option(args, name, fallback) {
	const found = args.find((arg) => arg.startsWith(`--${name}=`));
	return found === undefined ? fallback : found.slice(name.length + 3);
}

async function main(args) {
	if (args.includes("--help")) {
		console.log(`Usage: node scripts/install-wizard-preview.mjs [--scenario=${scenarioNames.join("|")}] [--step-ms=600]`);
		return;
	}
	const scenario = option(args, "scenario", "ready");
	const stepMs = Number(option(args, "step-ms", "600"));
	if (!scenarioNames.includes(scenario) || !Number.isFinite(stepMs) || stepMs < 0) {
		console.error(`Use --scenario=${scenarioNames.join("|")} and a non-negative --step-ms.`);
		process.exitCode = 2;
		return;
	}
	const { host } = await startPreview({ scenario, stepMs });
	process.once("SIGINT", () => host.close("signal"));
	process.once("SIGTERM", () => host.close("signal"));
	const { reason, outcome } = await host.closed;
	console.log(`Preview closed (${reason}); last outcome: ${outcome?.outcome ?? "none"}.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main(process.argv.slice(2));
}
