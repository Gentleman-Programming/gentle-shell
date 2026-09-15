import { consumeReviewMutation, pendingReviewMutation, recordReviewMutation } from "../lib/review-reminder-receipt.ts";
import { resolveSessionWorktree } from "../lib/session-worktree-registry.ts";
import { resolveResearchCapabilities, renderResearchCapabilities } from "../lib/sdd-research-capabilities.ts";
import { declareReviewRelayHandshake } from "../lib/review-relay-contract.ts";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {
	access,
	mkdir,
	readFile,
	readdir,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ThemeColor,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { Key, isKeyRelease, matchesKey, truncateToWidth, type KeybindingsManager, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { resolveGentlePiAgentHome } from "../lib/agent-home.ts";
import {
	ensureSddPreflight,
	getSddPreflightPreferences,
	installPackageAssets,
	getPackageAssetOwner,
	hasPackageAssetOwnerInstallation,
	type PackageAssetOwner,
	isPackageManagedSddAsset,
	isSddPreflightTrigger,
	renderSddPreflightPrompt,
	isParentConfirmedSddPreflightContext,
	SHIPPED_SDD_AGENT_NAMES,
	SDD_PREFLIGHT_FIELDS,
	type SddPreflightField,
	type SddPreflightPreferences,
	updatePackageManagedSddAgentOwnership,
} from "../lib/sdd-preflight.ts";
import {
	THINKING_LEVELS,
	normalizeModelConfig,
	normalizeModelId,
	normalizeRoutingEntry,
	readSavedModelConfig as readModelRoutingAuthority,
	readSavedModelConfigAsync as readModelRoutingAuthorityAsync,
	type AgentModelConfig,
	type AgentRoutingEntry,
	type ModelConfigFileResult,
	type ThinkingLevel,
} from "../lib/model-routing-authority.ts";
import {
	bootstrapProfilesFile,
	buildProfileListItems,
	createProfile,
	deleteProfile,
	duplicateProfile,
	formatOrchestratorSelection,
	formatRoutingRow,
	isProfileOrchestratorKey,
	parseProfileExportTextWithDrops,
	PROFILE_ORCHESTRATOR_KEY,
	profileExportPath,
	profileRoutingRows,
	profilesFilePath,
	readProfileOrchestrator,
	readProfilesFileResult,
	renameProfile,
	routingColumnWidths,
	serializeProfileExport,
	setActiveProfile,
	updateProfile,
	writeProfilesFileSync,
	type AgentProfilesFile,
	type ProfileListItem,
	type ProfileRoutingRow,
	type ProfilesParseDrops,
} from "../lib/agent-profiles.ts";
import {
	applyOrchestratorSettings,
	readOrchestratorSettings,
	restoreOrchestratorSettings,
	type OrchestratorSettingsReadResult,
} from "../lib/profiles-orchestrator.ts";
import { measureAgentsViewLayout, type AgentsViewLayout } from "../lib/agents-view-layout.ts";
import { NativeChoiceList } from "../lib/native-choice-list.ts";
import { createNativeFullscreenInteraction } from "../lib/native-fullscreen-interaction.ts";
import {
	parseSddStatusCommandArgs,
	renderNativeSddPhasePrompt,
	type SddPhase,
} from "../lib/sdd-status.ts";
import {
	REVIEW_HOST_RELAY_FAILURE,
	REVIEW_HOST_RELAY_PI_TIMEOUT_ENV,
	REVIEW_HOST_RELAY_PI_TIMEOUT_MAX_MS,
	REVIEW_HOST_RELAY_SUBMISSION_MISSING_MESSAGE,
	REVIEW_HOST_RELAY_UNAVAILABLE_MESSAGE,
	ReviewHostRelayError,
	reviewHostRelaySlots,
	reviewHostRelayUnachievableDetail,
	reviewHostRelayUnachievableReason,
	reviewProviderRoleVectorSlots,
	resolveReviewHostRelaySubmission,
	runReviewHostRelayReviewerGroup,
	runReviewHostRelaySlot,
	submitReviewHostRelayPreparedResult,
	type ReviewHostRelayPreparedResult,
	type ReviewHostRelayRequest,
	type ReviewHostRelayRunner,
	type ReviewHostRelaySlot,
	type ReviewProviderRoleVectorSlot,
} from "../lib/review-host-relay.ts";
import {
	JOURNAL_STATUS,
	REVIEW_OPERATION,
	REVIEW_TRANSITION,
	ReviewTransactionStore,
	canonicalHash,
	createReviewState,
	type ReviewBudgetV1,
	type ReviewReducerInput,
	type StartOperationResultV1,
	type ReviewTransition,
} from "../lib/review-transaction.ts";
import {
	REVIEW_MODE,
	REVIEW_PROJECTION,
	captureReviewSnapshot,
	type ReviewMode,
	type ReviewProjectionV1,
} from "../lib/review-snapshot.ts";
import { renderGentleAiLifecycleCall, renderGentleAiResult, type GentleAiRenderContext } from "../lib/gentle-ai-renderer.ts";
import { sanitizeTerminalText, stripAnsi } from "../lib/terminal-theme.ts";
import { CandidateViewError, CandidateViewRegistry, injectReviewCandidateView, readCandidateContextManifestPage, resolveCanonicalCandidateBase, type CandidateView } from "../lib/review-candidate-view.ts";
import {
	GentleAiDevBinaryOverrideError,
	GENTLE_AI_INSTALL_RECOVERY_COMMAND,
	GENTLE_AI_INSTALL_RECOVERY_INSTRUCTIONS,
	registerGentleAiDevBinary,
	resolveGentleAiBinary,
	resolveGentleAiDevBinaryOverride,
	unregisterGentleAiDevBinary,
	type GentleAiDevBinaryOverride,
} from "../lib/gentle-ai-binary.ts";
import {
	spawnTelemetryTrigger,
	type TelemetryTriggerSpawn,
} from "../lib/telemetry-trigger.ts";
import {
	createNativeReviewCli,
	createNodeExecFileAdapter,
	decodeNativeSddStatusV2,
	isCanonicalProcessString,
	isNativeReviewUnachievableVerbRefused,
	nativeReviewAbandonAuthorization,
	nativeReviewLegacyAliasRepairAuthorization,
	nativeReviewLegacyQuarantineAuthorization,
	nativeReviewReconcileAuthorization,
	nativeReviewRecoverAuthorization,
	normalizeNativeReviewCwd,
	NativeReviewCliError,
	NativeReviewConsentBindingError,
	NativeReviewConsentRequiredError,
	NativeReviewIntegrationError,
	NATIVE_REVIEW_ERROR_CODE,
	NATIVE_REVIEW_OPERATION,
	NATIVE_REVIEW_LEGACY_QUARANTINE,
	NATIVE_REVIEW_LEGACY_ALIAS_REPAIR,
	NATIVE_REVIEW_MODE_OPERATION,
	NATIVE_REVIEW_MODE_SOURCE,
	NATIVE_REVIEW_RECONCILE_ANOMALIES,
	sanitizeForeignNativeReviewDiagnostics,
	type NativeReviewCli,
	type NativeSddStatusV2,
	type NativeIntendedUntrackedSelectionSubmission,
	type NativeReviewAcknowledgeApprovedOutcome,
	type NativeReviewAcknowledgeApprovedRequest,
	type NativeTargetStatusRequest,
	type NativeReviewModeOperation,
	type NativeReviewModeSource,
	type NativeReviewModeStatus,
	type NativeReviewProcessDiagnostics,
	type NativeReviewUnachievableLensCaptureArtifact,
	type NativeStartResult,
	type NativeReviewAssessRequest,
	type ExecFileAdapter,
	type ExecFileResult,
} from "../lib/native-review-cli.ts";
import {
	verificationPlan,
	resolveWriterProfile,
	RDD_LINE,
	VERIFICATION_TIER,
	NATIVE_REVIEW_OUTCOME,
	type RddLine,
	type VerificationTier,
	type ReviewAssessmentV1,
	type NativeReviewOutcome,
} from "../lib/review-risk-assessment.ts";
import {
	assertReviewApprovedAcknowledgementExecuteV1,
	decodeReviewLastEventClosureV1,
	type ReviewCollectInputV3,
	type ReviewConsentEnvelope,
	type ReviewLastEventClosureBinding,
	type ReviewLastEventClosureV1,
	type ReviewStatusV3,
} from "../lib/review-integration-v2.ts";
import { reconcileUnknownReviewLastEventCapture } from "../lib/review-last-event-controller.ts";
import { acquireChildStandingReviewPermissionClient, type ChildStandingReviewPermissionClient } from "../lib/review-session-standing-permission-ipc.ts";
import { isPiConsentV3, presentReviewConsentUi } from "../lib/review-consent-ui.ts";
import {
	captureReviewSessionIdentity,
	grantReviewSessionPermission,
	hasReviewSessionPermission,
	resolveCanonicalGitRepositoryIdentity,
	revokeReviewSessionPermission,
	reviewSessionPermissionEpoch,
	revokeReviewSessionPermissionsForSession,
	sameReviewSessionIdentity,
	type ReviewSessionIdentity,
} from "../lib/review-session-standing-permission.ts";

const GRAPH_V1_ORDINARY_READ_ONLY = "Graph-v1 ordinary review authority is read-only; use native compact-v2 review operations";
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ASSETS_DIR = join(PACKAGE_ROOT, "assets");

function gentlePiAgentHome(): string {
	return resolveGentlePiAgentHome();
}

function packageAssetAudit(owner: PackageAssetOwner): { stale: number; overrides: number } {
	let stale = 0;
	let overrides = 0;
	for (const [assetSubdir, installedSubdir, ownershipPrefix] of [
		["agents", "agents", "agents"],
		["chains", "chains", "chains"],
		["support", join("gentle-ai", "support"), "gentle-ai/support"],
	] as const) {
		const assetDir = join(ASSETS_DIR, assetSubdir);
		if (!existsSync(assetDir)) continue;
		for (const entry of readdirSync(assetDir, { withFileTypes: true })) {
			if (!entry.isFile() || getPackageAssetOwner(`${ownershipPrefix}/${entry.name}`) !== owner) continue;
			const installedPath = join(gentlePiAgentHome(), installedSubdir, entry.name);
			try {
				if (!existsSync(installedPath)) {
					stale += 1;
					continue;
				}
				if (
					!isPackageManagedSddAsset(
						installedPath,
						`${ownershipPrefix}/${entry.name}`,
					)
				) {
					overrides += 1;
					continue;
				}
				const packaged = readFileSync(join(assetDir, entry.name), "utf8");
				const installed = readFileSync(installedPath, "utf8");
				const comparablePackaged =
					assetSubdir === "agents"
						? updateFrontmatterRouting(packaged, undefined)
						: packaged;
				const comparableInstalled =
					assetSubdir === "agents"
						? updateFrontmatterRouting(installed, undefined)
						: installed;
				if (comparablePackaged !== comparableInstalled) {
					stale += 1;
				}
			} catch {
				stale += 1;
			}
		}
	}
	return { stale, overrides };
}

function packageAssetDiagnosticLines(cwd: string): string[] {
	return (["delegation", "review", "sdd"] as const).flatMap((owner) => {
		const label = owner === "sdd" ? "SDD" : owner;
		const onDemand = owner === "sdd" && !hasPackageAssetOwnerInstallation(owner);
		const { stale, overrides } = packageAssetAudit(owner);
		const local = localAgentOverrideCount(cwd, owner);
		const lines = [onDemand
			? `info: Global ${label} assets: on demand (not installed)`
			: `${stale > 0 ? "warn" : "pass"}: Global ${label} assets stale: ${stale} file(s)`];
		if (!onDemand && stale > 0) {
			lines[0] += ` — run /gentle:install-${owner} --force to refresh managed assets`;
		}
		if (overrides > 0) {
			lines.push(`info: Global ${label} user overrides: ${overrides} file(s); preserved, not package drift`);
		}
		if (local > 0) {
			lines.push(`warn: Active ${label} agent overrides: ${local} file(s) — active non-builtin ${label} agents shadow package assets; keep only intentional overrides`);
		}
		return lines;
	});
}

function localAgentOverrideCount(cwd: string, owner: PackageAssetOwner): number {
	const packageSddAgentsDir = join(ASSETS_DIR, "agents");
	const packageSddAgentNames = new Set(
		listAgentsFromDir(packageSddAgentsDir, "builtin")
			.filter((agent) =>
				getPackageAssetOwner(
					`agents/${relative(packageSddAgentsDir, agent.filePath).split(sep).join("/")}`,
				) === owner,
			)
			.map((agent) => agent.name),
	);
	let count = 0;
	for (const { dir, source, packageManaged } of discoverableNonBuiltinAgentRoots(cwd)) {
		if (packageManaged || !existsSync(dir)) continue;
		for (const agent of listAgentsFromDir(dir, source)) {
			if (packageSddAgentNames.has(agent.name)) count += 1;
		}
	}
	return count;
}

// ---------------------------------------------------------------------------
// Background subagents policy — project > global > env > default off
// ---------------------------------------------------------------------------

type BackgroundSubagentsPolicy = "on" | "off";
type BackgroundSubagentsCapability = "ready" | "absent";

interface BackgroundSubagentsRendering {
	policy: BackgroundSubagentsPolicy;
	capability: BackgroundSubagentsCapability;
}

/** Which of the four sources decided the effective policy. */
type BackgroundSubagentsSource =
	| "project_file"
	| "global_file"
	| "environment"
	| "default";

interface BackgroundSubagentsResolution {
	policy: BackgroundSubagentsPolicy;
	source: BackgroundSubagentsSource;
	/** The deciding file was present but failed the strict decode. */
	malformed: boolean;
	projectFile: string;
	globalFile: string;
	projectFileExists: boolean;
	globalFileExists: boolean;
	/** The raw env value, reported even when it is unrecognized and inert. */
	envValue: string | undefined;
}

interface LoadBackgroundSubagentsOptions {
	/** Override the config home directory (used in tests to avoid touching ~/.pi). */
	gentlePiConfigHome?: string;
	/** Override the environment lookup (used in tests). */
	env?: Record<string, string | undefined>;
}

const BACKGROUND_SUBAGENTS_SCHEMA = "gentle-pi.background-subagents/v1";
const BACKGROUND_SUBAGENTS_FILE = "background-subagents.json";

const DEFAULT_BACKGROUND_SUBAGENTS_RENDERING: BackgroundSubagentsRendering = {
	policy: "off",
	capability: "absent",
};

/**
 * Strict decode of {"schema":"gentle-pi.background-subagents/v1","policy":"on"|"off"}.
 * Any malformed shape (bad JSON, wrong schema, unknown keys, invalid policy)
 * returns undefined so the caller fails closed to "off".
 */
function parseBackgroundSubagentsPolicyFile(
	raw: string,
): BackgroundSubagentsPolicy | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	if (parsed.schema !== BACKGROUND_SUBAGENTS_SCHEMA) return undefined;
	if (parsed.policy !== "on" && parsed.policy !== "off") return undefined;
	if (Object.keys(parsed).length !== 2) return undefined;
	return parsed.policy;
}

/**
 * Resolve the background-subagents policy AND the source that decided it.
 *
 * Resolution order (first hit wins, mirroring loadRuntimeGuardrailsConfig):
 *   1. Project file `${cwd}/.pi/gentle-ai/background-subagents.json`
 *   2. Global file `${configHome}/background-subagents.json`
 *      (configHome honors GENTLE_PI_CONFIG_HOME, default ~/.pi/gentle-ai)
 *   3. Env var GENTLE_PI_BACKGROUND_SUBAGENTS ("on" | "off")
 *   4. Default "off"
 *
 * A present-but-malformed file fails closed to "off" instead of falling
 * through to a lower-priority source, and it stays attributed to that file:
 * "off decided by a broken project file" and "off by default" are different
 * situations, and only the first one is a mistake to fix.
 *
 * Four sources with first-hit-wins is exactly the shape that makes an edit
 * look like it did nothing, so the deciding source is part of the result
 * rather than something a caller has to re-derive.
 */
function resolveBackgroundSubagentsPolicy(
	cwd: string,
	options: LoadBackgroundSubagentsOptions = {},
): BackgroundSubagentsResolution {
	const env = options.env ?? process.env;
	const envValue = env.GENTLE_PI_BACKGROUND_SUBAGENTS;
	let projectFile = "";
	let globalFile = "";
	try {
		const configHome = options.gentlePiConfigHome ?? gentleAiConfigHome();
		projectFile = join(cwd, ".pi", "gentle-ai", BACKGROUND_SUBAGENTS_FILE);
		globalFile = join(configHome, BACKGROUND_SUBAGENTS_FILE);
		const projectFileExists = existsSync(projectFile);
		const globalFileExists = existsSync(globalFile);
		const locations = { projectFile, globalFile, projectFileExists, globalFileExists, envValue };
		for (const [source, path, present] of [
			["project_file", projectFile, projectFileExists],
			["global_file", globalFile, globalFileExists],
		] as const) {
			if (!present) continue;
			let decoded: BackgroundSubagentsPolicy | undefined;
			try {
				decoded = parseBackgroundSubagentsPolicyFile(readFileSync(path, "utf8"));
			} catch {
				// Unreadable is indistinguishable from unusable at this layer, and
				// both must fail closed on the file that claimed the decision.
				decoded = undefined;
			}
			return decoded === undefined
				? { policy: "off", source, malformed: true, ...locations }
				: { policy: decoded, source, malformed: false, ...locations };
		}
		if (envValue === "on" || envValue === "off") {
			return { policy: envValue, source: "environment", malformed: false, ...locations };
		}
		return { policy: "off", source: "default", malformed: false, ...locations };
	} catch {
		return {
			policy: "off",
			source: "default",
			malformed: false,
			projectFile,
			globalFile,
			projectFileExists: false,
			globalFileExists: false,
			envValue,
		};
	}
}

/**
 * The effective policy alone, for callers that do not report a source.
 * It delegates so the loader and the resolver can never disagree.
 */
function loadBackgroundSubagentsPolicy(
	cwd: string,
	options: LoadBackgroundSubagentsOptions = {},
): BackgroundSubagentsPolicy {
	return resolveBackgroundSubagentsPolicy(cwd, options).policy;
}

/** Write the global policy file, creating the config home when needed. */
function writeGlobalBackgroundSubagentsPolicy(
	policy: BackgroundSubagentsPolicy,
	configHome: string = gentleAiConfigHome(),
): string {
	const path = join(configHome, BACKGROUND_SUBAGENTS_FILE);
	mkdirSync(configHome, { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify({ schema: BACKGROUND_SUBAGENTS_SCHEMA, policy }, null, 2)}\n`,
	);
	return path;
}

function describeBackgroundSubagentsSource(
	resolution: BackgroundSubagentsResolution,
): string {
	switch (resolution.source) {
		case "project_file":
			return `project file ${resolution.projectFile}`;
		case "global_file":
			return `global file ${resolution.globalFile}`;
		case "environment":
			return "GENTLE_PI_BACKGROUND_SUBAGENTS";
		default:
			return "built-in default";
	}
}

/**
 * Report the effective policy, the source that decided it, and the resolved
 * capability, plus whatever the user needs to know about the sources that did
 * NOT decide. `wrote` names a policy this invocation just wrote to the global
 * file; a write that a higher-priority file outranks must never be reported as
 * if it had taken effect.
 */
function renderBackgroundSubagentsReport(
	resolution: BackgroundSubagentsResolution,
	capability: BackgroundSubagentsCapability,
	wrote?: BackgroundSubagentsPolicy,
): { message: string; type: "info" | "warning" } {
	const lines = [
		`background subagents: ${resolution.policy} (decided by ${describeBackgroundSubagentsSource(resolution)}; capability: ${capability})`,
	];
	if (wrote !== undefined) {
		lines.push(`Wrote ${wrote} to the global file ${resolution.globalFile}.`);
	}
	if (resolution.malformed) {
		const path =
			resolution.source === "project_file" ? resolution.projectFile : resolution.globalFile;
		lines.push(
			`${path} is present but malformed, so the policy fails closed to off and no lower-priority source is consulted.`,
		);
	}
	const outranksTheWrite = wrote !== undefined && resolution.source === "project_file";
	if (outranksTheWrite) {
		lines.push(
			`That global write does not take effect here: the project file ${resolution.projectFile} outranks it. Edit or remove that project file to let the global setting decide.`,
		);
	} else if (
		wrote === undefined &&
		resolution.source === "project_file" &&
		resolution.globalFileExists
	) {
		lines.push(
			`The global file ${resolution.globalFile} exists but is outranked by that project file.`,
		);
	}
	if (resolution.envValue !== undefined && resolution.source !== "environment") {
		lines.push(
			resolution.envValue === "on" || resolution.envValue === "off"
				? `GENTLE_PI_BACKGROUND_SUBAGENTS=${resolution.envValue} is set, but both files outrank it and it outranks the built-in default; it decides only when neither file exists.`
				: `GENTLE_PI_BACKGROUND_SUBAGENTS="${resolution.envValue}" is not a recognized value ("on" or "off"), so it is ignored.`,
		);
	}
	lines.push(
		"Resolution order (first hit wins): project file, global file, GENTLE_PI_BACKGROUND_SUBAGENTS, built-in default off.",
	);
	return {
		message: lines.join("\n"),
		type: resolution.malformed || outranksTheWrite ? "warning" : "info",
	};
}

const SUBAGENTS_PACKAGE_NAMES = ["pi-subagents-j0k3r", "pi-subagents"] as const;
const SUBAGENT_RUN_TOOL = "subagent_run";
const JUDGMENT_DAY_FIX_AGENT_NAME = "jd-fix-agent";
const BOUNDED_WRITER_AGENT_NAMES = ["gentle-ai-worker", "worker", JUDGMENT_DAY_FIX_AGENT_NAME] as const;
const JUDGMENT_DAY_ACTIVATION_HEADING = "## Judgment Day activation";
const JUDGMENT_DAY_ACTIVATION_SENTENCE = "User explicitly requested Judgment Day.";
const JUDGMENT_DAY_AUTHORIZED_SEVERE_IDS_HEADING = "## Exact authorized severe IDs";
const JUDGMENT_DAY_CORRECTION_BATCH_HEADING = "## Judgment Day correction batch";
const JUDGMENT_DAY_FROZEN_FINDING_ROWS_HEADING = "## Exact frozen finding rows";
const ALLOWED_EDIT_SURFACES_HEADING = /^## Allowed edit surfaces[ \t]*$/gim;
const MARKDOWN_HEADING_LINE = /^ {0,3}#{1,6} /;
const MARKDOWN_LIST_MARKER = /^(?:[-*+]|\d+[.)]) +/;
const WRITER_EDIT_SURFACE_REJECTION =
	"Writer tasks must include the exact Markdown heading `## Allowed edit surfaces` with narrow repository-relative paths or narrow globs, one per line. Every non-empty line belongs to the section until the next canonical Markdown heading and must be a valid surface entry. Paths containing whitespace require whole-entry backticks; begin explanatory prose under the next Markdown heading. The parent must derive or map that canonical block from the delegated task and relaunch the writer; do not accept aliases, and do not ask the human to author paths or globs.";

function isTaskScopedRepositoryRelativePath(value: string, isWholeEntryBackticked: boolean): boolean {
	const normalized = value.replace(/\\/g, "/");
	if (
		normalized.length === 0 ||
		isAbsolute(value) ||
		/^(?:[A-Za-z]:|\/|~)/.test(normalized) ||
		/\p{Cc}|\p{Zl}|\p{Zp}/u.test(normalized) ||
		(/\p{White_Space}/u.test(normalized) && !isWholeEntryBackticked)
	) {
		return false;
	}

	const withoutCurrentDirectory = normalized.replace(/^(?:\.\/)+/, "");
	if (
		withoutCurrentDirectory.length === 0 ||
		withoutCurrentDirectory === "." ||
		withoutCurrentDirectory.startsWith("/") ||
		withoutCurrentDirectory.split("/").some((segment) => segment === "..")
	) {
		return false;
	}

	return !/[?*\[\]{}]/.test(withoutCurrentDirectory.split("/")[0]);
}

type AllowedEditSurfaceEntry = {
	source: string;
	value: string;
	isWholeEntryBackticked: boolean;
	isValidMarkdownSyntax: boolean;
};

/** Reads one entry and records whether backticks delimit the whole path. */
function readSurfaceEntry(line: string): AllowedEditSurfaceEntry {
	const withoutListMarker = line.replace(MARKDOWN_LIST_MARKER, "");
	const backticked = withoutListMarker.match(/^`([^`]+)`$/);
	return {
		source: line,
		value: backticked?.[1] ?? withoutListMarker,
		isWholeEntryBackticked: backticked !== null,
		isValidMarkdownSyntax:
			!/^(?:[-*+]|\d+[.)])$/.test(line) && (!withoutListMarker.includes("`") || backticked !== null),
	};
}

/**
 * Reads every non-empty line until the next Markdown heading as an edit surface.
 * A prose line cannot terminate this section: it must fail validation instead.
 */
function readAllowedEditSurfaceEntries(following: string): AllowedEditSurfaceEntry[] {
	const lines = following.split(/\r?\n/);
	const headingIndex = lines.findIndex((line) => MARKDOWN_HEADING_LINE.test(line));
	return (headingIndex === -1 ? lines : lines.slice(0, headingIndex))
		.map((line) => line.replace(/ +$/g, ""))
		.filter((line) => line.length > 0)
		.map((line) => readSurfaceEntry(line.replace(/^ {0,3}/, "")));
}

function hasTaskScopedAllowedEditSurfaces(...values: unknown[]): boolean {
	let expectedEntries: string[] | undefined;
	let hasSection = false;

	for (const value of values) {
		if (typeof value !== "string") continue;

		const headings = value.matchAll(ALLOWED_EDIT_SURFACES_HEADING);
		for (const heading of headings) {
			const bodyStart = (heading.index ?? 0) + heading[0].length;
			const entries = readAllowedEditSurfaceEntries(value.slice(bodyStart));
			if (
				entries.length === 0 ||
				!entries.every(
					(entry) =>
						entry.isValidMarkdownSyntax &&
						!/\p{Cc}|\p{Zl}|\p{Zp}/u.test(entry.source) &&
						isTaskScopedRepositoryRelativePath(entry.value, entry.isWholeEntryBackticked),
				)
			) {
				return false;
			}

			const uniqueEntries = [...new Set(entries.map((entry) => entry.value))].sort();
			if (
				expectedEntries &&
				(expectedEntries.length !== uniqueEntries.length ||
					expectedEntries.some((entry, index) => entry !== uniqueEntries[index]))
			) {
				return false;
			}
			expectedEntries = uniqueEntries;
			hasSection = true;
		}
	}

	return hasSection;
}

function sddDispatchAgentName(input: unknown): string | undefined {
	if (!isRecord(input)) return undefined;
	if (typeof input.agent === "string" && SDD_AGENT_NAME_SET.has(input.agent)) return input.agent;
	if (Array.isArray(input.agent) && input.agent.some((agent) => typeof agent === "string" && SDD_AGENT_NAME_SET.has(agent))) {
		return "invalid";
	}
	return undefined;
}

function rejectUnscopedBoundedWriterDispatch(input: unknown): { block: true; reason: string } | undefined {
	if (
		!isRecord(input) ||
		typeof input.agent !== "string" ||
		!(BOUNDED_WRITER_AGENT_NAMES as readonly string[]).includes(input.agent)
	) {
		return undefined;
	}
	if (hasTaskScopedAllowedEditSurfaces(input.task, input.context)) {
		return undefined;
	}
	return { block: true, reason: WRITER_EDIT_SURFACE_REJECTION };
}

function hasJudgmentDayFixAgentReference(input: Record<string, unknown>): boolean {
	return input.agent === JUDGMENT_DAY_FIX_AGENT_NAME ||
		(Array.isArray(input.agent) && input.agent.includes(JUDGMENT_DAY_FIX_AGENT_NAME)) ||
		input.agents === JUDGMENT_DAY_FIX_AGENT_NAME ||
		(Array.isArray(input.agents) && input.agents.includes(JUDGMENT_DAY_FIX_AGENT_NAME));
}

function canonicalJudgmentDaySectionBodies(value: unknown, heading: string): string[][] {
	if (typeof value !== "string") return [];
	const headingPattern = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "gm");
	return [...value.matchAll(headingPattern)].map((match) => {
		const body = value.slice((match.index ?? 0) + match[0].length);
		const nextHeading = body.search(/^ {0,3}#{1,6} /m);
		return body
			.slice(0, nextHeading === -1 ? undefined : nextHeading)
			.split(/\r?\n/)
			.filter((line) => line.length > 0);
	});
}

const JUDGMENT_DAY_SEVERE_ID_ENTRY = /^- `(JD-[A-Z][A-Z0-9]*-\d+)`$/;
const JUDGMENT_DAY_CORRECTION_ROUND_ENTRY = /^Round: [12] of 2\.$/;
const JUDGMENT_DAY_FROZEN_LEDGER_SHA256_ENTRY = /^Frozen ledger SHA-256: `([0-9a-f]{64})`$/;
const JUDGMENT_DAY_FROZEN_ROW_FIELDS = [
	"id",
	"lens",
	"location",
	"severity",
	"status_at_freeze",
	"evidence_class",
	"evidence_claim",
] as const;
const JUDGMENT_DAY_FIX_SECTION_HEADINGS = [
	JUDGMENT_DAY_ACTIVATION_HEADING,
	JUDGMENT_DAY_AUTHORIZED_SEVERE_IDS_HEADING,
	JUDGMENT_DAY_CORRECTION_BATCH_HEADING,
	JUDGMENT_DAY_FROZEN_FINDING_ROWS_HEADING,
	"## Allowed edit surfaces",
] as const;

function canonicalJudgmentDaySevereIds(entries: readonly string[]): string[] | undefined {
	const ids = entries.map((entry) => entry.match(JUDGMENT_DAY_SEVERE_ID_ENTRY)?.[1]);
	return ids.length > 0 && ids.every((id): id is string => id !== undefined) && new Set(ids).size === ids.length
		? ids
		: undefined;
}

function canonicalJudgmentDayCorrectionBatchHash(entries: readonly string[]): string | undefined {
	if (entries.length !== 2 || !JUDGMENT_DAY_CORRECTION_ROUND_ENTRY.test(entries[0]!)) return undefined;
	return entries[1]!.match(JUDGMENT_DAY_FROZEN_LEDGER_SHA256_ENTRY)?.[1];
}

function isNonEmptyJudgmentDayFrozenField(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function parseCanonicalJudgmentDayFrozenRows(
	entries: readonly string[],
	authorizedIds: readonly string[],
): Record<string, unknown>[] | undefined {
	if (entries.length !== authorizedIds.length) return undefined;
	const rows: Record<string, unknown>[] = [];
	const rowIds: string[] = [];
	for (const entry of entries) {
		let row: unknown;
		try {
			row = JSON.parse(entry) as unknown;
		} catch {
			return undefined;
		}
		if (!isRecord(row)) return undefined;
		const keys = Object.keys(row);
		if (keys.length !== JUDGMENT_DAY_FROZEN_ROW_FIELDS.length ||
			!JUDGMENT_DAY_FROZEN_ROW_FIELDS.every((field) => field in row) ||
			!isNonEmptyJudgmentDayFrozenField(row.id) ||
			!JUDGMENT_DAY_SEVERE_ID_ENTRY.test(`- \`${row.id}\``) ||
			row.lens !== "judgment-day" ||
			!isNonEmptyJudgmentDayFrozenField(row.location) ||
			(row.severity !== "BLOCKER" && row.severity !== "CRITICAL") ||
			row.status_at_freeze !== "open" ||
			!isNonEmptyJudgmentDayFrozenField(row.evidence_class) ||
			!isNonEmptyJudgmentDayFrozenField(row.evidence_claim)
		) return undefined;
		rows.push(row);
		rowIds.push(row.id);
	}
	return new Set(rowIds).size === rowIds.length &&
		rowIds.every((id, index) => id === authorizedIds[index])
		? rows
		: undefined;
}

function hasCanonicalJudgmentDayFixSectionOrder(...values: unknown[]): boolean {
	const dispatch = values.filter((value): value is string => typeof value === "string").join("\n");
	let previousPosition = -1;
	for (const heading of JUDGMENT_DAY_FIX_SECTION_HEADINGS) {
		const matches = [...dispatch.matchAll(new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "gm"))];
		if (matches.length !== 1 || (matches[0]!.index ?? -1) <= previousPosition) return false;
		previousPosition = matches[0]!.index ?? -1;
	}
	return true;
}

function hasCanonicalJudgmentDayFixActivation(...values: unknown[]): boolean {
	const hasMalformedHeading = values.some((value) =>
		typeof value === "string" && value.split(/\r?\n/).some((line) => {
			const candidate = line.match(/^ {0,3}#{1,6} (Judgment Day activation|Exact authorized severe IDs|Judgment Day correction batch|Exact frozen finding rows)[ \t]*$/i);
			return candidate !== null &&
				line !== JUDGMENT_DAY_ACTIVATION_HEADING &&
				line !== JUDGMENT_DAY_AUTHORIZED_SEVERE_IDS_HEADING &&
				line !== JUDGMENT_DAY_CORRECTION_BATCH_HEADING &&
				line !== JUDGMENT_DAY_FROZEN_FINDING_ROWS_HEADING;
		}),
	);
	const activationBodies = values.flatMap((value) =>
		canonicalJudgmentDaySectionBodies(value, JUDGMENT_DAY_ACTIVATION_HEADING),
	);
	const severeIdBodies = values.flatMap((value) =>
		canonicalJudgmentDaySectionBodies(value, JUDGMENT_DAY_AUTHORIZED_SEVERE_IDS_HEADING),
	);
	const correctionBatchBodies = values.flatMap((value) =>
		canonicalJudgmentDaySectionBodies(value, JUDGMENT_DAY_CORRECTION_BATCH_HEADING),
	);
	const frozenFindingRowBodies = values.flatMap((value) =>
		canonicalJudgmentDaySectionBodies(value, JUDGMENT_DAY_FROZEN_FINDING_ROWS_HEADING),
	);
	const authorizedIds = severeIdBodies.length === 1
		? canonicalJudgmentDaySevereIds(severeIdBodies[0]!)
		: undefined;
	const correctionBatchHash = correctionBatchBodies.length === 1
		? canonicalJudgmentDayCorrectionBatchHash(correctionBatchBodies[0]!)
		: undefined;
	const frozenFindingRows = authorizedIds !== undefined && frozenFindingRowBodies.length === 1
		? parseCanonicalJudgmentDayFrozenRows(frozenFindingRowBodies[0]!, authorizedIds)
		: undefined;
	return !hasMalformedHeading && hasCanonicalJudgmentDayFixSectionOrder(...values) &&
		activationBodies.length === 1 &&
		activationBodies[0]!.length === 1 &&
		activationBodies[0]![0] === JUDGMENT_DAY_ACTIVATION_SENTENCE &&
		authorizedIds !== undefined && correctionBatchHash !== undefined &&
		frozenFindingRows !== undefined && correctionBatchHash === canonicalHash(frozenFindingRows);
}

const JUDGMENT_DAY_FIX_DISPATCH_REJECTION =
	"Judgment Day fix dispatch requires exactly one `agent: \"jd-fix-agent\"`, one exact `## Judgment Day activation` section containing only `User explicitly requested Judgment Day.`, one non-empty unique canonical `## Exact authorized severe IDs` section, one exact `## Judgment Day correction batch` section with `Round: 1 of 2.` or `Round: 2 of 2.` and the matching canonical lowercase SHA-256 of one exact `## Exact frozen finding rows` section whose BLOCKER/CRITICAL open Judgment Day rows equal the authorized IDs in the same order, and the existing exact `## Allowed edit surfaces` guard. The parent must provide the canonical bounded dispatch; do not infer activation, authorization, or frozen findings.";

function rejectInvalidJudgmentDayFixDispatch(input: unknown): { block: true; reason: string } | undefined {
	if (!isRecord(input) || !hasJudgmentDayFixAgentReference(input)) return undefined;
	if (
		input.agent === JUDGMENT_DAY_FIX_AGENT_NAME &&
		!("agents" in input) &&
		hasCanonicalJudgmentDayFixActivation(input.task, input.context) &&
		hasTaskScopedAllowedEditSurfaces(input.task, input.context)
	) {
		return undefined;
	}
	return { block: true, reason: JUDGMENT_DAY_FIX_DISPATCH_REJECTION };
}

/**
 * Roots where an installed subagents package may live. These are the same
 * roots builtinAgentDirs() walks, minus its `/agents` suffix.
 *
 * builtinAgentDirs() looks for markdown agent definitions, which the package
 * legitimately may not ship. Capability is a different question, so it must
 * not reuse that path: pi-subagents-j0k3r v1.5.2 ships index.ts, src/, skills/
 * and scripts/ and no agents/ directory at all, so an agents-dir probe reports
 * "absent" on every real install and leaves the background policy inert.
 */
function subagentsPackageRoots(cwd: string): string[] {
	return SUBAGENTS_PACKAGE_NAMES.flatMap((packageName) => [
		join(PACKAGE_ROOT, "..", packageName),
		join(cwd, ".pi", "npm", "node_modules", packageName),
		join(homedir(), ".local", "lib", "node_modules", packageName),
	]);
}

/** A package root counts as installed only when it carries its own manifest. */
function hasInstalledSubagentsPackage(cwd: string): boolean {
	return subagentsPackageRoots(cwd).some((root) =>
		existsSync(join(root, "package.json")),
	);
}

function hasSubagentRunTool(activeTools: readonly string[]): boolean {
	return activeTools.some(
		(name) => name === SUBAGENT_RUN_TOOL || name.endsWith(`.${SUBAGENT_RUN_TOOL}`),
	);
}

/**
 * Read the live pi tool registry, or undefined when it carries no signal.
 *
 * An absent handle, a non-array result, a throwing registry, and an empty list
 * are all "no signal" rather than "no subagents": reporting absent from an
 * uninformative registry would reproduce the very defect this probe fixes.
 */
function readActiveToolNames(pi: unknown): readonly string[] | undefined {
	try {
		const getActiveTools = (pi as { getActiveTools?: () => unknown })
			?.getActiveTools;
		if (typeof getActiveTools !== "function") return undefined;
		const tools = getActiveTools.call(pi);
		if (!Array.isArray(tools)) return undefined;
		const names = tools
			.map((tool) =>
				typeof tool === "string"
					? tool
					: isRecord(tool) && typeof tool.name === "string"
						? tool.name
						: "",
			)
			.filter((name) => name.length > 0);
		return names.length > 0 ? names : undefined;
	} catch {
		return undefined;
	}
}

/**
 * `subagent_run` availability probe.
 *
 * The live tool registry answers the question directly and wins whenever it
 * carries any signal. Without it -- prompt rendering outside a session, or a
 * runtime with no getActiveTools -- capability falls back to the presence of
 * an installed subagents package.
 */
function resolveBackgroundSubagentsCapability(
	cwd: string,
	activeTools?: readonly string[],
): BackgroundSubagentsCapability {
	try {
		if (activeTools !== undefined && activeTools.length > 0) {
			return hasSubagentRunTool(activeTools) ? "ready" : "absent";
		}
		return hasInstalledSubagentsPackage(cwd) ? "ready" : "absent";
	} catch {
		return "absent";
	}
}

function renderBackgroundSubagentsStatusLine(
	background: BackgroundSubagentsRendering,
): string {
	return `Background subagent policy: ${background.policy} (capability: ${background.capability})`;
}

/**
 * A `status` object is only trusted when `effective` is exactly `on`/`off`
 * and `source` is one of the exported `NATIVE_REVIEW_MODE_SOURCE` values.
 * `resolveRddModeStatus` only ever produces a value shaped like this, but
 * `renderRddStatusLine` validates at the render boundary anyway -- a
 * malformed or partial object (a bad decode upstream, a future field
 * change, a hand-built test fixture) must fail closed to the "unknown"
 * line, never render an unrecognized value verbatim.
 */
function isValidRddModeStatus(
	status: NativeReviewModeStatus | undefined,
): status is NativeReviewModeStatus {
	if (status === undefined || status === null || typeof status !== "object") return false;
	if (status.effective !== "on" && status.effective !== "off") return false;
	const validSources: readonly string[] = Object.values(NATIVE_REVIEW_MODE_SOURCE);
	return typeof status.source === "string" && validSources.includes(status.source);
}

/**
 * Renders the receipt-driven-development status line rendered next to
 * `Background subagent policy` (gentle-pi#661). Renders the fail-closed
 * "unknown" line whenever `status` is not a validated on/off status with a
 * recognized source -- `undefined` (the native reader could not answer:
 * binary absent, timed out, aborted, or a native CLI failure) or any
 * malformed/partial object. This is a pure render, never a native call, so
 * it never throws.
 */
function renderRddStatusLine(
	status: NativeReviewModeStatus | undefined,
): string {
	return isValidRddModeStatus(status)
		? `Receipt-driven development: ${status.effective} (decided by ${status.source})`
		: "Receipt-driven development: unknown (native status unavailable)";
}

// The primary-session prompt awaits this on every non-SDD, non-named agent
// start, so an unbounded native read would stall session start behind a
// hung `gentle-ai` child (gentle-pi#661 native-review escalation). The
// production call site (before_agent_start) passes
// `AbortSignal.timeout(RDD_STATUS_TIMEOUT_MS)`; resolveRddModeStatus also
// races the call against that same signal itself (not just the CLI's own
// signal handling) so an abort is honored even against a stub/mock
// reviewMode that ignores its `signal` argument, as tests do.
const RDD_STATUS_TIMEOUT_MS = 3000;
// Repeated session/agent-start builds within this window reuse the last
// resolved status instead of respawning the native binary. Deliberately
// memoizes a failed/undefined resolution too (a sustained outage should not
// retry every agent start), trading a slower recovery signal for far fewer
// spawns; the one-shot notify below still surfaces a sustained outage.
const RDD_STATUS_MEMO_TTL_MS = 30_000;
const rddStatusMemo = new Map<string, { readonly status: NativeReviewModeStatus | undefined; readonly expiresAt: number }>();

/** @internal test seam: clears the per-cwd RDD status memo. */
function clearRddStatusMemoForTesting(): void {
	rddStatusMemo.clear();
}

// gentle-pi#668 (corrected): last-known outcome for ONE candidate, keyed by
// repository realpath AND targetIdentity -- never repository alone, or one
// candidate's outcome would leak into every other candidate's `assess` call.
// Only declined/unavailable are ever written (from ANSWER_CONSENT); `closed`
// is never written/derived -- pass it explicitly. A missing entry reads back
// `undefined`, treated as `unknown` (fail closed, exactly like `off`).
const nativeReviewOutcomeByCandidate = new Map<string, "declined" | "unavailable">();

function nativeReviewOutcomeMemoKey(cwd: string, targetIdentity: string): string {
	try {
		return `${realpathSync(cwd)}\u0000${targetIdentity}`;
	} catch {
		return `${cwd}\u0000${targetIdentity}`;
	}
}

function recordNativeReviewOutcome(cwd: string, targetIdentity: string, outcome: "declined" | "unavailable"): void {
	nativeReviewOutcomeByCandidate.set(nativeReviewOutcomeMemoKey(cwd, targetIdentity), outcome);
}

/** Returns the recorded outcome for exactly this candidate, or `undefined` when none is recorded. */
function readNativeReviewOutcome(cwd: string, targetIdentity: string): "declined" | "unavailable" | undefined {
	return nativeReviewOutcomeByCandidate.get(nativeReviewOutcomeMemoKey(cwd, targetIdentity));
}

/** @internal test seam: clears the per-candidate native review outcome memo. */
function clearNativeReviewOutcomeMemoForTesting(): void {
	nativeReviewOutcomeByCandidate.clear();
}

// Best-effort current-candidate target identity for `assess` (gentle-pi#668):
// reuses `targetStatus`, a native call this tool already makes elsewhere.
async function readCurrentTargetIdentityBestEffort(
	nativeReviewCli: Pick<NativeReviewCli, "targetStatus"> | null | undefined,
	cwd: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (nativeReviewCli?.targetStatus === undefined) return undefined;
	try {
		const status = await nativeReviewCli.targetStatus({ cwd, ...(signal === undefined ? {} : { signal }) });
		return status.applicability === "current_target" ? status.targetIdentity : undefined;
	} catch {
		return undefined;
	}
}

function rddAbortRejection(signal: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason ?? new Error("aborted"));
			return;
		}
		signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
	});
}

async function readRddModeStatusOnce(
	nativeReviewCli: Pick<NativeReviewCli, "reviewMode"> | null | undefined,
	cwd: string,
	signal?: AbortSignal,
): Promise<NativeReviewModeStatus | undefined> {
	if (!nativeReviewCli?.reviewMode) return undefined;
	try {
		const call = nativeReviewCli.reviewMode({ cwd, operation: NATIVE_REVIEW_MODE_OPERATION.STATUS, signal });
		const result = signal === undefined ? await call : await Promise.race([call, rddAbortRejection(signal)]);
		return result.status;
	} catch {
		return undefined;
	}
}

// gentle-pi#662: read-only combined native risk assessment plus the computed
// verification plan (`lib/review-risk-assessment.ts`), for the `gentle_review`
// tool's `assess` operation. Never throws: an unavailable/failed native
// assess call (older binary without the verb, timeout, malformed response)
// resolves to the `unassessable` tier, which `verificationPlan` treats the
// same as `high` -- the fail-closed rule from gentle-pi#662.
interface ReviewAssessmentPlanDetails {
	schema: "gentle-pi.review-assessment-plan/v1";
	risk: VerificationTier;
	reasons: readonly { code: string; path: string; detail: string }[];
	changedPaths: number;
	changedLines: number;
	candidate: { kind: string; baseRef: string | undefined } | null;
	rddLine: RddLine;
	nativeReviewOutcome: NativeReviewOutcome;
	// gentle-pi#668: where nativeReviewOutcome came from -- explicit (caller
	// passed it), derived (matched this exact candidate), or unknown.
	outcome_source: "explicit" | "derived" | "unknown";
	writerProfile: "small" | "large";
	plan: {
		writerSelfVerification: boolean;
		structuralReadbackOnly: boolean;
		independentVerifier: boolean;
		reason: string;
	};
}

async function resolveReviewAssessmentPlan(
	nativeReviewCli: Pick<NativeReviewCli, "reviewMode" | "assess" | "targetStatus"> | null | undefined,
	cwd: string,
	input: ReviewAssessInput,
	signal?: AbortSignal,
): Promise<ReviewAssessmentPlanDetails> {
	if (input.baseRef !== undefined && input.committedOnly !== true) throw new Error("Review assess baseRef requires committedOnly: true");
	if (input.baseRef === undefined && input.committedOnly !== undefined) throw new Error("Review assess committedOnly requires an explicit baseRef");

	const status = await readRddModeStatusOnce(nativeReviewCli, cwd, signal);
	const rddLine: RddLine = isValidRddModeStatus(status) ? status.effective : RDD_LINE.UNKNOWN;
	const writerProfile = resolveWriterProfile({
		...(input.writerModelId === undefined ? {} : { model: { id: input.writerModelId } }),
		thinking: input.writerEffort,
	});

	let assessment: ReviewAssessmentV1 | undefined;
	let unassessableDetail: string | undefined;
	if (nativeReviewCli?.assess === undefined) {
		unassessableDetail = "native review assess is unavailable: the installed gentle-ai binary does not expose the assess command.";
	} else {
		try {
			const request: NativeReviewAssessRequest = {
				cwd,
				...(input.baseRef === undefined ? {} : { baseRef: input.baseRef, committedOnly: true as const }),
				...(signal === undefined ? {} : { signal }),
			};
			assessment = await nativeReviewCli.assess(request);
		} catch (error) {
			unassessableDetail = `native review assess failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	const risk: VerificationTier = assessment?.risk ?? VERIFICATION_TIER.UNASSESSABLE;
	// gentle-pi#668: explicit always wins; otherwise derive only for THIS
	// candidate's own target identity, never repository-only. `closed` is
	// never derived.
	const targetIdentity = input.nativeReviewOutcome === undefined ? await readCurrentTargetIdentityBestEffort(nativeReviewCli, cwd, signal) : undefined;
	const derived = targetIdentity === undefined ? undefined : readNativeReviewOutcome(cwd, targetIdentity);
	const nativeReviewOutcome: NativeReviewOutcome = input.nativeReviewOutcome ?? derived ?? NATIVE_REVIEW_OUTCOME.UNKNOWN;
	const outcomeSource: "explicit" | "derived" | "unknown" = input.nativeReviewOutcome !== undefined ? "explicit" : derived === undefined ? "unknown" : "derived";
	const plan = verificationPlan({ rddLine, risk, writerProfile, nativeReviewOutcome });
	return {
		schema: "gentle-pi.review-assessment-plan/v1",
		risk,
		reasons: assessment?.reasons ?? (unassessableDetail === undefined ? [] : [{ code: "native-assess-unavailable", path: "", detail: unassessableDetail }]),
		changedPaths: assessment?.changedPaths ?? 0,
		changedLines: assessment?.changedLines ?? 0,
		candidate: assessment === undefined ? null : { kind: assessment.candidate.kind, baseRef: assessment.candidate.baseRef },
		rddLine,
		nativeReviewOutcome,
		outcome_source: outcomeSource,
		writerProfile,
		plan,
	};
}

let rddStatusUnavailableWarned = false;

/**
 * Best-effort native RDD mode status read for prompt rendering, memoized per
 * cwd for `RDD_STATUS_MEMO_TTL_MS`. Reuses the `reviewMode` STATUS reader
 * (`gentle-ai review mode status --json`, decoded to
 * `NativeReviewModeStatus`) that the `/gentle:review-mode` command also
 * calls. Never throws and never hangs past `signal`'s deadline when one is
 * given: an absent binary, a timed-out/aborted process, or a native CLI
 * failure all resolve to `undefined`. `ctx` is optional and used only for a
 * one-shot (per process) UI notice when the read is swallowed, so a
 * sustained native outage is observable beyond the rendered "unknown" line.
 */
async function resolveRddModeStatus(
	nativeReviewCli: Pick<NativeReviewCli, "reviewMode"> | null | undefined,
	cwd: string,
	signal?: AbortSignal,
	now: () => number = Date.now,
	ctx?: Pick<ExtensionContext, "hasUI" | "ui">,
): Promise<NativeReviewModeStatus | undefined> {
	const nowMs = now();
	const cached = rddStatusMemo.get(cwd);
	if (cached !== undefined && cached.expiresAt > nowMs) return cached.status;
	const status = await readRddModeStatusOnce(nativeReviewCli, cwd, signal);
	rddStatusMemo.set(cwd, { status, expiresAt: nowMs + RDD_STATUS_MEMO_TTL_MS });
	if (status === undefined && !rddStatusUnavailableWarned) {
		rddStatusUnavailableWarned = true;
		if (ctx?.hasUI) {
			ctx.ui.notify(
				"Gentle AI: receipt-driven-development status is unavailable (native review CLI absent, timed out, or failed). The parent prompt renders \"unknown\" until this recovers; this notice will not repeat this session.",
				"warning",
			);
		}
	}
	return status;
}

/** Resolves and renders the RDD status line for a production call site in one call. */
async function resolveRddStatusLine(
	nativeReviewCli: Pick<NativeReviewCli, "reviewMode"> | null | undefined,
	cwd: string,
	signal?: AbortSignal,
	now: () => number = Date.now,
	ctx?: Pick<ExtensionContext, "hasUI" | "ui">,
): Promise<string> {
	return renderRddStatusLine(await resolveRddModeStatus(nativeReviewCli, cwd, signal, now, ctx));
}

// Rendered prompts are memoized per background policy/capability/RDD-status
// key for the process lifetime; the assets bytes themselves are read once
// per key. `rddStatusLine` defaults to the "unknown" fallback line (the
// longest of the three renderable forms), not "", so the default no-argument
// render IS the worst case the canonical 8 KiB budget in
// tests/orchestrator-budget.test.ts measures; assets/orchestrator.md is
// sized with that worst case already included. Production still resolves
// and passes the real line (on/off/unknown) via resolveRddStatusLine.
const orchestratorPromptCache = new Map<string, string>();
function getOrchestratorPrompt(
	cwd: string = process.cwd(),
	activeTools?: readonly string[],
	rddStatusLine: string = renderRddStatusLine(undefined),
): string {
	const background: BackgroundSubagentsRendering = {
		policy: loadBackgroundSubagentsPolicy(cwd),
		capability: resolveBackgroundSubagentsCapability(cwd, activeTools),
	};
	const cacheKey = `${background.policy}:${background.capability}:${rddStatusLine}`;
	let prompt = orchestratorPromptCache.get(cacheKey);
	if (prompt === undefined) {
		prompt = renderOrchestratorPrompt(ASSETS_DIR, background, rddStatusLine);
		orchestratorPromptCache.set(cacheKey, prompt);
	}
	return prompt;
}

function renderOrchestratorPrompt(
	assetsDir: string,
	background: BackgroundSubagentsRendering = DEFAULT_BACKGROUND_SUBAGENTS_RENDERING,
	rddStatusLine: string = renderRddStatusLine(undefined),
): string {
	const backgroundPolicyBlock = `${renderBackgroundSubagentsStatusLine(background)}\n${rddStatusLine}`;
	return readFileSync(join(assetsDir, "orchestrator.md"), "utf8")
		.replaceAll("{{GENTLE_PI_ASSETS_ROOT}}", assetsDir)
		.replaceAll(
			"{{GENTLE_PI_BACKGROUND_POLICY}}",
			backgroundPolicyBlock,
		)
		.trim();
}

// gentle-pi#560 / gentle-ai#4056, #4057: Gentle AI stopped writing a
// runtime-specific review execution contract into Pi's generated
// APPEND_SYSTEM composition on 2026-08-01. This package now injects the
// mirrored provider contract bundle's own `orchestration/pi.md` text
// instead, read once from the package-local mirror
// (contracts/review-provider-contract-mirror/) and cached as the fully
// rendered fragment for the process lifetime. It is deliberately NOT folded
// into getOrchestratorPrompt/orchestratorPromptCache: that core prompt is
// pinned at an 8192-byte budget (tests/orchestrator-budget.test.ts).
const PROVIDER_CONTRACT_MIRROR_ROOT = join(PACKAGE_ROOT, "contracts", "review-provider-contract-mirror");
const PROVIDER_CONTRACT_LOCK_FILE = "provider-contract.lock.json";
const PI_ORCHESTRATION_RUNTIME = "pi";

let reviewContractPromptFragmentCache: string | null | undefined;
let reviewContractPromptMissingWarned = false;

// Verifies the mirrored orchestration/pi.md bytes against the lock's digest before injection (gentle-ai R1/R3).
function readMirroredReviewContractFragment(mirrorRoot: string = PROVIDER_CONTRACT_MIRROR_ROOT): string | null {
	try {
		const lockPath = join(mirrorRoot, PROVIDER_CONTRACT_LOCK_FILE);
		const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
			contract_semver?: unknown;
			entries?: Record<string, unknown>;
		};
		if (typeof lock.contract_semver !== "string" || lock.contract_semver === "") return null;
		const expectedSha256 = lock.entries?.[`orchestration/${PI_ORCHESTRATION_RUNTIME}.md`];
		if (typeof expectedSha256 !== "string" || !/^[0-9a-f]{64}$/.test(expectedSha256)) return null;
		const contractPath = join(mirrorRoot, `v${lock.contract_semver}`, "bundle", "orchestration", `${PI_ORCHESTRATION_RUNTIME}.md`);
		const rawBytes = readFileSync(contractPath);
		const actualSha256 = createHash("sha256").update(rawBytes).digest("hex");
		if (!timingSafeEqual(Buffer.from(expectedSha256, "hex"), Buffer.from(actualSha256, "hex"))) return null;
		const text = rawBytes.toString("utf8").trim();
		if (text.length === 0) return null;
		return `## Gentle AI review execution contract (mirrored provider bundle ${lock.contract_semver})\n\n${text}`;
	} catch {
		return null;
	}
}

function loadReviewContractPromptFragment(
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	mirrorRoot: string = PROVIDER_CONTRACT_MIRROR_ROOT,
): string | null {
	if (reviewContractPromptFragmentCache === undefined) {
		reviewContractPromptFragmentCache = readMirroredReviewContractFragment(mirrorRoot);
	}
	if (reviewContractPromptFragmentCache === null && !reviewContractPromptMissingWarned) {
		reviewContractPromptMissingWarned = true;
		if (ctx.hasUI) {
			ctx.ui.notify(
				"Gentle AI review execution contract is unavailable: the mirrored provider bundle is missing, unreadable, or fails digest verification. Review preflight instructions will not be injected this session.",
				"warning",
			);
		}
	}
	return reviewContractPromptFragmentCache;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

type PersonaMode = "gentleman" | "neutral";

const PERSONA_OPTIONS = ["gentleman", "neutral"] as const;

const GENTLEMAN_PERSONA_PROMPT = `Persona:
- Be direct, technical, and concise.
- Always respond in the same language the user writes in.
- When the user writes Spanish, answer in natural Rioplatense Spanish with voseo.
- Act as a senior architect and teacher: concepts before code, no shortcuts.
- Treat AI as a tool directed by the human; never present yourself as a default chatbot.
- Push back when the user asks for code without enough context or understanding.
- Correct errors directly, explain why, and show the better path.`;

const NEUTRAL_PERSONA_PROMPT = `Persona:
- Be direct, technical, concise, warm, and professional.
- Always respond in the same language the user writes in.
- Do not use slang or regional expressions.
- When the user writes Spanish, use neutral/professional Spanish. Do NOT use voseo (vos tenés, vos querés, hacé, andá, etc.) or any regional conjugations.
- Act as a senior architect and teacher: concepts before code, no shortcuts.
- Treat AI as a tool directed by the human; never present yourself as a default chatbot.
- Push back when the user asks for code without enough context or understanding.
- Correct errors directly, explain why, and show the better path.`;

function buildGentlePrompt(
	persona: PersonaMode,
	cwd: string = process.cwd(),
	activeTools?: readonly string[],
	rddStatusLine: string = renderRddStatusLine(undefined),
): string {
	const personaPrompt =
		persona === "neutral" ? NEUTRAL_PERSONA_PROMPT : GENTLEMAN_PERSONA_PROMPT;
	const languageBoundary =
		persona === "neutral"
			? "Language: neutral/professional Spanish when the user writes Spanish. Do NOT use voseo or Rioplatense regional expressions."
			: "Language: natural Rioplatense Spanish with voseo when the user writes Spanish.";
	return `## el Gentleman Identity and Harness

Current persona mode: ${persona}

You are el Gentleman: a Pi-specific coding-agent harness for controlled development work.

Identity contract:
- When the user asks who or what you are, answer as el Gentleman, not as a generic assistant, and never introduce yourself as only "your assistant" or "the default assistant". Convey this meaning, translated into the user's language: "I am el Gentleman: a Pi-specific coding-agent harness for controlled development, with a senior architect persona. I run Organic Driven Development by default and SDD/OpenSpec when explicitly selected, coordinate subagents, use phase artifacts, run commands, and edit files. I am not a generic chatbot."
- Follow the currently selected persona mode.
- Mention ODD as the default workflow, SDD/OpenSpec phase artifacts, and subagents as core capabilities.
- Mention memory only when memory packages or callable memory tools are actually active; never invent persistent memory.
- Do not claim portability outside the Pi runtime.

${personaPrompt}

${languageBoundary}

Default workflow: Organic Driven Development (MANDATORY)
Organic Driven Development (ODD) is the predefined workflow of this orchestrator. Every request enters it, without the user asking for a workflow, a plan, or task tracking. SDD is a branch inside ODD, entered only by an explicit request or an accepted proposal. Never describe this workflow only when asked about it: run it. Run these steps in this order on every request:
1. **Authorize.** Investigation, explanation, review, comparison, and proposal-only requests stay read-only: no writer, apply, or implementation artifacts. Ambiguous or conditional change intent gets one clarification; stop and wait.
2. **Explore.** Explore existing code and requirements first, proportionately to the request, before proposing or writing anything.
3. **Resolve uncertainty.** Recommend optional research only for a named uncertainty; ask one focused user question only for a real unresolved product decision, then stop and wait; use at most one scoped read-only assumption challenge for a high-consequence unproven premise.
4. **Classify.** The work is substantial when exploration yields two or more meaningful implementation steps, or progress worth recovering after an interruption. Small, understood work stays small and creates no durable task artifacts.
5. **Track before the first write.** For substantial authorized implementation, create \`odd/tasks/<feature-name>.md\` and its Engram mirror \`odd/<feature-name>/tasks\` automatically, before the first source write, without asking permission for tasks or storage. Tell the user in one line which feature document was created and how many tasks it holds.
6. **Implement task by task.** Route each task through the orchestrator's Work Routing Ladder, with the configured TDD mode and applicable checks. Check an item off only after its outcome and checks were observed; update the file and the mirror after each task.
7. **Close.** Report the verified outcome, every failed, skipped, or pending check, and the next step. Native review applies only at the deliverable boundary and only under the user-owned RDD switch.
Resume an interrupted feature with \`mem_context\`, then project- and feature-scoped \`mem_search\`, then \`mem_get_observation\` for the full document, then the task file itself; reconcile before continuing the next unfinished task. Detail for steps 3–7: \`orchestrator-delegation.md\` and \`orchestrator-memory.md\`.

Harness principles:
- el Gentleman is not prompt engineering. It is runtime discipline around powerful agents.
- Organic Driven Development (ODD) is the predefined workflow for every request: authorize, explore, resolve uncertainty, classify, track substantial work before the first write, implement task by task with proportionate checks, close. SDD is explicitly selected.
- Clarify scope, constraints, acceptance criteria, and non-goals before implementation.
- Use subagents when available for exploration, planning, implementation, and review, while keeping one parent session responsible for orchestration.
- Keep writes single-threaded unless the user explicitly approves parallel write isolation.
- Use configured TDD mode, source, and exact runner; test presence does not enable it. Follow orchestrator-delegation.md for ODD forwarding and evidence.
- Protect the human reviewer: avoid oversized changes, surface review workload risk, and ask before turning one task into a large multi-area change.
- Never claim persistent memory is available because of this package. Memory is provided by separate packages or MCP tools when installed and callable.

${getOrchestratorPrompt(cwd, activeTools, rddStatusLine)}`;
}

// Matches `git [global-flags] push` — tolerates flags like -C /repo or --work-tree=/tmp
// between `git` and the subcommand. Short flags may be followed by a separate value token.
const GIT_GLOBAL_FLAGS_SRC = String.raw`(?:\s+--?\S+(?:\s+[^-\s]\S*)?)* `;
const GIT_PUSH_RE = new RegExp(String.raw`\bgit${GIT_GLOBAL_FLAGS_SRC}(push)\b`);

const DENIED_BASH_PATTERNS: RegExp[] = [
	// Block rm -rf targeting /, ~ or ~/subdir, $HOME or $HOME/subdir, .. or .
	/\brm\s+-rf\s+(?:\/(?:\s|$)|~(?:\/|\s|$)|[$]HOME(?:\/|\s|$)|\.\.?(?:\s|$))/,
	/\bgit\s+reset\s+--hard\b/,
	/\bgit\s+clean\b(?=[^\n]*(?:-[^\n]*f|--force))(?=[^\n]*(?:-[^\n]*d|--directories))/,
	// Force-push deny: tolerates git global flags (e.g. -C /repo) before the subcommand
	new RegExp(String.raw`\bgit${GIT_GLOBAL_FLAGS_SRC}push\b(?=[^\n]*\s--force(?:-with-lease)?\b)`),
	new RegExp(String.raw`\bgit${GIT_GLOBAL_FLAGS_SRC}push\b(?=[^\n]*\s-[^\s-]*f)`),
	/\bchmod\s+-R\s+777\b/,
	/\bchown\s+-R\b/,
];

// ---------------------------------------------------------------------------
// Autonomous guard — runtime guardrails config
// ---------------------------------------------------------------------------

const GUARD_ACTION = {
	ALLOW: "allow",
	CONFIRM: "confirm",
	BLOCK: "block",
} as const;

type GuardAction = (typeof GUARD_ACTION)[keyof typeof GUARD_ACTION];
type GuardClassification = GuardAction | "not-guarded";

interface GuardMatch {
	key: GuardedCommandKey;
	action: GuardAction;
	triggerIndex: number;
}

interface GuardEvaluation {
	action: GuardClassification;
	key?: GuardedCommandKey;
	triggerIndex: number;
	matches: GuardMatch[];
}

const GUARDED_COMMAND_KEY = {
	GIT_PUSH: "gitPush",
	GIT_REBASE: "gitRebase",
	GIT_BRANCH_DELETE_FORCE: "gitBranchDeleteForce",
	NPM_PUBLISH: "npmPublish",
	PI_REMOVE: "piRemove",
} as const;

type GuardedCommandKey = (typeof GUARDED_COMMAND_KEY)[keyof typeof GUARDED_COMMAND_KEY];

type GuardedCommandsConfig = Partial<Record<GuardedCommandKey, GuardAction>>;

interface RuntimeGuardrailsConfig {
	autonomousMode: boolean;
	guardedCommands: GuardedCommandsConfig;
}

interface LoadGuardrailsOptions {
	/** Override the config home directory (used in tests to avoid touching ~/.pi). */
	gentlePiConfigHome?: string;
}

const GUARDED_KEY_PATTERNS: Record<GuardedCommandKey, RegExp> = {
	gitPush: GIT_PUSH_RE,
	gitRebase: /\bgit\s+(rebase)\b/,
	gitBranchDeleteForce: /\bgit\s+(branch)\s+(?:-[a-zA-Z]*D[a-zA-Z]*|-[a-zA-Z]*d[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*d[a-zA-Z]*|--delete\b[^\r\n;&|]*--force\b|--force\b[^\r\n;&|]*--delete\b)/,
	npmPublish: /\bnpm\s+(publish)\b/,
	piRemove: /\bpi\s+(remove)\b/,
};

const AUTONOMOUS_DEFAULT_ACTIONS: Record<GuardedCommandKey, GuardAction> = {
	gitPush: "allow",
	gitRebase: "confirm",
	gitBranchDeleteForce: "confirm",
	npmPublish: "block",
	piRemove: "confirm",
};

const GUARDED_COMMAND_LABELS: Record<GuardedCommandKey, string> = {
	gitPush: "git push",
	gitRebase: "git rebase",
	gitBranchDeleteForce: "forced git branch deletion",
	npmPublish: "npm publish",
	piRemove: "pi remove",
};

const SAFE_GUARDRAILS_CONFIG: RuntimeGuardrailsConfig = {
	autonomousMode: false,
	guardedCommands: {},
};

/**
 * Classify a shell command under the runtime guard policy.
 *
 * Ordering (non-negotiable):
 *   1. Hard-deny patterns → "block" (always, cannot be overridden by config)
 *   2. If autonomousMode is false → mirror the legacy CONFIRM_BASH_PATTERNS result
 *   3. If autonomousMode is true → use configured GuardAction for the matched key
 *      (applying AUTONOMOUS_DEFAULT_ACTIONS for any key not set in guardedCommands)
 *   4. No match → "not-guarded"
 */
function collectGuardedMatches(
	command: string,
	config: RuntimeGuardrailsConfig,
): GuardMatch[] {
	const matches: GuardMatch[] = [];
	for (const [key, pattern] of Object.entries(GUARDED_KEY_PATTERNS) as [
		GuardedCommandKey,
		RegExp,
	][]) {
		const globalPattern = new RegExp(pattern.source, `${pattern.flags}g`);
		for (const match of command.matchAll(globalPattern)) {
			const action = config.autonomousMode
				? (config.guardedCommands[key] ?? AUTONOMOUS_DEFAULT_ACTIONS[key])
				: "confirm";
			matches.push({
				key,
				action,
				triggerIndex: match.index + match[0].lastIndexOf(match[1]),
			});
		}
	}
	return matches.sort((left, right) => left.triggerIndex - right.triggerIndex);
}

function evaluateGuardedCommand(
	command: string,
	config: RuntimeGuardrailsConfig,
): GuardEvaluation {
	const matches = collectGuardedMatches(command, config);

	// Hard denies override every configured action across the complete command.
	for (const pattern of DENIED_BASH_PATTERNS) {
		const denied = pattern.exec(command);
		if (!denied) continue;
		const matchedAction = matches.find((match) =>
			match.triggerIndex >= denied.index && match.triggerIndex < denied.index + denied[0].length,
		);
		return {
			action: "block",
			key: matchedAction?.key,
			triggerIndex: matchedAction?.triggerIndex ?? denied.index,
			matches,
		};
	}

	// Configured block, then confirmation, then allow win across all matches.
	const selected = matches.find((match) => match.action === "block")
		?? matches.find((match) => match.action === "confirm")
		?? matches.find((match) => match.action === "allow");
	if (selected) return { ...selected, matches };
	return { action: "not-guarded", triggerIndex: 0, matches };
}

function classifyGuardedCommand(
	command: string,
	config: RuntimeGuardrailsConfig,
): GuardClassification {
	return evaluateGuardedCommand(command, config).action;
}

function guardedCommandPreview(command: string, triggerIndex: number): string {
	const start = Math.max(0, triggerIndex - 60);
	const prefix = start > 0 ? "…" : "";
	return `${prefix}${truncateToWidth(command.slice(start).replace(/\s+/g, " ").trim(), 180 - prefix.length, "…")}`;
}

/** Confirmation headline for all guarded actions; generic when no key matched. */
function guardedCommandTitle(
	key?: GuardedCommandKey,
	matches: readonly GuardMatch[] = [],
): string {
	if (matches.length > 1) {
		return `Allow guarded actions: ${matches.map((match) => GUARDED_COMMAND_LABELS[match.key]).join("; ")}?`;
	}
	return key === undefined
		? "Allow guarded command?"
		: `Allow guarded ${GUARDED_COMMAND_LABELS[key]}?`;
}

function parseGuardrailsConfigFile(
	raw: string,
): RuntimeGuardrailsConfig | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;

	const autonomousMode = parsed.autonomousMode === true;

	const rawCommands = isRecord(parsed.guardedCommands) ? parsed.guardedCommands : {};
	const guardedCommands: GuardedCommandsConfig = {};
	const validActions = new Set<string>(["allow", "confirm", "block"]);
	for (const [key, value] of Object.entries(rawCommands)) {
		if (
			typeof value === "string" &&
			validActions.has(value) &&
			Object.values(GUARDED_COMMAND_KEY).includes(key as GuardedCommandKey)
		) {
			guardedCommands[key as GuardedCommandKey] = value as GuardAction;
		}
	}

	return { autonomousMode, guardedCommands };
}

/**
 * Load the runtime guardrails config.
 *
 * Resolution order (project overrides global):
 *   1. Check GENTLE_PI_AUTONOMOUS_MODE env var — if "1", forces autonomousMode=true
 *      and uses default guarded command actions.
 *   2. Read global config from ${gentlePiConfigHome}/runtime-guardrails.json
 *   3. Read project config from ${cwd}/.pi/gentle-ai/runtime-guardrails.json
 *      (project values are merged on top of global)
 *   4. Any parse/read error anywhere → fail safe (return SAFE_GUARDRAILS_CONFIG)
 */
function loadRuntimeGuardrailsConfig(
	cwd: string,
	options: LoadGuardrailsOptions = {},
): RuntimeGuardrailsConfig {
	try {
		// Env var override: forces autonomous mode with default actions
		if (process.env.GENTLE_PI_AUTONOMOUS_MODE === "1") {
			return { autonomousMode: true, guardedCommands: {} };
		}

		const configHome = options.gentlePiConfigHome ?? gentleAiConfigHome();
		const globalConfigPath = join(configHome, "runtime-guardrails.json");
		const projectConfigPath = join(cwd, ".pi", "gentle-ai", "runtime-guardrails.json");

		let merged: RuntimeGuardrailsConfig = { autonomousMode: false, guardedCommands: {} };

		if (existsSync(globalConfigPath)) {
			const globalParsed = parseGuardrailsConfigFile(
				readFileSync(globalConfigPath, "utf8"),
			);
			if (!globalParsed) return SAFE_GUARDRAILS_CONFIG;
			merged = globalParsed;
		}

		if (existsSync(projectConfigPath)) {
			const projectParsed = parseGuardrailsConfigFile(
				readFileSync(projectConfigPath, "utf8"),
			);
			if (!projectParsed) return SAFE_GUARDRAILS_CONFIG;
			// Project values fully override global values
			merged = {
				autonomousMode: projectParsed.autonomousMode,
				guardedCommands: {
					...merged.guardedCommands,
					...projectParsed.guardedCommands,
				},
			};
		}

		return merged;
	} catch {
		return SAFE_GUARDRAILS_CONFIG;
	}
}

const PATH_GUARDED_TOOL_NAMES = new Set(["read", "write", "edit"]);
const PATH_INPUT_KEYS = new Set([
	"path",
	"paths",
	"file",
	"files",
	"filePath",
	"filePaths",
]);
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
	/(^|\/)\.ssh(?:\/|$)/,
	/(^|\/)\.credentials(?:\/|$)/,
	/(^|\/)library\/keychains(?:\/|$)/,
	/(^|\/)\.aws\/credentials$/,
	/(^|\/)\.config\/gh\/hosts\.ya?ml$/,
	/(^|\/)secrets(?:\/|$)/,
	/(^|\/)\.env(?:$|[./_-])/,
	/\.(?:pem|key|p12|pfx)$/,
];

const SDD_AGENT_NAME_SET = new Set<string>(SHIPPED_SDD_AGENT_NAMES);
const SDD_CHANGE_FLAG = "gentle-sdd-change";
const SDD_CHANGE_KEYS = ["changeName", "phase", "workspaceRoot"] as const;

const JUDGMENT_DAY_AGENT_NAMES = [
	"jd-judge-a",
	"jd-judge-b",
	"jd-fix-agent",
] as const;

const CORE_MODEL_AGENT_NAMES = [
	...SHIPPED_SDD_AGENT_NAMES,
	...JUDGMENT_DAY_AGENT_NAMES,
] as const;
const CORE_MODEL_AGENT_NAME_SET = new Set<string>(CORE_MODEL_AGENT_NAMES);

type AgentSource = "project" | "user" | "builtin";

interface AgentEntry {
	name: string;
	source: AgentSource;
	filePath?: string;
}

const KEEP_CURRENT = "Keep current";
const INHERIT_MODEL = "Inherit active/default model";
const CUSTOM_MODEL = "Custom model id";
const INHERIT_THINKING = "Inherit effort";
const THINKING_OPTIONS: (ThinkingLevel | typeof INHERIT_THINKING)[] = [
	INHERIT_THINKING,
	...THINKING_LEVELS,
];

const MODEL_CONTROL_OPTIONS = [
	KEEP_CURRENT,
	INHERIT_MODEL,
	CUSTOM_MODEL,
] as const;
const MODEL_PANEL_MAX_RENDER_ROWS = 20;
const AGENT_LIST_MAX_VISIBLE_ROWS = MODEL_PANEL_MAX_RENDER_ROWS - 13;
const MODEL_LIST_MAX_VISIBLE_ROWS = 12;

function readStringPath(value: unknown, path: string[]): string | undefined {
	let current = value;
	for (const key of path) {
		if (!isRecord(current)) return undefined;
		current = current[key];
	}
	return typeof current === "string" ? current : undefined;
}

function isSddAgentStartEvent(event: unknown): boolean {
	const candidates = readAgentStartNames(event);
	if (candidates.some((value) => SDD_AGENT_NAME_SET.has(value)) || sddPhaseFromAgentStartEvent(event) !== undefined) return true;

	const systemPrompt = readStringPath(event, ["systemPrompt"]) ?? "";
	return SHIPPED_SDD_AGENT_NAMES.some((name) => {
		const phase = name.replace(/^sdd-/, "");
		return new RegExp(`\\bSDD ${phase} executor\\b`, "i").test(systemPrompt);
	});
}

function readAgentStartNames(event: unknown): string[] {
	return [
		readStringPath(event, ["agentName"]),
		readStringPath(event, ["agent"]),
		readStringPath(event, ["name"]),
		readStringPath(event, ["agent", "name"]),
		readStringPath(event, ["subagent", "name"]),
	]
		.filter((value): value is string => value !== undefined)
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
}

function isNamedAgentStartEvent(event: unknown): boolean {
	return readAgentStartNames(event).length > 0;
}

function sddPhaseFromAgentStartEvent(event: unknown): SddPhase | "remediate" | undefined {
	const phases = ["apply", "verify", "archive", "remediate"] as const;
	const names = readAgentStartNames(event);
	const systemPrompt = readStringPath(event, ["systemPrompt"]) ?? "";
	const promptPhases = phases.filter((phase) => new RegExp(`\\bSDD ${phase} executor\\b`, "i").test(systemPrompt));
	if (promptPhases.length > 1) return undefined;
	if (names.length === 0) return promptPhases[0];
	return phases.find((phase) => names.every((name) => name === `sdd-${phase}`) &&
		(promptPhases.length === 0 || promptPhases[0] === phase));
}

function resolveSddChangeSelection(serialized: unknown, cwd: string, agentName: string): { changeName: string; workspaceRoot: string; phase: SddPhase | "remediate"; failedEvidenceRevision?: string } {
	if (typeof serialized !== "string") throw new Error("SDD selection must be a JSON string.");
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		throw new Error("SDD selection is malformed.");
	}
	if (!isRecord(value) || Object.keys(value).sort().join(",") !== (value.phase === "remediate" ? "changeName,failedEvidenceRevision,phase,workspaceRoot" : SDD_CHANGE_KEYS.join(","))) {
		throw new Error("SDD selection must contain only changeName, workspaceRoot, and phase.");
	}
	const { changeName, workspaceRoot, phase } = value;
	if (typeof changeName !== "string" || changeName.length === 0 ||
		typeof workspaceRoot !== "string" || workspaceRoot.length === 0 ||
		(phase !== "apply" && phase !== "verify" && phase !== "archive" && phase !== "remediate")) {
		throw new Error("SDD selection has an invalid identity.");
	}
	if (agentName !== `sdd-${phase}`) throw new Error("SDD selection phase does not match the child agent.");
	let canonicalCwd: string;
	let canonicalSelectionRoot: string;
	try {
		canonicalCwd = realpathSync(cwd);
		canonicalSelectionRoot = realpathSync(workspaceRoot);
	} catch {
		throw new Error("SDD selection workspaceRoot cannot be resolved.");
	}
	if (canonicalCwd !== canonicalSelectionRoot || workspaceRoot !== canonicalSelectionRoot) {
		throw new Error("SDD selection workspaceRoot does not match the canonical child root.");
	}
	if (phase === "remediate" && (typeof value.failedEvidenceRevision !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.failedEvidenceRevision))) throw new Error("Invalid remediation revision");
	return { changeName, workspaceRoot: canonicalCwd, phase, ...(phase === "remediate" ? { failedEvidenceRevision: value.failedEvidenceRevision as string } : {}) };
}

function assertNativeSddPhaseReady(status: NativeSddStatusV2, phase: SddPhase | "remediate"): void {
	if (!status.phaseInstructions || !(phase in status.phaseInstructions)) {
		throw new Error(`Native SDD status cannot represent phase ${phase}.`);
	}
	if (phase === "remediate") {
		if (status.nextRecommended !== phase) throw new Error("Native SDD status does not select remediation.");
		return;
	}
	// Optional verification may be explicitly selected when native recommends
	// apply or archive. Preserve that recommendation; never advance an older provider.
	const optionalVerify = phase === "verify" && (status.nextRecommended === "archive" || status.nextRecommended === "apply") && status.blockedReasons.length === 0;
	if ((!optionalVerify && status.nextRecommended !== phase) || status.dependencies[phase] !== "ready" ||
		(status.blockedReasons.length > 0 && phase !== "verify")) {
		// A native-selected verify can refresh the evidence named by a blocker.
		// Apply/archive never inherit that exception (gentle-pi#972).
		throw new Error(`SDD selection native status blocks phase ${phase}; it cannot execute.`);
	}
}

async function resolveSelectedNativeSddChangeStartup(
	serialized: unknown,
	cwd: string,
	agentName: string,
	native: Pick<NativeReviewCli, "sddStatus"> | null | undefined,
): Promise<{ selection: { changeName: string; workspaceRoot: string; phase: SddPhase | "remediate"; failedEvidenceRevision?: string }; status: NativeSddStatusV2 }> {
	const selection = resolveSddChangeSelection(serialized, cwd, agentName);
	if (native?.sddStatus === undefined) throw new Error("SDD selection native status is unavailable.");
	let status: NativeSddStatusV2;
	try {
		status = decodeNativeSddStatusV2(
			await native.sddStatus({ changeName: selection.changeName, workspaceRoot: selection.workspaceRoot }),
			{ changeName: selection.changeName, workspaceRoot: selection.workspaceRoot },
		);
	} catch (error) {
		throw new Error(`SDD selection native status is blocked: ${error instanceof Error ? error.message : String(error)}`);
	}
	assertNativeSddPhaseReady(status, selection.phase);
	if (selection.phase === "remediate" && status.remediationState?.failedEvidenceRevision !== selection.failedEvidenceRevision) {
		throw new Error("Stale remediation selection");
	}
	return { selection, status };
}

function readSddChangeFlag(pi: ExtensionAPI): unknown {
	try {
		const value = (pi as unknown as { getFlag?: (name: string) => unknown }).getFlag?.(SDD_CHANGE_FLAG);
		return value === false ? undefined : value;
	} catch {
		return null;
	}
}

function normalizePolicyPath(value: string): string {
	return value.trim().replace(/^~(?=\/|$)/, homedir()).replace(/\\/g, "/").toLowerCase();
}

function isSensitivePath(value: string): boolean {
	const normalized = normalizePolicyPath(value);
	return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function collectPathInputs(value: unknown, key?: string): string[] {
	if (typeof value === "string") return key && PATH_INPUT_KEYS.has(key) ? [value] : [];
	if (Array.isArray(value)) return value.flatMap((item) => collectPathInputs(item, key));
	if (!isRecord(value)) return [];
	return Object.entries(value).flatMap(([entryKey, entryValue]) =>
		collectPathInputs(entryValue, entryKey),
	);
}

function hasWritableEngramTool(pi: ExtensionAPI): boolean {
	try {
		const getActiveTools = (pi as unknown as { getActiveTools?: () => unknown[] })
			.getActiveTools;
		if (typeof getActiveTools !== "function") return false;
		const tools = getActiveTools.call(pi);
		return tools.some((tool) => {
			const name =
				typeof tool === "string"
					? tool
					: isRecord(tool) && typeof tool.name === "string"
						? tool.name
						: "";
			return name === "mem_save" || name.endsWith(".mem_save");
		});
	} catch {
		return false;
	}
}

function evaluateSensitivePathTool(
	toolName: string,
	input: unknown,
): ToolCallEventResult | undefined {
	if (!PATH_GUARDED_TOOL_NAMES.has(toolName)) return undefined;
	const sensitivePath = collectPathInputs(input).find(isSensitivePath);
	if (!sensitivePath) return undefined;
	return {
		block: true,
		reason: `Gentle AI safety policy blocked access to sensitive path: ${sanitizeTerminalText(sensitivePath)}. Ask the user for an explicit safer plan.`,
	};
}

const ASK_USER_CHOICE_BLOCKED_EVENT = "gentle-pi:ask-user-choice:blocked";

const HERDR_BLOCKER_LABEL = {
	CHOICE: "Choice awaiting input",
	GUARDED_CONFIRMATION: "Guarded command confirmation",
	QUESTIONNAIRE: "Questionnaire awaiting input",
} as const;

type HerdrBlockerLabel = (typeof HERDR_BLOCKER_LABEL)[keyof typeof HERDR_BLOCKER_LABEL];

type HerdrConfirmationLifecycle = {
	begin(): void;
	settle(): void;
};

function createHerdrConfirmationLifecycle(events: ExtensionAPI["events"]): HerdrConfirmationLifecycle {
	let pending = 0;
	let choiceActive = false;
	let questionnaireActive = false;
	let emittedLabel: HerdrBlockerLabel | undefined;
	const emitEffectiveBlocker = (): void => {
		const nextLabel = choiceActive
			? HERDR_BLOCKER_LABEL.CHOICE
			: questionnaireActive
				? HERDR_BLOCKER_LABEL.QUESTIONNAIRE
				: pending > 0
					? HERDR_BLOCKER_LABEL.GUARDED_CONFIRMATION
					: undefined;
		if (nextLabel === emittedLabel) return;
		emittedLabel = nextLabel;
		if (nextLabel === undefined) events.emit("herdr:blocked", { active: false });
		else events.emit("herdr:blocked", { active: true, label: nextLabel });
	};

	events?.on?.(ASK_USER_CHOICE_BLOCKED_EVENT, (event) => {
		if (!isRecord(event) || typeof event.active !== "boolean" || event.active === choiceActive) return;
		choiceActive = event.active;
		emitEffectiveBlocker();
	});

	events?.on?.("rpiv:ask-user:blocked", (event) => {
		if (!isRecord(event) || typeof event.active !== "boolean" || event.active === questionnaireActive) return;
		questionnaireActive = event.active;
		emitEffectiveBlocker();
	});

	return {
		begin() {
			pending += 1;
			emitEffectiveBlocker();
		},
		settle() {
			if (pending === 0) return;
			pending -= 1;
			emitEffectiveBlocker();
		},
	};
}

async function confirmCommand(
	command: string,
	ctx: ExtensionContext,
	events: ExtensionAPI["events"],
	herdrLifecycle: HerdrConfirmationLifecycle,
): Promise<ToolCallEventResult | undefined> {
	const guardrailsConfig = loadRuntimeGuardrailsConfig(ctx.cwd);
	const evaluation = evaluateGuardedCommand(command, guardrailsConfig);
	const { action: classification } = evaluation;

	if (classification === "block") {
		return {
			block: true,
			reason:
				"Gentle AI safety policy blocked a destructive shell command. Ask the user for an explicit safer plan.",
		};
	}

	if (classification === "not-guarded") return undefined;

	// classification is "allow" or "confirm" from this point on
	if (classification === "allow") return undefined;

	// classification === "confirm"
	if (!ctx.hasUI) {
		return {
			block: true,
			reason:
				"Gentle AI safety policy requires interactive confirmation before this command.",
		};
	}
	const title = guardedCommandTitle(evaluation.key, evaluation.matches);
	const preview = guardedCommandPreview(command, evaluation.triggerIndex);
	const requestId = randomUUID();
	const emitPermissionRequest = (
		state: "waiting" | "approved" | "denied",
	): void => {
		events.emit("pi-permission-system:permission-request", {
			requestId,
			state,
			source: "tool_call",
			message: "Gentle AI safety policy requires confirmation for this tool call.",
			toolName: "bash",
		});
	};
	let approved = false;
	let confirmationFailed = false;
	let confirmationError: unknown;
	emitPermissionRequest("waiting");
	herdrLifecycle.begin();
	try {
		approved = await ctx.ui.confirm(title, preview);
	} catch (error) {
		confirmationFailed = true;
		confirmationError = error;
	} finally {
		try {
			emitPermissionRequest(confirmationFailed || !approved ? "denied" : "approved");
		} finally {
			herdrLifecycle.settle();
		}
	}
	if (confirmationFailed) throw confirmationError;
	if (approved) return undefined;
	return {
		block: true,
		reason:
			"Gentle AI safety policy blocked the command because it was not confirmed.",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function gentleAiConfigHome(): string {
	return process.env.GENTLE_PI_CONFIG_HOME ?? join(homedir(), ".pi", "gentle-ai");
}

function modelConfigPath(_cwd: string): string {
	return join(gentleAiConfigHome(), "models.json");
}

function modelExportPath(_cwd: string): string {
	return join(gentleAiConfigHome(), "models.export.json");
}

const MODEL_EXPORT_KIND = "gentle-pi.agent_model_routing";
const MODEL_EXPORT_VERSION = 1;

function legacyProjectModelConfigPath(cwd: string): string {
	return join(cwd, ".pi", "gentle-ai", "models.json");
}

function projectPersonaConfigPath(cwd: string): string {
	return join(cwd, ".pi", "gentle-ai", "persona.json");
}

function personaConfigPath(_cwd: string): string {
	return join(gentleAiConfigHome(), "persona.json");
}

function readPersonaFile(path: string): PersonaMode | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed)) return undefined;
		return parsed.mode === "neutral" ? "neutral" : "gentleman";
	} catch {
		return undefined;
	}
}

function readPersonaMode(cwd: string): PersonaMode {
	return (
		readPersonaFile(projectPersonaConfigPath(cwd)) ??
		readPersonaFile(personaConfigPath(cwd)) ??
		"gentleman"
	);
}

function writePersonaMode(cwd: string, mode: PersonaMode): string[] {
	const paths = [personaConfigPath(cwd)];
	const projectPath = projectPersonaConfigPath(cwd);
	if (existsSync(projectPath)) paths.push(projectPath);
	for (const path of paths) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ mode }, null, 2)}\n`);
	}
	return paths;
}

function readSavedModelConfig(cwd: string): ModelConfigFileResult {
	const projectPath = legacyProjectModelConfigPath(cwd);
	const result = readModelRoutingAuthority(modelConfigPath(cwd), projectPath);
	return result.status === "invalid" && result.path === projectPath
		? { status: "valid", config: {} }
		: result;
}

async function readSavedModelConfigAsync(
	cwd: string,
): Promise<ModelConfigFileResult> {
	const projectPath = legacyProjectModelConfigPath(cwd);
	const result = await readModelRoutingAuthorityAsync(modelConfigPath(cwd), projectPath);
	return result.status === "invalid" && result.path === projectPath
		? { status: "valid", config: {} }
		: result;
}

export function readModelConfig(cwd: string): AgentModelConfig {
	const result = readSavedModelConfig(cwd);
	return result.status === "valid" ? result.config : {};
}

export async function readModelConfigAsync(
	cwd: string,
): Promise<AgentModelConfig> {
	const result = await readSavedModelConfigAsync(cwd);
	return result.status === "valid" ? result.config : {};
}

function writeModelConfig(cwd: string, config: AgentModelConfig): void {
	const path = modelConfigPath(cwd);
	mkdirSync(dirname(path), { recursive: true });
	const cleaned = normalizeModelConfig(config) ?? {};
	writeFileSync(path, `${JSON.stringify(cleaned, null, 2)}\n`);
}

async function writeModelConfigAsync(cwd: string, config: AgentModelConfig): Promise<void> {
	const path = modelConfigPath(cwd);
	await mkdir(dirname(path), { recursive: true });
	const cleaned = normalizeModelConfig(config) ?? {};
	await writeFile(path, `${JSON.stringify(cleaned, null, 2)}\n`);
}

function parseModelExport(value: unknown): AgentModelConfig | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind !== MODEL_EXPORT_KIND || value.version !== MODEL_EXPORT_VERSION) return undefined;
	return normalizeModelConfig(value.agents);
}

async function exportSavedModelConfig(ctx: ExtensionContext): Promise<number> {
	const saved = await readModelRoutingAuthorityAsync(
		modelConfigPath(ctx.cwd),
		legacyProjectModelConfigPath(ctx.cwd),
	);
	if (saved.status === "invalid") throw new Error(`Invalid model config: ${saved.path}`);
	const agents = saved.status === "valid" ? saved.config : {};
	const path = modelExportPath(ctx.cwd);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		`${JSON.stringify({ kind: MODEL_EXPORT_KIND, version: MODEL_EXPORT_VERSION, agents }, null, 2)}\n`,
	);
	return Object.keys(agents).length;
}

async function readModelExport(ctx: ExtensionContext): Promise<AgentModelConfig | undefined> {
	try {
		return parseModelExport(JSON.parse(await readFile(modelExportPath(ctx.cwd), "utf8")));
	} catch {
		return undefined;
	}
}

function cloneModelConfig(config: AgentModelConfig): AgentModelConfig {
	return Object.fromEntries(
		Object.entries(config).map(([name, entry]) => [name, { ...entry }]),
	);
}

function updateFrontmatterRouting(
	content: string,
	entry: AgentRoutingEntry | undefined,
): string {
	if (!content.startsWith("---\n")) return content;
	const endIndex = content.indexOf("\n---", 4);
	if (endIndex === -1) return content;
	const frontmatter = content.slice(4, endIndex);
	const body = content.slice(endIndex);
	const lines = frontmatter
		.split("\n")
		.filter(
			(line) => !line.startsWith("model:") && !line.startsWith("thinking:"),
		);
	const toInsert: string[] = [];
	if (entry?.model) toInsert.push(`model: ${entry.model}`);
	if (entry?.thinking) toInsert.push(`thinking: ${entry.thinking}`);
	if (toInsert.length > 0) {
		const descriptionIndex = lines.findIndex((line) =>
			line.startsWith("description:"),
		);
		const insertIndex =
			descriptionIndex >= 0 ? descriptionIndex + 1 : Math.min(1, lines.length);
		lines.splice(insertIndex, 0, ...toInsert);
	}
	return `---\n${lines.join("\n")}${body}`;
}

/**
 * The routing an agent file currently carries, read the same way
 * `updateFrontmatterRouting` writes it: top-level `model:` and `thinking:`
 * frontmatter lines. Anything else is "no routing", not an error.
 */
function readFrontmatterRouting(content: string): AgentRoutingEntry | undefined {
	if (!content.startsWith("---\n")) return undefined;
	const endIndex = content.indexOf("\n---", 4);
	if (endIndex === -1) return undefined;
	const raw: Record<string, string> = {};
	for (const line of content.slice(4, endIndex).split("\n")) {
		if (line.startsWith("model:")) raw.model = line.slice("model:".length).trim();
		else if (line.startsWith("thinking:")) raw.thinking = line.slice("thinking:".length).trim();
	}
	if (raw.model === undefined && raw.thinking === undefined) return undefined;
	const entry = normalizeRoutingEntry(raw);
	return entry && !isClearRoutingEntry(entry) ? entry : undefined;
}

function routingEntryFromModelProfile(value: unknown): AgentRoutingEntry | undefined {
	if (!isRecord(value)) return undefined;
	const entry = normalizeRoutingEntry({ model: value.model, thinking: value.effort });
	return entry && !isClearRoutingEntry(entry) ? entry : undefined;
}

function readSubagentModelProfiles(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(parsed) && isRecord(parsed.model_profiles) ? parsed.model_profiles : {};
	} catch {
		return {};
	}
}

async function readSubagentModelProfilesAsync(path: string): Promise<Record<string, unknown>> {
	if (!(await pathExists(path))) return {};
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		return isRecord(parsed) && isRecord(parsed.model_profiles) ? parsed.model_profiles : {};
	} catch {
		return {};
	}
}

/**
 * The routing an agent is materialized with — what subagent launches actually
 * resolve — regardless of what `models.json` records: the runtime reads
 * `subagents.json` model profiles first and the agent frontmatter otherwise.
 */
function readMaterializedRoutingEntry(
	cwd: string,
	agent: AgentEntry,
	profilesByPath: Map<string, Record<string, unknown>>,
): AgentRoutingEntry | undefined {
	const profilesPath = agentModelProfileConfigPath(cwd, agent.source);
	let profiles = profilesByPath.get(profilesPath);
	if (!profiles) {
		profiles = readSubagentModelProfiles(profilesPath);
		profilesByPath.set(profilesPath, profiles);
	}
	const fromProfile = routingEntryFromModelProfile(profiles[agent.name]);
	if (fromProfile) return fromProfile;
	if (!agent.filePath || !existsSync(agent.filePath)) return undefined;
	try {
		return readFrontmatterRouting(readFileSync(agent.filePath, "utf8"));
	} catch {
		return undefined;
	}
}

async function readMaterializedRoutingEntryAsync(
	cwd: string,
	agent: AgentEntry,
	profilesByPath: Map<string, Record<string, unknown>>,
): Promise<AgentRoutingEntry | undefined> {
	const profilesPath = agentModelProfileConfigPath(cwd, agent.source);
	let profiles = profilesByPath.get(profilesPath);
	if (!profiles) {
		profiles = await readSubagentModelProfilesAsync(profilesPath);
		profilesByPath.set(profilesPath, profiles);
	}
	const fromProfile = routingEntryFromModelProfile(profiles[agent.name]);
	if (fromProfile) return fromProfile;
	if (!agent.filePath || !(await pathExists(agent.filePath))) return undefined;
	try {
		return readFrontmatterRouting(await readFile(agent.filePath, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * The routing in effect: `models.json` where it speaks, and the materialized
 * stores the runtime resolves from for every discoverable agent it is silent
 * about. A sparse `models.json` therefore never hides routing that is still
 * live (#1012). Reading never writes.
 */
function readEffectiveModelConfig(cwd: string): AgentModelConfig {
	const effective = cloneModelConfig(readModelConfig(cwd));
	const profilesByPath = new Map<string, Record<string, unknown>>();
	for (const agent of listDiscoverableAgents(cwd)) {
		if (isProviderReviewRole(agent.name) || agent.name in effective) continue;
		const entry = readMaterializedRoutingEntry(cwd, agent, profilesByPath);
		if (entry) effective[agent.name] = entry;
	}
	return effective;
}

async function readEffectiveModelConfigAsync(cwd: string): Promise<AgentModelConfig> {
	const effective = cloneModelConfig(await readModelConfigAsync(cwd));
	const profilesByPath = new Map<string, Record<string, unknown>>();
	for (const agent of await listDiscoverableAgentsAsync(cwd)) {
		if (isProviderReviewRole(agent.name) || agent.name in effective) continue;
		const entry = await readMaterializedRoutingEntryAsync(cwd, agent, profilesByPath);
		if (entry) effective[agent.name] = entry;
	}
	return effective;
}

/**
 * A profile is a complete routing snapshot: applying it must leave every
 * discoverable agent it omits on inherit, not on whatever was materialized
 * before. Padding the omitted agents with clear entries makes
 * `applyModelConfig` remove their model profiles and frontmatter routing, the
 * same way `/gentle:models` clears an agent set to inherit.
 */
async function withOmittedAgentsClearedAsync(
	cwd: string,
	config: AgentModelConfig,
): Promise<AgentModelConfig> {
	const completed = cloneModelConfig(config);
	for (const agent of await listDiscoverableAgentsAsync(cwd)) {
		if (isProviderReviewRole(agent.name) || agent.name in completed) continue;
		completed[agent.name] = {};
	}
	return completed;
}

function parseAgentName(filePath: string): string | undefined {
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
	const name = content.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();
	if (!name) return undefined;
	const packageName = content
		.match(/^package:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]
		?.trim();
	return packageName ? `${packageName}.${name}` : name;
}

async function parseAgentNameAsync(
	filePath: string,
): Promise<string | undefined> {
	let content: string;
	try {
		content = await readFile(filePath, "utf8");
	} catch {
		return undefined;
	}
	const name = content.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();
	if (!name) return undefined;
	const packageName = content
		.match(/^package:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]
		?.trim();
	return packageName ? `${packageName}.${name}` : name;
}

function listAgentFilesRecursive(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "skills") continue;
			files.push(...listAgentFilesRecursive(path));
		} else if (
			entry.isFile() &&
			entry.name.endsWith(".md") &&
			!entry.name.endsWith(".chain.md")
		)
			files.push(path);
	}
	return files;
}

async function listAgentFilesRecursiveAsync(dir: string): Promise<string[]> {
	if (!(await pathExists(dir))) return [];
	const files: string[] = [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return files;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "skills") continue;
			files.push(...(await listAgentFilesRecursiveAsync(path)));
		} else if (
			entry.isFile() &&
			entry.name.endsWith(".md") &&
			!entry.name.endsWith(".chain.md")
		) {
			files.push(path);
		}
	}
	return files;
}

function listAgentsFromDir(dir: string, source: AgentSource): AgentEntry[] {
	return listAgentFilesRecursive(dir)
		.map((filePath): AgentEntry | undefined => {
			const name = parseAgentName(filePath);
			return name ? { name, source, filePath } : undefined;
		})
		.filter((entry): entry is AgentEntry => entry !== undefined);
}

async function listAgentsFromDirAsync(
	dir: string,
	source: AgentSource,
): Promise<AgentEntry[]> {
	const filePaths = await listAgentFilesRecursiveAsync(dir);
	const entries: AgentEntry[] = [];
	for (const filePath of filePaths) {
		const name = await parseAgentNameAsync(filePath);
		if (name) entries.push({ name, source, filePath });
	}
	return entries;
}

interface DiscoverableNonBuiltinAgentRoot {
	dir: string;
	source: AgentSource;
	/** The package installer owns this directory, so packageAssetAudit reports it. */
	packageManaged: boolean;
}

function discoverableNonBuiltinAgentRoots(cwd: string): DiscoverableNonBuiltinAgentRoot[] {
	const globalAgentHome = gentlePiAgentHome();
	const roots: DiscoverableNonBuiltinAgentRoot[] = [
		{ dir: join(globalAgentHome, "agents"), source: "user", packageManaged: true },
		{ dir: join(globalAgentHome, "subagents"), source: "user", packageManaged: false },
		{ dir: join(homedir(), ".agents"), source: "user", packageManaged: false },
		{ dir: join(cwd, ".agents"), source: "project", packageManaged: false },
		{ dir: join(cwd, ".pi", "agents"), source: "project", packageManaged: false },
		{ dir: join(cwd, ".pi", "subagents"), source: "project", packageManaged: false },
	];
	const unique = new Map<string, DiscoverableNonBuiltinAgentRoot>();
	for (const root of roots) {
		let canonical: string;
		try {
			canonical = realpathSync(root.dir);
		} catch {
			canonical = resolve(root.dir);
		}
		const existing = unique.get(canonical);
		if (existing) {
			// Reinsert so a later alias keeps true later-root precedence even when
			// another physical root appears between the duplicate entries. A merged
			// package-managed root must keep its installer-owned path: ownership
			// updates validate that lexical path against the managed manifest root.
			const managedRoot = existing.packageManaged ? existing : root.packageManaged ? root : undefined;
			unique.delete(canonical);
			unique.set(canonical, {
				dir: managedRoot?.dir ?? root.dir,
				source: root.source,
				packageManaged: managedRoot !== undefined,
			});
		} else unique.set(canonical, root);
	}
	return [...unique.values()];
}

function builtinAgentDirs(cwd: string): string[] {
	return [
		join(PACKAGE_ROOT, "..", "pi-subagents-j0k3r", "agents"),
		join(cwd, ".pi", "npm", "node_modules", "pi-subagents-j0k3r", "agents"),
		join(homedir(), ".local", "lib", "node_modules", "pi-subagents-j0k3r", "agents"),
		join(PACKAGE_ROOT, "..", "pi-subagents", "agents"),
		join(cwd, ".pi", "npm", "node_modules", "pi-subagents", "agents"),
		join(homedir(), ".local", "lib", "node_modules", "pi-subagents", "agents"),
	];
}

function listBuiltinAgentNames(cwd: string): Set<string> {
	return new Set(
		builtinAgentDirs(cwd).flatMap((dir) =>
			listAgentsFromDir(dir, "builtin").map((agent) => agent.name),
		),
	);
}

async function listBuiltinAgentNamesAsync(cwd: string): Promise<Set<string>> {
	const names = new Set<string>();
	for (const dir of builtinAgentDirs(cwd)) {
		for (const agent of await listAgentsFromDirAsync(dir, "builtin")) {
			names.add(agent.name);
		}
	}
	return names;
}

function listDiscoverableAgents(cwd: string): AgentEntry[] {
	const builtinDirs = builtinAgentDirs(cwd);
	const agents = [
		...builtinDirs.flatMap((dir) => listAgentsFromDir(dir, "builtin")),
		...discoverableNonBuiltinAgentRoots(cwd).flatMap(({ dir, source }) =>
			listAgentsFromDir(dir, source),
		),
	];
	const byName = new Map<string, AgentEntry>();
	for (const agent of agents) byName.set(agent.name, agent);
	return orderDiscoverableAgents(Array.from(byName.values()));
}

async function listDiscoverableAgentsAsync(cwd: string): Promise<AgentEntry[]> {
	const builtinDirs = builtinAgentDirs(cwd);
	const agents: AgentEntry[] = [];
	for (const dir of builtinDirs) {
		agents.push(...(await listAgentsFromDirAsync(dir, "builtin")));
	}
	for (const { dir, source } of discoverableNonBuiltinAgentRoots(cwd)) {
		agents.push(...(await listAgentsFromDirAsync(dir, source)));
	}
	const byName = new Map<string, AgentEntry>();
	for (const agent of agents) byName.set(agent.name, agent);
	return orderDiscoverableAgents(Array.from(byName.values()));
}

function orderDiscoverableAgents(agents: AgentEntry[]): AgentEntry[] {
	const coreFirst = CORE_MODEL_AGENT_NAMES.map((name) =>
		agents.find((agent) => agent.name === name),
	).filter((agent): agent is AgentEntry => agent !== undefined);
	const rest = agents
		.filter((agent) => !CORE_MODEL_AGENT_NAME_SET.has(agent.name))
		.sort((left, right) => left.name.localeCompare(right.name));
	return [...coreFirst, ...rest];
}

function isClearRoutingEntry(entry: AgentRoutingEntry): boolean {
	return entry.model === undefined && entry.thinking === undefined;
}

function agentModelProfileConfigPath(cwd: string, source: AgentSource): string {
	return source === "project"
		? join(cwd, ".pi", "subagents.json")
		: join(gentlePiAgentHome(), "subagents.json");
}

function modelProfileForRoutingEntry(
	entry: AgentRoutingEntry | undefined,
): Record<string, string> | undefined {
	if (!entry || isClearRoutingEntry(entry)) return undefined;
	const profile: Record<string, string> = {};
	if (entry.model) profile.model = entry.model;
	if (entry.thinking) profile.effort = entry.thinking;
	return Object.keys(profile).length > 0 ? profile : undefined;
}

function updateSubagentModelProfileAtPath(
	path: string,
	name: string,
	entry: AgentRoutingEntry | undefined,
	options: { preserveExisting?: boolean } = {},
): boolean {
	let config: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (isRecord(parsed)) config = { ...parsed };
		} catch {
			config = {};
		}
	}
	const modelProfiles = isRecord(config.model_profiles)
		? { ...config.model_profiles }
		: {};
	const profile = modelProfileForRoutingEntry(entry);
	// A write that would leave the profile as it is (including removing a
	// profile that was never there) is not an update and touches no file.
	if (JSON.stringify(modelProfiles[name]) === JSON.stringify(profile)) return false;
	if (profile) {
		if (options.preserveExisting && isRecord(modelProfiles[name])) return false;
		modelProfiles[name] = profile;
	} else delete modelProfiles[name];
	if (Object.keys(modelProfiles).length > 0) config.model_profiles = modelProfiles;
	else delete config.model_profiles;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
	return true;
}

async function updateSubagentModelProfileAtPathAsync(
	path: string,
	name: string,
	entry: AgentRoutingEntry | undefined,
	options: { preserveExisting?: boolean } = {},
): Promise<boolean> {
	let config: Record<string, unknown> = {};
	if (await pathExists(path)) {
		try {
			const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
			if (isRecord(parsed)) config = { ...parsed };
		} catch {
			config = {};
		}
	}
	const modelProfiles = isRecord(config.model_profiles)
		? { ...config.model_profiles }
		: {};
	const profile = modelProfileForRoutingEntry(entry);
	// A write that would leave the profile as it is (including removing a
	// profile that was never there) is not an update and touches no file.
	if (JSON.stringify(modelProfiles[name]) === JSON.stringify(profile)) return false;
	if (profile) {
		if (options.preserveExisting && isRecord(modelProfiles[name])) return false;
		modelProfiles[name] = profile;
	} else delete modelProfiles[name];
	if (Object.keys(modelProfiles).length > 0) config.model_profiles = modelProfiles;
	else delete config.model_profiles;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
	return true;
}

function updateSubagentModelProfile(
	cwd: string,
	source: AgentSource,
	name: string,
	entry: AgentRoutingEntry | undefined,
	options: { preserveExisting?: boolean } = {},
): boolean {
	return updateSubagentModelProfileAtPath(
		agentModelProfileConfigPath(cwd, source),
		name,
		entry,
		options,
	);
}

function projectSettingsPath(cwd: string): string {
	return join(cwd, ".pi", "settings.json");
}

/**
 * Pi's own global settings file, which is where the orchestrator model lives.
 * Profiles own the three `default*` keys there; nothing else in this extension
 * reads or writes that file.
 */
function orchestratorSettingsPath(): string {
	return join(gentlePiAgentHome(), "settings.json");
}

function removeLegacyAgentOverridesFromSettings(
	settingsPath: string,
	settings: Record<string, unknown>,
): void {
	const subagents = isRecord(settings.subagents)
		? { ...settings.subagents }
		: undefined;
	if (!subagents) return;
	delete subagents.agentOverrides;
	if (Object.keys(subagents).length > 0) settings.subagents = subagents;
	else delete settings.subagents;
	mkdirSync(dirname(settingsPath), { recursive: true });
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function isValidJsonObjectFileOrMissing(path: string): boolean {
	if (!existsSync(path)) return true;
	try {
		return isRecord(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return false;
	}
}

const PROVIDER_REVIEW_ROLES = ["review-refuter", "review-validator"] as const;

function isProviderReviewRole(name: string): boolean {
	return PROVIDER_REVIEW_ROLES.some((role) => role === name);
}

function modelAssignmentNames(cwd: string): string[] {
	return [...new Set([
		...PROVIDER_REVIEW_ROLES,
		...listDiscoverableAgents(cwd).map((agent) => agent.name),
	])];
}

const PROVIDER_ROUTING_DEFAULT_LABELS = {
	model: "Pi persisted default model",
	effort: "Pi persisted default effort",
} as const;

type RoutingDefaultField = keyof typeof PROVIDER_ROUTING_DEFAULT_LABELS;

function routingDefaultLabel(name: string, field: RoutingDefaultField): string {
	return isProviderReviewRole(name) ? PROVIDER_ROUTING_DEFAULT_LABELS[field] : "inherit";
}

function migrateLegacyProjectModelOverrides(cwd: string): number {
	const settingsPath = projectSettingsPath(cwd);
	if (!existsSync(settingsPath)) return 0;
	let settings: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
		if (!isRecord(parsed)) return 0;
		settings = { ...parsed };
	} catch {
		return 0;
	}
	const subagents = isRecord(settings.subagents) ? settings.subagents : undefined;
	const agentOverrides = isRecord(subagents?.agentOverrides)
		? subagents.agentOverrides
		: undefined;
	if (!agentOverrides) return 0;
	const agentsByName = new Map(listDiscoverableAgents(cwd).map((agent) => [agent.name, agent]));
	const migratableEntries = Object.entries(agentOverrides)
		.filter(([name]) => !isProviderReviewRole(name))
		.map(([name, value]) => ({ name, entry: normalizeRoutingEntry(value) }))
		.filter((item): item is { name: string; entry: AgentRoutingEntry } =>
			item.entry !== undefined && !isClearRoutingEntry(item.entry),
		);
	const targetPaths = new Set(
		migratableEntries.map(({ name }) =>
			agentModelProfileConfigPath(cwd, agentsByName.get(name)?.source ?? "project"),
		),
	);
	if (![...targetPaths].every(isValidJsonObjectFileOrMissing)) return 0;
	let migrated = 0;
	for (const { name, entry } of migratableEntries) {
		const source = agentsByName.get(name)?.source ?? "project";
		if (updateSubagentModelProfile(cwd, source, name, entry, { preserveExisting: true })) migrated += 1;
	}
	removeLegacyAgentOverridesFromSettings(settingsPath, settings);
	return migrated;
}

async function updateSubagentModelProfileAsync(
	cwd: string,
	source: AgentSource,
	name: string,
	entry: AgentRoutingEntry | undefined,
	options: { preserveExisting?: boolean } = {},
): Promise<boolean> {
	return updateSubagentModelProfileAtPathAsync(
		agentModelProfileConfigPath(cwd, source),
		name,
		entry,
		options,
	);
}

export function applyModelConfig(
	cwd: string,
	config: AgentModelConfig,
): { updated: number; skipped: number } {
	let updated = 0;
	let skipped = 0;
	const seenAgents = new Set<string>();
	for (const agent of listDiscoverableAgents(cwd)) {
		if (isProviderReviewRole(agent.name)) continue;
		seenAgents.add(agent.name);
		const entry = config[agent.name];
		if (entry === undefined) {
			skipped += 1;
			continue;
		}
		if (agent.source === "builtin") {
			if (updateSubagentModelProfile(cwd, agent.source, agent.name, entry)) updated += 1;
			else skipped += 1;
			continue;
		}
		if (!agent.filePath || !existsSync(agent.filePath)) {
			skipped += 1;
		} else {
			const original = readFileSync(agent.filePath, "utf8");
			const next = updateFrontmatterRouting(original, entry);
			if (next === original) {
				skipped += 1;
			} else {
				if (!updatePackageManagedSddAgentOwnership(agent.filePath, original, next)) {
					writeFileSync(agent.filePath, next);
				}
				updated += 1;
			}
		}
		if (updateSubagentModelProfile(cwd, agent.source, agent.name, entry)) updated += 1;
		else skipped += 1;
	}
	for (const [name, entry] of Object.entries(config)) {
		if (isProviderReviewRole(name)) continue;
		// The orchestrator is routing, not an agent: its model lives in Pi's global
		// settings.json and must never reach subagents.json.
		if (isProfileOrchestratorKey(name)) continue;
		if (!seenAgents.has(name) && isClearRoutingEntry(entry)) {
			if (updateSubagentModelProfile(cwd, "user", name, entry)) updated += 1;
			else skipped += 1;
		}
	}
	return { updated, skipped };
}

export async function applyModelConfigAsync(
	cwd: string,
	config: AgentModelConfig,
): Promise<{ updated: number; skipped: number }> {
	let updated = 0;
	let skipped = 0;
	const seenAgents = new Set<string>();
	for (const agent of await listDiscoverableAgentsAsync(cwd)) {
		if (isProviderReviewRole(agent.name)) continue;
		seenAgents.add(agent.name);
		const entry = config[agent.name];
		if (entry === undefined) {
			skipped += 1;
			continue;
		}
		if (agent.source === "builtin") {
			if (await updateSubagentModelProfileAsync(cwd, agent.source, agent.name, entry))
				updated += 1;
			else skipped += 1;
			continue;
		}
		if (!agent.filePath || !(await pathExists(agent.filePath))) {
			skipped += 1;
		} else {
			const original = await readFile(agent.filePath, "utf8");
			const next = updateFrontmatterRouting(original, entry);
			if (next === original) {
				skipped += 1;
			} else {
				if (!updatePackageManagedSddAgentOwnership(agent.filePath, original, next)) {
					await writeFile(agent.filePath, next);
				}
				updated += 1;
			}
		}
		if (await updateSubagentModelProfileAsync(cwd, agent.source, agent.name, entry))
			updated += 1;
		else skipped += 1;
	}
	for (const [name, entry] of Object.entries(config)) {
		if (isProviderReviewRole(name)) continue;
		if (isProfileOrchestratorKey(name)) continue;
		if (!seenAgents.has(name) && isClearRoutingEntry(entry)) {
			if (await updateSubagentModelProfileAsync(cwd, "user", name, entry))
				updated += 1;
			else skipped += 1;
		}
	}
	return { updated, skipped };
}

export async function applySavedModelConfig(
	ctx: ExtensionContext,
	applyConfig: typeof applyModelConfigAsync = applyModelConfigAsync,
): Promise<{ updated: number; skipped: number; invalidPath?: string }> {
	const result = await readModelRoutingAuthorityAsync(
		modelConfigPath(ctx.cwd),
		legacyProjectModelConfigPath(ctx.cwd),
	);
	if (result.status === "invalid") {
		return { updated: 0, skipped: 0, invalidPath: result.path };
	}
	return applyConfig(
		ctx.cwd,
		result.status === "valid" ? result.config : {},
	);
}

function describeModelConfig(cwd: string, config: AgentModelConfig): string[] {
	return modelAssignmentNames(cwd).map((name) => {
		const entry = config[name];
		const model = entry?.model ?? routingDefaultLabel(name, "model");
		const thinking = entry?.thinking ?? routingDefaultLabel(name, "effort");
		return `${sanitizeTerminalText(name)}: model=${sanitizeTerminalText(model)}, effort=${sanitizeTerminalText(thinking)}`;
	});
}

async function getPiModelOptions(ctx: ExtensionContext): Promise<string[]> {
	const models = await ctx.modelRegistry.getAvailable();
	const modelIds = models
		.map((model) => normalizeModelId(`${model.provider}/${model.id}`))
		.filter((model): model is string => model !== undefined)
		.sort((left, right) => left.localeCompare(right));
	return [...MODEL_CONTROL_OPTIONS, ...modelIds];
}

interface OverlayComponent {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
}

type ModelPanelResult =
	| { type: "save"; config: AgentModelConfig }
	| { type: "custom"; agent: string | "all"; config: AgentModelConfig }
	| { type: "export"; config: AgentModelConfig }
	| { type: "restore"; config: AgentModelConfig }
	| { type: "cancel" };

const SET_ALL_AGENTS = "Set all agents";

const PANEL_TONE = {
	BORDER: "border",
	MUTED: "muted",
	TEXT: "text",
	TITLE: "title",
	ACCENT: "accent",
	STATUS: "status",
} as const;

type PanelTone = (typeof PANEL_TONE)[keyof typeof PANEL_TONE];

const PANEL_TONE_COLOR: Record<PanelTone, ThemeColor> = {
	border: "border",
	muted: "muted",
	text: "text",
	title: "accent",
	accent: "accent",
	status: "thinkingHigh",
};

class SddModelPanel implements OverlayComponent {
	private cursor = 0;
	private mode: "agents" | "models" | "effort" = "agents";
	private selectedRow = SET_ALL_AGENTS;
	private modelCursor = 0;
	private effortCursor = 0;
	private query = "";
	private readonly draft: AgentModelConfig;
	private readonly rows: string[];
	private readonly modelOptions: string[];
	private readonly done: (result: ModelPanelResult) => void;
	private readonly theme: Theme | undefined;

	constructor(
		initialConfig: AgentModelConfig,
		modelOptions: string[],
		agents: string[],
		done: (result: ModelPanelResult) => void,
		theme?: Theme,
	) {
		this.draft = cloneModelConfig(initialConfig);
		this.rows = [SET_ALL_AGENTS, ...agents];
		this.modelOptions = modelOptions;
		this.done = done;
		this.theme = theme;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.mode === "models") {
			this.handleModelInput(data);
			return;
		}
		if (this.mode === "effort") {
			this.handleEffortInput(data);
			return;
		}
		this.handleAgentInput(data);
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 4);
		const lines =
			this.mode === "models"
				? this.renderModelPicker(innerWidth)
				: this.mode === "effort"
					? this.renderEffortPicker(innerWidth)
					: this.renderAgentList(innerWidth);
		return this.renderCard(lines, width);
	}

	private renderCard(lines: string[], width: number): string[] {
		const innerWidth = Math.max(1, width - 4);
		const horizontal = "─".repeat(innerWidth + 2);
		const border = (text: string) => this.renderText(text, "border");
		return [
			border(`╭${horizontal}╮`),
			...lines.map(
				(line) =>
					`${border("│")} ${this.fitStyledLine(line, innerWidth)} ${border("│")}`,
			),
			border(`╰${horizontal}╯`),
		];
	}

	private fitStyledLine(line: string, width: number): string {
		const visible = stripAnsi(line);
		if (visible.length > width) {
			return truncateToWidth(visible, Math.max(1, width), "…", true);
		}
		return `${line}${" ".repeat(Math.max(0, width - visible.length))}`;
	}

	private renderLine(text = "", width: number, tone?: PanelTone): string {
		const safe = truncateToWidth(
			sanitizeTerminalText(text),
			Math.max(1, width),
			"…",
			true,
		);
		return tone ? this.renderText(safe, tone) : safe;
	}

	private renderText(text: string, tone: PanelTone): string {
		const safe = sanitizeTerminalText(text);
		if (!this.theme) return safe;
		return this.theme.fg(PANEL_TONE_COLOR[tone], safe);
	}

	private renderCursor(focused: boolean): string {
		return focused ? this.renderText("▸", "accent") : " ";
	}

	private handleAgentInput(data: string): void {
		const maxCursor = this.rows.length + 1;
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
			this.done({ type: "cancel" });
			return;
		}
		if (matchesKey(data, "ctrl+s")) {
			this.done({ type: "save", config: this.draft });
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.cursor = Math.min(maxCursor, this.cursor + 1);
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.cursor = Math.max(0, this.cursor - 1);
			return;
		}
		if (matchesKey(data, "g")) {
			this.cursor = 0;
			return;
		}
		if (data === "G") {
			this.cursor = maxCursor;
			return;
		}
		if (matchesKey(data, "i")) {
			this.applyInherit();
			return;
		}
		if (matchesKey(data, "e")) {
			this.selectedRow = this.rows[this.cursor] ?? SET_ALL_AGENTS;
			this.mode = "effort";
			this.effortCursor = 0;
			return;
		}
		if (matchesKey(data, "x")) {
			this.done({ type: "export", config: this.draft });
			return;
		}
		if (matchesKey(data, "r")) {
			this.done({ type: "restore", config: this.draft });
			return;
		}
		if (matchesKey(data, "c")) {
			const row = this.rows[this.cursor];
			if (row === SET_ALL_AGENTS)
				this.done({ type: "custom", agent: "all", config: this.draft });
			else if (row)
				this.done({ type: "custom", agent: row, config: this.draft });
			return;
		}
		if (!matchesKey(data, "return")) return;
		if (this.cursor === this.rows.length) {
			this.done({ type: "save", config: this.draft });
			return;
		}
		if (this.cursor === this.rows.length + 1) {
			this.done({ type: "cancel" });
			return;
		}
		this.selectedRow = this.rows[this.cursor] ?? SET_ALL_AGENTS;
		this.mode = "models";
		this.modelCursor = 0;
		this.query = "";
	}

	private handleModelInput(data: string): void {
		const options = this.filteredModelOptions();
		if (matchesKey(data, "ctrl+c")) {
			this.done({ type: "cancel" });
			return;
		}
		if (matchesKey(data, "escape")) {
			this.mode = "agents";
			this.query = "";
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.query = this.query.slice(0, -1);
			this.modelCursor = Math.min(
				this.modelCursor,
				Math.max(0, this.filteredModelOptions().length - 1),
			);
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.modelCursor = Math.min(
				Math.max(0, options.length - 1),
				this.modelCursor + 1,
			);
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.modelCursor = Math.max(0, this.modelCursor - 1);
			return;
		}
		if (matchesKey(data, "return")) {
			const selected = options[this.modelCursor];
			if (!selected) return;
			if (selected === CUSTOM_MODEL) {
				this.done({
					type: "custom",
					agent: this.selectedRow === SET_ALL_AGENTS ? "all" : this.selectedRow,
					config: this.draft,
				});
				return;
			}
			if (selected === KEEP_CURRENT) {
				this.mode = "agents";
				return;
			}
			this.applyModelSelection(
				selected === INHERIT_MODEL ? undefined : selected,
			);
			this.mode = "agents";
			return;
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.query += data;
			this.modelCursor = 0;
		}
	}

	private applyModelSelection(model: string | undefined): void {
		const row = this.rows[this.cursor];
		if (row === SET_ALL_AGENTS) {
			for (const name of this.rows.slice(1)) this.setModel(name, model);
			return;
		}
		if (!row) return;
		this.setModel(row, model);
	}

	private applyThinkingSelection(thinking: ThinkingLevel | undefined): void {
		const row = this.selectedRow;
		if (row === SET_ALL_AGENTS) {
			for (const name of this.rows.slice(1)) this.setThinking(name, thinking);
			return;
		}
		this.setThinking(row, thinking);
	}

	private applyInherit(): void {
		const row = this.rows[this.cursor];
		if (row === SET_ALL_AGENTS) {
			for (const name of this.rows.slice(1)) this.clearEntry(name);
			return;
		}
		if (row) this.clearEntry(row);
	}

	private setModel(name: string, model: string | undefined): void {
		const current = this.draft[name] ?? {};
		if (model === undefined) delete current.model;
		else current.model = model;
		if (!current.model && !current.thinking) this.draft[name] = {};
		else this.draft[name] = current;
	}

	private setThinking(name: string, thinking: ThinkingLevel | undefined): void {
		const current = this.draft[name] ?? {};
		if (thinking === undefined) delete current.thinking;
		else current.thinking = thinking;
		if (!current.model && !current.thinking) this.draft[name] = {};
		else this.draft[name] = current;
	}

	private clearEntry(name: string): void {
		this.draft[name] = {};
	}

	private filteredModelOptions(): string[] {
		const query = this.query.trim().toLowerCase();
		if (!query) return this.modelOptions;
		return this.modelOptions.filter((option) =>
			option.toLowerCase().includes(query),
		);
	}

	private renderAgentList(width: number): string[] {
		const lines: string[] = [];
		const line = (text = "", tone?: PanelTone) =>
			this.renderLine(text, width, tone);
		lines.push(line("Assign Models and Effort to Agents", "title"));
		lines.push("");
		lines.push(line("Current assignments:", "muted"));
		lines.push("");
		const visibleRows = Math.min(AGENT_LIST_MAX_VISIBLE_ROWS, this.rows.length);
		const listCursor = Math.min(this.cursor, this.rows.length - 1);
		const start = Math.max(
			0,
			Math.min(
				listCursor - Math.floor(visibleRows / 2),
				Math.max(0, this.rows.length - visibleRows),
			),
		);
		const end = Math.min(this.rows.length, start + visibleRows);
		if (start > 0) lines.push(line(`  ↑ ${start} more agent(s)`, "muted"));
		for (let i = start; i < end; i++) {
			const row = this.rows[i] ?? SET_ALL_AGENTS;
			const focused = i === this.cursor;
			const label =
				row === SET_ALL_AGENTS
					? this.renderSetAllLabel(row)
					: this.renderAgentLabel(row);
			lines.push(`${this.renderCursor(focused)} ${label}`);
		}
		if (end < this.rows.length)
			lines.push(line(`  ↓ ${this.rows.length - end} more agent(s)`, "muted"));
		lines.push("");
		lines.push(
			`${this.renderCursor(this.cursor === this.rows.length)} ${this.renderText(
				"Continue",
				this.cursor === this.rows.length ? "accent" : "text",
			)}`,
		);
		lines.push(
			`${this.renderCursor(this.cursor === this.rows.length + 1)} ${this.renderText(
				"← Back",
				this.cursor === this.rows.length + 1 ? "accent" : "text",
			)}`,
		);
		lines.push("");
		lines.push(
			line(
				`j/k scroll • enter model/save • e effort • i ${isProviderReviewRole(this.rows[this.cursor] ?? "") ? "Pi persisted defaults" : "inherit"} • c custom • x export • r restore • ctrl+s save • esc back`,
				"muted",
			),
		);
		return lines;
	}

	private renderModelPicker(width: number): string[] {
		const lines: string[] = [];
		const options = this.filteredModelOptions();
		const line = (text = "", tone?: PanelTone) =>
			this.renderLine(text, width, tone);
		lines.push(
			line(`Select model for ${sanitizeTerminalText(this.selectedRow)}`, "title"),
		);
		lines.push("");
		lines.push(
			`${this.renderText("◎", "accent")} ${this.renderText(this.query || "search...", "muted")}`,
		);
		lines.push("");
		const start = Math.max(
			0,
			Math.min(
				this.modelCursor - Math.floor(MODEL_LIST_MAX_VISIBLE_ROWS / 2),
				Math.max(0, options.length - MODEL_LIST_MAX_VISIBLE_ROWS),
			),
		);
		const end = Math.min(options.length, start + MODEL_LIST_MAX_VISIBLE_ROWS);
		for (let i = start; i < end; i++) {
			const focused = i === this.modelCursor;
			lines.push(
				`${this.renderCursor(focused)} ${this.renderText(
					options[i] === INHERIT_MODEL && isProviderReviewRole(this.selectedRow)
						? routingDefaultLabel(this.selectedRow, "model")
						: (options[i] ?? ""),
					focused ? "status" : "text",
				)}`,
			);
		}
		if (options.length === 0) lines.push(line("  No matching models", "muted"));
		lines.push("");
		lines.push(
			line("j/k: navigate • type: search • enter: select • esc: back", "muted"),
		);
		return lines;
	}

	private handleEffortInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.done({ type: "cancel" });
			return;
		}
		if (matchesKey(data, "escape")) {
			this.mode = "agents";
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.effortCursor = Math.min(
				Math.max(0, THINKING_OPTIONS.length - 1),
				this.effortCursor + 1,
			);
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.effortCursor = Math.max(0, this.effortCursor - 1);
			return;
		}
		if (!matchesKey(data, "return")) return;
		const selected = THINKING_OPTIONS[this.effortCursor];
		if (selected === INHERIT_THINKING) this.applyThinkingSelection(undefined);
		else this.applyThinkingSelection(selected);
		this.mode = "agents";
	}

	private renderEffortPicker(width: number): string[] {
		const lines: string[] = [];
		const line = (text = "", tone?: PanelTone) =>
			this.renderLine(text, width, tone);
		lines.push(
			line(`Select effort for ${sanitizeTerminalText(this.selectedRow)}`, "title"),
		);
		lines.push("");
		for (let i = 0; i < THINKING_OPTIONS.length; i++) {
			const focused = i === this.effortCursor;
			lines.push(
				`${this.renderCursor(focused)} ${this.renderText(
					THINKING_OPTIONS[i] === INHERIT_THINKING && isProviderReviewRole(this.selectedRow)
						? routingDefaultLabel(this.selectedRow, "effort")
						: (THINKING_OPTIONS[i] ?? ""),
					focused ? "status" : "text",
				)}`,
			);
		}
		lines.push("");
		lines.push(line("j/k: navigate • enter: select • esc: back", "muted"));
		return lines;
	}

	private renderSetAllLabel(row: string): string {
		const models = this.rows
			.slice(1)
			.map((name) => this.draft[name]?.model ?? routingDefaultLabel(name, "model"));
		const efforts = this.rows
			.slice(1)
			.map((name) => this.draft[name]?.thinking ?? routingDefaultLabel(name, "effort"));
		const firstModel = models[0] ?? "inherit";
		const firstEffort = efforts[0] ?? "inherit";
		const modelLabel = models.every((value) => value === firstModel)
			? firstModel
			: "mixed";
		const effortLabel = efforts.every((value) => value === firstEffort)
			? firstEffort
			: "mixed";
		return `${this.renderText(sanitizeTerminalText(row).padEnd(20), "text")} ${this.renderText("model=", "muted")}${this.renderText(modelLabel, "status")}${this.renderText(
			", effort=",
			"muted",
		)}${this.renderText(effortLabel, "status")}`;
	}

	private renderAgentLabel(row: string): string {
		const model = this.draft[row]?.model ?? routingDefaultLabel(row, "model");
		const effort = this.draft[row]?.thinking ?? routingDefaultLabel(row, "effort");
		return `${this.renderText(sanitizeTerminalText(row).padEnd(20), "text")} ${this.renderText("model=", "muted")}${this.renderText(model, "status")}${this.renderText(
			", effort=",
			"muted",
		)}${this.renderText(effort, "status")}`;
	}
}

function renderSddModelPanelForTesting(
	initialConfig: AgentModelConfig,
	modelOptions: string[],
	agents: string[],
	width: number,
	theme?: Theme,
): string[] {
	return new SddModelPanel(initialConfig, modelOptions, agents, () => {}, theme).render(
		width,
	);
}

async function showSddModelPanel(
	ctx: ExtensionContext,
	config: AgentModelConfig,
): Promise<ModelPanelResult> {
	const modelOptions = await getPiModelOptions(ctx);
	const agents = modelAssignmentNames(ctx.cwd);
	return ctx.ui.custom<ModelPanelResult>(
		(_tui, theme, _keybindings, done) =>
			new SddModelPanel(config, modelOptions, agents, done, theme),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "70%",
				minWidth: 72,
				maxHeight: "85%",
			},
		},
	);
}

async function handleModelsCommand(ctx: ExtensionContext): Promise<void> {
	migrateLegacyProjectModelOverrides(ctx.cwd);
	const savedConfig = await readModelRoutingAuthorityAsync(
		modelConfigPath(ctx.cwd),
		legacyProjectModelConfigPath(ctx.cwd),
	);
	if (savedConfig.status === "invalid") {
		ctx.ui.notify(
			`el Gentleman cannot open model config because ${savedConfig.path} is invalid JSON or not an object. Fix or remove the file, then run /gentle:models again.`,
			"warning",
		);
		return;
	}
	let config = savedConfig.status === "valid" ? savedConfig.config : {};
	let result = await showSddModelPanel(ctx, config);
	while (result.type === "custom" || result.type === "export" || result.type === "restore") {
		config = cloneModelConfig(result.config);
		if (result.type === "export") {
			try {
				const count = await exportSavedModelConfig(ctx);
				ctx.ui.notify(`el Gentleman exported ${count} saved model routing entr${count === 1 ? "y" : "ies"} to ${modelExportPath(ctx.cwd)}.`, "info");
			} catch (error) {
				ctx.ui.notify(`Model routing export failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
			result = await showSddModelPanel(ctx, config);
			continue;
		}
		if (result.type === "restore") {
			const restored = await readModelExport(ctx);
			if (!restored) {
				ctx.ui.notify(`Model routing restore failed: ${modelExportPath(ctx.cwd)} is missing or invalid.`, "warning");
				result = await showSddModelPanel(ctx, config);
				continue;
			}
			const approved = await ctx.ui.confirm("Restore saved model routing?", `Replace ${modelConfigPath(ctx.cwd)} with ${modelExportPath(ctx.cwd)}`);
			if (approved) {
				try {
					await writeModelConfigAsync(ctx.cwd, restored);
				} catch (error) {
					ctx.ui.notify(`Model routing restore failed before writing config: ${error instanceof Error ? error.message : String(error)}`, "warning");
					result = await showSddModelPanel(ctx, config);
					continue;
				}
				config = restored;
				try {
					const applyResult = await applyModelConfigAsync(ctx.cwd, restored);
					ctx.ui.notify([
						"el Gentleman restored global model config.",
						`Import: ${modelExportPath(ctx.cwd)}`,
						`Global config: ${modelConfigPath(ctx.cwd)}`,
						`Agents updated: ${applyResult.updated}`,
					].join("\n"), "info");
				} catch (error) {
					ctx.ui.notify([
						"el Gentleman restored global model config, but applying it to agents failed.",
						`Global config: ${modelConfigPath(ctx.cwd)}`,
						`Apply error: ${error instanceof Error ? error.message : String(error)}`,
					].join("\n"), "warning");
				}
			}
			result = await showSddModelPanel(ctx, config);
			continue;
		}
		const current =
			result.agent === "all"
				? "inherit"
				: (config[result.agent]?.model ?? "inherit");
		const custom = await ctx.ui.input(
			`${result.agent === "all" ? "all agents" : sanitizeTerminalText(result.agent)} custom model id`,
			current === "inherit" ? "provider/model" : sanitizeTerminalText(current),
		);
		if (custom === undefined) return;
		const trimmed = custom.trim();
		if (trimmed.length > 0) {
			const model = normalizeModelId(trimmed);
			if (!model) {
				ctx.ui.notify(
					"Custom model id must be a single-line provider/model identifier using letters, numbers, '.', '-', '_', '~', ':', '@', '/', '+', '%' only.",
					"warning",
				);
				result = await showSddModelPanel(ctx, config);
				continue;
			}
			if (result.agent === "all") {
				const next: AgentModelConfig = { ...config };
				for (const name of modelAssignmentNames(ctx.cwd)) {
					next[name] = {
						...(next[name] ?? {}),
						model,
					};
				}
				config = next;
			} else {
				config = {
					...config,
					[result.agent]: {
						...(config[result.agent] ?? {}),
						model,
					},
				};
			}
		}
		result = await showSddModelPanel(ctx, config);
	}
	if (result.type !== "save") return;
	writeModelConfig(ctx.cwd, result.config);
	const applyResult = await applyModelConfigAsync(ctx.cwd, result.config);
	ctx.ui.notify(
		[
			"el Gentleman global model config saved.",
			`Global config: ${modelConfigPath(ctx.cwd)}`,
			`Agents updated: ${applyResult.updated}`,
			...describeModelConfig(ctx.cwd, result.config),
		].join("\n"),
		"info",
	);
}

type ProfilesPanelResult =
	| { type: "apply"; name: string }
	| { type: "create" }
	| { type: "update"; name: string }
	| { type: "duplicate"; name: string }
	| { type: "rename"; name: string }
	| { type: "delete"; name: string }
	| { type: "export"; name: string }
	| { type: "import" }
	| { type: "close" };

type ProfilesSnapshotHandler = (name: string) => AgentProfilesFile;

const PROFILES_PANEL_MIN_BODY_ROWS = 6;

type ProfilesPanelPointerLayout = AgentsViewLayout & { listTop: number };

function hasOwnProfile(profiles: Record<string, unknown>, name: string): boolean {
	return Object.prototype.hasOwnProperty.call(profiles, name);
}

function profilesErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Keep a detail-pane scroll offset inside the bounds of its own content. */
function clampDetailScroll(offset: number, lineCount: number, bodyRows: number): number {
	return Math.max(0, Math.min(offset, Math.max(0, lineCount - bodyRows)));
}

// Left profile list, right detail panes. Rendering and pointer routing share
// one measured layout; the list rows keep native keyboard, hover, press,
// click, and wheel handling through NativeChoiceList. The frame takes the full
// overlay, so its height follows the terminal rows the same way AgentsView does.
class ProfilesPanel implements OverlayComponent {
	private completed = false;
	private pointerLayout: ProfilesPanelPointerLayout | undefined;
	private detailScroll = 0;
	private lastDetailLineCount = 0;
	private lastDetailRows = 0;
	private lastSelectedId: string | undefined;
	private feedback: string | undefined;
	readonly list: NativeChoiceList<ProfileListItem>;
	private file: AgentProfilesFile;
	private readonly currentConfig: AgentModelConfig;
	private readonly done: (result: ProfilesPanelResult) => void;
	private readonly saveSnapshot: ProfilesSnapshotHandler;
	private readonly requestRender: () => void;
	private readonly listItems: ProfileListItem[];
	private readonly theme: Theme | undefined;
	private readonly rows: () => number;
	private readonly orchestratorSettings: OrchestratorSettingsReadResult;

	constructor(
		file: AgentProfilesFile,
		currentConfig: AgentModelConfig,
		done: (result: ProfilesPanelResult) => void,
		keybindings: KeybindingsManager | undefined,
		theme: Theme | undefined,
		selectedName: string | undefined,
		rows: () => number,
		orchestratorSettings: OrchestratorSettingsReadResult,
		saveSnapshot: ProfilesSnapshotHandler,
		requestRender: () => void,
	) {
		this.file = file;
		this.currentConfig = currentConfig;
		this.done = done;
		this.saveSnapshot = saveSnapshot;
		this.requestRender = requestRender;
		this.theme = theme;
		this.rows = rows;
		this.orchestratorSettings = orchestratorSettings;
		const items = buildProfileListItems(file);
		this.listItems = items;
		this.list = new NativeChoiceList<ProfileListItem>(
			items,
			{
				selectedPrefix: (text) => this.renderText(text, "accent"),
				selectedText: (text) => this.renderText(text, "accent"),
				description: (text) => this.renderText(text, "muted"),
				hoverBackground: (text) => (this.theme ? this.theme.bg("toolPendingBg", text) : text),
			},
			keybindings,
		);
		this.list.onSelect = (item) => this.finish({ type: "apply", name: item.id });
		this.list.onCancel = () => this.finish({ type: "close" });
		const selected = selectedName ? items.findIndex((item) => item.id === selectedName) : -1;
		if (selected >= 0) this.list.setSelectedIndex(selected);
	}

	invalidate(): void {
		this.pointerLayout = undefined;
		this.list.invalidate();
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
			this.finish({ type: "close" });
			return;
		}
		const name = this.list.getSelectedItem()?.id;
		if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("j"))) {
			this.scrollDetail(this.pageRows());
			return;
		}
		if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("k"))) {
			this.scrollDetail(-this.pageRows());
			return;
		}
		// Agents-view line scroll: j/k move the routing one line at a time. The
		// arrow keys stay with the profile list, exactly as the letters below stay
		// profile actions.
		if (data === "j") {
			this.scrollDetail(1);
			return;
		}
		if (data === "k") {
			this.scrollDetail(-1);
			return;
		}
		if (data === "c") return this.finish({ type: "create" });
		if (data === "i") return this.finish({ type: "import" });
		if (!name) return this.list.handleInput(data);
		if (data === "s") {
			try {
				this.file = this.saveSnapshot(name);
				this.refreshListItems();
				this.feedback = `Snapshot saved; live routing unchanged. Profile "${name}" saved from current routing.`;
			} catch (error) {
				this.feedback = `Snapshot failed; live routing unchanged. Profile "${name}" was not saved from current routing: ${profilesErrorMessage(error)}`;
			}
			this.requestRender();
			return;
		}
		if (data === "d") return this.finish({ type: "duplicate", name });
		if (data === "r") return this.finish({ type: "rename", name });
		if (data === "x") return this.finish({ type: "delete", name });
		if (data === "e") return this.finish({ type: "export", name });
		this.list.handleInput(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const layout = this.pointerLayout;
		if (!layout) return undefined;
		const inBody = event.y >= layout.listTop && event.y < layout.listTop + layout.bodyRows;
		if (
			inBody &&
			event.type === "wheel" &&
			event.wheelDelta &&
			layout.mode === "panes" &&
			event.x >= layout.threadX &&
			event.x < layout.threadX + layout.threadWidth
		) {
			this.scrollDetail(event.wheelDelta);
			return { handled: true, render: true };
		}
		if (!inBody) return undefined;
		if (event.x < layout.listX || event.x >= layout.listX + layout.listWidth) return undefined;
		return this.list.handleMouse({
			...event,
			x: event.x - layout.listX,
			y: event.y - layout.listTop,
			width: layout.listWidth,
			height: layout.bodyRows,
		});
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const listWidth = measureAgentsViewLayout(safeWidth, PROFILES_PANEL_MIN_BODY_ROWS + 3).listWidth;
		const listLines = this.list.render(listWidth);
		// The frame fills the overlay, and the overlay fills the terminal, so the
		// body height comes from the terminal rows rather than from the content.
		const rows = Math.max(PROFILES_PANEL_MIN_BODY_ROWS + 3, Math.floor(this.rows()));
		const layout = measureAgentsViewLayout(safeWidth, rows);
		if (layout.mode === "fallback" || layout.width === 0) {
			this.pointerLayout = undefined;
			return [];
		}
		const selectedId = this.list.getSelectedItem()?.id;
		if (selectedId !== this.lastSelectedId) {
			this.lastSelectedId = selectedId;
			this.detailScroll = 0;
		}
		const detailLines = this.renderDetailLines(layout.threadWidth, layout.mode === "panes");
		this.lastDetailLineCount = detailLines.length;
		this.lastDetailRows = layout.bodyRows;
		this.detailScroll = clampDetailScroll(this.detailScroll, detailLines.length, layout.bodyRows);
		this.pointerLayout = { ...layout, listTop: 1 };
		const rule = "─".repeat(Math.max(0, layout.width - 2));
		const lines: string[] = [this.renderText(`╭${rule}╮`, "border")];
		for (let row = 0; row < layout.bodyRows; row += 1) {
			lines.push(this.renderBodyRow(row, layout, listLines, detailLines));
		}
		lines.push(this.renderFooterRow(layout.width));
		lines.push(this.renderText(`╰${rule}╯`, "border"));
		return lines;
	}

	private scrollDetail(delta: number): void {
		this.detailScroll = clampDetailScroll(
			this.detailScroll + Math.trunc(delta),
			this.lastDetailLineCount,
			this.lastDetailRows,
		);
	}

	private refreshListItems(): void {
		// Keep the list instance (and its pointer observer) alive while refreshing the
		// mutable item records that NativeChoiceList already holds by reference.
		for (const item of buildProfileListItems(this.file)) {
			const current = this.listItems.find((candidate) => candidate.id === item.id);
			if (current) Object.assign(current, item);
		}
		this.list.refreshItems();
	}

	private pageRows(): number {
		return Math.max(1, this.lastDetailRows - 1);
	}

	private finish(result: ProfilesPanelResult): void {
		if (this.completed) return;
		this.completed = true;
		this.list.setDisabled(true);
		this.done(result);
	}

	private renderBodyRow(
		row: number,
		layout: AgentsViewLayout,
		listLines: string[],
		detailLines: string[],
	): string {
		if (layout.mode === "panes") {
			return [
				this.renderText("│", "border"),
				" ",
				this.fitPaneLine(listLines[row] ?? "", layout.listWidth),
				" ",
				this.renderText("│", "border"),
				" ",
				this.fitPaneLine(detailLines[this.detailScroll + row] ?? "", layout.threadWidth),
				this.renderText("│", "border"),
			].join("");
		}
		return [
			this.renderText("│", "border"),
			" ",
			this.fitPaneLine(listLines[row] ?? "", layout.listWidth),
			" ",
			this.renderText("│", "border"),
		].join("");
	}

	private renderFooterRow(width: number): string {
		const hints =
			"enter apply · c create · s snapshot · d duplicate · r rename · x delete · e export · i import · j/k line · ctrl+j/k page · esc close";
		const text = this.feedback ?? hints;
		return [
			this.renderText("│", "border"),
			" ",
			this.fitPaneLine(this.renderText(text, this.feedback ? "status" : "muted"), width - 4),
			" ",
			this.renderText("│", "border"),
		].join("");
	}

	private renderDetailLines(width: number, showDetail: boolean): string[] {
		if (!showDetail) return [];
		const name = this.list.getSelectedItem()?.id;
		if (!name || !hasOwnProfile(this.file.profiles, name)) {
			return [this.renderLine("No profile selected.", width, "muted")];
		}
		const config = this.file.profiles[name];
		const profileRows = profileRoutingRows(config);
		const currentRows = profileRoutingRows(this.currentConfig);
		// One shared measurement across both tables, so the same agent sits in the
		// same column whether it comes from the profile or from models.json.
		const widths = routingColumnWidths(profileRows, currentRows);
		return [
			this.renderLine(name === this.file.active ? `${name} (active)` : name, width, "title"),
			this.renderLine(
				`orchestrator  ${formatOrchestratorSelection(readProfileOrchestrator(config))}`,
				width,
				"text",
			),
			this.renderLine(`now           ${this.effectiveOrchestratorLabel()}`, width, "muted"),
			"",
			this.renderLine("Profile routing", width, "accent"),
			...this.indentLines(this.routingLines(profileRows, widths), width),
			"",
			this.renderLine("Current routing (effective)", width, "accent"),
			...this.indentLines(this.routingLines(currentRows, widths), width),
		];
	}

	private effectiveOrchestratorLabel(): string {
		const settings = this.orchestratorSettings;
		if (settings.status === "invalid") {
			return `unreadable (${sanitizeTerminalText(settings.reason)})`;
		}
		return formatOrchestratorSelection(settings.status === "valid" ? settings.entry : undefined);
	}

	private routingLines(
		rows: ProfileRoutingRow[],
		widths: { agent: number; model: number },
	): string[] {
		if (rows.length === 0) {
			return ["No routing entries — every agent inherits its default model."];
		}
		return rows.map((row) => formatRoutingRow(row, widths));
	}

	private indentLines(lines: string[], width: number): string[] {
		return lines.map((line) => this.renderLine(`  ${line}`, width, "text"));
	}

	private fitPaneLine(line: string, width: number): string {
		const visible = stripAnsi(line);
		if (visible.length > width) {
			return truncateToWidth(visible, Math.max(1, width), "…", true);
		}
		return `${line}${" ".repeat(Math.max(0, width - visible.length))}`;
	}

	private renderLine(text: string, width: number, tone?: PanelTone): string {
		const safe = truncateToWidth(
			sanitizeTerminalText(text),
			Math.max(1, width),
			"…",
			true,
		);
		return tone ? this.renderText(safe, tone) : safe;
	}

	private renderText(text: string, tone: PanelTone): string {
		const safe = sanitizeTerminalText(text);
		if (!this.theme) return safe;
		return this.theme.fg(PANEL_TONE_COLOR[tone], safe);
	}
}

async function showProfilesPanel(
	ctx: ExtensionContext,
	file: AgentProfilesFile,
	currentConfig: AgentModelConfig,
	selectedName: string | undefined,
	saveSnapshot: ProfilesSnapshotHandler,
): Promise<ProfilesPanelResult> {
	// Read once, for the panel lifetime. The orchestrator shown as "now" is the
	// state the panel opened on, not a value that changes mid-panel.
	const orchestratorSettings = readOrchestratorSettings(orchestratorSettingsPath());
	return ctx.ui.custom<ProfilesPanelResult>(
		(tui, theme, keybindings, done) => {
			const panel = new ProfilesPanel(
				file,
				currentConfig,
				done,
				keybindings,
				theme,
				selectedName,
				() => Math.max(0, tui.terminal.rows),
				orchestratorSettings,
				saveSnapshot,
				() => tui.requestRender(),
			);
			const container = createNativeFullscreenInteraction({
				keyboardTarget: panel,
				requestRender: () => tui.requestRender(),
				mouseObserver: panel.list.createMouseObserver(() => tui.requestRender()),
			});
			container.addChild(panel);
			return container;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
			},
		},
	);
}

function reportProfilesDrops(ctx: ExtensionContext, path: string, drops: ProfilesParseDrops): void {
	// Dropped names are by definition the ones that failed validation, so they are
	// untrusted input reaching the terminal and must be sanitized like any other
	// externally supplied text.
	const parts: string[] = [];
	if (drops.droppedProfiles.length > 0) {
		parts.push(`profiles: ${drops.droppedProfiles.map((name) => sanitizeTerminalText(name)).join(", ")}`);
	}
	if (drops.droppedAgents.length > 0) {
		parts.push(
			`routing entries: ${drops.droppedAgents.map(({ profile, agent }) => `${sanitizeTerminalText(profile)}/${sanitizeTerminalText(agent)}`).join(", ")}`,
		);
	}
	if (drops.droppedActive !== undefined) {
		parts.push(`active marker: ${sanitizeTerminalText(drops.droppedActive)}`);
	}
	if (parts.length > 0) {
		ctx.ui.notify(
			`el Gentleman dropped invalid entries while loading ${sanitizeTerminalText(path)} — ${parts.join("; ")}.`,
			"warning",
		);
	}
}

function profileSnapshotFrom(
	current: AgentModelConfig,
	settings: OrchestratorSettingsReadResult,
): AgentModelConfig {
	const snapshot = cloneModelConfig(current);
	if (settings.status === "valid" && settings.entry !== undefined) {
		snapshot[PROFILE_ORCHESTRATOR_KEY] = { ...settings.entry };
	}
	return snapshot;
}

async function runProfilesPanelAction(
	ctx: ExtensionContext,
	path: string,
	file: AgentProfilesFile,
	result: Exclude<ProfilesPanelResult, { type: "close" }>,
): Promise<AgentProfilesFile> {
	switch (result.type) {
		case "apply": {
			if (!hasOwnProfile(file.profiles, result.name)) return file;
			const normalized = normalizeModelConfig(file.profiles[result.name]) ?? {};
			const orchestratorEntry = readProfileOrchestrator(normalized);
			// Applying spans three files — the store, models.json, and Pi's global
			// settings.json — and there is no cross-file rename, so order the writes to
			// keep the store truthful and compensate on failure: claim the profile in
			// the store first, then materialise routing, then the orchestrator. A claim
			// that fails leaves routing untouched; anything that fails after the claim
			// restores the previous claim and, when the previously active profile is
			// known, the routing that profile implies.
			const claimed = setActiveProfile(file, result.name);
			try {
				writeProfilesFileSync(path, claimed);
			} catch (error) {
				ctx.ui.notify(
					`el Gentleman could not update ${sanitizeTerminalText(path)}: ${profilesErrorMessage(error)}`,
					"warning",
				);
				return file;
			}
			const previousActiveConfig =
				file.active !== undefined && hasOwnProfile(file.profiles, file.active)
					? normalizeModelConfig(file.profiles[file.active]) ?? {}
					: undefined;
			// Set only when the orchestrator write succeeded, so the revert knows it has
			// something to undo. A rollback closure (not a previous-bytes value) is used
			// because "the file did not exist before" is a real state that must restore
			// by removing the file, and `undefined` bytes cannot carry that distinction.
			let orchestratorRollback: (() => void) | undefined;
			const revertClaim = async (routingWritten: boolean): Promise<AgentProfilesFile> => {
				let restored = previousActiveConfig === undefined ? "" : "routing";
				if (routingWritten && previousActiveConfig !== undefined) {
					try {
						await writeModelConfigAsync(ctx.cwd, previousActiveConfig);
						// Materialize the previous profile again with the same
						// replacement semantics, so the failed profile's routes do not
						// linger in subagents.json or the agent frontmatter.
						await applyModelConfigAsync(
							ctx.cwd,
							await withOmittedAgentsClearedAsync(ctx.cwd, previousActiveConfig),
						);
					} catch {
						restored = "";
					}
				}
				if (orchestratorRollback) {
					try {
						orchestratorRollback();
						restored = restored === "" ? "settings" : `${restored} and settings`;
					} catch {
						restored = restored === "" ? "" : restored;
					}
				}
				try {
					writeProfilesFileSync(path, file);
					restored = restored === "" ? "active marker" : `${restored} and active marker`;
				} catch {
					restored = restored === "" ? "nothing" : restored;
				}
				const unresolved =
					routingWritten && previousActiveConfig === undefined
						? ` ${sanitizeTerminalText(modelConfigPath(ctx.cwd))} still holds this profile's routing because no previously active profile was recorded to restore.`
						: "";
				ctx.ui.notify(
					`el Gentleman could not apply profile "${result.name}". Restored: ${restored}.${unresolved}`,
					"warning",
				);
				return file;
			};
			try {
				await writeModelConfigAsync(ctx.cwd, normalized);
			} catch (error) {
				ctx.ui.notify(
					`el Gentleman could not write ${sanitizeTerminalText(modelConfigPath(ctx.cwd))}: ${profilesErrorMessage(error)}`,
					"warning",
				);
				return revertClaim(false);
			}
			// models.json holds the profile as written; the padding with clear
			// entries only drives materialization, so agents the profile omits
			// return to inherit instead of keeping a previously materialized route.
			let applyResult: { updated: number; skipped: number };
			try {
				applyResult = await applyModelConfigAsync(
					ctx.cwd,
					await withOmittedAgentsClearedAsync(ctx.cwd, normalized),
				);
			} catch (error) {
				ctx.ui.notify(
					`el Gentleman could not materialize profile "${result.name}": ${profilesErrorMessage(error)}`,
					"warning",
				);
				return revertClaim(true);
			}
			let orchestratorNote = "";
			if (orchestratorEntry !== undefined) {
				const settingsPath = orchestratorSettingsPath();
				const written = applyOrchestratorSettings(settingsPath, orchestratorEntry);
				if (written.status === "invalid") {
					ctx.ui.notify(
						`el Gentleman could not set the orchestrator from profile "${result.name}": ${sanitizeTerminalText(written.reason)}. ${sanitizeTerminalText(settingsPath)} was left unchanged.`,
						"warning",
					);
					return revertClaim(true);
				}
				if (written.status === "written") {
					const previous = written.previous;
					orchestratorRollback = () => restoreOrchestratorSettings(settingsPath, previous);
					orchestratorNote = `\nOrchestrator set to ${formatOrchestratorSelection(orchestratorEntry)} in ${sanitizeTerminalText(settingsPath)}.`;
				}
			}
			ctx.ui.notify(
				[
					`el Gentleman applied profile "${result.name}" — ${applyResult.updated} agent${applyResult.updated === 1 ? "" : "s"} updated.`,
					"New routing takes effect on the next subagent launch.",
				].join("\n") + orchestratorNote,
				"info",
			);
			return claimed;
		}
		case "create": {
			const name = await ctx.ui.input("New profile name", "e.g. deep-work");
			if (name === undefined) return file;
			try {
				const next = createProfile(file, name.trim(), {});
				writeProfilesFileSync(path, next);
				return next;
			} catch (error) {
				ctx.ui.notify(`Profile not created: ${profilesErrorMessage(error)}`, "warning");
				return file;
			}
		}
		case "update": {
			// A profile is a complete snapshot, so capturing the current routing also
			// captures the orchestrator the routing is running under. A settings file
			// that cannot be read leaves the snapshot without an orchestrator entry
			// rather than inventing one.
			const snapshot = profileSnapshotFrom(
				await readEffectiveModelConfigAsync(ctx.cwd),
				readOrchestratorSettings(orchestratorSettingsPath()),
			);
			try {
				const next = updateProfile(file, result.name, snapshot);
				writeProfilesFileSync(path, next);
				ctx.ui.notify(
					`el Gentleman updated profile "${result.name}" from the current routing in ${modelConfigPath(ctx.cwd)}.`,
					"info",
				);
				return next;
			} catch (error) {
				ctx.ui.notify(`Profile not updated: ${profilesErrorMessage(error)}`, "warning");
				return file;
			}
		}
		case "duplicate": {
			const name = await ctx.ui.input(`Duplicate profile "${result.name}" as`, `${result.name}-copy`);
			if (name === undefined) return file;
			try {
				const next = duplicateProfile(file, result.name, name.trim());
				writeProfilesFileSync(path, next);
				return next;
			} catch (error) {
				ctx.ui.notify(`Profile not duplicated: ${profilesErrorMessage(error)}`, "warning");
				return file;
			}
		}
		case "rename": {
			const name = await ctx.ui.input(`Rename profile "${result.name}" to`, result.name);
			if (name === undefined) return file;
			try {
				const next = renameProfile(file, result.name, name.trim());
				writeProfilesFileSync(path, next);
				return next;
			} catch (error) {
				ctx.ui.notify(`Profile not renamed: ${profilesErrorMessage(error)}`, "warning");
				return file;
			}
		}
		case "delete": {
			const approved = await ctx.ui.confirm(
				"Delete profile?",
				`Delete profile "${result.name}" from ${path}? The routing in ${modelConfigPath(ctx.cwd)} is not changed.`,
			);
			if (!approved) return file;
			try {
				const next = deleteProfile(file, result.name);
				writeProfilesFileSync(path, next);
				return next;
			} catch (error) {
				ctx.ui.notify(`Profile not deleted: ${profilesErrorMessage(error)}`, "warning");
				return file;
			}
		}
		case "export": {
			if (!hasOwnProfile(file.profiles, result.name)) return file;
			const exportPath = profileExportPath(gentleAiConfigHome());
			try {
				const text = serializeProfileExport(result.name, file.profiles[result.name]);
				await mkdir(dirname(exportPath), { recursive: true });
				await writeFile(exportPath, text);
				ctx.ui.notify(`el Gentleman exported profile "${result.name}" to ${exportPath}.`, "info");
			} catch (error) {
				ctx.ui.notify(`Profile export failed: ${profilesErrorMessage(error)}`, "warning");
			}
			return file;
		}
		case "import": {
			const importPath = profileExportPath(gentleAiConfigHome());
			let text: string;
			try {
				text = await readFile(importPath, "utf8");
			} catch {
				ctx.ui.notify(`Profile import failed: ${importPath} is missing or unreadable.`, "warning");
				return file;
			}
			const parsed = parseProfileExportTextWithDrops(text);
			if (!parsed) {
				ctx.ui.notify(
					`Profile import failed: ${importPath} is not a valid agent-model profile export.`,
					"warning",
				);
				return file;
			}
			if (parsed.droppedAgents.length > 0) {
				ctx.ui.notify(
					`el Gentleman dropped invalid routing entries while importing profile "${parsed.name}": ${parsed.droppedAgents.join(", ")}.`,
					"warning",
				);
			}
			if (hasOwnProfile(file.profiles, parsed.name)) {
				const approved = await ctx.ui.confirm(
					"Replace existing profile?",
					`Profile "${parsed.name}" already exists in ${path}. Replace its routing with the import?`,
				);
				if (!approved) return file;
			}
			try {
				const next = hasOwnProfile(file.profiles, parsed.name)
					? updateProfile(file, parsed.name, parsed.config)
					: createProfile(file, parsed.name, parsed.config);
				writeProfilesFileSync(path, next);
				const entries = Object.keys(parsed.config).length;
				ctx.ui.notify(
					`el Gentleman imported profile "${parsed.name}" (${entries} routing ${entries === 1 ? "entry" : "entries"}) from ${importPath}.`,
					"info",
				);
				return next;
			} catch (error) {
				ctx.ui.notify(`Profile import failed: ${profilesErrorMessage(error)}`, "warning");
				return file;
			}
		}
	}
}

async function handleProfilesCommand(ctx: ExtensionContext): Promise<void> {
	const path = profilesFilePath(gentleAiConfigHome());
	const read = readProfilesFileResult(path);
	if (read.status === "invalid") {
		ctx.ui.notify(
			`el Gentleman cannot open agent profiles because ${path} is invalid JSON or not a profiles file. Fix or remove the file, then run /gentle:profiles again.`,
			"warning",
		);
		return;
	}
	let file: AgentProfilesFile;
	if (read.status === "missing") {
		file = bootstrapProfilesFile(await readEffectiveModelConfigAsync(ctx.cwd));
		try {
			writeProfilesFileSync(path, file);
		} catch (error) {
			ctx.ui.notify(
				`el Gentleman could not create ${path}: ${profilesErrorMessage(error)}`,
				"warning",
			);
			return;
		}
		ctx.ui.notify(`el Gentleman seeded the "current" profile in ${path} from the routing currently in effect.`, "info");
	} else {
		file = read.file;
		reportProfilesDrops(ctx, path, read.drops);
	}
	const saveSnapshot: ProfilesSnapshotHandler = (name) => {
		const next = updateProfile(
			file,
			name,
			profileSnapshotFrom(
				readEffectiveModelConfig(ctx.cwd),
				readOrchestratorSettings(orchestratorSettingsPath()),
			),
		);
		writeProfilesFileSync(path, next);
		file = next;
		return next;
	};
	let selectedName: string | undefined;
	let result = await showProfilesPanel(
		ctx,
		file,
		await readEffectiveModelConfigAsync(ctx.cwd),
		selectedName,
		saveSnapshot,
	);
	while (result.type !== "close") {
		selectedName = "name" in result ? result.name : undefined;
		file = await runProfilesPanelAction(ctx, path, file, result);
		result = await showProfilesPanel(
			ctx,
			file,
			await readEffectiveModelConfigAsync(ctx.cwd),
			selectedName,
			saveSnapshot,
		);
	}
}

async function handlePersonaCommand(ctx: ExtensionContext): Promise<void> {
	const current = readPersonaMode(ctx.cwd);
	const selected = await ctx.ui.select(
		`el Gentleman persona (current: ${current})`,
		[...PERSONA_OPTIONS],
	);
	if (selected !== "gentleman" && selected !== "neutral") return;
	const writtenPaths = writePersonaMode(ctx.cwd, selected);
	ctx.ui.notify(
		[
			`el Gentleman persona set to: ${selected}`,
			`Global config: ${personaConfigPath(ctx.cwd)}`,
			...(writtenPaths.length > 1
				? [`Project override updated: ${projectPersonaConfigPath(ctx.cwd)}`]
				: []),
			"Run /reload or start a new Pi session for already-injected prompts to refresh.",
		].join("\n"),
		"info",
	);
}

// ---------------------------------------------------------------------------
// Review gate helpers — pure, exported via __testing for unit tests
// ---------------------------------------------------------------------------

const REVIEW_CONTROLLER_OPERATION = {
	START: "start",
	ANSWER_CONSENT: "answer-consent",
	ADVANCE: "advance",
	ACKNOWLEDGE_APPROVED: "acknowledge-approved",
	STATUS: "status",
	SELECT_INTENDED_UNTRACKED: "select-intended-untracked",
	EXPORT: "export",
	IMPORT: "import",
	INSPECT: "inspect",
	RESET: "reset",
	RECOVER: "recover",
	RECOVER_LOCK: "recover-lock",
	ABANDON: "abandon",
	QUARANTINE_LEGACY: "quarantine-legacy",
	RECONCILE_AUTHORITY: "reconcile-authority",
	REPAIR_LEGACY_ALIAS: "repair-legacy-alias",
	REPAIR: "repair",
	// gentle-pi#662: read-only native risk assessment (gentle-ai#4295). Never
	// mutates review authority state and never requires a lineageId.
	ASSESS: "assess",
} as const;

type ReviewControllerOperation =
	(typeof REVIEW_CONTROLLER_OPERATION)[keyof typeof REVIEW_CONTROLLER_OPERATION];

function reviewToolOperationPath(args: unknown): string {
	const operation = isRecord(args) ? args.operation : undefined;
	if (
		typeof operation !== "string" ||
		!Object.values(REVIEW_CONTROLLER_OPERATION).includes(operation as ReviewControllerOperation)
	) {
		return "review";
	}
	return `review ${operation.replaceAll("-", " ")}`;
}

const REVIEW_CONTROLLER_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	required: ["operation"],
	properties: {
		operation: {
			type: "string",
			enum: Object.values(REVIEW_CONTROLLER_OPERATION),
			description: "Controller operation. Inspect authority before start. Reset requires the exact challenge returned by inspect.",
		},
		lineageId: {
			type: "string",
			description: "Bounded review lineage identifier. A failed start creates no lineage; do not use it with status or advance.",
		},
		selectionBinding: { type: "string", description: "Opaque provider-issued pre-lineage intended-untracked selection binding." },
		intendedUntracked: { type: "array", items: { type: "string" }, description: 'Repository-relative paths selected from the provider binding; on inspect they are accepted only with untrackedScope "select".' },
		untrackedScope: { type: "string", enum: ["exclude", "select"], description: 'Inspect-only: resolve the intended-untracked selection stop in one call. "exclude" excludes every eligible untracked path and forbids intendedUntracked; "select" includes exactly the supplied intendedUntracked paths.' },
		changeName: {
			type: "string",
			description: "Canonical OpenSpec change name required to resolve a recovered authority during lifecycle validate.",
		},
		idempotencyKey: {
			type: "string",
			description: "Required for graph-v1 start and advance operations.",
		},
		transition: {
			type: "string",
			description: "A supported REVIEW_TRANSITION value for advance.",
		},
		input: {
			type: "string",
			description: "A JSON-serialized object string, not a nested object. New native ordinary START uses {\"mode\":\"ordinary\"}; answer-consent uses exactly {\"consentBinding\":\"<opaque id>\",\"answer\":\"granted|declined\"}. Ordinary provider capture belongs only to gentle_review_capture. An explicit baseRef requires committedOnly: true and requests a committed range, while repository-local policyPath remains optional. ASSESS accepts an optional object with baseRef, committedOnly, writerModelId, writerEffort, and nativeReviewOutcome (gentle-pi#662/#668); omitting writerModelId and writerEffort assesses the ambient working tree and fails closed to a small writer profile (never large) because the writer's actual profile is unknown to this call. nativeReviewOutcome (one of closed, declined, unavailable, unknown) tells ASSESS whether the native review actually closed for this candidate: when Receipt-driven development reads on but the review was declined for this candidate, is unavailable, or its outcome is unknown, ASSESS falls back to the exact risk-gated plan it returns when RDD is off, re-enabling the separate verifier -- a decline is candidate-scoped and never lowers the bar below the RDD-off path. Omitting it lets ASSESS try to derive declined/unavailable from what this process itself recorded for this exact candidate (never a different one, and never from repository state alone), failing closed to unknown when it cannot; `closed` is never derived -- pass it explicitly, and only right after acknowledging the approved review for this same candidate. The returned outcome_source (explicit|derived|unknown) says which of these produced the value. Legacy controller input remains separate.",
		},
		outputPath: { type: "string", description: "Retired with legacy bundle export; ignored. Export returns legacy-operation-retired." },
		inputPath: { type: "string", description: "Repository-local JSON input file for the separate legacy controller flow (alternative to input). Legacy bundle import is retired." },
		operationId: { type: "string", description: "Retired with legacy bundle transport; ignored. Export/import return legacy-operation-retired." },
		lineageIds: { type: "string", description: "Retired with legacy bundle export; ignored. Export returns legacy-operation-retired." },
		workspaceRoot: {
			type: "string",
			description: "Optional explicit user-authorized absolute path inside the Git worktree that owns this review. It must resolve to an existing Git worktree; nested paths are canonicalized to that worktree root. Pi never invents this selector. Absent, the session cwd is used unless one unambiguous lineage binding already identifies its target root.",
		},
	},
} as const;

const REVIEW_CAPTURE_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	required: ["lineageId", "collectBinding"],
	properties: {
		lineageId: {
			type: "string",
			minLength: 1,
			description: "Exact lineage from the current provider-issued collect transition.",
		},
		collectBinding: {
			type: "string",
			minLength: 1,
			description: "JSON-serialized exact copy of one decoded provider-owned next_transition.collect input from current STATUS.",
		},
		reviewerRunAcknowledged: {
			type: "boolean",
			description: "Required only after the one-slot materialize reviewer forecast; authorizes exactly one Pi host-relay run.",
		},
		correctionLines: {
			type: "integer",
			minimum: 1,
			description: "Positive correction-line plan in diff lines: one replaced source line counts as two (one deletion plus one addition). A different unit from the provider's frozen logical correction budget. Accepted only for the selected provider correction-plan slot and within its exact bounds.",
		},
		workspaceRoot: {
			type: "string",
			description: "Optional explicit existing Git worktree root, resolved with the controller's worktree confinement semantics.",
		},
	},
} as const;

interface ReviewCaptureParameters {
	lineageId: string;
	collectBinding: string;
	reviewerRunAcknowledged?: boolean;
	correctionLines?: number;
	workspaceRoot?: string;
}

const REVIEW_CAPTURE_GROUP_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	required: ["lineageId", "collectBindings"],
	properties: {
		lineageId: { type: "string", minLength: 1, description: "Exact lineage from the current provider-issued collect transition." },
		collectBindings: { type: "array", minItems: 1, items: { type: "string", minLength: 1 }, description: "Ordered JSON-serialized exact copies of the complete current materialize reviewer collect set." },
		reviewerRunAcknowledged: { type: "boolean", description: "Required after the one group forecast; authorizes exactly the forecast reviewer runs." },
		workspaceRoot: { type: "string", description: "Optional explicit existing Git worktree root, resolved with the controller's worktree confinement semantics." },
	},
} as const;

interface ReviewCaptureGroupParameters {
	lineageId: string;
	collectBindings: readonly string[];
	reviewerRunAcknowledged?: boolean;
	workspaceRoot?: string;
}

const REVIEW_SCOPE_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	required: ["manifest", "sha256"],
	properties: {
		manifest: { type: "string", maxLength: 4_096, description: "Exact controller-supplied gzip/base64url frozen changed-scope manifest." },
		sha256: { type: "string", pattern: "^[0-9a-f]{64}$", description: "Exact controller-supplied SHA-256 of the decompressed canonical manifest bytes." },
		cursor: { type: "integer", minimum: 0, description: "Pagination cursor. Start at 0 and continue with nextCursor until absent." },
	},
} as const;

interface ReviewScopeParameters {
	manifest: string;
	sha256: string;
	cursor?: number;
}

// gentle-pi#662: read-only native risk assessment, gating the separate
// verifier on native risk instead of a task-description judgment when the
// rendered `Receipt-driven development:` line is `off` or `unknown`. Exposed
// as `gentle_review` operation `assess` (not a dedicated tool), taking its
// optional fields through the controller's existing generic `input` JSON
// string, exactly like START's `{"mode":...,"baseRef":...}`.
interface ReviewAssessInput {
	baseRef?: string;
	committedOnly?: boolean;
	writerModelId?: string;
	writerEffort?: string;
	// gentle-pi#668: the caller's own known outcome for this candidate.
	// Omitted tries to auto-derive declined/unavailable for this EXACT
	// candidate's own target identity (never a different one); `closed` is
	// never auto-derived -- pass it explicitly.
	nativeReviewOutcome?: NativeReviewOutcome;
}

function isNativeReviewOutcome(value: unknown): value is NativeReviewOutcome {
	return typeof value === "string" && (Object.values(NATIVE_REVIEW_OUTCOME) as readonly string[]).includes(value);
}

function parseReviewAssessInput(operation: ReviewControllerOperation, raw: string | undefined): ReviewAssessInput {
	if (raw === undefined) return {};
	const value = parseControllerJson(raw, operation);
	const allowed = new Set(["baseRef", "committedOnly", "writerModelId", "writerEffort", "nativeReviewOutcome"]);
	const unexpected = Object.keys(value).find((key) => !allowed.has(key));
	if (unexpected !== undefined) throw new Error(`Review controller ${operation} input does not accept ${unexpected}`);
	const { baseRef, committedOnly, writerModelId, writerEffort, nativeReviewOutcome } = value;
	if (baseRef !== undefined && typeof baseRef !== "string") throw new Error(`Review controller ${operation} input baseRef must be a string`);
	if (committedOnly !== undefined && typeof committedOnly !== "boolean") throw new Error(`Review controller ${operation} input committedOnly must be a boolean`);
	if (writerModelId !== undefined && typeof writerModelId !== "string") throw new Error(`Review controller ${operation} input writerModelId must be a string`);
	if (writerEffort !== undefined && typeof writerEffort !== "string") throw new Error(`Review controller ${operation} input writerEffort must be a string`);
	if (nativeReviewOutcome !== undefined && !isNativeReviewOutcome(nativeReviewOutcome)) {
		throw new Error(`Review controller ${operation} input nativeReviewOutcome must be one of ${Object.values(NATIVE_REVIEW_OUTCOME).join(", ")}`);
	}
	return {
		...(baseRef === undefined ? {} : { baseRef: baseRef as string }),
		...(committedOnly === undefined ? {} : { committedOnly: committedOnly as boolean }),
		...(writerModelId === undefined ? {} : { writerModelId: writerModelId as string }),
		...(writerEffort === undefined ? {} : { writerEffort: writerEffort as string }),
		...(nativeReviewOutcome === undefined ? {} : { nativeReviewOutcome: nativeReviewOutcome as NativeReviewOutcome }),
	};
}

interface ReviewControllerParameters {
	operation: ReviewControllerOperation;
	lineageId?: string;
	selectionBinding?: string;
	intendedUntracked?: readonly string[];
	untrackedScope?: NativeStartUntrackedScope;
	changeName?: string;
	idempotencyKey?: string;
	transition?: string;
	input?: string;
	outputPath?: string;
	inputPath?: string;
	operationId?: string;
	lineageIds?: string;
	acknowledgeUntrustedBundleSource?: string;
	workspaceRoot?: string;
}

type NativeReviewAcknowledgementCli = NativeReviewCli & {
	acknowledgeApproved?: (request: NativeReviewAcknowledgeApprovedRequest) => Promise<NativeReviewAcknowledgeApprovedOutcome | void>;
};

interface ReviewControllerStartInput {
	mode: ReviewMode;
	projection: ReviewProjectionV1;
	policyHash: string;
	evidenceHash: string;
	budget: ReviewBudgetV1;
	parentLineageId?: string;
}

function isReviewControllerOperation(value: string): value is ReviewControllerOperation {
	return Object.values(REVIEW_CONTROLLER_OPERATION).some((operation) => operation === value);
}

function parseReviewControllerParameters(value: unknown): ReviewControllerParameters {
	if (!isRecord(value)) throw new Error("Review controller parameters must be an object");
	if (typeof value.operation !== "string" || !isReviewControllerOperation(value.operation)) {
		throw new Error("Review controller operation is unsupported");
	}
	if (value.operation === REVIEW_CONTROLLER_OPERATION.SELECT_INTENDED_UNTRACKED) {
		const unexpected = Object.keys(value).find((key) => !["operation", "selectionBinding", "intendedUntracked", "workspaceRoot"].includes(key));
		if (unexpected !== undefined || typeof value.selectionBinding !== "string" || !Array.isArray(value.intendedUntracked) || (value.workspaceRoot !== undefined && typeof value.workspaceRoot !== "string")) throw new Error("Review intended-untracked selection accepts exactly selectionBinding and intendedUntracked, with optional workspaceRoot");
		return { operation: value.operation, selectionBinding: value.selectionBinding, intendedUntracked: value.intendedUntracked, ...(typeof value.workspaceRoot === "string" ? { workspaceRoot: value.workspaceRoot } : {}) };
	}
	// gentle-pi#706: top-level untrackedScope/intendedUntracked resolve the
	// intended-untracked stop through inspect alone. intendedUntracked is not a
	// standalone selector: inspect accepts it only for an explicit select scope.
	const hasIntendedUntracked = "intendedUntracked" in value;
	if (hasIntendedUntracked && value.operation !== REVIEW_CONTROLLER_OPERATION.INSPECT) {
		throw new Error(
			`Review controller ${value.operation} does not accept intendedUntracked; it is accepted only by inspect with untrackedScope select`,
		);
	}
	if (value.untrackedScope !== undefined) {
		if (value.operation !== REVIEW_CONTROLLER_OPERATION.INSPECT)
			throw new Error(
				`Review controller ${value.operation} does not accept untrackedScope; it is accepted only by inspect`,
			);
		if (
			value.untrackedScope !== NATIVE_START_UNTRACKED_SCOPE.EXCLUDE &&
			value.untrackedScope !== NATIVE_START_UNTRACKED_SCOPE.SELECT
		)
			throw new Error(
				"Review controller inspect untrackedScope must be exclude or select",
			);
	}
	if (hasIntendedUntracked) {
		if (value.untrackedScope !== NATIVE_START_UNTRACKED_SCOPE.SELECT) {
			throw new Error(
				"Review controller inspect intendedUntracked requires untrackedScope select",
			);
		}
		if (!Array.isArray(value.intendedUntracked)) {
			throw new Error(
				"Review controller inspect intendedUntracked must be an array of repository-relative paths",
			);
		}
	}

	const needsLineage = ![REVIEW_CONTROLLER_OPERATION.START, REVIEW_CONTROLLER_OPERATION.ANSWER_CONSENT, REVIEW_CONTROLLER_OPERATION.STATUS, REVIEW_CONTROLLER_OPERATION.EXPORT, REVIEW_CONTROLLER_OPERATION.IMPORT, REVIEW_CONTROLLER_OPERATION.INSPECT, REVIEW_CONTROLLER_OPERATION.RESET, REVIEW_CONTROLLER_OPERATION.RECOVER, REVIEW_CONTROLLER_OPERATION.RECOVER_LOCK, REVIEW_CONTROLLER_OPERATION.ABANDON, REVIEW_CONTROLLER_OPERATION.QUARANTINE_LEGACY, REVIEW_CONTROLLER_OPERATION.RECONCILE_AUTHORITY, REVIEW_CONTROLLER_OPERATION.REPAIR_LEGACY_ALIAS, REVIEW_CONTROLLER_OPERATION.REPAIR, REVIEW_CONTROLLER_OPERATION.ASSESS].includes(value.operation as ReviewControllerOperation);
	if (needsLineage && (typeof value.lineageId !== "string" || value.lineageId.trim().length === 0)) {
		throw new Error("Review controller requires a lineageId");
	}
	const parameters: ReviewControllerParameters = {
		operation: value.operation,
		...(typeof value.lineageId === "string" ? { lineageId: value.lineageId } : {}),
		...(value.operation === REVIEW_CONTROLLER_OPERATION.INSPECT && value.untrackedScope !== undefined ? { untrackedScope: value.untrackedScope } : {}),
		...(value.operation === REVIEW_CONTROLLER_OPERATION.INSPECT && value.intendedUntracked !== undefined ? { intendedUntracked: [...value.intendedUntracked] } : {}),
	};
	for (const key of ["changeName", "idempotencyKey", "transition", "input", "outputPath", "inputPath", "operationId", "lineageIds", "acknowledgeUntrustedBundleSource", "workspaceRoot"] as const) {
		const optional = value[key];
		if (optional !== undefined && typeof optional !== "string") {
			if (value.operation === REVIEW_CONTROLLER_OPERATION.START && key === "input") {
				throw new Error("Review controller START input must be a JSON string encoding an object, not a nested object. No lineage was created; do not call STATUS or ADVANCE for this attempted lineage.");
			}
			throw new Error(`Review controller ${key} must be a string`);
		}
		if (typeof optional === "string") parameters[key] = optional;
	}
	return parameters;
}

function parseReviewCaptureParameters(value: unknown): ReviewCaptureParameters {
	if (!isRecord(value)) throw new Error("Review capture parameters must be an object");
	const allowed = new Set(["lineageId", "collectBinding", "reviewerRunAcknowledged", "correctionLines", "workspaceRoot"]);
	const unexpected = Object.keys(value).find((key) => !allowed.has(key));
	if (unexpected !== undefined) throw new Error(`Review capture does not accept ${unexpected}`);
	if (!isCanonicalProcessString(value.lineageId)) throw new Error("Review capture requires an exact non-empty lineageId");
	if (typeof value.collectBinding !== "string" || value.collectBinding.length === 0) throw new Error("Review capture requires a JSON-serialized collectBinding");
	if (value.reviewerRunAcknowledged !== undefined && typeof value.reviewerRunAcknowledged !== "boolean") throw new Error("Review capture reviewerRunAcknowledged must be boolean");
	if (value.correctionLines !== undefined && (!Number.isSafeInteger(value.correctionLines) || value.correctionLines < 1)) throw new Error("Review capture correctionLines must be a positive integer");
	if (value.workspaceRoot !== undefined && typeof value.workspaceRoot !== "string") throw new Error("Review capture workspaceRoot must be a string");
	return {
		lineageId: value.lineageId,
		collectBinding: value.collectBinding,
		...(value.reviewerRunAcknowledged === undefined ? {} : { reviewerRunAcknowledged: value.reviewerRunAcknowledged }),
		...(value.correctionLines === undefined ? {} : { correctionLines: value.correctionLines }),
		...(value.workspaceRoot === undefined ? {} : { workspaceRoot: value.workspaceRoot }),
	};
}

function parseReviewCaptureGroupParameters(value: unknown): ReviewCaptureGroupParameters {
	if (!isRecord(value)) throw new Error("Review capture group parameters must be an object");
	const allowed = new Set(["lineageId", "collectBindings", "reviewerRunAcknowledged", "workspaceRoot"]);
	const unexpected = Object.keys(value).find((key) => !allowed.has(key));
	if (unexpected !== undefined) throw new Error(`Review capture group does not accept ${unexpected}`);
	if (!isCanonicalProcessString(value.lineageId)) throw new Error("Review capture group requires an exact non-empty lineageId");
	if (!Array.isArray(value.collectBindings) || value.collectBindings.length === 0 || value.collectBindings.some((binding) => typeof binding !== "string" || binding.length === 0)) throw new Error("Review capture group requires one or more JSON-serialized collectBindings");
	if (value.reviewerRunAcknowledged !== undefined && typeof value.reviewerRunAcknowledged !== "boolean") throw new Error("Review capture group reviewerRunAcknowledged must be boolean");
	if (value.workspaceRoot !== undefined && typeof value.workspaceRoot !== "string") throw new Error("Review capture group workspaceRoot must be a string");
	return {
		lineageId: value.lineageId,
		collectBindings: [...value.collectBindings],
		...(value.reviewerRunAcknowledged === undefined ? {} : { reviewerRunAcknowledged: value.reviewerRunAcknowledged }),
		...(value.workspaceRoot === undefined ? {} : { workspaceRoot: value.workspaceRoot }),
	};
}

function requiredControllerString(
	parameters: ReviewControllerParameters,
	key: "idempotencyKey" | "transition" | "command" | "input" | "outputPath" | "inputPath" | "operationId",
): string {
	const value = parameters[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Review controller ${parameters.operation} requires ${key}`);
	}
	return value;
}

function readRepositoryControllerInput(inputPath: string, repositoryRoot: string): string {
	const canonicalRoot = realpathSync(repositoryRoot);
	const requestedPath = resolve(canonicalRoot, inputPath);
	const relativePath = relative(canonicalRoot, requestedPath);
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw new Error("Review controller inputPath must be confined to the repository");
	}
	const stat = lstatSync(requestedPath);
	if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(requestedPath) !== requestedPath) {
		throw new Error("Review controller inputPath must be a regular non-symlink file");
	}
	return readFileSync(requestedPath, "utf8");
}

function parseControllerJson(input: string, operation: ReviewControllerOperation): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(input);
	} catch (error) {
		if (operation === REVIEW_CONTROLLER_OPERATION.START) {
			throw new Error(
				`Review controller START input must be a JSON string encoding an object: ${error instanceof Error ? error.message : String(error)}. No lineage was created; do not call STATUS or ADVANCE for this attempted lineage.`,
			);
		}
		throw new Error(
			`Review controller ${operation} input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isRecord(value)) throw new Error(`Review controller ${operation} input must be a JSON object`);
	return value;
}

async function authorizeDestructiveReviewOperation(
	parametersValue: unknown,
	ctx: ExtensionContext,
): Promise<void> {
	const parameters = parseReviewControllerParameters(parametersValue);
	// RESET alone carries the legacy repository-wide challenge. Native compact-v2
	// RECOVER has its own six-field contract and its own derived
	// `gentle-ai.review-recovery-authorization/v1` binding, neither of which the
	// legacy `repositoryId`/`commonDirHash`/`inventoryHash`/`confirmation` quartet
	// can express. Native INSPECT never publishes that quartet either, so
	// demanding it here made the only supported recovery flow unreachable
	// (issue #212).
	// RECOVER authorizes itself in `executeReviewControllerOperation`, the way
	// REPAIR_LEGACY_ALIAS does, because its binding can only be derived from a
	// fresh native target-status read.
	const isReset = parameters.operation === REVIEW_CONTROLLER_OPERATION.RESET;
	const maintenance = nativeMaintenanceOperation(parameters.operation);
	if (!isReset && maintenance === undefined) return;
	const input = parseControllerJson(requiredControllerString(parameters, "input"), parameters.operation);
	if (maintenance !== undefined && (missingNativeMaintenanceInputs(maintenance, input).length > 0 || invalidNativeMaintenanceInput(maintenance, input))) return;
	if (isReset) {
		for (const key of ["repositoryId", "commonDirHash", "inventoryHash"] as const) {
			if (typeof input[key] !== "string" || input[key].length === 0) throw new Error(`Review controller ${parameters.operation} requires an exact string ${key}`);
		}
		if (typeof input.confirmation !== "string" || input.confirmation.length === 0) throw new Error(`Review controller ${parameters.operation} requires an exact string confirmation`);
	}
	if (!ctx.hasUI) {
		throw new Error(`Review controller ${parameters.operation.toUpperCase()} requires fresh explicit authorization through the interactive Pi UI; headless execution fails closed`);
	}
	const maintenanceAuthorization = maintenance === undefined ? undefined : nativeMaintenanceAuthorization(maintenance, input);
	const approved = await ctx.ui.confirm(
		maintenance !== undefined ? `Authorize review authority ${parameters.operation.toUpperCase()}?` : `Authorize destructive review authority ${parameters.operation.toUpperCase()}?`,
		maintenance !== undefined
			? [`Operation: ${parameters.operation.toUpperCase()}`, "Exact published authorization binding:", maintenanceAuthorization!, maintenance === "abandon" ? "The native command may quarantine only an eligible pristine compact-v2 lineage." : maintenance === "quarantineLegacy" ? "The native command may quarantine only the published malformed freeze-findings legacy diagnostic." : "The native command may quarantine only the bound invalid recovery successor; the predecessor stays untouched."].join("\n")
			: [`Operation: ${parameters.operation.toUpperCase()}`, `Repository: ${input.repositoryId}`, `Exact challenge: ${input.confirmation}`, "This invalidates all prior review authority for this repository."].join("\n"),
	);
	if (!approved) throw new Error(`Review controller ${parameters.operation.toUpperCase()} was not explicitly authorized`);
}

function parseReviewBudget(value: unknown, label: string): ReviewBudgetV1 {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	return value as unknown as ReviewBudgetV1;
}

function parseStartInput(value: Record<string, unknown>): ReviewControllerStartInput {
	if (value.mode !== REVIEW_MODE.ORDINARY && value.mode !== REVIEW_MODE.JUDGMENT_DAY) {
		throw new Error(
			'Review controller START supports only "ordinary" or "judgment-day" mode; use "ordinary" unless Judgment Day was explicitly selected. Pass input as a JSON string encoding the START object. START failed before authority access, so no lineage was created; do not call STATUS or ADVANCE for this attempted lineage.',
		);
	}
	if (!isRecord(value.projection) || typeof value.projection.kind !== "string") {
		throw new Error("Review controller start requires a projection");
	}
	let projection: ReviewProjectionV1;
	if (value.projection.kind === REVIEW_PROJECTION.COMPLETE) {
		projection = { kind: REVIEW_PROJECTION.COMPLETE };
	} else if (
		value.projection.kind === REVIEW_PROJECTION.INTENDED_COMMIT &&
		typeof value.projection.tree === "string"
	) {
		projection = {
			kind: REVIEW_PROJECTION.INTENDED_COMMIT,
			tree: value.projection.tree,
		};
	} else {
		throw new Error("Review controller start projection is unsupported or unresolved");
	}
	if (typeof value.policyHash !== "string" || typeof value.evidenceHash !== "string") {
		throw new Error("Review controller start requires policyHash and evidenceHash");
	}
	if (value.parentLineageId !== undefined && typeof value.parentLineageId !== "string") {
		throw new Error("Review controller parentLineageId must be a string");
	}
	const result: ReviewControllerStartInput = {
		mode: value.mode,
		projection,
		policyHash: value.policyHash,
		evidenceHash: value.evidenceHash,
		budget: parseReviewBudget(value.budget, "Review controller start budget"),
	};
	if (typeof value.parentLineageId === "string") result.parentLineageId = value.parentLineageId;
	return result;
}

function isReviewTransition(value: string): value is ReviewTransition {
	return Object.values(REVIEW_TRANSITION).some((transition) => transition === value);
}

function isGraphV1JudgmentDayLineage(cwd: string, lineageId: string): boolean {
	try {
		return ReviewTransactionStore.forRepository(cwd).read(lineageId).mode === REVIEW_MODE.JUDGMENT_DAY;
	} catch {
		return false;
	}
}

interface NativeStartPreAuthorityRejection {
	lineage_created: false;
	mutation_performed: false;
	mutation_outcome: "none";
	reset_eligible: false;
}

function nativeStartPreAuthorityRejection(): NativeStartPreAuthorityRejection {
	return {
		lineage_created: false,
		mutation_performed: false,
		mutation_outcome: "none",
		reset_eligible: false,
	};
}

// Organic-rdd-parity Phase 3 (Design Decision #7): consulted once at the top
// of the ORDINARY START branch, before targetStatus. Dark until the
// negotiated version reports the `mode` capability true — `reviewMode`
// throws VERSION_INCOMPATIBLE in that case, which this treats identically to
// "capability absent" (today's path unchanged), never as a failure. Any
// other error (a real native process failure) still surfaces through the
// caller's existing nativeOperationFailure handling.
const REVIEW_MODE_DISABLED_OUTCOME = "review-mode-disabled";

// Parity with gentle-ai's reviewModeScopeForSource
// (internal/reviewtransaction/rdd_mode.go): the continuation is scoped to the
// source that actually decided, so the operator is not left to work out which
// of the two independent sources they have to change.
//
// A clone-local override can only disable. Pi's explicit clone-scope enable
// clears that override, but cannot enable global RDD: when global is still
// unset or off, clearing it leaves the effective mode off. Tell the operator
// to make the global opt-in first when needed, then clear this clone override.
// Pi never mutates the operator's global gentle-ai state automatically.
//
// The default branch changed with the pinned v2.4.0 runtime, which made
// receipt-driven development opt-in. It used to be unreachable as a reason for
// reviews being off — an all-sources-unset install resolved to ON with source
// `default` — so naming a continuation for it would have been a guess, and
// gentle-ai returned an empty scope to say exactly that. v2.4.0 resolves the
// same install to OFF with source `default`, which makes it the most common
// refusal there is: every install that never opted in. gentle-ai answers
// `global` for it now, not because default is a global opinion but because
// global is the only scope that can turn reviews on at all, and Pi answers the
// same. Leaving this undefined would hand the single most common state a dead
// end.
function reviewModeContinuation(source: NativeReviewModeSource): string | undefined {
	if (source === NATIVE_REVIEW_MODE_SOURCE.CLONE_LOCAL) return "Run `gentle-ai review mode enable --scope=global` if global RDD is still off, then run /gentle:review-mode enable to clear this clone-local override.";
	if (source === NATIVE_REVIEW_MODE_SOURCE.GLOBAL) return "Run `gentle-ai review mode enable --scope=global` to turn reviews back on; /gentle:review-mode enable only clears the clone-local setting, which cannot override a global off.";
	return "Run `gentle-ai review mode enable --scope=global` to opt in; RDD is off by default until explicitly enabled. /gentle:review-mode enable only clears a clone-local override and cannot enable global RDD.";
}

// Names the situation before the mechanism, then the mechanism, mirroring
// gentle-ai's RDDDisabledError.Error(). Pi skips rather than rejects — a
// disabled switch never blocks here — but it must not discard which source
// decided, because that is precisely the information the operator needs and
// the only thing that selects a working way back on.
function nativeReviewModeSkipped(operation: ReviewControllerOperation, source: NativeReviewModeSource): Record<string, unknown> {
	const continuation = reviewModeContinuation(source);
	return {
		operation,
		status: "skipped",
		outcome: REVIEW_MODE_DISABLED_OUTCOME,
		delivery: "disabled/unmanaged",
		mode_source: source,
		reason: `receipt-driven development is disabled: ${operation} is skipped because the ${source} mode source keeps it off`,
		...(continuation === undefined ? {} : { next_action: continuation }),
		...nativeStartPreAuthorityRejection(),
	};
}

async function resolveReviewModeGate(
	nativeReviewCli: NativeReviewCli | null,
	operation: ReviewControllerOperation,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<Record<string, unknown> | undefined> {
	if (nativeReviewCli?.reviewMode === undefined) return undefined;
	try {
		const mode = await nativeReviewCli.reviewMode({ cwd, operation: NATIVE_REVIEW_MODE_OPERATION.STATUS, ...(signal === undefined ? {} : { signal }) });
		return mode.status.effective === "off" ? nativeReviewModeSkipped(operation, mode.status.source) : undefined;
	} catch (error) {
		if (asNativeReviewCliError(error)?.code === NATIVE_REVIEW_ERROR_CODE.VERSION_INCOMPATIBLE) return undefined;
		throw error;
	}
}

// gentle-pi#185: a native CLI without negotiated STATUS support (no
// `targetStatus`, or a version-incompatible provider) hits this boundary
// before any candidate-view restoration is attempted, so it can never
// reproduce the #176 empty-registry failure — but the boundary's own
// `next_action` was a machine token with nothing a human or an agent could
// run. `remediation_command` names the exact upstream command that
// re-establishes negotiated STATUS for this session's Pi host identity.
const NATIVE_STATUS_UNSUPPORTED_REMEDIATION_COMMAND = "gentle-ai review status --cwd <repo> --contract gentle-ai.review-integration/v2 --agent pi --next-transition";

function nativeStatusUnsupported(operation: ReviewControllerOperation): Record<string, unknown> {
	return {
		operation,
		status: "blocked",
		outcome: "native-status-unsupported",
		...(operation === REVIEW_CONTROLLER_OPERATION.START ? nativeStartPreAuthorityRejection() : { mutation_performed: false }),
		inventory_complete: false,
		next_action: "require-upstream-read-only-native-status-inventory",
		remediation_command: NATIVE_STATUS_UNSUPPORTED_REMEDIATION_COMMAND,
		evidence: {
			native_contract: "gentle-ai/2.1.4",
			general_status: "unsupported",
			claimant_inventory: "unsupported",
		},
	};
}

// Bundled and source module instances can coexist, making instanceof insufficient.
function asNativeReviewCliError(error: unknown): { code: string; diagnostics: NativeReviewProcessDiagnostics } | undefined {
	if (error instanceof NativeReviewCliError) return error;
	if (!isRecord(error) || error.name !== "NativeReviewCliError") return undefined;
	const value = error as { code?: unknown; diagnostics?: unknown };
	if (typeof value.code !== "string") return undefined;
	const diagnostics = sanitizeForeignNativeReviewDiagnostics(value.diagnostics);
	return diagnostics === undefined || value.code !== diagnostics.error_code ? undefined : { code: value.code, diagnostics };
}

// Same coexisting-module-instance caveat as asNativeReviewCliError above.
function asNativeReviewConsentBindingError(error: unknown): { reason: string; message: string } | undefined {
	if (error instanceof NativeReviewConsentBindingError) return { reason: error.reason, message: error.message };
	if (!(error instanceof Error) || error.name !== "NativeReviewConsentBindingError") return undefined;
	const reason = (error as unknown as { reason?: unknown }).reason;
	return typeof reason !== "string" || reason.length === 0 ? undefined : { reason, message: error.message };
}

function nativeStatusPackageBinaryMissing(operation: ReviewControllerOperation, diagnostics: NativeReviewProcessDiagnostics): Record<string, unknown> {
	return {
		operation,
		status: "blocked",
		outcome: "native-status-package-binary-missing",
		...(operation === REVIEW_CONTROLLER_OPERATION.START ? nativeStartPreAuthorityRejection() : { lineage_created: false, mutation_performed: false, mutation_outcome: "none" }),
		inventory_complete: false,
		diagnostics,
		reason: `The verified package-local binary is unavailable. ${GENTLE_AI_INSTALL_RECOVERY_INSTRUCTIONS} This does not prove install lifecycle scripts were disabled.`,
		recovery_command: GENTLE_AI_INSTALL_RECOVERY_COMMAND,
		next_action: GENTLE_AI_INSTALL_RECOVERY_INSTRUCTIONS,
	};
}

function nativeStatusFailed(operation: ReviewControllerOperation, error: unknown): Record<string, unknown> {
	const cliError = asNativeReviewCliError(error);
	if (cliError?.code === NATIVE_REVIEW_ERROR_CODE.VERSION_INCOMPATIBLE) return nativeStatusUnsupported(operation);
	if (cliError?.code === NATIVE_REVIEW_ERROR_CODE.PACKAGE_BINARY_MISSING) return nativeStatusPackageBinaryMissing(operation, cliError.diagnostics);
	if (cliError !== undefined) {
		return {
			...nativeOperationFailure(operation, error),
			outcome: "native-status-unavailable",
			inventory_complete: false,
			next_action: "require-complete-native-authority-inventory",
		};
	}
	// gentle-pi#599: a negotiated STATUS/inspect request the native provider
	// rejects with a decoded failure/v2 envelope (for example a preflight
	// `invalid_request` refusal for a nested foreign Git repository) used to
	// fall through to the generic outcome below, discarding the envelope's own
	// cause, code, retry_safe, and next_action -- the one piece of information
	// that makes the refusal actionable (pass the intended nested repo as
	// workspaceRoot). `nativeOperationFailure` already renders this exact
	// failure-envelope shape faithfully for every mutating operation; reuse it
	// here instead of masking the refusal as opaque authority-inventory
	// corruption.
	if (error instanceof NativeReviewIntegrationError) {
		return {
			...nativeOperationFailure(operation, error),
			outcome: "native-status-unavailable",
			inventory_complete: false,
		};
	}
	return {
		operation,
		status: "blocked",
		outcome: "native-status-unavailable",
		lineage_created: false,
		mutation_performed: false,
		mutation_outcome: "none",
		inventory_complete: false,
		next_action: "require-complete-native-authority-inventory",
	};
}

const NATIVE_RECOVERY_INPUT = {
	reclaim: ["lineage", "actor", "reason"],
	recover: ["predecessorLineage", "expectedPredecessorRevision", "successorLineage", "disposition", "actor", "reason"],
} as const;

const NATIVE_MAINTENANCE_INPUT = {
	abandon: ["lineage", "expectedRevision", "snapshotIdentity", "actor", "reason"],
	quarantineLegacy: ["repository", "lineage", "expectedRevision", "diagnostic", "disposition", "actor", "reason"],
	reconcileAuthority: ["predecessorLineage", "expectedPredecessorRevision", "successorLineage", "expectedSuccessorRevision", "actor", "reason"],
} as const;
type NativeMaintenanceOperation = keyof typeof NATIVE_MAINTENANCE_INPUT;

function nativeMaintenanceOperation(operation: ReviewControllerOperation): NativeMaintenanceOperation | undefined {
	if (operation === REVIEW_CONTROLLER_OPERATION.ABANDON) return "abandon";
	if (operation === REVIEW_CONTROLLER_OPERATION.QUARANTINE_LEGACY) return "quarantineLegacy";
	if (operation === REVIEW_CONTROLLER_OPERATION.RECONCILE_AUTHORITY) return "reconcileAuthority";
	return undefined;
}

function missingNativeMaintenanceInputs(operation: NativeMaintenanceOperation, input: Record<string, unknown>): readonly string[] {
	const missing = NATIVE_MAINTENANCE_INPUT[operation].filter((key) => !isCanonicalProcessString(input[key]));
	if (operation !== "abandon") return missing;
	return [
		...missing,
		...(Array.isArray(input.capturedLensResults) && input.capturedLensResults.every((entry) => isCanonicalProcessString(entry)) ? [] : ["capturedLensResults"]),
		...(typeof input.findingsPresent === "boolean" ? [] : ["findingsPresent"]),
	];
}

function invalidNativeMaintenanceInput(operation: NativeMaintenanceOperation, input: Record<string, unknown>): boolean {
	if (operation === "quarantineLegacy") return input.diagnostic !== NATIVE_REVIEW_LEGACY_QUARANTINE.DIAGNOSTIC || input.disposition !== NATIVE_REVIEW_LEGACY_QUARANTINE.DISPOSITION;
	return operation === "reconcileAuthority" && input.anomalies !== undefined && input.anomalies !== NATIVE_REVIEW_RECONCILE_ANOMALIES.COMBINED;
}

function nativeMaintenanceAuthorization(operation: NativeMaintenanceOperation, input: Record<string, unknown>): string {
	if (operation === "abandon") return nativeReviewAbandonAuthorization({ lineage: String(input.lineage), expectedRevision: String(input.expectedRevision), snapshotIdentity: String(input.snapshotIdentity), capturedLensResults: (input.capturedLensResults as readonly unknown[]).map(String), findingsPresent: input.findingsPresent === true, actor: String(input.actor), reason: String(input.reason) });
	if (operation === "quarantineLegacy") return nativeReviewLegacyQuarantineAuthorization({ repository: String(input.repository), lineage: String(input.lineage), expectedRevision: String(input.expectedRevision), diagnostic: NATIVE_REVIEW_LEGACY_QUARANTINE.DIAGNOSTIC, disposition: NATIVE_REVIEW_LEGACY_QUARANTINE.DISPOSITION, actor: String(input.actor), reason: String(input.reason) });
	return nativeReviewReconcileAuthorization({ predecessorLineage: String(input.predecessorLineage), expectedPredecessorRevision: String(input.expectedPredecessorRevision), successorLineage: String(input.successorLineage), expectedSuccessorRevision: String(input.expectedSuccessorRevision), actor: String(input.actor), reason: String(input.reason), ...(input.anomalies === undefined ? {} : { anomalies: NATIVE_REVIEW_RECONCILE_ANOMALIES.COMBINED }) });
}

async function executeNativeAuthorityMaintenance(
	operation: ReviewControllerOperation,
	nativeOperation: NativeMaintenanceOperation,
	input: Record<string, unknown>,
	cwd: string,
	nativeReviewCli: NativeReviewCli | null,
	signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
	const method = nativeOperation === "abandon" ? nativeReviewCli?.abandon : nativeOperation === "quarantineLegacy" ? nativeReviewCli?.quarantineLegacy : nativeReviewCli?.reconcileAuthority;
	const nativeCommand = nativeOperation === "quarantineLegacy" ? "review quarantine-legacy" : nativeOperation === "reconcileAuthority" ? "review reconcile-authority" : "review abandon";
	if (method === undefined) {
		return { operation, status: "blocked", outcome: "native-maintenance-unavailable", native_operation: nativeCommand, mutation_performed: false, mutation_outcome: "none", next_action: "install-package-local-gentle-ai-or-run-native-review-cli-directly" };
	}
	const missing = missingNativeMaintenanceInputs(nativeOperation, input);
	if (missing.length > 0) {
		return { operation, status: "blocked", outcome: "native-input-required", native_operation: nativeCommand, missing_input: missing, mutation_performed: false, mutation_outcome: "none", next_action: "resubmit-with-exact-native-maintenance-input" };
	}
	if (invalidNativeMaintenanceInput(nativeOperation, input)) {
		return { operation, status: "blocked", outcome: "native-input-invalid", native_operation: nativeCommand, mutation_performed: false, mutation_outcome: "none", next_action: "resubmit-with-the-exact-published-native-maintenance-binding" };
	}
	try {
		const result = nativeOperation === "abandon"
			? await nativeReviewCli.abandon!({ cwd, lineage: String(input.lineage), expectedRevision: String(input.expectedRevision), snapshotIdentity: String(input.snapshotIdentity), capturedLensResults: (input.capturedLensResults as readonly unknown[]).map(String), findingsPresent: input.findingsPresent === true, actor: String(input.actor), reason: String(input.reason), maintainerAuthorization: nativeMaintenanceAuthorization(nativeOperation, input), ...(signal === undefined ? {} : { signal }) })
			: nativeOperation === "quarantineLegacy"
				? await nativeReviewCli.quarantineLegacy!({ cwd, repository: String(input.repository), lineage: String(input.lineage), expectedRevision: String(input.expectedRevision), diagnostic: NATIVE_REVIEW_LEGACY_QUARANTINE.DIAGNOSTIC, disposition: NATIVE_REVIEW_LEGACY_QUARANTINE.DISPOSITION, actor: String(input.actor), reason: String(input.reason), maintainerAuthorization: nativeMaintenanceAuthorization(nativeOperation, input), ...(signal === undefined ? {} : { signal }) })
				: await nativeReviewCli.reconcileAuthority!({ cwd, predecessorLineage: String(input.predecessorLineage), expectedPredecessorRevision: String(input.expectedPredecessorRevision), successorLineage: String(input.successorLineage), expectedSuccessorRevision: String(input.expectedSuccessorRevision), actor: String(input.actor), reason: String(input.reason), ...(input.anomalies === undefined ? {} : { anomalies: NATIVE_REVIEW_RECONCILE_ANOMALIES.COMBINED }), maintainerAuthorization: nativeMaintenanceAuthorization(nativeOperation, input), ...(signal === undefined ? {} : { signal }) });
		return { operation, native_operation: nativeCommand, result: result.record, mutation_performed: true, mutation_outcome: "committed", next_action: "inspect" };
	} catch (error) {
		return nativeOperationFailure(operation, error);
	}
}

const NATIVE_LEGACY_ALIAS_REPAIR_INPUT = ["lineage", "actor", "reason"] as const;

async function executeNativeLegacyAliasRepair(
	input: Record<string, unknown>,
	cwd: string,
	nativeReviewCli: NativeReviewCli | null,
	signal: AbortSignal | undefined,
	context: ExtensionContext | undefined,
): Promise<Record<string, unknown>> {
	const operation = REVIEW_CONTROLLER_OPERATION.REPAIR_LEGACY_ALIAS;
	const nativeOperation = "review repair-legacy-alias";
	if (Object.keys(input).some((key) => !NATIVE_LEGACY_ALIAS_REPAIR_INPUT.includes(key as (typeof NATIVE_LEGACY_ALIAS_REPAIR_INPUT)[number]))) {
		return { operation, status: "blocked", outcome: "native-input-invalid", native_operation: nativeOperation, mutation_performed: false, mutation_outcome: "none", next_action: "resubmit-with-lineage-actor-and-reason-only" };
	}
	const missing = NATIVE_LEGACY_ALIAS_REPAIR_INPUT.filter((key) => !isCanonicalProcessString(input[key]));
	if (missing.length > 0) {
		return { operation, status: "blocked", outcome: "native-input-required", native_operation: nativeOperation, missing_input: missing, mutation_performed: false, mutation_outcome: "none", next_action: "resubmit-with-lineage-actor-and-reason" };
	}
	if (nativeReviewCli?.reviewStatus === undefined || nativeReviewCli.repairLegacyAlias === undefined) {
		return { operation, status: "blocked", outcome: "native-maintenance-unavailable", native_operation: nativeOperation, mutation_performed: false, mutation_outcome: "none", next_action: "install-package-local-gentle-ai-v2.1.11-or-run-native-review-cli-directly" };
	}
	let inventory;
	try {
		inventory = await nativeReviewCli.reviewStatus({ cwd, ...(signal === undefined ? {} : { signal }) });
	} catch (error) {
		return nativeOperationFailure(operation, error);
	}
	const candidate = inventory.complete
		? inventory.entries.filter((entry) =>
			entry.version === "legacy-v1"
			&& entry.status === "invalid"
			&& entry.lineageId === input.lineage
			&& isCanonicalProcessString(entry.revision)
			&& entry.problems.length === 1
			&& entry.problems[0] === NATIVE_REVIEW_LEGACY_ALIAS_REPAIR.DIAGNOSTIC,
		)
		: [];
	if (candidate.length !== 1 || !isCanonicalProcessString(inventory.repository)) {
		return { operation, status: "blocked", outcome: "native-alias-repair-ineligible", native_operation: nativeOperation, mutation_performed: false, mutation_outcome: "none", next_action: "inspect-complete-native-authority-inventory" };
	}
	const entry = candidate[0]!;
	const request = {
		cwd,
		repository: inventory.repository,
		lineage: entry.lineageId!,
		expectedRevision: entry.revision!,
		diagnostic: NATIVE_REVIEW_LEGACY_ALIAS_REPAIR.DIAGNOSTIC,
		disposition: NATIVE_REVIEW_LEGACY_ALIAS_REPAIR.DISPOSITION,
		actor: input.actor as string,
		reason: input.reason as string,
	};
	const authorization = nativeReviewLegacyAliasRepairAuthorization(request);
	if (context?.hasUI !== true) throw new Error("Review controller REPAIR_LEGACY_ALIAS requires fresh explicit authorization through the interactive Pi UI; headless execution fails closed");
	const approved = await context.ui.confirm(
		"Authorize review authority REPAIR_LEGACY_ALIAS?",
		["Operation: REPAIR_LEGACY_ALIAS", "Exact published authorization binding:", authorization, "The native command may quarantine only this fresh, invalid legacy-v1 alias lineage; it never rewrites or validates historical authority."].join("\n"),
	);
	if (!approved) throw new Error("Review controller REPAIR_LEGACY_ALIAS was not explicitly authorized");
	try {
		const result = await nativeReviewCli.repairLegacyAlias({ ...request, maintainerAuthorization: authorization, ...(signal === undefined ? {} : { signal }) });
		return { operation, native_operation: nativeOperation, result: result.record, mutation_performed: true, mutation_outcome: "committed", next_action: "inspect" };
	} catch (error) {
		return nativeOperationFailure(operation, error);
	}
}

/**
 * Routes the destructive controller operations to their closest audited native
 * equivalent: RESET and RECOVER_LOCK map to `gentle-ai review reclaim`
 * (audited quarantine of one incomplete entry) and RECOVER maps to
 * `gentle-ai review recover` (auditable successor authority). Native inputs
 * the legacy flow never carried are requested through a structured envelope
 * instead of being invented. Pi-owned authorization semantics run before this
 * routing and are unchanged.
 */
async function executeNativeRecoveryRoute(
	operation: ReviewControllerOperation,
	nativeOperation: "reclaim" | "recover",
	input: Record<string, unknown>,
	cwd: string,
	nativeReviewCli: NativeReviewCli | null,
	signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
	const nativeCommand = `review ${nativeOperation}`;
	const method = nativeOperation === "reclaim" ? nativeReviewCli?.reclaim : nativeReviewCli?.recover;
	if (nativeReviewCli === null || method === undefined) {
		return {
			operation,
			status: "blocked",
			outcome: "native-recovery-unavailable",
			native_operation: nativeCommand,
			mutation_performed: false,
			mutation_outcome: "none",
			next_action: "install-package-local-gentle-ai-or-run-native-review-cli-directly",
		};
	}
	const missing = NATIVE_RECOVERY_INPUT[nativeOperation].filter((key) =>
		key === "disposition"
			? input[key] !== "scope_changed" && input[key] !== "invalidated" && input[key] !== "escalated"
			: typeof input[key] !== "string" || (input[key] as string).trim().length === 0,
	);
	if (missing.length > 0) {
		return {
			operation,
			status: "blocked",
			outcome: "native-input-required",
			native_operation: nativeCommand,
			missing_input: missing,
			mutation_performed: false,
			mutation_outcome: "none",
			next_action: "resubmit-with-exact-native-recovery-input",
		};
	}
	try {
		const result = nativeOperation === "reclaim"
			? await nativeReviewCli.reclaim!({ cwd, lineage: String(input.lineage), actor: String(input.actor), reason: String(input.reason), ...(signal === undefined ? {} : { signal }) })
			: await nativeReviewCli.recover!({
				cwd,
				predecessorLineage: String(input.predecessorLineage),
				expectedPredecessorRevision: String(input.expectedPredecessorRevision),
				successorLineage: String(input.successorLineage),
				disposition: input.disposition as "scope_changed" | "invalidated" | "escalated",
				actor: String(input.actor),
				reason: String(input.reason),
				...(typeof input.maintainerAuthorization === "string" ? { maintainerAuthorization: input.maintainerAuthorization } : {}),
				...(signal === undefined ? {} : { signal }),
			});
		return {
			operation,
			native_operation: nativeCommand,
			result: result.record,
			mutation_performed: true,
			mutation_outcome: "committed",
			next_action: "inspect",
		};
	} catch (error) {
		return nativeOperationFailure(operation, error);
	}
}

function mapNativeStartResult(result: NativeStartResult): Record<string, unknown> {
	return {
		lineage_id: result.lineageId,
		state: result.state,
		risk_tier: result.riskLevel,
		selected_lenses: result.selectedLenses,
		changed_files: result.changedFiles,
		original_changed_lines: result.changedLines,
		correction_budget: result.correctionBudget,
		action: result.action,
		lenses_required: result.lensesRequired,
		...(result.riskReasons === undefined ? {} : { risk_reasons: result.riskReasons }),
		// Organic-parity passthrough (Design Decision #8, organic-rdd-parity):
		// risk_evidence/hint are rendered verbatim from the native start result,
		// with zero local derivation; both stay absent whenever the negotiated
		// version's capability is dark (every shipped row today).
		...(result.riskEvidence === undefined ? {} : { risk_evidence: result.riskEvidence }),
		...(result.hint === undefined ? {} : { hint: result.hint }),
		...(result.nextTransition === undefined ? {} : { next_transition: result.nextTransition }),
	};
}

function requiredStatusActionText(lineageId?: string): string {
	return `Run target-scoped review.status${lineageId === undefined ? "" : ` for lineage ${lineageId}`} and follow only its declared action.`;
}

// The public collect projection is collectBindings: each provider collect
// input serialized once as the opaque binding gentle_review_capture consumes.
// The raw next_transition.collect.inputs carry the same bytes, so a four-lens
// collect state used to cost about 28k characters per STATUS, INSPECT, or
// START answer and again on every blocked retry (#465). The raw transition
// keeps its kind and reason so the orchestrator still sees the collect state.
function withoutRawCollectInputs(raw: Record<string, unknown>): Record<string, unknown> {
	if (!isRecord(raw.next_transition)) return raw;
	const { collect: _collect, ...transition } = raw.next_transition;
	return { ...raw, next_transition: transition };
}

function mapNativeTargetStatus(operation: ReviewControllerOperation, status: ReviewStatusV3, requestedLineageId?: string): Record<string, unknown> {
	if (
		status.nextTransition?.kind === "collect" &&
		(operation === REVIEW_CONTROLLER_OPERATION.START || operation === REVIEW_CONTROLLER_OPERATION.INSPECT || operation === REVIEW_CONTROLLER_OPERATION.STATUS)
	) {
		const selection = reviewIntendedUntrackedInput(status);
		return {
			operation,
			status: "blocked",
			result: withoutRawCollectInputs(status.raw),
			...(selection === undefined
				? { collectBindings: publicReviewCaptureBindings(status) }
				: { selectionBinding: canonicalReviewCaptureBinding(selection) }),
		};
	}
	if (status.action === "recover") {
		return {
			operation,
			status: "blocked",
			result: status.raw,
			provider_action: "recover",
			recovery_disposition: status.actionDisposition,
			next_action: "recover-with-provider-disposition",
			required_status_action: "Use only the provider-selected recovery disposition; do not substitute scope_changed, invalidated, or escalated.",
		};
	}
	// gentle-pi#627: a stale managed-asset set stops the transition with the
	// exact `gentle-ai sync` invocation that resolves it. Render that command
	// as the one actionable next step; every other reason code keeps rendering
	// as a plain blocked result.
	if (status.nextTransition?.kind === "stop" && status.nextTransition.reasonCode === "managed_assets_outdated" && status.nextTransition.continuation !== undefined) {
		return {
			operation,
			status: "blocked",
			result: status.raw,
			...(requestedLineageId === undefined ? {} : { requested_lineage_id: requestedLineageId }),
			hint: `run ${status.nextTransition.continuation.command}`,
		};
	}
	// gentle-pi#638: an unachievable-lens stop carries the exact withdraw command for every declared slot, mirroring the managed_assets_outdated precedent. A restart that never saw the collect offer still finds its way back from this hint alone.
	// gentle-pi#822: when the caller asked about one lineage, render only that lineage's withdraw command; the first entry may belong to an unrelated lineage, so an unmatched request omits the hint instead of surfacing a potentially unrelated withdraw command. Without a requested lineage the first entry stays the fallback.
	if (status.nextTransition?.kind === "stop" && status.nextTransition.reasonCode === "unachievable_lens_slot" && status.nextTransition.unachievableLensSlots !== undefined) {
		const withdrawSlot = requestedLineageId === undefined ? status.nextTransition.unachievableLensSlots[0] : status.nextTransition.unachievableLensSlots.find((slot) => slot.withdraw.binding.lineageId === requestedLineageId);
		return {
			operation,
			status: "blocked",
			result: status.raw,
			...(requestedLineageId === undefined ? {} : { requested_lineage_id: requestedLineageId }),
			...(withdrawSlot === undefined ? {} : { hint: `run ${withdrawSlot.withdraw.command}` }),
		};
	}
	return {
		operation,
		status: status.action === "start" ? "ready" : "blocked",
		result: status.raw,
		...(requestedLineageId === undefined ? {} : { requested_lineage_id: requestedLineageId }),
	};
}

interface NativeStartPolicyValidation {
	policyPath?: string;
	reason?: string;
}

function isStrictDescendantPath(parent: string, candidate: string): boolean {
	const pathFromParent = relative(parent, candidate);
	return pathFromParent.length > 0 && pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent);
}

function validateNativeStartPolicyPath(cwd: string, value: unknown): NativeStartPolicyValidation {
	if (typeof value !== "string" || value.trim().length === 0) return { reason: "policy-path-not-regular" };
	let repository: string;
	try {
		repository = realpathSync(cwd);
	} catch {
		return { reason: "policy-path-outside-scope" };
	}
	const policyRoot = join(repository, ".gentle-ai", "policies");
	const candidate = resolve(repository, value);
	if (!isStrictDescendantPath(policyRoot, candidate)) return { reason: "policy-path-outside-scope" };
	const gentleDirectory = join(repository, ".gentle-ai");
	for (const directory of [gentleDirectory, policyRoot]) {
		try {
			const metadata = lstatSync(directory);
			if (metadata.isSymbolicLink()) return { reason: "policy-path-symlink" };
			if (!metadata.isDirectory()) return { reason: "policy-path-not-regular" };
		} catch {
			return { reason: "policy-path-not-regular" };
		}
	}
	const segments = relative(policyRoot, candidate).split(sep);
	let current = policyRoot;
	for (const [index, segment] of segments.entries()) {
		current = join(current, segment);
		try {
			const metadata = lstatSync(current);
			if (metadata.isSymbolicLink()) return { reason: "policy-path-symlink" };
			if (index === segments.length - 1) {
				if (!metadata.isFile()) return { reason: "policy-path-not-regular" };
			} else if (!metadata.isDirectory()) {
				return { reason: "policy-path-not-regular" };
			}
		} catch {
			return { reason: "policy-path-not-regular" };
		}
	}
	try {
		const canonicalPath = realpathSync(candidate);
		if (canonicalPath !== candidate || !isStrictDescendantPath(policyRoot, canonicalPath)) return { reason: "policy-path-symlink" };
		return { policyPath: canonicalPath };
	} catch {
		return { reason: "policy-path-not-regular" };
	}
}

const NATIVE_START_FOCUS = {
	RISK: "risk",
	RESILIENCE: "resilience",
	READABILITY: "readability",
	RELIABILITY: "reliability",
} as const;
type NativeStartFocus = (typeof NATIVE_START_FOCUS)[keyof typeof NATIVE_START_FOCUS];

function isNativeStartFocus(value: unknown): value is NativeStartFocus {
	return typeof value === "string" && (Object.values(NATIVE_START_FOCUS) as readonly string[]).includes(value);
}

const NATIVE_START_UNTRACKED_SCOPE = {
	EXCLUDE: "exclude",
	SELECT: "select",
} as const;
type NativeStartUntrackedScope = (typeof NATIVE_START_UNTRACKED_SCOPE)[keyof typeof NATIVE_START_UNTRACKED_SCOPE];

interface NativeStartUntrackedSelection {
	untrackedScope?: NativeStartUntrackedScope;
	expectedUntrackedInventory?: string;
	intendedUntracked?: readonly string[];
	reason?: string;
}

interface RetainedNativeUntrackedSelection {
	readonly untrackedScope: NativeStartUntrackedScope;
	readonly expectedUntrackedInventory: string;
	readonly intendedUntracked: readonly string[];
	readonly submission?: NativeIntendedUntrackedSelectionSubmission;
}

interface RetainedPreLineageNativeUntrackedSelection extends RetainedNativeUntrackedSelection {
	readonly targetIdentity: string;
	readonly candidateTree: string;
}

interface RetainedNativeCaptureRoute { readonly workspaceRoot: string; readonly lineageId: string; readonly baseRef?: string; readonly committedOnly?: true; }

type RetainedNativeStatusSelection = RetainedNativeUntrackedSelection | RetainedNativeCaptureRoute;

const MAX_RETAINED_NATIVE_STATUS_SELECTIONS = 64;
class NativeCaptureRouteRegistrationError extends Error {}

function isNativeStartUntrackedPath(value: unknown): value is string {
	return isCanonicalProcessString(value)
		&& !isAbsolute(value)
		&& !/^[A-Za-z]:\//.test(value)
		&& !value.includes("\\")
		&& value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function validateNativeStartUntrackedSelection(value: Record<string, unknown>): NativeStartUntrackedSelection {
	const declared = "untrackedScope" in value || "expectedUntrackedInventory" in value || "intendedUntracked" in value;
	if (!declared) return {};
	const scope = value.untrackedScope;
	const expectedUntrackedInventory = value.expectedUntrackedInventory;
	const intendedUntracked = value.intendedUntracked;
	if (
		(scope !== NATIVE_START_UNTRACKED_SCOPE.EXCLUDE && scope !== NATIVE_START_UNTRACKED_SCOPE.SELECT) ||
		!isCanonicalProcessString(expectedUntrackedInventory) ||
		(intendedUntracked !== undefined && (!Array.isArray(intendedUntracked) || intendedUntracked.some((path) => !isNativeStartUntrackedPath(path) || intendedUntracked.indexOf(path) !== intendedUntracked.lastIndexOf(path))))
	) return { reason: "untracked-selection-invalid" };
	if (scope === NATIVE_START_UNTRACKED_SCOPE.EXCLUDE && (intendedUntracked?.length ?? 0) > 0) return { reason: "untracked-selection-invalid" };
	if (scope === NATIVE_START_UNTRACKED_SCOPE.SELECT && (intendedUntracked?.length ?? 0) === 0) return { reason: "untracked-selection-invalid" };
	return {
		untrackedScope: scope,
		expectedUntrackedInventory,
		intendedUntracked: intendedUntracked === undefined ? [] : [...intendedUntracked],
	};
}

function nativeStartRejection(reason: string, field?: string): Record<string, unknown> {
	return {
		operation: REVIEW_CONTROLLER_OPERATION.START,
		status: "blocked",
		outcome: reason === "legacy-policy-hash-unsupported"
			? "native-start-legacy-policy-hash-unsupported"
			: reason === "base-ref-invalid"
				? "native-start-base-ref-invalid"
				: reason === "base-ref-ambiguous"
					? "native-start-base-ref-ambiguous"
					: reason === "base-ref-unresolvable" || reason === "base-ref-moved"
						? "native-start-base-ref-unresolvable"
						: reason === "committed-only-required"
							? "native-start-committed-only-required"
							: reason === "committed-only-invalid"
								? "native-start-committed-only-invalid"
								: reason === "unknown-field" || reason === "focus-invalid" || reason === "untracked-selection-invalid"
									? "native-start-input-invalid"
									: "native-start-policy-path-invalid",
		reason,
		...(field === undefined ? {} : { field }),
		...nativeStartPreAuthorityRejection(),
	};
}

function nativeStatusInputRejection(reason: string, field?: string): Record<string, unknown> {
	return {
		operation: REVIEW_CONTROLLER_OPERATION.STATUS,
		status: "blocked",
		outcome: "native-status-input-invalid",
		reason,
		...(field === undefined ? {} : { field }),
		mutation_performed: false,
		mutation_outcome: "none",
	};
}

const PENDING_REVIEW_CONSENT_TTL_MS = 10 * 60 * 1000;
const REVIEW_SESSION_PERMISSION_STATUS_KEY = "gentle-review-session-permission";
const REVIEW_SESSION_PERMISSION_STATUS_TEXT = "reviews allowed for this session";

type PendingReviewConsentSessionKey = string | symbol;

interface PendingReviewConsent {
	id: string;
	repositoryCwd: string;
	authorityCwd: string;
	candidateView: CandidateView;
	candidateViews: CandidateViewRegistry | null;
	verifyCandidate: () => void;
	cleanupCandidate: () => void;
	untrackedSelection?: RetainedNativeUntrackedSelection;
	consent: ReviewConsentEnvelope;
	consentDigest: string;
	expiresAt: number;
	expiry?: ReturnType<typeof setTimeout>;
}

const PENDING_REVIEW_CONSENT_DISPOSITION = {
	EXPIRED: "expired",
	CONSUMED: "consumed",
} as const;

type PendingReviewConsentDisposition = (typeof PENDING_REVIEW_CONSENT_DISPOSITION)[keyof typeof PENDING_REVIEW_CONSENT_DISPOSITION];

const PENDING_REVIEW_CONSENT_STALE_DISPOSITION_LIMIT = 32;

/**
 * Process-memory-only pending consent partitions. A loaded extension module
 * shares this registry across registrations, while exact Pi session IDs remain
 * the only continuity boundary. It intentionally has no persistence surface.
 */
export class PendingReviewConsentRegistry {
	private readonly sessions = new Map<PendingReviewConsentSessionKey, Map<string, PendingReviewConsent>>();
	// gentle-pi#455: a binding id is globally unique (randomUUID), so its live
	// owner and its stale disposition are tracked by binding id alone. This
	// index lets answer-consent resolve and atomically take exactly once a
	// binding another active Pi session's START created; the per-session map
	// above stays authoritative for session-scoped listings and shutdown cleanup.
	private readonly byBinding = new Map<string, PendingReviewConsentSessionKey>();
	private readonly staleDispositions = new Map<string, PendingReviewConsentDisposition>();

	get(sessionKey: PendingReviewConsentSessionKey): Map<string, PendingReviewConsent> | undefined {
		return this.sessions.get(sessionKey);
	}

	ensure(sessionKey: PendingReviewConsentSessionKey): Map<string, PendingReviewConsent> {
		let pending = this.sessions.get(sessionKey);
		if (pending === undefined) {
			pending = new Map<string, PendingReviewConsent>();
			this.sessions.set(sessionKey, pending);
		}
		return pending;
	}

	// Registers a freshly created pending binding under its owning session and
	// the cross-session binding index in one step so the two never drift.
	add(sessionKey: PendingReviewConsentSessionKey, pending: PendingReviewConsent): void {
		this.ensure(sessionKey).set(pending.id, pending);
		this.byBinding.set(pending.id, sessionKey);
	}

	// Resolves a live binding to its owning session regardless of which
	// session asks, so answer-consent can reach a binding another session's
	// START created (gentle-pi#455).
	resolve(bindingId: string): { sessionKey: PendingReviewConsentSessionKey; pending: PendingReviewConsent } | undefined {
		const sessionKey = this.byBinding.get(bindingId);
		const pending = sessionKey === undefined ? undefined : this.sessions.get(sessionKey)?.get(bindingId);
		return pending === undefined ? undefined : { sessionKey, pending };
	}

	private remove(sessionKey: PendingReviewConsentSessionKey, pending: PendingReviewConsent): boolean {
		const session = this.sessions.get(sessionKey);
		if (session?.get(pending.id) !== pending) return false;
		session.delete(pending.id);
		if (session.size === 0) this.sessions.delete(sessionKey);
		if (this.byBinding.get(pending.id) === sessionKey) this.byBinding.delete(pending.id);
		return true;
	}

	private rememberDisposition(pending: PendingReviewConsent, disposition: PendingReviewConsentDisposition): void {
		this.staleDispositions.delete(pending.id);
		this.staleDispositions.set(pending.id, disposition);
		while (this.staleDispositions.size > PENDING_REVIEW_CONSENT_STALE_DISPOSITION_LIMIT) this.staleDispositions.delete(this.staleDispositions.keys().next().value!);
	}

	consume(sessionKey: PendingReviewConsentSessionKey, pending: PendingReviewConsent): boolean {
		if (!this.remove(sessionKey, pending)) return false;
		this.rememberDisposition(pending, PENDING_REVIEW_CONSENT_DISPOSITION.CONSUMED);
		return true;
	}

	expire(sessionKey: PendingReviewConsentSessionKey, pending: PendingReviewConsent): boolean {
		if (!this.remove(sessionKey, pending)) return false;
		this.rememberDisposition(pending, PENDING_REVIEW_CONSENT_DISPOSITION.EXPIRED);
		return true;
	}

	discard(sessionKey: PendingReviewConsentSessionKey, pending: PendingReviewConsent): void {
		this.remove(sessionKey, pending);
	}

	staleDisposition(binding: string): PendingReviewConsentDisposition | undefined {
		return this.staleDispositions.get(binding);
	}

	take(sessionKey: PendingReviewConsentSessionKey): PendingReviewConsent[] {
		const session = this.sessions.get(sessionKey);
		this.sessions.delete(sessionKey);
		if (session !== undefined) for (const pending of session.values()) if (this.byBinding.get(pending.id) === sessionKey) this.byBinding.delete(pending.id);
		return session === undefined ? [] : [...session.values()];
	}
}

const processPendingReviewConsentRegistry = new PendingReviewConsentRegistry();
const processRetainedNativeStatusSelections = new Map<PendingReviewConsentSessionKey, Map<string, RetainedNativeStatusSelection>>();

// gentle-pi#556 / gentle-ai#4051: nesting depth of named-agent (SDD phase
// executor or other subagent) starts vs. ends for a session. Starts and
// ends are paired so a subagent's own loop end never leaves the primary
// loop's `agent_end` preflight suppressed for the rest of the session: a
// named-agent start increments the depth, a matching end decrements it,
// and a fresh primary-loop start resets it to 0.
const processAgentEndSubagentDepth = new Map<PendingReviewConsentSessionKey, number>();

// gentle-pi#677: gentle-ai#4309 owns anonymous usage telemetry end to end;
// Pi only nudges it once per process. This is a plain process-lifetime
// guard, not a session-keyed map, because the nudge is meant to fire at most
// once no matter how many primary-session `before_agent_start` events this
// process observes.
let processTelemetryTriggerAttempted = false;

/** Testing-only reset for the once-per-process telemetry trigger guard. */
function resetTelemetryTriggerGuardForTesting(): void {
	processTelemetryTriggerAttempted = false;
}

function pendingReviewConsentSessionKey(context: ExtensionContext | undefined, fallbackKey: symbol): PendingReviewConsentSessionKey {
	try {
		const sessionManager = (context as unknown as { sessionManager?: { getSessionId?: () => unknown } } | undefined)?.sessionManager;
		const sessionId = sessionManager?.getSessionId?.();
		if (typeof sessionId === "string") return sessionId;
	} catch { /* Minimal or test contexts use the registration-local fallback. */ }
	return fallbackKey;
}

function consumePendingReviewConsent(pending: PendingReviewConsent, registry: PendingReviewConsentRegistry, sessionKey: PendingReviewConsentSessionKey): boolean {
	if (!registry.consume(sessionKey, pending)) return false;
	if (pending.expiry !== undefined) clearTimeout(pending.expiry);
	pending.expiry = undefined;
	return true;
}

function discardPendingReviewConsent(pending: PendingReviewConsent, registry: PendingReviewConsentRegistry, sessionKey: PendingReviewConsentSessionKey): void {
	if (pending.expiry !== undefined) clearTimeout(pending.expiry);
	pending.expiry = undefined;
	registry.discard(sessionKey, pending);
}

function expirePendingReviewConsent(pending: PendingReviewConsent, registry: PendingReviewConsentRegistry, sessionKey: PendingReviewConsentSessionKey): void {
	if (pending.expiry !== undefined) clearTimeout(pending.expiry);
	pending.expiry = undefined;
	if (registry.expire(sessionKey, pending)) pending.cleanupCandidate();
}

function cleanupPendingReviewConsent(pending: PendingReviewConsent, registry: PendingReviewConsentRegistry, sessionKey: PendingReviewConsentSessionKey): void {
	discardPendingReviewConsent(pending, registry, sessionKey);
	pending.cleanupCandidate();
}

function cleanupAllPendingReviewConsents(registry: PendingReviewConsentRegistry, sessionKey: PendingReviewConsentSessionKey): void {
	for (const pending of registry.take(sessionKey)) cleanupPendingReviewConsent(pending, registry, sessionKey);
}

// An unused consent binding and the candidate view retained exclusively for
// that binding expire as one lifecycle unit. TTL expiry is observable the
// moment synchronous time says `expiresAt <= now`, so cleanup must be
// synchronous with respect to that observation — the queued cleanup
// macrotask is a safety net, not the authority. Pruning here (before any
// later START may reuse the retained view) keeps timer order from deciding
// correctness: a fresh candidate retry never reuses a view whose binding
// already expired, so it cannot trip `candidate-target-projection-drift`.
function pruneExpiredReviewConsents(registry: PendingReviewConsentRegistry, sessionKey: PendingReviewConsentSessionKey, now: () => number): void {
	const pendingReviewConsents = registry.get(sessionKey);
	if (pendingReviewConsents === undefined) return;
	for (const pending of [...pendingReviewConsents.values()]) {
		if (pending.expiresAt <= now()) expirePendingReviewConsent(pending, registry, sessionKey);
	}
}

function reviewConsentDigest(consent: ReviewConsentEnvelope): string {
	return createHash("sha256").update(JSON.stringify(consent)).digest("hex");
}

function reviewSessionManagerAndId(context: ExtensionContext): { manager: object; sessionId: string } | undefined {
	try {
		const manager = context.sessionManager as unknown as { getSessionId?: () => unknown };
		const sessionId = manager.getSessionId?.();
		if (typeof manager !== "object" || manager === null || typeof sessionId !== "string" || sessionId.length === 0) return undefined;
		return { manager, sessionId };
	} catch {
		return undefined;
	}
}

function isDirectOrdinaryReviewStart(parametersValue: unknown): boolean {
	try {
		const parameters = parseReviewControllerParameters(parametersValue);
		if (parameters.operation !== REVIEW_CONTROLLER_OPERATION.START) return false;
		const input = parseControllerJson(requiredControllerString(parameters, "input"), parameters.operation);
		return input.mode === REVIEW_MODE.ORDINARY;
	} catch {
		return false;
	}
}

function isHostReviewConsentEligibleOperation(parametersValue: unknown): boolean {
	if (isDirectOrdinaryReviewStart(parametersValue)) return true;
	try {
		return parseReviewControllerParameters(parametersValue).operation === REVIEW_CONTROLLER_OPERATION.SELECT_INTENDED_UNTRACKED;
	} catch {
		return false;
	}
}

function completedGrantedReviewConsent(outcome: Record<string, unknown>): boolean {
	if (
		outcome.operation !== REVIEW_CONTROLLER_OPERATION.ANSWER_CONSENT ||
		outcome.status !== undefined ||
		outcome.outcome !== undefined ||
		outcome.native_invocation_attempted === false ||
		outcome.mutation_performed === false ||
		outcome.lineage_created === false ||
		!isCanonicalProcessString(outcome.workspace_root)
	) return false;
	const result = outcome.result;
	if (!isRecord(result)) return false;
	const nonnegativeInteger = (value: unknown): boolean => Number.isInteger(value) && Number(value) >= 0;
	return isCanonicalProcessString(result.lineage_id) &&
		isCanonicalProcessString(result.state) &&
		isCanonicalProcessString(result.risk_tier) &&
		Array.isArray(result.selected_lenses) && result.selected_lenses.every(isCanonicalProcessString) &&
		nonnegativeInteger(result.changed_files) &&
		nonnegativeInteger(result.original_changed_lines) &&
		nonnegativeInteger(result.correction_budget) &&
		(result.action === "created" || result.action === "resumed" || result.action === "replayed" || result.action === "closed") &&
		typeof result.lenses_required === "boolean";
}

// gentle-pi#516: a binding this session does not hold (already answered,
// expired, or issued by another Pi session or process) used to fall through
// to the plain negotiated STATUS, which reads exactly like a healthy pre-start
// "ready" and sent the model back into START for a second consent prompt. The
// fact is local and proven before any provider call, so the outcome names the
// binding and the exit; the current STATUS rides along as context only.
const STALE_CONSENT_BINDING_DIAGNOSTIC_CODE = {
	EXPIRED: "consent-binding-expired",
	ALREADY_CONSUMED: "consent-binding-already-consumed",
	UNKNOWN: "consent-binding-unknown",
} as const;

type StaleConsentBindingDiagnosticCode = (typeof STALE_CONSENT_BINDING_DIAGNOSTIC_CODE)[keyof typeof STALE_CONSENT_BINDING_DIAGNOSTIC_CODE];

interface StaleConsentBindingDiagnostics {
	code: StaleConsentBindingDiagnosticCode;
	message: string;
}

function staleConsentBindingDiagnostics(binding: string, disposition: PendingReviewConsentDisposition | undefined): StaleConsentBindingDiagnostics {
	const exit = "Run START again for this candidate to obtain a fresh consent envelope and answer that envelope's binding once; do not resend this binding.";
	if (disposition === PENDING_REVIEW_CONSENT_DISPOSITION.EXPIRED) {
		return { code: STALE_CONSENT_BINDING_DIAGNOSTIC_CODE.EXPIRED, message: `consent binding ${binding} expired after ${PENDING_REVIEW_CONSENT_TTL_MS / 60_000} minutes without an answer. ${exit}` };
	}
	if (disposition === PENDING_REVIEW_CONSENT_DISPOSITION.CONSUMED) {
		return { code: STALE_CONSENT_BINDING_DIAGNOSTIC_CODE.ALREADY_CONSUMED, message: `consent binding ${binding} was already consumed by an earlier answer. ${exit}` };
	}
	return { code: STALE_CONSENT_BINDING_DIAGNOSTIC_CODE.UNKNOWN, message: `consent binding ${binding} is not held by this Pi session. ${exit}` };
}

function staleConsentBindingOutcome(operation: ReviewControllerOperation, binding: string, diagnostics: ReturnType<typeof staleConsentBindingDiagnostics>, status: ReviewStatusV3): Record<string, unknown> {
	const mapped = mapNativeTargetStatus(operation, status);
	return {
		...mapped,
		status: "blocked",
		outcome: "consent-binding-stale",
		consent_binding: binding,
		diagnostics,
		native_invocation_attempted: false,
		...nativeStartPreAuthorityRejection(),
		provider_action: status.action,
		...(status.action === "start" ? { next_action: "restart-for-fresh-consent" } : mapped.next_action === undefined ? { next_action: status.action } : {}),
	};
}

// gentle-pi#455 correction: cross-session resolution looks a binding up by
// its opaque id alone, so it must independently confirm the answering
// invocation addresses the same repository its owning START minted it for.
// This is a typed, non-bearer refusal in the same shape family as the
// stale-binding outcome -- it never runs the mode gate or native
// answerConsent, and never consumes the binding, so it stays answerable from
// the correct repository afterwards.
function consentBindingRepositoryMismatchOutcome(operation: ReviewControllerOperation, binding: string, mintingRepositoryCwd: string, answeringRepositoryCwd: string): Record<string, unknown> {
	return {
		operation,
		status: "blocked",
		outcome: "consent-binding-repository-mismatch",
		consent_binding: binding,
		diagnostics: {
			code: "consent-binding-repository-mismatch",
			message: `consent binding ${binding} was minted for repository ${mintingRepositoryCwd}, not ${answeringRepositoryCwd}. Answer this binding from a session addressing ${mintingRepositoryCwd}; do not resend this binding from a different repository.`,
		},
		native_invocation_attempted: false,
		...nativeStartPreAuthorityRejection(),
		next_action: "answer-from-minting-repository",
	};
}

// gentle-pi#874: the committed-range selector a current STATUS owns. A
// selectorless STATUS on a clean, fully committed worktree answers with a
// review.start execute transition naming the exact merge-base the provider
// wants, so a plain START can adopt the route the provider just rendered
// instead of making the caller hand-copy `base-ref` into its input. Only the
// provider's own offered argument is read -- never a guess, a persisted value,
// or a stale transition -- and anything that is not a full commit id paired
// with committed-only is refused, so every other STATUS keeps today's
// behaviour byte-for-byte.
const OFFERED_COMMITTED_RANGE_BASE_REF = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function offeredCommittedRangeBaseRef(target: ReviewStatusV3): string | undefined {
	const execute = target.nextTransition?.kind === "execute" ? target.nextTransition.execute : undefined;
	if (execute?.operation !== "review.start") return undefined;
	if (execute.arguments.some((argument) => argument.name === "workspace-overlay")) return undefined;
	const baseRef = execute.arguments.find((argument) => argument.name === "base-ref")?.value;
	if (baseRef === undefined || !OFFERED_COMMITTED_RANGE_BASE_REF.test(baseRef)) return undefined;
	if (execute.arguments.find((argument) => argument.name === "committed-only")?.value !== "true") return undefined;
	return baseRef;
}

function assertNativeStartCandidateBinding(candidateView: CandidateView, target: ReviewStatusV3): void {
	candidateView.verify();
	if (
		target.projection.projection !== "workspace" ||
		target.projection.baseTree !== candidateView.baseTree ||
		target.projection.initialReviewTree !== candidateView.candidateTree ||
		target.projection.currentCandidateTree !== candidateView.candidateTree ||
		JSON.stringify([...target.projection.paths].sort()) !== JSON.stringify([...candidateView.paths].sort()) ||
		(candidateView.intendedUntracked !== undefined && JSON.stringify([...target.projection.intendedUntracked].sort()) !== JSON.stringify([...candidateView.intendedUntracked].sort()))
	) {
		throw new CandidateViewError("native START workspace target does not match the immutable reviewer candidate view", "candidate-target-projection-drift");
	}
}

function completeNativeStart(
	operation: ReviewControllerOperation,
	result: NativeStartResult,
	workspaceRoot: string,
	candidateView: CandidateView | undefined,
	candidateViews: CandidateViewRegistry | null,
): Record<string, unknown> {
	if (candidateView === undefined) return { operation, result: mapNativeStartResult(result), workspace_root: workspaceRoot };
	if (candidateViews && result.lensesRequired) {
		const binding = { token: candidateView.token, lineageId: result.lineageId, selectedLenses: result.selectedLenses };
		if (result.action === "resumed" && !candidateViews.hasCurrentBinding(candidateView.contributorRoot)) candidateViews.restoreCurrentFromNativeStart(binding);
		else candidateViews.bindCurrent(binding);
	} else if (candidateViews && ((result.action === "created" && result.state === "reviewing") || result.action === "resumed")) candidateViews.retain(candidateView.token, result.lineageId);
	else candidateViews?.cleanup(candidateView.token);
	const actorBinding = result.lensesRequired
		? {
			workspace_root: workspaceRoot,
			candidate_root: candidateView.root,
			candidate_tree: candidateView.candidateTree,
			candidate_paths: candidateView.paths,
		}
		: undefined;
	return {
		operation,
		result: mapNativeStartResult(result),
		workspace_root: workspaceRoot,
		...(actorBinding === undefined ? {} : { actor_binding: actorBinding }),
	};
}

// gentle-ai#4003: every Pi-side teardown step that fails after the native
// burn is deferred cleanup, not a failed acknowledgement. Only the
// already-sanitized CandidateViewError surface is relayed; anything else is
// reduced to the step's fixed code so no path or command text reaches the
// caller. The candidate-view hint is out-of-band on purpose: no controller
// operation exposes a cleanup-only retry, and replaying acknowledge-approved
// would hit the already-burned lineage.
const POST_BURN_CLEANUP = {
	candidateView: { code: "candidate-view-cleanup-failed", nextAction: "retry-candidate-view-cleanup-or-remove-the-view-out-of-band" },
	retainedSelection: { code: "retained-selection-cleanup-failed", nextAction: "retained-selection-clears-on-the-next-terminal-status" },
} as const;

function deferredPostBurnCleanup(step: (typeof POST_BURN_CLEANUP)[keyof typeof POST_BURN_CLEANUP], cleanup: () => void): Record<string, unknown> | undefined {
	try {
		cleanup();
		return undefined;
	} catch (error) {
		return {
			status: "deferred",
			diagnostics: error instanceof CandidateViewError
				? { code: error.reason, message: error.message }
				: { code: step.code },
			next_action: step.nextAction,
		};
	}
}

function nativeOperationFailure(operation: ReviewControllerOperation | "gentle_review_capture", error: unknown): Record<string, unknown> {
	const value = error as { mutationOutcome?: unknown; nextAction?: unknown; diagnostics?: unknown; auditRecord?: unknown; launchAttempted?: unknown; candidateViewPreNative?: unknown; failureEnvelope?: { raw?: unknown; mutationOutcome?: unknown; replayability?: unknown; nextAction?: unknown; code?: unknown; continuation?: { command?: unknown } } };
	if (isRecord(value.failureEnvelope) && isRecord(value.failureEnvelope.raw)) {
		const mutationOutcome = value.failureEnvelope.mutationOutcome;
		return {
			operation,
			status: "blocked",
			native_failure: value.failureEnvelope.raw,
			...(mutationOutcome === "committed"
				? { mutation_performed: true, mutation_outcome: "committed" }
				: mutationOutcome === "unknown"
					? { mutation_outcome: "unknown" }
					: { mutation_performed: false, mutation_outcome: "none" }),
			...(typeof value.failureEnvelope.replayability === "string" ? { replayability: value.failureEnvelope.replayability } : {}),
			...(typeof value.failureEnvelope.nextAction === "string" ? { next_action: value.failureEnvelope.nextAction } : {}),
			// gentle-pi#627: START's preflight failure envelope for a stale
			// managed-asset set carries a top-level continuation; render its
			// `gentle-ai sync` command as the one actionable next step.
			...(value.failureEnvelope.code === "managed_assets_outdated" && typeof value.failureEnvelope.continuation?.command === "string"
				? { hint: `run ${value.failureEnvelope.continuation.command}` }
				: {}),
		};
	}
	// Every consent binding guard runs before the provider is launched, so this
	// is a local mismatch with nothing to reconcile. Reporting it as a native
	// operation failure hides the one fact that makes it fixable.
	const consentBinding = asNativeReviewConsentBindingError(error);
	if (consentBinding !== undefined) {
		return {
			operation,
			status: "blocked",
			outcome: "consent-binding-invalid",
			native_invocation_attempted: false,
			lineage_created: false,
			mutation_performed: false,
			mutation_outcome: "none" as const,
			diagnostics: { code: consentBinding.reason, message: consentBinding.message },
			next_action: "resolve-consent-binding",
		};
	}
	if (error instanceof NativeCaptureRouteRegistrationError) {
		return {
			operation,
			status: "blocked",
			outcome: "capture-route-registration-rejected",
			mutation_performed: false,
			mutation_outcome: "none",
		};
	}
	const mutationOutcome = value.mutationOutcome === "unknown" ? "unknown" : "none";
	const nativeCliError = asNativeReviewCliError(error);
	if (nativeCliError?.code === NATIVE_REVIEW_ERROR_CODE.PACKAGE_BINARY_MISSING) return nativeStatusPackageBinaryMissing(operation, nativeCliError.diagnostics);
	const nativeDiagnostics = nativeCliError?.diagnostics;
	// A target-status probe verifies `version` before it invokes `review/status`.
	// Preserve either already-sanitized diagnostic on every controller route rather
	// than relabeling an actionable failure as an opaque controller failure.
	const preservesNativeTargetStatusDiagnostic = nativeDiagnostics?.operation === NATIVE_REVIEW_OPERATION.VERSION || nativeDiagnostics?.operation === NATIVE_REVIEW_OPERATION.STATUS;
	const preservesAnswerConsentStartDiagnostic = operation === REVIEW_CONTROLLER_OPERATION.ANSWER_CONSENT && nativeDiagnostics?.operation === NATIVE_REVIEW_OPERATION.START;
	const diagnostics = operation === REVIEW_CONTROLLER_OPERATION.START && error instanceof CandidateViewError && value.candidateViewPreNative === true
		? error.diagnostics ?? { code: error.reason, message: "candidate view rejected before native START" }
		: error instanceof CandidateViewError
			? { code: error.reason, message: error.message }
			: nativeDiagnostics?.operation === `review/${operation}` || preservesNativeTargetStatusDiagnostic || preservesAnswerConsentStartDiagnostic
		? nativeDiagnostics
		: undefined;
	return {
		operation,
		status: "blocked",
		outcome: "native-operation-failed",
		...(operation === REVIEW_CONTROLLER_OPERATION.START && mutationOutcome === "none"
			? nativeStartPreAuthorityRejection()
			: mutationOutcome === "none"
				? { lineage_created: false, mutation_performed: false, mutation_outcome: "none" as const }
				: { mutation_outcome: mutationOutcome }),
		...(diagnostics === undefined ? {} : { diagnostics }),
		...(isRecord(value.auditRecord) ? { native_audit_record: value.auditRecord } : {}),
		...(mutationOutcome === "unknown" || value.nextAction === "review.status"
			? { replayability: "status_required", next_action: "review.status", required_status_action: requiredStatusActionText() }
			: { next_action: "resolve-native-operation-failure" }),
	};
}

function nativeMutationRequiresStatus(error: unknown): boolean {
	const value = error as {
		mutationOutcome?: unknown;
		nextAction?: unknown;
		failureEnvelope?: { mutationOutcome?: unknown; replayability?: unknown; nextAction?: unknown };
	};
	return value.mutationOutcome === "unknown" ||
		value.nextAction === "review.status" ||
		value.failureEnvelope?.mutationOutcome === "unknown" ||
		value.failureEnvelope?.replayability === "status_required" ||
		value.failureEnvelope?.nextAction === "review.status";
}

async function reconcileNativeMutationFailure(
	operation: ReviewControllerOperation,
	error: unknown,
	nativeReviewCli: NativeReviewCli,
	target: Parameters<NonNullable<NativeReviewCli["targetStatus"]>>[0],
	retainedSelections: Map<string, RetainedNativeStatusSelection>,
	preOperationRevision?: string,
	canonicalRetentionRoot = target.cwd,
): Promise<Record<string, unknown>> {
	const failure = nativeOperationFailure(operation, error);
	if (!nativeMutationRequiresStatus(error)) return failure;
	if (nativeReviewCli.targetStatus === undefined) {
		return {
			...failure,
			outcome: "native-mutation-status-required",
			replayability: "status_required",
			next_action: "review.status",
			required_status_action: requiredStatusActionText(target.lineageId),
		};
	}
	try {
		const status = await nativeReviewCli.targetStatus(target);
		syncRetainedNativeStatusSelections(retainedSelections, canonicalRetentionRoot, status, target.baseRef);
		const projectedStatus = mapNativeTargetStatus(operation, status, target.lineageId);
		const { next_action: staleNextAction, required_status_action: staleStatusDirective, ...reconciledBase } = failure;
		void staleNextAction;
		void staleStatusDirective;
		// Field defect (fambig, 2026-08-16): an envelope-less mutating failure
		// is stamped mutationOutcome "unknown", but a reconciled authority
		// revision identical to the pre-operation revision PROVES the failed
		// call never mutated. Report that proof as mutation_outcome none and
		// claim no replay prohibition for it. Every genuinely ambiguous result
		// — revision moved, no pre-operation revision held, or STATUS
		// unavailable — stays fail-closed exactly as before.
		if (preOperationRevision !== undefined && status.authority?.revision === preOperationRevision) {
			const { replayability: staleReplayability, ...provenBase } = reconciledBase;
			void staleReplayability;
			return {
				...provenBase,
				...projectedStatus,
				status: "blocked",
				outcome: "native-mutation-status-reconciled",
				reconciliation: status.raw,
				authority_applicability: status.applicability,
				provider_action: status.action,
				mutation_performed: false,
				mutation_outcome: "none",
				mutation_outcome_reason: `authority revision unchanged across reconciliation (${preOperationRevision}); the failed operation provably did not mutate`,
			};
		}
		return {
			...reconciledBase,
			...projectedStatus,
			status: "blocked",
			outcome: "native-mutation-status-reconciled",
			reconciliation: status.raw,
			authority_applicability: status.applicability,
			provider_action: status.action,
			replayability: status.replayability,
			...(status.action === "start" && projectedStatus.next_action === undefined ? { next_action: "start" } : {}),
			required_status_action: projectedStatus.required_status_action ?? requiredStatusActionText(target.lineageId),
		};
	} catch (statusError) {
		return {
			...failure,
			outcome: "native-mutation-status-reconciliation-failed",
			reconciliation_failure: nativeOperationFailure(REVIEW_CONTROLLER_OPERATION.STATUS, statusError),
			replayability: "status_required",
			next_action: "review.status",
			required_status_action: requiredStatusActionText(target.lineageId),
		};
	}
}

function reviewWorkspaceGitIdentity(cwd: string): { toplevel: string; commonDir: string } {
	const git = (...arguments_: string[]): string =>
		execFileSync("git", arguments_, { cwd, encoding: "utf8" }).trim();
	const toplevel = realpathSync(git("rev-parse", "--show-toplevel"));
	const commonDir = realpathSync(resolve(cwd, git("rev-parse", "--git-common-dir")));
	return { toplevel, commonDir };
}

/**
 * Resolves the explicit user-authorized workspace target. An explicit path may
 * be nested and may belong to a repository unrelated to the Pi session cwd;
 * Git resolves it to its canonical worktree top-level. The session cwd remains
 * the legacy default only when no target was selected or remembered.
 */
function resolveReviewControllerWorkspaceRoot(
	requested: string | undefined,
	sessionCwd: string,
	candidateViews: CandidateViewRegistry | null,
	lineageId: string | undefined,
): string {
	const remembered = requested === undefined && lineageId !== undefined
		? candidateViews?.resolveWorkspaceRoot(lineageId)
		: undefined;
	const selected = requested ?? remembered ?? sessionCwd;
	if (selected.trim().length === 0 || !isAbsolute(selected)) {
		throw new Error(`Review controller workspaceRoot must be an absolute path to an existing Git worktree root; received ${JSON.stringify(selected)}`);
	}
	let resolved: string;
	try {
		resolved = realpathSync(selected);
		if (!lstatSync(resolved).isDirectory()) throw new Error("not a directory");
	} catch {
		throw new Error(`Review controller workspaceRoot ${selected} is not an existing directory; create or adopt the worktree before binding review operations to it`);
	}
	let target: { toplevel: string; commonDir: string };
	try {
		target = reviewWorkspaceGitIdentity(resolved);
	} catch {
		if (requested === undefined && remembered === undefined) return sessionCwd;
		throw new Error(`Review controller workspaceRoot ${resolved} is not inside a Git worktree; review operations bind only to real worktrees of the session repository`);
	}
	if (lineageId !== undefined) candidateViews?.assertWorkspaceRoot(lineageId, target.toplevel);
	return target.toplevel;
}

function reviewLifecycleStorageKey(workspaceRoot: string, lineageId: string): string {
	return `${workspaceRoot}\u0000${lineageId}`;
}

function reviewCaptureSelectionStorageKey(collectBinding: string): string {
	return `capture\u0000${collectBinding}`;
}

function cloneRetainedNativeUntrackedSelection(selection: NativeStartUntrackedSelection): RetainedNativeUntrackedSelection | undefined {
	if (selection.untrackedScope === undefined || selection.expectedUntrackedInventory === undefined) return undefined;
	return Object.freeze({
		untrackedScope: selection.untrackedScope,
		expectedUntrackedInventory: selection.expectedUntrackedInventory,
		intendedUntracked: Object.freeze([...(selection.intendedUntracked ?? [])]),
	});
}

function retainNativeStatusSelection(selections: Map<string, RetainedNativeStatusSelection>, key: string, selection: RetainedNativeStatusSelection): void {
	if (!selections.has(key)) {
		while (selections.size >= MAX_RETAINED_NATIVE_STATUS_SELECTIONS) {
			const oldestKey = selections.keys().next().value;
			if (oldestKey === undefined) return;
			selections.delete(oldestKey);
		}
	}
	selections.set(key, selection);
}

function retainNativeUntrackedSelection(selections: Map<string, RetainedNativeStatusSelection>, workspaceRoot: string, lineageId: string, selection: RetainedNativeUntrackedSelection | undefined): void {
	if (selection !== undefined) retainNativeStatusSelection(selections, reviewLifecycleStorageKey(workspaceRoot, lineageId), selection);
}

function readRetainedNativeUntrackedSelection(selections: Map<string, RetainedNativeStatusSelection>, workspaceRoot: string, lineageId: string): NativeStartUntrackedSelection {
	const selection = selections.get(reviewLifecycleStorageKey(workspaceRoot, lineageId));
	return selection === undefined || "baseRef" in selection
		? {}
		: {
			untrackedScope: selection.untrackedScope,
			expectedUntrackedInventory: selection.expectedUntrackedInventory,
			intendedUntracked: [...selection.intendedUntracked],
		};
}

// gentle-pi#706: inspect's untrackedScope round trip retains the resolved
// selection under the pre-lineage empty-lineage key so the next plain START in
// that worktree adopts it without re-deriving the selection.
function nativePreLineageCandidateIdentity(
	status: ReviewStatusV3,
): { targetIdentity: string; candidateTree: string } | undefined {
	const candidateTree = status.projection.currentCandidateTree;
	return isCanonicalProcessString(status.targetIdentity) && isCanonicalProcessString(candidateTree)
		? { targetIdentity: status.targetIdentity, candidateTree }
		: undefined;
}

function readRetainedPreLineageNativeUntrackedSelection(
	selections: Map<string, RetainedNativeStatusSelection>,
	workspaceRoot: string,
): RetainedPreLineageNativeUntrackedSelection | undefined {
	const selection = selections.get(reviewLifecycleStorageKey(workspaceRoot, ""));
	return selection !== undefined &&
		!("baseRef" in selection) &&
		typeof (selection as Partial<RetainedPreLineageNativeUntrackedSelection>).targetIdentity === "string" &&
		typeof (selection as Partial<RetainedPreLineageNativeUntrackedSelection>).candidateTree === "string"
		? selection as RetainedPreLineageNativeUntrackedSelection
		: undefined;
}

function sameNativePreLineageCandidate(
	selection: RetainedPreLineageNativeUntrackedSelection,
	status: ReviewStatusV3,
): boolean {
	const identity = nativePreLineageCandidateIdentity(status);
	return identity !== undefined &&
		identity.targetIdentity === selection.targetIdentity &&
		identity.candidateTree === selection.candidateTree;
}

function isRetainedNativeCaptureRoute(selection: RetainedNativeStatusSelection | undefined): selection is RetainedNativeCaptureRoute {
	return selection !== undefined && "workspaceRoot" in selection;
}

function retainNativeCaptureRoutes(selections: Map<string, RetainedNativeStatusSelection>, workspaceRoot: string, status: ReviewStatusV3, baseRef: string | undefined): void {
	const lineageId = status.authority?.lineageId;
	if (status.applicability !== "current_target" || !isCanonicalProcessString(lineageId) || isTerminalReviewAuthorityState(status.authority?.state)) return;
	const routes = (status.nextTransition?.kind === "collect" ? status.nextTransition.collect?.inputs ?? [] : []).map((input) => ({ key: reviewCaptureSelectionStorageKey(canonicalReviewCaptureBinding(input)), route: Object.freeze({ workspaceRoot, lineageId, ...(baseRef === undefined ? {} : { baseRef, committedOnly: true as const }) }) }));
	for (const { key, route } of routes) {
		const existing = selections.get(key);
		if (isRetainedNativeCaptureRoute(existing) && (existing.workspaceRoot !== route.workspaceRoot || existing.lineageId !== route.lineageId || existing.baseRef !== route.baseRef || existing.committedOnly !== route.committedOnly)) throw new NativeCaptureRouteRegistrationError("Provider collectBinding collides with a different registered route");
	}
	const current = new Set(routes.map(({ key }) => key));
	for (const [key, selection] of selections) if (isRetainedNativeCaptureRoute(selection) && selection.workspaceRoot === workspaceRoot && selection.lineageId === lineageId && !current.has(key)) selections.delete(key);
	for (const { key, route } of routes) if (!selections.has(key)) retainNativeStatusSelection(selections, key, route);
}

function readRetainedNativeCaptureRoute(selections: Map<string, RetainedNativeStatusSelection>, collectBinding: string): RetainedNativeCaptureRoute | undefined {
	const selection = selections.get(reviewCaptureSelectionStorageKey(collectBinding));
	return isRetainedNativeCaptureRoute(selection) ? selection : undefined;
}

function isTerminalReviewAuthorityState(state: string | undefined): boolean { return state === "invalidated" || state === "approved" || state === "escalated"; }

function clearRetainedNativeUntrackedSelection(selections: Map<string, RetainedNativeStatusSelection>, workspaceRoot: string, lineageId: string): void {
	selections.delete(reviewLifecycleStorageKey(workspaceRoot, lineageId));
}

function clearRetainedNativeStatusSelectionsOnTerminal(selections: Map<string, RetainedNativeStatusSelection>, workspaceRoot: string, lineageId: string | undefined, state: string | undefined): void {
	if (lineageId === undefined || !isTerminalReviewAuthorityState(state)) return;
	if (state !== "approved") clearRetainedNativeUntrackedSelection(selections, workspaceRoot, lineageId);
	for (const [key, selection] of selections) if (isRetainedNativeCaptureRoute(selection) && selection.workspaceRoot === workspaceRoot && selection.lineageId === lineageId) selections.delete(key);
}

function syncRetainedNativeStatusSelections(selections: Map<string, RetainedNativeStatusSelection>, workspaceRoot: string, status: ReviewStatusV3, baseRef: string | undefined): void {
	clearRetainedNativeStatusSelectionsOnTerminal(selections, workspaceRoot, status.authority?.lineageId, status.authority?.state);
	retainNativeCaptureRoutes(selections, workspaceRoot, status, baseRef);
}

function requiresExplicitTargetLifecycleRoot(requested: string | undefined, sessionCwd: string, workspaceRoot: string): boolean {
	return requested !== undefined || workspaceRoot !== sessionCwd;
}

// gentle-pi#311 P4 — the thin Pi host relay. The provider decides which
// capture slots the host satisfies by issuing the --materialize token on a
// pi-bound `review.capture-result` collect input; nothing is ever inferred.
// The runner is injectable for tests only; production always uses the real
// relay in lib/review-host-relay.ts.
let activeReviewHostRelayRunner: ReviewHostRelayRunner = runReviewHostRelaySlot;
let activeReviewHostRelayReviewerGroupRunner = runReviewHostRelayReviewerGroup;
let activeReviewHostRelaySubmissionRunner = submitReviewHostRelayPreparedResult;
function setReviewHostRelayRunnerForTesting(runner?: ReviewHostRelayRunner): void {
	activeReviewHostRelayRunner = runner ?? runReviewHostRelaySlot;
}
function setReviewHostRelayGroupRunnersForTesting(reviewerGroup?: typeof runReviewHostRelayReviewerGroup, submission?: typeof submitReviewHostRelayPreparedResult): void {
	activeReviewHostRelayReviewerGroupRunner = reviewerGroup ?? runReviewHostRelayReviewerGroup;
	activeReviewHostRelaySubmissionRunner = submission ?? submitReviewHostRelayPreparedResult;
}

const REVIEW_HOST_RELAY_RETRY_ACTION =
	"Call fresh STATUS and submit only an exact reoffered one-slot binding; never replay this capture from transcript inference.";

// gentle-pi#522 / #524: gentle-ai refused the submission at admission and
// stated that the lens slot was not consumed. The refused bytes are the
// problem, so the continuation is a fresh reviewer run on the reoffered slot,
// not a replay and not an unknown-outcome reconciliation.
const REVIEW_HOST_RELAY_REFUSED_ACTION =
	"gentle-ai refused this submission at admission and did not consume the lens slot; the reason is in failure.stderr. "
	+ "Call fresh STATUS and run only the exact slot it reoffers so the reviewer produces a new result that satisfies that refusal; never resubmit the refused bytes.";

// gentle-pi#638: the declaration recorded, so fresh STATUS stops the review with one withdraw binding per declared slot instead of reoffering the reviewer. The withdraw command is the only way back to the same slot; everything else needs a smaller candidate and a new review.
const REVIEW_HOST_RELAY_UNACHIEVABLE_ACTION =
	"A deterministic relay failure was declared unachievable for this bound slot, and fresh STATUS now stops this review instead of reoffering the reviewer. "
	+ "If the failure was transient, run the withdraw command in unachievable_lens_slots with the same binding so the review re-offers this exact reviewer; otherwise reduce the candidate scope and start a new review.";

// gentle-pi#638: the relay failure was deterministic but gentle-ai refused the declaration, so no slot state changed and the review still needs a provider-bound continuation.
const REVIEW_HOST_RELAY_DECLARATION_FAILED_ACTION =
	"The relay failure was deterministic for this slot, but gentle-ai refused the unachievable declaration, so no slot state changed. "
	+ "Call fresh STATUS and follow only its declared action; never replay this capture from transcript inference.";

function reviewHostRelayTimeoutNextAction(error: ReviewHostRelayError): string {
	const measured = error.elapsedMs === null || error.timeoutMs === null
		? ""
		: ` The reviewer was killed after ${error.elapsedMs}ms against a ${error.timeoutMs}ms bound.`;
	return `Do not relaunch this slot unchanged: the same bound kills the same reviewer run again and re-spends the model tokens for nothing.${measured} `
		+ `Change one of two things first: export ${REVIEW_HOST_RELAY_PI_TIMEOUT_ENV}=<milliseconds> above the reviewer's real wall time (hard ceiling ${REVIEW_HOST_RELAY_PI_TIMEOUT_MAX_MS}), or reduce the candidate scope so the materialized prompt is smaller. `
		+ "Then call fresh STATUS and submit only its exact reoffered slot.";
}

function reviewHostRelayFailureReport(error: ReviewHostRelayError): Record<string, unknown> {
	return {
		kind: error.kind,
		stage: error.stage,
		exit_code: error.exitCode,
		timed_out: error.timedOut,
		...(error.elapsedMs === null ? {} : { elapsed_ms: error.elapsedMs }),
		...(error.timeoutMs === null ? {} : { timeout_ms: error.timeoutMs }),
		// The captured native stderr is the only place the provider's exact
		// refusal reason lives (gentle-pi#524); dropping it hid every admission
		// refusal behind "submission-refused".
		...(error.stderr.length === 0 ? {} : { stderr: error.stderr }),
	};
}

function mapLastEventClosure(
	closure: ReviewLastEventClosureV1,
	binding: ReviewLastEventClosureBinding,
): Record<string, unknown> {
	if (closure.lineageId !== binding.lineageId) throw new CandidateViewError("last-event closure returned a different lineage", "last-event-closure-binding-drift");
	if (binding.targetIdentity !== undefined && closure.targetIdentity !== undefined && closure.targetIdentity !== binding.targetIdentity) {
		throw new CandidateViewError("last-event closure returned a different target", "last-event-closure-binding-drift");
	}
	return {
		tool: "gentle_review_capture",
		status: "closed",
		outcome: "native-last-event-closure",
		closure: {
			schema: closure.schema,
			operation: closure.operation,
			lineage_id: closure.lineageId,
			state: closure.state,
			store_revision: closure.storeRevision,
			...(closure.action === undefined ? {} : { action: closure.action }),
			...(closure.targetIdentity === undefined ? {} : { target_identity: closure.targetIdentity }),
			...(closure.requestHash === undefined ? {} : { request_hash: closure.requestHash }),
			...(closure.correctionLines === undefined ? {} : { correction_lines: closure.correctionLines }),
			...(closure.advisoryFindings === undefined ? {} : { advisory_findings: closure.advisoryFindings }),
			...(closure.statusContinuation === undefined ? {} : { status_continuation: closure.statusContinuation.raw }),
			// The host has to see the acknowledgement to run it: approval now
			// waits for that exact invocation instead of burning on its own, so
			// dropping it here would strand the lineage as approved forever.
			...(closure.acknowledgement === undefined ? {} : { acknowledgement: closure.acknowledgement.raw }),
			// A present-but-unreadable continuation is not the same as none: the
			// host is approved and cannot end it here, and silence would read as
			// nothing left to do.
			...(closure.acknowledgementUndecodable === undefined ? {} : { acknowledgement_undecodable: true }),
		},
		lineage_id: closure.lineageId,
		state: closure.state,
		store_revision: closure.storeRevision,
	};
}

function mapAndClearLastEventClosure(
	closure: ReviewLastEventClosureV1,
	binding: ReviewLastEventClosureBinding,
	selections: Map<string, RetainedNativeStatusSelection>,
	workspaceRoot: string,
): Record<string, unknown> {
	const mapped = mapLastEventClosure(closure, binding);
	clearRetainedNativeStatusSelectionsOnTerminal(selections, workspaceRoot, closure.lineageId, closure.state);
	return mapped;
}

function decodeRelayLastEventClosure(submission: string): ReviewLastEventClosureV1 | undefined {
	let body: unknown;
	try { body = JSON.parse(submission); } catch { throw new CandidateViewError("host relay submission returned malformed JSON", "last-event-closure-decode-failed"); }
	if (typeof body !== "object" || body === null || Array.isArray(body) || (body as { schema?: unknown }).schema !== "gentle-ai.review-last-event-closure/v1") return undefined;
	return decodeReviewLastEventClosureV1(body);
}

async function reconcileUnknownReviewCaptureFailure(
	error: unknown | undefined,
	nativeReviewCli: NativeReviewCli,
	cwd: string,
	binding: ReviewLastEventClosureBinding,
	selections: Map<string, RetainedNativeStatusSelection>,
	route: RetainedNativeCaptureRoute | undefined,
	expectedReviewCaptureSuffix?: readonly string[],
	agent?: "pi",
): Promise<Record<string, unknown>> {
	const failure = error === undefined ? undefined : nativeOperationFailure("gentle_review_capture", error);
	if (error !== undefined && !nativeMutationRequiresStatus(error)) return failure;
	try {
		const selector = agent === undefined ? route : { ...route, agent };
		const status = await reconcileUnknownReviewLastEventCapture(nativeReviewCli, cwd, binding, selector);
		syncRetainedNativeStatusSelections(selections, cwd, status, route?.baseRef);
		if (expectedReviewCaptureSuffix !== undefined && !hasExactReviewCaptureSuffix(status, expectedReviewCaptureSuffix)) return captureGroupAuthorityDrift(status);
		return {
			tool: "gentle_review_capture",
			status: "reconciled",
			outcome: "native-capture-outcome-unknown",
			...(failure === undefined ? {} : { native_failure: failure }),
			lineage_id: binding.lineageId,
			target_identity: status.targetIdentity,
			provider_action: status.action,
			...(status.nextTransition === undefined ? {} : { next_transition: status.nextTransition }),
			result: status.raw,
		};
	} catch (statusError) {
		const reconciliationFailure = nativeOperationFailure("gentle_review_capture", statusError);
		return { ...(failure ?? reconciliationFailure), outcome: "native-capture-status-reconciliation-failed", reconciliation_failure: reconciliationFailure };
	}
}

async function executeReviewHostRelayCapture(
	slot: ReviewHostRelaySlot,
	nativeReviewCli: NativeReviewCli,
	cwd: string,
	binding: ReviewLastEventClosureBinding,
	selections: Map<string, RetainedNativeStatusSelection>,
	route: RetainedNativeCaptureRoute | undefined,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	try {
		if (slot.submission === undefined) {
			throw new ReviewHostRelayError(
				REVIEW_HOST_RELAY_FAILURE.SUBMISSION_CONTRACT_MISMATCH,
				"binding",
				REVIEW_HOST_RELAY_SUBMISSION_MISSING_MESSAGE,
			);
		}
		const result = await activeReviewHostRelayRunner({
			captureArgumentTokens: slot.captureArgumentTokens,
			targetCwd: cwd,
			submission: slot.submission,
			...(signal === undefined ? {} : { signal }),
		});
		const closure = decodeRelayLastEventClosure(result.submission);
		if (closure !== undefined) return mapAndClearLastEventClosure(closure, binding, selections, cwd);
		return {
			tool: "gentle_review_capture",
			status: "captured",
			outcome: "native-reviewer-result-captured",
			lineage_id: binding.lineageId,
			host_relay: {
				transport: "pi_host_relay",
				...(slot.lens === undefined ? {} : { lens: slot.lens }),
				...(slot.order === undefined ? {} : { order: slot.order }),
				...(slot.subjectHash === undefined ? {} : { subject_hash: slot.subjectHash }),
				prompt_bytes: result.promptByteLength,
				result_bytes: result.resultByteLength,
				submission: result.submission,
			},
		};
	} catch (error) {
		if (!(error instanceof ReviewHostRelayError)) return await reconcileUnknownReviewCaptureFailure(error, nativeReviewCli, cwd, binding, selections, route, undefined, REVIEW_HOST_AGENT);
		if (error.mutationOutcome === "unknown") {
			return {
				...(await reconcileUnknownReviewCaptureFailure(error, nativeReviewCli, cwd, binding, selections, route, undefined, REVIEW_HOST_AGENT)),
				failure: reviewHostRelayFailureReport(error),
				reason: error.message,
			};
		}
		if (error.kind === REVIEW_HOST_RELAY_FAILURE.RELAY_UNAVAILABLE) {
			return {
				tool: "gentle_review_capture",
				status: "blocked",
				outcome: "pi-host-relay-unavailable",
				reason: REVIEW_HOST_RELAY_UNAVAILABLE_MESSAGE,
				mutation_performed: false,
				mutation_outcome: "none",
			};
		}
		if (error.kind === REVIEW_HOST_RELAY_FAILURE.HANDSHAKE_REFUSED) {
			return {
				tool: "gentle_review_capture",
				status: "blocked",
				outcome: "pi-host-relay-handshake-refused",
				reason: error.message,
				refusal: error.stderr,
				mutation_performed: false,
				mutation_outcome: "none",
			};
		}
		// gentle-pi#638: the two deterministic relay failure classes end the slot, not the transport. Declaring the slot unachievable through the native verb records the provider-owned fact that this reviewer cannot complete under current conditions, then exactly one bound STATUS re-query renders the typed stop with its withdraw binding instead of reoffering the same slot. The declaration binding is re-derived from the slot's own provider-issued `--name=value` tokens, never from transcript state.
		const unachievableReason = reviewHostRelayUnachievableReason(error);
		const declarationBinding = unachievableSlotDeclarationBinding(slot);
		if (unachievableReason !== undefined && declarationBinding !== undefined && nativeReviewCli.captureUnachievableLens !== undefined) {
			let declared: NativeReviewUnachievableLensCaptureArtifact | undefined;
			try {
				declared = await nativeReviewCli.captureUnachievableLens({ cwd, ...declarationBinding, reason: unachievableReason, ...(reviewHostRelayUnachievableDetail(error) === undefined ? {} : { detail: reviewHostRelayUnachievableDetail(error)! }), ...(signal === undefined ? {} : { signal }) });
			} catch (declarationError) {
				// Fail open only on the unknown-verb capability refusal: an older binary without `capture-unachievable` keeps today's transport-failure behavior below. Every other declaration failure is surfaced, never hidden behind the relay failure it followed.
				if (!isNativeReviewUnachievableVerbRefused(declarationError)) {
					// gentle-pi#822 (outside-diff): the declaration failure's own envelope carries the mutation truth — the process may have recorded the declaration before failing — so the mutation fields are derived from it instead of hardcoded none, and an unknown outcome is proven or disproven by one bound STATUS re-query without ever changing the failure outcome.
					const declarationFailureReport = nativeOperationFailure("gentle_review_capture", declarationError);
					let declarationMutationPerformed = declarationFailureReport.mutation_performed === true;
					let declarationMutationOutcome: "none" | "unknown" | "committed" = declarationFailureReport.mutation_outcome === "committed" ? "committed" : declarationFailureReport.mutation_outcome === "unknown" ? "unknown" : "none";
					if (declarationMutationOutcome === "unknown") {
						try {
							const status = await reconcileUnknownReviewLastEventCapture(nativeReviewCli, cwd, binding, route === undefined ? { agent: REVIEW_HOST_AGENT } : { ...route, agent: REVIEW_HOST_AGENT });
							syncRetainedNativeStatusSelections(selections, cwd, status, route?.baseRef);
							const stop = status.nextTransition?.kind === "stop" && status.nextTransition.reasonCode === "unachievable_lens_slot" ? status.nextTransition : undefined;
							const declaredSlot = stop?.unachievableLensSlots?.find((candidate) => candidate.lens === slot.lens && String(candidate.selectedOrder) === slot.order && candidate.subjectHash === declarationBinding.requestHash && candidate.withdraw.binding.targetIdentity === declarationBinding.targetIdentity && candidate.withdraw.binding.lineageId === declarationBinding.lineageId && candidate.withdraw.binding.revision === declarationBinding.expectedRevision);
							if (stop !== undefined && declaredSlot !== undefined) {
								declarationMutationPerformed = true;
								declarationMutationOutcome = "committed";
							}
						} catch {
							// Without proof the mutation stays unknown; the declaration failure is already the reported outcome.
						}
					}
					return {
						tool: "gentle_review_capture",
						status: "blocked",
						outcome: "unachievable-lens-declaration-failed",
						reason: error.message,
						failure: reviewHostRelayFailureReport(error),
						declaration_failure: declarationFailureReport,
						mutation_performed: declarationMutationPerformed,
						mutation_outcome: declarationMutationOutcome,
						next_action: REVIEW_HOST_RELAY_DECLARATION_FAILED_ACTION,
					};
					}
			}
			if (declared !== undefined) {
				const declaration = { lens: declared.lens, selected_order: declared.selectedOrder, subject_hash: declarationBinding.requestHash, reason: declared.reason };
				try {
					const status = await reconcileUnknownReviewLastEventCapture(nativeReviewCli, cwd, binding, route === undefined ? { agent: REVIEW_HOST_AGENT } : { ...route, agent: REVIEW_HOST_AGENT });
					syncRetainedNativeStatusSelections(selections, cwd, status, route?.baseRef);
					const stop = status.nextTransition?.kind === "stop" && status.nextTransition.reasonCode === "unachievable_lens_slot" ? status.nextTransition : undefined;
					// gentle-pi#822: the stop may also carry slots declared by other runs, so expose only the entry matching the identity this session just declared. A stop with slots but no matching entry is a reconciliation failure, never a success rendering someone else's withdraw command.
					const declaredSlot = stop?.unachievableLensSlots?.find((slot) => slot.lens === declaration.lens && slot.selectedOrder === declaration.selected_order && slot.subjectHash === declaration.subject_hash && slot.withdraw.binding.targetIdentity === declarationBinding.targetIdentity && slot.withdraw.binding.lineageId === declarationBinding.lineageId && slot.withdraw.binding.revision === declarationBinding.expectedRevision);
					// gentle-pi#822: success is proven, never assumed — a STATUS with no unachievable_lens_slot stop at all (no transition, a different reason code, or a collect reoffer) is a reconciliation failure exactly like a stop whose entries do not match the declared identity.
					if (declaredSlot === undefined) {
						return {
							tool: "gentle_review_capture",
							status: "blocked",
							outcome: "unachievable-lens-declaration-reconciliation-failed",
							reason: error.message,
							failure: reviewHostRelayFailureReport(error),
							declaration,
							reconciliation_failure: { operation: "gentle_review_capture", status: "blocked", outcome: "unachievable-lens-slot-declaration-unmatched", reason: stop === undefined ? "the bound STATUS did not return the unachievable_lens_slot stop" : "no unachievable_lens_slots entry matches the declared slot identity", declared_slot: { lens: declaration.lens, selected_order: declaration.selected_order, subject_hash: declaration.subject_hash }, mutation_performed: true, mutation_outcome: "committed" },
							mutation_performed: true,
							mutation_outcome: "committed",
							next_action: REVIEW_HOST_RELAY_DECLARATION_FAILED_ACTION,
						};
					}
					return {
						tool: "gentle_review_capture",
						status: "blocked",
						outcome: "unachievable-lens-slot-declared",
						reason: error.message,
						failure: reviewHostRelayFailureReport(error),
						declaration,
						provider_action: status.action,
						...(status.nextTransition === undefined ? {} : { next_transition: status.nextTransition }),
						unachievable_lens_slots: [{ lens: declaredSlot.lens, selected_order: declaredSlot.selectedOrder, subject_hash: declaredSlot.subjectHash, reason: declaredSlot.reason, ...(declaredSlot.detail === undefined ? {} : { detail: declaredSlot.detail }), withdraw: declaredSlot.withdraw.command }],
						result: status.raw,
						next_action: REVIEW_HOST_RELAY_UNACHIEVABLE_ACTION,
						mutation_performed: true,
						mutation_outcome: "committed",
					};
				} catch (statusError) {
					return {
						tool: "gentle_review_capture",
						status: "blocked",
						outcome: "unachievable-lens-declaration-reconciliation-failed",
						reason: error.message,
						failure: reviewHostRelayFailureReport(error),
						declaration,
						reconciliation_failure: nativeOperationFailure("gentle_review_capture", statusError),
						mutation_performed: true,
						mutation_outcome: "committed",
						next_action: REVIEW_HOST_RELAY_DECLARATION_FAILED_ACTION,
					};
				}
			}
		}
		return {
			tool: "gentle_review_capture",
			status: "blocked",
			outcome: error.kind === REVIEW_HOST_RELAY_FAILURE.PI_TIMED_OUT ? "pi-host-relay-timeout" : "pi-host-relay-transport-failure",
			failure: reviewHostRelayFailureReport(error),
			reason: error.message,
			mutation_performed: false,
			mutation_outcome: "none",
			next_action: error.kind === REVIEW_HOST_RELAY_FAILURE.PI_TIMED_OUT
				? reviewHostRelayTimeoutNextAction(error)
				: error.kind === REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED
					? REVIEW_HOST_RELAY_REFUSED_ACTION
					: REVIEW_HOST_RELAY_RETRY_ACTION,
		};
	}
}

const REVIEW_PROVIDER_ROLE_RETRY_ACTION =
	"Call fresh STATUS and execute only the exact one-slot role vector it reoffers; never relaunch from transcript inference.";

// gentle-pi#638: re-derives the capture-unachievable declaration binding from one materialize slot's own provider-issued tokens. The provider renders those tokens as `--name=value` pairs (review-host-relay.ts renderToken), and Go verifies every value against the frozen authority before recording, so a missing required value or subject hash means the slot cannot be declared and the caller keeps its fall-back behavior.
function unachievableSlotDeclarationBinding(slot: ReviewHostRelaySlot): { lineageId: string; targetIdentity: string; expectedRevision: string; requestHash: string; repositoryContext?: string } | undefined {
	const tokenValue = (name: string): string | undefined => {
		const prefix = `--${name}=`;
		const token = slot.captureArgumentTokens.find((candidate) => candidate.startsWith(prefix));
		return token === undefined ? undefined : token.slice(prefix.length);
	};
	const lineageId = tokenValue("lineage");
	const targetIdentity = tokenValue("target");
	const expectedRevision = tokenValue("expected-revision");
	const repositoryContext = tokenValue("repository-context");
	if (lineageId === undefined || targetIdentity === undefined || expectedRevision === undefined || slot.subjectHash === undefined) return undefined;
	return { lineageId, targetIdentity, expectedRevision, requestHash: slot.subjectHash, ...(repositoryContext === undefined ? {} : { repositoryContext }) };
}

async function executeProviderRoleVectorCapture(
	slot: ReviewProviderRoleVectorSlot,
	nativeReviewCli: NativeReviewCli,
	cwd: string,
	binding: ReviewLastEventClosureBinding,
	selections: Map<string, RetainedNativeStatusSelection>,
	route: RetainedNativeCaptureRoute | undefined,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	if (nativeReviewCli.captureProviderRole === undefined) {
		return {
			tool: "gentle_review_capture",
			status: "blocked",
			outcome: "provider-role-capture-unsupported",
			reason: "The provider issued a self-contained role capture vector, but this runtime has no native provider-role capture surface.",
			mutation_performed: false,
			mutation_outcome: "none",
		};
	}
	try {
		const artifact = await nativeReviewCli.captureProviderRole({
			captureOperation: slot.captureOperation,
			argumentTokens: slot.argumentTokens,
			cwd,
			...(signal === undefined ? {} : { signal }),
		});
		if ("operation" in artifact) return mapAndClearLastEventClosure(artifact, binding, selections, cwd);
		return {
			tool: "gentle_review_capture",
			status: "captured",
			outcome: "native-provider-role-captured",
			lineage_id: artifact.lineageId,
			provider_role: {
				transport: "go_owned_pi_process",
				capture_operation: slot.captureOperation,
				role: artifact.role,
				target_identity: artifact.targetIdentity,
				captured: artifact.captured,
			},
		};
	} catch (error) {
		const outcome = await reconcileUnknownReviewCaptureFailure(error, nativeReviewCli, cwd, binding, selections, route);
		return {
			...outcome,
			...(outcome.status === "reconciled" ? {} : { retry_discipline: REVIEW_PROVIDER_ROLE_RETRY_ACTION }),
		};
	}
}

// The provider-named lenses still awaiting a reviewer result: one lens per
// pending `review.capture-result` collect input, in provider order.
function pendingReviewerLenses(status: ReviewStatusV3): readonly string[] {
	if (status.nextTransition?.kind !== "collect") return [];
	return [...new Set((status.nextTransition.collect?.inputs ?? [])
		.filter((input) => input.captureOperation === "review.capture-result")
		.map((input) => input.artifactSubject?.lens)
		.filter((lens): lens is NonNullable<typeof lens> => lens !== undefined))];
}

// Live defect (2026-08-16, Engram #12461): a successor lineage created by
// native `review recover` exists only in native authority — this controller
// never saw its START, so direct reviewer dispatch refused with
// current-binding-missing even though the controller itself had just decoded
// the successor's authoritative STATUS. Mirror the START-time registration
// from STATUS discovery: when an unknown-but-live lineage still collecting
// reviewer results appears in a status this controller decoded, restore its
// frozen projection from the native descriptor and bind the dispatch-facing
// current candidate view with the provider-named pending lenses.
//
// Field report (2026-08-16, gentle-pi 402f9f77): hydration must run from
// EVERY lane that decodes an authoritative status, not from the STATUS
// operation alone — the reported flow was `finalize` (blocked on
// review.capture-result) followed by a reviewer dispatch, which never passed
// through STATUS. It also never fails its caller: STATUS and the blocked
// FINALIZE envelope stay read-only, and the outcome is returned so the caller
// can report it instead of swallowing it.
// Field defect (2026-08-16, third report): the Pi host relay never ran for a
// real lineage. Measured against the live 2.4.0-main provider on a faithful
// reproduction — an agent-less `review status` returns a bare capture-result
// collect input (lineage, expected-revision, target, repository-context, lens,
// order, subject-hash), while the SAME status with `--agent pi` additionally
// carries agent=pi, materialize=true and the provider submission. The adapter
// never named its agent, so reviewHostRelaySlots() saw zero materialize slots,
// the relay was unreachable, and no lens was ever launched.
//
// The agent is PROBED, never assumed. The pinned provider defines `--agent` as
// of v2.4.0 — v2.2.3 did not define it on `review status` at all and refused it
// outright — but Pi still never version-sniffs: the installed binary remains
// the only authority on whether the flag exists. A typed refusal is remembered
// per provider instance and blocks the lifecycle with its exact provider cause;
// Pi never degrades it into an agent-less STATUS fallback.
const REVIEW_HOST_AGENT = "pi" as const;
const REVIEW_TRANSPORT_REFUSAL_CODES = new Set([
	"immutable_review_transport_unsupported",
	"unsupported_agent",
	"unknown_flag",
]);
interface ReviewTransportRefusal { supported: false; code: string; message: string; }
interface NegotiatedHostTransportStatus {
	status?: ReviewStatusV3;
	transport?: ReviewTransportRefusal;
}
const reviewTransportRefusalByProvider = new WeakMap<object, ReviewTransportRefusal>();

function clearReviewTransportProbeForTesting(nativeReviewCli: NativeReviewCli | null): void {
	if (nativeReviewCli !== null) reviewTransportRefusalByProvider.delete(nativeReviewCli as unknown as object);
}

function hostTransportUnavailable(
	operation: ReviewControllerOperation | "gentle_review_capture" | "gentle_review_capture_group",
	transport: ReviewTransportRefusal,
): Record<string, unknown> {
	// #535: a provider-printed raw `gentle-ai review ...` continuation is a dead
	// end in this runtime — Pi is not in the provider's immutable review runtime
	// list, so every CLI-only exit refuses with this same transport code. The
	// refusal therefore names the continuation that runs in this surface (the
	// gentle_review / gentle_review_capture wrapper tools) while the provider's
	// own diagnostic stays intact in relay_transport as evidence.
	const isCapture = operation === "gentle_review_capture" || operation === "gentle_review_capture_group";
	return {
		...(isCapture ? { tool: operation } : { operation }),
		status: "blocked",
		outcome: "pi-host-relay-transport-unavailable",
		reason: `The native provider refused the required pi reviewer transport (${transport.code}): ${transport.message}`,
		relay_transport: transport,
		mutation_performed: false,
		mutation_outcome: "none",
		wrapper_continuation: {
			tool: "gentle_review",
			operation: REVIEW_CONTROLLER_OPERATION.INSPECT,
			...(isCapture ? { then: operation } : {}),
		},
		next_action: `Install a native gentle-ai provider that supports \`review status --agent pi\`, then re-enter negotiated STATUS with gentle_review {"operation":"inspect"}${!isCapture ? " and follow the transition it returns" : operation === "gentle_review_capture_group" ? " and resubmit gentle_review_capture_group with the complete exact ordered collectBindings that fresh STATUS returns" : " and resubmit gentle_review_capture with the exact one-slot collectBinding that fresh STATUS returns"}. A provider-printed raw CLI continuation does not run in this runtime, and Pi never falls back to an agent-less lifecycle route.`,
	};
}

/**
 * Queries negotiated STATUS for the required pi reviewer transport. A typed
 * refusal is cached per provider and returned as unavailable; neither a fresh
 * nor remembered refusal may issue an agent-less lifecycle STATUS request.
 */
async function negotiatedStatusForHostTransport(
	nativeReviewCli: NativeReviewCli,
	request: NativeTargetStatusRequest,
	retainedSelections: Map<string, RetainedNativeStatusSelection>,
	canonicalRetentionRoot = request.cwd,
): Promise<NegotiatedHostTransportStatus> {
	const provider = nativeReviewCli as unknown as object;
	const remembered = reviewTransportRefusalByProvider.get(provider);
	if (remembered !== undefined) return { transport: remembered };
	try {
		const status = await nativeReviewCli.targetStatus!({ ...request, agent: REVIEW_HOST_AGENT });
		syncRetainedNativeStatusSelections(retainedSelections, canonicalRetentionRoot, status, request.baseRef);
		return { status };
	} catch (error) {
		const code = error instanceof NativeReviewIntegrationError ? error.failureEnvelope.code : undefined;
		// Only the closed transport-refusal set is typed unavailable; every
		// other failure remains an error for the caller's normal error path.
		if (code === undefined || !REVIEW_TRANSPORT_REFUSAL_CODES.has(code)) throw error;
		const transport: ReviewTransportRefusal = { supported: false, code, message: error.message };
		reviewTransportRefusalByProvider.set(provider, transport);
		return { transport };
	}
}

// gentle-pi#568: resolves the current negotiated review STATUS for a session,
// under the exact guards `agent_end` uses to decide whether to nudge: a
// native review CLI with both `reviewMode` and `targetStatus`, a UI-bearing
// context, and RDD effectively on. Returns `undefined` on any missing guard,
// an effective-off mode, or any STATUS error or transport refusal. Startup
// negotiation and mutation-gated `agent_end` use the same native whole-target
// path; neither derives candidate scope from local mutation receipts.
async function resolveNegotiatedReviewStatusForSession(
	nativeReviewCli: NativeReviewCli | null,
	ctx: ExtensionContext,
	sessionKey: PendingReviewConsentSessionKey,
): Promise<ReviewStatusV3 | undefined> {
	if (nativeReviewCli?.reviewMode === undefined || nativeReviewCli.targetStatus === undefined) return undefined;
	if (ctx.hasUI !== true) return undefined;
	let modeEffective: "on" | "off";
	try {
		const mode = await nativeReviewCli.reviewMode({ cwd: ctx.cwd, operation: NATIVE_REVIEW_MODE_OPERATION.STATUS });
		modeEffective = mode.status.effective;
	} catch {
		return undefined;
	}
	if (modeEffective === "off") return undefined;
	try {
		const retainedSelections = ((key: PendingReviewConsentSessionKey) => processRetainedNativeStatusSelections.get(key) ?? processRetainedNativeStatusSelections.set(key, new Map()).get(key)!)(sessionKey);
		const negotiated = await negotiatedStatusForHostTransport(nativeReviewCli, { cwd: ctx.cwd }, retainedSelections, ctx.cwd);
		return negotiated.status;
	} catch {
		return undefined;
	}
}

// gentle-pi#556 / gentle-ai#4051: the mutation-gated reminder sent
// through `agent_end`. It never runs START itself, so it names the one
// supported continuation (gentle_review inspect) and defers the resulting
// consent envelope to the human.
function renderAgentEndReviewPreflightMessage(targetIdentity: string): string {
	return `Receipt-driven development is enabled, and this worktree holds an unreviewed candidate (target ${targetIdentity}). First determine whether the user explicitly left this exact target unreviewed. If yes, do not invoke review; report that disposition and continue. Only otherwise, call the gentle_review tool with {"operation":"inspect"} and follow the transition it returns; it currently offers review.start for this target. An eligible interactive Pi host may resolve consent directly with its own three-action UI. If gentle_review instead returns an unresolved gentle-ai.review-integration.consent/v3 envelope, relay that original two-choice provider envelope to the human losslessly. Never answer consent from model prose or tool arguments.\n\nThis extension never runs START itself. This reminder consumes only this session's observed mutation generation.`;
}

function canonicalReviewCaptureBinding(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((entry) => canonicalReviewCaptureBinding(entry)).join(",")}]`;
	if (!isRecord(value)) throw new Error("Review capture collectBinding must encode a JSON object");
	return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalReviewCaptureBinding(value[key])}`).join(",")}}`;
}

function parseCanonicalReviewCaptureBinding(input: string): string {
	let binding: unknown;
	try {
		binding = JSON.parse(input);
	} catch (error) {
		throw new Error(`Review capture collectBinding is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(binding)) throw new Error("Review capture collectBinding must encode exactly one collect input object");
	return canonicalReviewCaptureBinding(binding);
}

function exactCollectArgument(input: ReviewCollectInputV3, name: string): string | undefined {
	const matches = input.arguments.filter((argument) => argument.name === name);
	return matches.length === 1 ? matches[0]!.value : undefined;
}

// The intended-untracked collect input arrived with status/v6 and every later
// status version keeps it; matching one exact version left every workspace
// with untracked files unable to start a review once gentle-ai answered v7
// (gentle-pi#610, gentle-ai#4187).
const INTENDED_UNTRACKED_STATUS_SCHEMA = /^gentle-ai\.review-integration\.status\/v(\d+)$/;
function statusCarriesIntendedUntrackedSelection(schema: unknown): boolean {
	const match = typeof schema === "string" ? INTENDED_UNTRACKED_STATUS_SCHEMA.exec(schema) : null;
	return match !== null && Number(match[1]) >= 6;
}

function reviewIntendedUntrackedInput(status: ReviewStatusV3): ReviewCollectInputV3 | undefined {
	if (!statusCarriesIntendedUntrackedSelection(status.raw.schema) || status.nextTransition?.kind !== "collect") return undefined;
	const matches = (status.nextTransition.collect?.inputs ?? []).filter((input) => {
		const value = input.submission?.values[0];
		return input.name === "intended_untracked_selection" && input.schema === "gentle-ai.review-intended-untracked-selection/v1" && input.captureOperation === "external.select_intended_untracked" && input.submission?.operationToken === "status" && input.submission.values.length === 1 && value?.slot === "intended_untracked_selection" && value.domain === "schema_bound_json";
	});
	return matches.length === 1 ? matches[0] : undefined;
}

// gentle-pi#706: the inspect stop on the intended-untracked selection carries no
// continuation, so the blocked result names it exactly: the inventory digest
// covers path names only, and the round trip resolves either through the select
// operation or through inspect's own top-level untrackedScope.
const INSPECT_UNTRACKED_SELECTION_NEXT_STEP =
	'The intended-untracked selection is required before START. The expected_untracked_inventory digest covers untracked path names only (git ls-files --others --exclude-standard); nothing is read or hashed at inventory time, and file content is hashed only for selected paths at candidate freeze. Either call gentle_review with operation "select-intended-untracked" passing this selectionBinding and intendedUntracked ([] excludes every eligible path, a subset includes only those paths), or call inspect again with untrackedScope ("exclude", or "select" with intendedUntracked) to resolve the round trip in one call. To keep a path out of the inventory permanently, ignore it through .gitignore or .git/info/exclude.';

interface PublicReviewCaptureBinding { collectBinding: string; }
function publicReviewCaptureBindings(status: ReviewStatusV3): readonly PublicReviewCaptureBinding[] {
	if (status.nextTransition?.kind !== "collect") return [];
	return (status.nextTransition.collect?.inputs ?? []).filter((input) => input.captureOperation !== "external.select_intended_untracked").map((input) => ({ collectBinding: canonicalReviewCaptureBinding(input) }));
}

function captureBindingRejected(reason: string, group = false): Record<string, unknown> {
	return {
		tool: group ? "gentle_review_capture_group" : "gentle_review_capture",
		status: "blocked",
		outcome: group ? "capture-group-rejected" : "capture-binding-rejected",
		reason,
		mutation_performed: false,
		mutation_outcome: "none",
	};
}

interface SelectedReviewCapture {
	input: ReviewCollectInputV3;
	binding: ReviewLastEventClosureBinding;
}

function selectExactReviewCapture(
	status: ReviewStatusV3,
	lineageId: string,
	canonicalBinding: string,
): SelectedReviewCapture | Record<string, unknown> {
	const statusLineageId = status.authority?.lineageId;
	const statusTargetIdentity = status.targetIdentity;
	if (
		!isCanonicalProcessString(lineageId) ||
		!isCanonicalProcessString(statusLineageId) ||
		!isCanonicalProcessString(statusTargetIdentity) ||
		status.applicability !== "current_target" ||
		statusLineageId !== lineageId
	) {
		return captureBindingRejected("current STATUS does not offer one non-empty matching lineage and target identity");
	}
	if (status.nextTransition?.kind !== "collect") {
		return captureBindingRejected("current STATUS does not offer a collect transition");
	}
	const matches = (status.nextTransition.collect?.inputs ?? []).filter((input) => canonicalReviewCaptureBinding(input) === canonicalBinding);
	if (matches.length !== 1) {
		return captureBindingRejected(matches.length === 0
			? "collectBinding is missing or stale for current STATUS"
			: "collectBinding matches more than one current STATUS input");
	}
	const input = matches[0]!;
	const inputLineageId = exactCollectArgument(input, "lineage");
	const inputTargetIdentity = exactCollectArgument(input, "target");
	// Go's targeted-validator vector binds its capture target to the correction
	// target from the provider-owned validation request, rather than STATUS's
	// current candidate identity. All other captures remain bound to STATUS.
	const expectedInputTargetIdentity = input.validationRequest?.correctionTargetIdentity ?? statusTargetIdentity;
	if (
		!isCanonicalProcessString(inputLineageId) ||
		!isCanonicalProcessString(inputTargetIdentity) ||
		inputLineageId !== lineageId ||
		inputTargetIdentity !== expectedInputTargetIdentity
	) {
		return captureBindingRejected("collectBinding does not carry one non-empty matching provider lineage and target token");
	}
	return {
		input,
		binding: { lineageId, targetIdentity: statusTargetIdentity },
	};
}

function isSelectedReviewCapture(value: SelectedReviewCapture | Record<string, unknown>): value is SelectedReviewCapture {
	return "input" in value && "binding" in value;
}

function captureGroupRejected(reason: string): Record<string, unknown> { return captureBindingRejected(reason, true); }

function hasExactReviewCaptureSuffix(status: ReviewStatusV3, expected: readonly string[]): boolean {
	const current = status.nextTransition?.kind === "collect"
		? (status.nextTransition.collect?.inputs ?? []).filter((input) => input.captureOperation === "review.capture-result").map(canonicalReviewCaptureBinding)
		: [];
	return current.length === expected.length && current.every((binding, index) => binding === expected[index]);
}

function captureGroupAuthorityDrift(status: ReviewStatusV3): Record<string, unknown> {
	return { ...captureGroupRejected("authoritative STATUS does not offer exactly the unsubmitted reviewer suffix"), outcome: "capture-group-authority-drift", reconciliation: status.raw, authority_applicability: status.applicability, provider_action: status.action, next_transition: status.nextTransition };
}

interface SelectedReviewCaptureGroup {
	slots: readonly ReviewHostRelaySlot[];
	binding: ReviewLastEventClosureBinding;
}

function selectExactReviewCaptureGroup(
	status: ReviewStatusV3,
	lineageId: string,
	canonicalBindings: readonly string[],
): SelectedReviewCaptureGroup | Record<string, unknown> {
	const inputs = status.nextTransition?.kind === "collect" ? status.nextTransition.collect?.inputs ?? [] : [];
	const slots = reviewHostRelaySlots(inputs);
	if (inputs.length === 0 || slots.length !== inputs.length) {
		return captureGroupRejected("current STATUS does not offer an exclusively materialize reviewer capture group");
	}
	const currentBindings = inputs.map((input) => canonicalReviewCaptureBinding(input));
	if (new Set(currentBindings).size !== currentBindings.length || canonicalBindings.length !== currentBindings.length || canonicalBindings.some((binding, index) => binding !== currentBindings[index])) {
		return captureGroupRejected("collectBindings must be the complete distinct current reviewer group in exact provider order");
	}
	const first = selectExactReviewCapture(status, lineageId, currentBindings[0]!);
	if (!isSelectedReviewCapture(first)) return captureGroupRejected(String(first.reason ?? "current STATUS rejected a reviewer binding"));
	const expectedRevision = exactCollectArgument(inputs[0]!, "expected-revision");
	const repositoryContext = exactCollectArgument(inputs[0]!, "repository-context");
	const statusTargetIdentity = status.targetIdentity;
	const currentRepositoryContext = status.repositoryContext;
	if (!isCanonicalProcessString(expectedRevision) || !isCanonicalProcessString(repositoryContext) || currentRepositoryContext === undefined || expectedRevision !== currentRepositoryContext.revision) {
		return captureGroupRejected("current STATUS does not bind one matching expected revision and repository context for the reviewer group");
	}
	if (currentRepositoryContext.handle !== repositoryContext || currentRepositoryContext.targetIdentity !== statusTargetIdentity) {
		return captureGroupRejected("current STATUS repository context does not match the reviewer group binding");
	}
	const lenses = new Set<string>(), orders = new Set<string>(), subjectHashes = new Set<string>();
	for (let index = 0; index < inputs.length; index += 1) {
		const input = inputs[index]!, slot = slots[index]!, subject = input.artifactSubject;
		const slotLineage = exactCollectArgument(input, "lineage"), target = exactCollectArgument(input, "target");
		const revision = exactCollectArgument(input, "expected-revision"), context = exactCollectArgument(input, "repository-context");
		const subjectHash = exactCollectArgument(input, "subject-hash"), order = slot.order, lens = slot.lens;
		if (
			subject === undefined || slot.submission === undefined || slotLineage !== lineageId || target !== statusTargetIdentity
			|| revision !== expectedRevision || context !== repositoryContext || subjectHash !== subject.subjectHash || order === undefined || lens === undefined
			|| subject.lineageId !== lineageId || subject.authorityRevision !== expectedRevision || subject.targetIdentity !== statusTargetIdentity
			|| lens !== subject.lens || String(subject.selectedOrder) !== order
		) return captureGroupRejected("current STATUS carries an incomplete or mismatched materialize reviewer binding");
		try { resolveReviewHostRelaySubmission(slot.submission); } catch { return captureGroupRejected("current STATUS carries an invalid provider reviewer submission descriptor"); }
		const value = slot.submission.values[0];
		if (slot.submission.operationToken !== "capture-result" || value?.slot !== "reviewer_result" || value.domain !== "artifact_path_or_stdin" || lenses.has(lens) || orders.has(order) || subjectHashes.has(subject.subjectHash)) {
			return captureGroupRejected("current STATUS carries duplicate or invalid reviewer slot identities");
		}
		lenses.add(lens); orders.add(order); subjectHashes.add(subject.subjectHash);
	}
	return { slots, binding: first.binding };
}

function reviewHostRelayGroupFailure(
	error: ReviewHostRelayError,
	slots: readonly ReviewHostRelaySlot[],
	prepared: readonly ReviewHostRelayPreparedResult[],
	submitted: number,
): Record<string, unknown> {
	return {
		tool: "gentle_review_capture_group",
		status: "blocked",
		outcome: error.kind === REVIEW_HOST_RELAY_FAILURE.RELAY_UNAVAILABLE ? "pi-host-relay-unavailable" : error.kind === REVIEW_HOST_RELAY_FAILURE.HANDSHAKE_REFUSED ? "pi-host-relay-handshake-refused" : error.kind === REVIEW_HOST_RELAY_FAILURE.PI_TIMED_OUT ? "pi-host-relay-timeout" : "pi-host-relay-transport-failure",
		reason: error.message,
		failure: reviewHostRelayFailureReport(error),
		...reviewHostRelayGroupProgress(slots, prepared, submitted),
		next_action: error.kind === REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED ? REVIEW_HOST_RELAY_REFUSED_ACTION : REVIEW_HOST_RELAY_RETRY_ACTION,
	};
}

async function executeReviewCaptureOperation(
	parametersValue: unknown,
	sessionCwd: string,
	nativeReviewCli: NativeReviewCli | null,
	signal?: AbortSignal,
	candidateViews: CandidateViewRegistry | null = new CandidateViewRegistry(),
	retainedUntrackedSelections: Map<string, RetainedNativeStatusSelection> = new Map(),
	requireRegisteredRoute = false,
): Promise<Record<string, unknown>> {
	const parameters = parseReviewCaptureParameters(parametersValue);
	if (nativeReviewCli === null || nativeReviewCli.targetStatus === undefined) {
		return {
			tool: "gentle_review_capture",
			status: "blocked",
			outcome: "native-status-unsupported",
			mutation_performed: false,
			mutation_outcome: "none",
		};
	}
	const canonicalBinding = parseCanonicalReviewCaptureBinding(parameters.collectBinding);
	const cwd = resolveReviewControllerWorkspaceRoot(parameters.workspaceRoot, sessionCwd, candidateViews, parameters.lineageId);
	const route = readRetainedNativeCaptureRoute(retainedUntrackedSelections, canonicalBinding);
	if (requireRegisteredRoute && (route === undefined || route.workspaceRoot !== cwd || route.lineageId !== parameters.lineageId)) {
		return captureBindingRejected("collectBinding is unknown, expired, or belongs to a different session route");
	}
	let status: ReviewStatusV3;
	try {
		const negotiated = await negotiatedStatusForHostTransport(nativeReviewCli, {
			cwd,
			lineageId: parameters.lineageId,
			...(route?.baseRef === undefined ? {} : { baseRef: route.baseRef, committedOnly: true }),
			...readRetainedNativeUntrackedSelection(retainedUntrackedSelections, cwd, parameters.lineageId),
			...(signal === undefined ? {} : { signal }),
		}, retainedUntrackedSelections, cwd);
		if (negotiated.transport !== undefined) return hostTransportUnavailable("gentle_review_capture", negotiated.transport);
		status = negotiated.status!;
	} catch (error) {
		return nativeOperationFailure("gentle_review_capture", error);
	}
	const selected = selectExactReviewCapture(status, parameters.lineageId, canonicalBinding);
	if (!isSelectedReviewCapture(selected)) return selected;

	// During correction the flow carries both the original authority target
	// identity and a distinct provider-issued correction target identity
	// (gentle-pi#535 row 15). Echo the correction one on the capture result so
	// the caller never reconstructs which is which from the opaque binding.
	const correctionTargetIdentity = selected.input.validationRequest?.correctionTargetIdentity ?? selected.input.artifactSubject?.correctionTargetIdentity;
	const withCorrectionTarget = (result: Record<string, unknown>): Record<string, unknown> =>
		correctionTargetIdentity === undefined ? result : { ...result, correction_target_identity: correctionTargetIdentity };

	const hostRelaySlots = reviewHostRelaySlots([selected.input]);
	if (hostRelaySlots.length === 1) {
		if (parameters.correctionLines !== undefined) return captureBindingRejected("correctionLines is valid only for a correction-plan capture");
		if (parameters.reviewerRunAcknowledged !== true) {
			return {
				tool: "gentle_review_capture",
				status: "blocked",
				outcome: "reviewer-model-run-forecast",
				cost_forecast: {
					transport: "pi_host_relay",
					model_runs: 1,
					lenses: hostRelaySlots[0]!.lens === undefined ? [] : [hostRelaySlots[0]!.lens],
				},
				mutation_performed: false,
				mutation_outcome: "none",
			};
		}
		return withCorrectionTarget(await executeReviewHostRelayCapture(hostRelaySlots[0]!, nativeReviewCli, cwd, selected.binding, retainedUntrackedSelections, route, signal));
	}

	if (selected.input.captureOperation === "review.capture-correction-plan") {
		if (parameters.reviewerRunAcknowledged !== undefined) return captureBindingRejected("reviewerRunAcknowledged is valid only for a materialize reviewer capture");
		const submission = selected.input.submission;
		const value = submission?.values.length === 1 ? submission.values[0] : undefined;
		if (submission === undefined || value?.slot !== "correction_lines") return captureBindingRejected("provider correction-plan capture omitted its exact correction-lines binding");
		if (parameters.correctionLines === undefined) {
			return {
				tool: "gentle_review_capture",
				status: "blocked",
				outcome: "correction-lines-required",
				minimum: value.minimum ?? 1,
				maximum: value.maximum ?? 200,
				mutation_performed: false,
				mutation_outcome: "none",
			};
		}
		if ((value.minimum !== undefined && parameters.correctionLines < value.minimum) || (value.maximum !== undefined && parameters.correctionLines > value.maximum)) {
			return captureBindingRejected("correctionLines is outside the exact provider-issued correction-plan bounds");
		}
		if (nativeReviewCli.captureCorrectionPlan === undefined) return captureBindingRejected("native correction-plan capture is unavailable");
		try {
			const closure = await nativeReviewCli.captureCorrectionPlan({
				argumentTokens: submission.argumentTokens,
				correctionLines: parameters.correctionLines,
				cwd,
				...(signal === undefined ? {} : { signal }),
			});
			return withCorrectionTarget(mapAndClearLastEventClosure(closure, selected.binding, retainedUntrackedSelections, cwd));
		} catch (error) {
			return await reconcileUnknownReviewCaptureFailure(error, nativeReviewCli, cwd, selected.binding, retainedUntrackedSelections, route);
		}
	}

	const providerRoleSlots = reviewProviderRoleVectorSlots([selected.input]);
	if (providerRoleSlots.length === 1) {
		if (parameters.reviewerRunAcknowledged !== undefined || parameters.correctionLines !== undefined) {
			return captureBindingRejected("reviewerRunAcknowledged and correctionLines are not valid for a provider role capture");
		}
		return withCorrectionTarget(await executeProviderRoleVectorCapture(providerRoleSlots[0]!, nativeReviewCli, cwd, selected.binding, retainedUntrackedSelections, route, signal));
	}
	return captureBindingRejected(`unsupported provider capture operation: ${selected.input.captureOperation}`);
}

function reviewHostRelayGroupDiagnostics(slots: readonly ReviewHostRelaySlot[], prepared: readonly ReviewHostRelayPreparedResult[], count: number): readonly Record<string, unknown>[] {
	return slots.slice(0, count).map((slot, index) => ({
		...(slot.lens === undefined ? {} : { lens: slot.lens }),
		...(slot.order === undefined ? {} : { order: slot.order }),
		...(slot.subjectHash === undefined ? {} : { subject_hash: slot.subjectHash }),
		prompt_bytes: prepared[index]?.promptByteLength,
		result_bytes: prepared[index]?.resultByteLength,
	}));
}

function reviewHostRelayGroupProgress(
	slots: readonly ReviewHostRelaySlot[],
	prepared: readonly ReviewHostRelayPreparedResult[],
	submitted: number,
	uncertain = false,
): Record<string, unknown> {
	const outcome = submitted === 0 ? uncertain ? "unknown" : "none" : uncertain ? "partial_unknown" : submitted === slots.length ? "completed" : "partial";
	return {
		prepared_reviewers: prepared.length,
		submitted_reviewers: submitted,
		host_relay: { transport: "pi_host_relay", reviewers: reviewHostRelayGroupDiagnostics(slots, prepared, submitted) },
		...(submitted === 0 && uncertain ? { mutation_outcome: outcome } : { mutation_performed: submitted > 0, mutation_outcome: outcome }),
	};
}

async function executeReviewCaptureGroupOperation(
	parametersValue: unknown,
	sessionCwd: string,
	nativeReviewCli: NativeReviewCli | null,
	signal?: AbortSignal,
	candidateViews: CandidateViewRegistry | null = new CandidateViewRegistry(),
	retainedUntrackedSelections: Map<string, RetainedNativeStatusSelection> = new Map(),
	requireRegisteredRoute = false,
): Promise<Record<string, unknown>> {
	const parameters = parseReviewCaptureGroupParameters(parametersValue);
	if (nativeReviewCli === null || nativeReviewCli.targetStatus === undefined) return { ...captureGroupRejected("native target STATUS is unavailable"), outcome: "native-status-unsupported" };
	const canonicalBindings = parameters.collectBindings.map((binding) => parseCanonicalReviewCaptureBinding(binding));
	const cwd = resolveReviewControllerWorkspaceRoot(parameters.workspaceRoot, sessionCwd, candidateViews, parameters.lineageId);
	const routes = canonicalBindings.map((binding) => readRetainedNativeCaptureRoute(retainedUntrackedSelections, binding));
	const route = routes[0];
	if (requireRegisteredRoute && (route === undefined || routes.some((candidate) => candidate === undefined || candidate.workspaceRoot !== cwd || candidate.lineageId !== parameters.lineageId || candidate.baseRef !== route.baseRef))) {
		return captureGroupRejected("collectBindings are unknown, expired, or belong to different session routes");
	}
	const freshStatus = () => negotiatedStatusForHostTransport(nativeReviewCli, {
		cwd, lineageId: parameters.lineageId,
		...(route?.baseRef === undefined ? {} : { baseRef: route.baseRef, committedOnly: true }),
		...readRetainedNativeUntrackedSelection(retainedUntrackedSelections, cwd, parameters.lineageId),
		...(signal === undefined ? {} : { signal }),
	}, retainedUntrackedSelections, cwd);
	let status: ReviewStatusV3;
	try {
		const negotiated = await freshStatus();
		if (negotiated.transport !== undefined) return hostTransportUnavailable("gentle_review_capture_group", negotiated.transport);
		status = negotiated.status!;
	} catch (error) {
		return { ...captureGroupRejected(error instanceof Error ? error.message : String(error)), outcome: "native-status-failed" };
	}
	const group = selectExactReviewCaptureGroup(status, parameters.lineageId, canonicalBindings);
	if (!("slots" in group && "binding" in group)) return group;
	if (parameters.reviewerRunAcknowledged !== true) {
		return {
			tool: "gentle_review_capture_group",
			status: "blocked",
			outcome: "reviewer-model-run-forecast",
			cost_forecast: { transport: "pi_host_relay", model_runs: group.slots.length, lenses: group.slots.map((slot) => slot.lens).filter((lens): lens is string => lens !== undefined) },
			mutation_performed: false,
			mutation_outcome: "none",
		};
	}
	const requests: readonly ReviewHostRelayRequest[] = group.slots.map((slot) => ({
		captureArgumentTokens: slot.captureArgumentTokens,
		targetCwd: cwd,
		submission: slot.submission!,
		...(signal === undefined ? {} : { signal }),
	}));
	let prepared: readonly ReviewHostRelayPreparedResult[];
	try {
		prepared = await activeReviewHostRelayReviewerGroupRunner(requests);
		if (prepared.length !== requests.length) throw new Error("Pi host relay reviewer group returned a different number of prepared results");
	} catch (error) {
		return error instanceof ReviewHostRelayError
			? reviewHostRelayGroupFailure(error, group.slots, [], 0)
			: { ...captureGroupRejected(error instanceof Error ? error.message : String(error)), outcome: "pi-host-relay-reviewer-group-failed" };
	}
	for (let index = 0; index < prepared.length; index += 1) {
		let current: SelectedReviewCapture | Record<string, unknown>;
		try {
			const negotiated = await freshStatus();
			if (negotiated.transport !== undefined) return { ...hostTransportUnavailable("gentle_review_capture_group", negotiated.transport), ...reviewHostRelayGroupProgress(group.slots, prepared, index) };
			if (!hasExactReviewCaptureSuffix(negotiated.status!, canonicalBindings.slice(index))) return { ...captureGroupAuthorityDrift(negotiated.status!), ...reviewHostRelayGroupProgress(group.slots, prepared, index) };
			current = selectExactReviewCapture(negotiated.status!, parameters.lineageId, canonicalBindings[index]!);
		} catch (error) {
			return { ...captureGroupRejected(error instanceof Error ? error.message : String(error)), outcome: "native-status-failed", ...reviewHostRelayGroupProgress(group.slots, prepared, index) };
		}
		if (!isSelectedReviewCapture(current)) return { ...captureGroupRejected(String(current.reason ?? "current STATUS rejected a reviewer binding")), ...reviewHostRelayGroupProgress(group.slots, prepared, index) };
		try {
			const result = await activeReviewHostRelaySubmissionRunner(prepared[index]!);
			const closure = decodeRelayLastEventClosure(result.submission);
			if (closure !== undefined) {
				const closed = mapAndClearLastEventClosure(closure, current.binding, retainedUntrackedSelections, cwd);
				return { ...closed, tool: "gentle_review_capture_group", ...reviewHostRelayGroupProgress(group.slots, prepared, index + 1) };
			}
		} catch (error) {
			if (error instanceof ReviewHostRelayError && error.mutationOutcome !== "unknown") return reviewHostRelayGroupFailure(error, group.slots, prepared, index);
			const reconciled = await reconcileUnknownReviewCaptureFailure(error, nativeReviewCli, cwd, current.binding, retainedUntrackedSelections, route, undefined, REVIEW_HOST_AGENT);
			return { ...reconciled, tool: "gentle_review_capture_group", ...reviewHostRelayGroupProgress(group.slots, prepared, index, true), ...(error instanceof ReviewHostRelayError ? { failure: reviewHostRelayFailureReport(error), reason: error.message } : {}) };
		}
	}
	const reconciled = await reconcileUnknownReviewCaptureFailure(undefined, nativeReviewCli, cwd, group.binding, retainedUntrackedSelections, route, canonicalBindings.slice(prepared.length), REVIEW_HOST_AGENT);
	return { ...reconciled, tool: "gentle_review_capture_group", outcome: reconciled.outcome === "capture-group-authority-drift" ? reconciled.outcome : reconciled.status === "reconciled" ? "native-reviewer-group-status-reconciled" : "native-reviewer-group-status-reconciliation-failed", ...reviewHostRelayGroupProgress(group.slots, prepared, prepared.length) };
}

type DispatchHydrationOutcome =
	| { hydrated: true; lineage_id: string; lenses: readonly string[] }
	| { hydrated: false; lineage_id: string; reason: string; message: string }
	| undefined;

function hydrateDispatchBindingFromStatus(candidateViews: CandidateViewRegistry | null, contributorRoot: string, status: ReviewStatusV3): DispatchHydrationOutcome {
	if (candidateViews === null || candidateViews.hasCurrentBinding(contributorRoot)) return undefined;
	const lineageId = status.authority?.lineageId;
	if (lineageId === undefined || status.applicability !== "current_target" || candidateViews.hasProjection(lineageId, contributorRoot)) return undefined;
	const lenses = pendingReviewerLenses(status);
	if (lenses.length === 0) return undefined;
	try {
		candidateViews.restoreCurrentForDispatchFromNative(lineageId, contributorRoot, status.projection, lenses);
		return { hydrated: true, lineage_id: lineageId, lenses };
	} catch (error) {
		// Never fail the caller on hydration; the registry records the typed
		// cause so the later dispatch refusal names the attempt instead of
		// claiming no binding was ever available.
		return {
			hydrated: false,
			lineage_id: lineageId,
			reason: error instanceof CandidateViewError ? error.reason : "candidate-view-invalid",
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

async function executeReviewControllerOperation(
	parametersValue: unknown,
	sessionCwd: string,
	nativeReviewCli: NativeReviewCli | null,
	signal?: AbortSignal,
	candidateViews: CandidateViewRegistry | null = new CandidateViewRegistry(),
	context?: ExtensionContext,
	retainedUntrackedSelections: Map<string, RetainedNativeStatusSelection> = new Map(),
	pendingReviewConsentRegistry: PendingReviewConsentRegistry = processPendingReviewConsentRegistry,
	pendingReviewConsentFallbackKey: symbol = Symbol("pending-review-consent-fallback"),
	reviewConsentNow: () => number = Date.now,
	reviewConsentScheduleTimer: (callback: () => void, delayMs: number) => { unref: () => void } = setTimeout,
	intendedUntrackedSelection?: NativeIntendedUntrackedSelectionSubmission,
): Promise<Record<string, unknown>> {
	const parameters = parseReviewControllerParameters(parametersValue);
	const defaultCwd = resolveReviewControllerWorkspaceRoot(parameters.workspaceRoot, sessionCwd, candidateViews, parameters.lineageId);
	const pendingReviewConsentSession = pendingReviewConsentSessionKey(context, pendingReviewConsentFallbackKey);
	const _useTargetLifecycleRoot = requiresExplicitTargetLifecycleRoot(parameters.workspaceRoot, sessionCwd, defaultCwd);
	const includeWorkspaceRoot = parameters.workspaceRoot !== undefined || defaultCwd !== sessionCwd;
	if (parameters.operation === REVIEW_CONTROLLER_OPERATION.EXPORT || parameters.operation === REVIEW_CONTROLLER_OPERATION.IMPORT) {
		// Legacy bundle transport rode on the retired pre-integration graph/compact
		// stores. The native v2.1.11 CLI exposes no bundle equivalent, so both
		// operations return a structured retirement envelope; the enum members are
		// kept so the tool schema stays stable for existing callers.
		return {
			operation: parameters.operation,
			status: "blocked",
			outcome: "legacy-operation-retired",
			reason: "Legacy review bundle transport (export/import) was retired together with the pre-integration graph/compact stores; gentle-ai v2.1.11 exposes no native bundle equivalent.",
			mutation_performed: false,
			mutation_outcome: "none",
			next_action: "Use the native `gentle-ai review` CLI (start/finalize/validate/status/recover) against the repository review authority; receipts and canonical artifacts live in the Git common-directory store at .git/gentle-ai/reviews and travel with the repository through normal Git replication.",
		};
	}
	if (parameters.operation === REVIEW_CONTROLLER_OPERATION.ASSESS) {
		// Read-only native risk assessment (gentle-ai#4295, gentle-pi#662). Never
		// mutates, never requires a lineageId, and never routes through
		// authorizeDestructiveReviewOperation (it returns early for any
		// operation that is neither RESET nor a maintenance operation).
		const input = parseReviewAssessInput(parameters.operation, parameters.input);
		const details = await resolveReviewAssessmentPlan(nativeReviewCli, defaultCwd, input, signal);
		return { operation: parameters.operation, ...details, ...(includeWorkspaceRoot ? { workspace_root: defaultCwd } : {}) };
	}
	if (parameters.operation === REVIEW_CONTROLLER_OPERATION.REPAIR_LEGACY_ALIAS) {
		const input = parseControllerJson(requiredControllerString(parameters, "input"), parameters.operation);
		return await executeNativeLegacyAliasRepair(input, defaultCwd, nativeReviewCli, signal, context);
	}
	const maintenance = nativeMaintenanceOperation(parameters.operation);
	if (maintenance !== undefined) {
		const input = parseControllerJson(requiredControllerString(parameters, "input"), parameters.operation);
		return await executeNativeAuthorityMaintenance(parameters.operation, maintenance, input, defaultCwd, nativeReviewCli, signal);
	}
	if (
		parameters.operation === REVIEW_CONTROLLER_OPERATION.INSPECT &&
		nativeReviewCli !== null
	) {
		// A new inspect supersedes every pre-lineage selection before its first
		// STATUS attempt. A failed or changed-candidate inspect cannot leave an
		// older selection available for a later START.
		clearRetainedNativeUntrackedSelection(retainedUntrackedSelections, defaultCwd, "");
		try {
			if (nativeReviewCli.targetStatus !== undefined) {
				const negotiated = await negotiatedStatusForHostTransport(
					nativeReviewCli,
					{
						cwd: defaultCwd,
						...(signal === undefined ? {} : { signal }),
					},
					retainedUntrackedSelections,
					defaultCwd,
				);
				if (negotiated.transport !== undefined) {
					return {
						...hostTransportUnavailable(parameters.operation, negotiated.transport),
						...(includeWorkspaceRoot ? { workspace_root: defaultCwd } : {}),
					};
				}
				const status = negotiated.status!;
				const plainMapped = mapNativeTargetStatus(
					parameters.operation,
					status,
					undefined,
				);
				if (parameters.untrackedScope === undefined) {
					// gentle-pi#706: the stop alone never tells the caller what to do next.
					return {
						...plainMapped,
						...("selectionBinding" in plainMapped
							? { nextStep: INSPECT_UNTRACKED_SELECTION_NEXT_STEP }
							: {}),
						...(includeWorkspaceRoot ? { workspace_root: defaultCwd } : {}),
					};
				}
				const input = reviewIntendedUntrackedInput(status);
				if (input === undefined)
					return {
						...plainMapped,
						untracked_selection: "not-required",
						...(includeWorkspaceRoot ? { workspace_root: defaultCwd } : {}),
					};
				const eligibleJson = exactCollectArgument(input, "eligible_paths_json"),
					inventory = exactCollectArgument(input, "expected_untracked_inventory");
				let eligible: unknown;
				try {
					eligible = JSON.parse(eligibleJson ?? "");
				} catch {
					eligible = undefined;
				}
				const selected = validateNativeStartUntrackedSelection({
					untrackedScope: parameters.untrackedScope,
					expectedUntrackedInventory: inventory,
					intendedUntracked: parameters.intendedUntracked,
				});
				if (
					!Array.isArray(eligible) ||
					selected.reason !== undefined ||
					selected.intendedUntracked!.some((path) => !eligible.includes(path))
				) {
					return {
						operation: parameters.operation,
						status: "blocked",
						outcome: "inspect-untracked-scope-invalid",
						reason:
							"The requested untrackedScope/intendedUntracked combination is invalid for the current intended-untracked stop: paths must be members of the eligible inventory, exclude selects none, and select selects at least one.",
						mutation_performed: false,
						mutation_outcome: "none",
					};
				}
				const submission: NativeIntendedUntrackedSelectionSubmission = {
					argumentTokens: input.submission!.argumentTokens,
					value: JSON.stringify({
						schema: "gentle-ai.review-intended-untracked-selection/v1",
						untracked_scope: parameters.untrackedScope,
						expected_untracked_inventory: inventory,
						intended_untracked: selected.intendedUntracked,
					}),
				};
				const resolved = await negotiatedStatusForHostTransport(
					nativeReviewCli,
					{
						cwd: defaultCwd,
						untrackedScope: parameters.untrackedScope,
						expectedUntrackedInventory: inventory,
						intendedUntracked: selected.intendedUntracked,
						intendedUntrackedSelection: submission,
						...(signal === undefined ? {} : { signal }),
					},
					retainedUntrackedSelections,
					defaultCwd,
				);
				if (resolved.transport !== undefined) {
					return {
						...hostTransportUnavailable(parameters.operation, resolved.transport),
						...(includeWorkspaceRoot ? { workspace_root: defaultCwd } : {}),
					};
				}
				const resolvedStatus = resolved.status!;
				const candidateIdentity = nativePreLineageCandidateIdentity(resolvedStatus);
				if (candidateIdentity !== undefined) {
					retainNativeUntrackedSelection(
						retainedUntrackedSelections,
						defaultCwd,
						"",
						Object.freeze({
							untrackedScope: parameters.untrackedScope,
							expectedUntrackedInventory: inventory!,
							intendedUntracked: Object.freeze([...selected.intendedUntracked!]),
							submission,
							...candidateIdentity,
						}),
					);
				}
				const resolvedMapped = mapNativeTargetStatus(
					parameters.operation,
					resolvedStatus,
					undefined,
				);
				return {
					...resolvedMapped,
					...("selectionBinding" in resolvedMapped
						? { nextStep: INSPECT_UNTRACKED_SELECTION_NEXT_STEP }
						: {}),
					...(includeWorkspaceRoot ? { workspace_root: defaultCwd } : {}),
				};
			}
			return nativeStatusUnsupported(parameters.operation);
		} catch (error) {
			return nativeStatusFailed(parameters.operation, error);
		}
	}
	if (parameters.operation === REVIEW_CONTROLLER_OPERATION.INSPECT) {
		return nativeStatusUnsupported(parameters.operation);
	}

	if (parameters.operation === REVIEW_CONTROLLER_OPERATION.RECOVER_LOCK) {
		const input = parseControllerJson(requiredControllerString(parameters, "input"), parameters.operation);
		if (typeof input.ownerHash !== "string") throw new Error("Lock recovery requires an exact ownerHash");
		// A stuck legacy mutation lock is an incomplete in-flight entry; the
		// audited native quarantine owns its removal. Lock recovery is not a
		// destructive authority reset, so pending authorizations survive.
		return await executeNativeRecoveryRoute(parameters.operation, "reclaim", input, defaultCwd, nativeReviewCli, undefined, signal);
	}
	if (parameters.operation === REVIEW_CONTROLLER_OPERATION.RECOVER) {
		const input = parseControllerJson(requiredControllerString(parameters, "input"), parameters.operation);
		// The authorization binding is Pi-derived, never caller-carried. It is
		// recorded verbatim as a maintainer attestation, so accepting one the
		// caller composed would let an unapproved actor sign the recovery edge.
		if (input.maintainerAuthorization !== undefined) {
			return {
				operation: parameters.operation,
				status: "blocked",
				outcome: "native-recovery-caller-authorization-rejected",
				native_operation: "review recover",
				mutation_performed: false,
				mutation_outcome: "none",
				next_action: "resubmit-without-maintainer-authorization",
			};
		}
		const missing = NATIVE_RECOVERY_INPUT.recover.filter((key) =>
			key === "disposition"
				? !["scope_changed", "invalidated", "escalated"].includes(input[key] as string)
				: !isCanonicalProcessString(input[key]),
		);
		if (missing.length > 0) return await executeNativeRecoveryRoute(parameters.operation, "recover", input, defaultCwd, nativeReviewCli, signal);
		if (nativeReviewCli?.targetStatus === undefined) return nativeStatusUnsupported(parameters.operation);
		const frozenTarget = candidateViews?.hasProjection(String(input.predecessorLineage), defaultCwd)
			? candidateViews.resolveProjection(String(input.predecessorLineage), defaultCwd)
			: undefined;
		const statusRequest = {
			cwd: defaultCwd,
			lineageId: String(input.predecessorLineage),
			...(frozenTarget?.committedOnly === true ? { baseRef: frozenTarget.baseCommit, committedOnly: true } : {}),
			...(signal === undefined ? {} : { signal }),
		};
		let status: ReviewStatusV3;
		try {
			status = await nativeReviewCli.targetStatus(statusRequest);
		} catch (error) {
			return nativeStatusFailed(parameters.operation, error);
		}
		const pinnedRecoveryStatus = (candidate: ReviewStatusV3): boolean =>
			candidate.action === "recover"
			&& candidate.actionDisposition === status.actionDisposition
			&& candidate.authority?.lineageId === input.predecessorLineage
			&& candidate.authority?.revision === input.expectedPredecessorRevision
			&& candidate.targetIdentity === status.targetIdentity;
		if (status.action !== "recover" || status.actionDisposition === undefined || status.authority?.lineageId !== input.predecessorLineage || status.authority.revision !== input.expectedPredecessorRevision || !isCanonicalProcessString(status.targetIdentity)) {
			return { operation: parameters.operation, status: "blocked", outcome: "native-recovery-status-mismatch", mutation_performed: false, mutation_outcome: "none", result: status.raw, next_action: "follow-provider-target-status" };
		}
		if (input.disposition !== status.actionDisposition) {
			return { operation: parameters.operation, status: "blocked", outcome: "native-recovery-disposition-mismatch", mutation_performed: false, mutation_outcome: "none", provider_disposition: status.actionDisposition, next_action: "resubmit-with-provider-disposition" };
		}
		const recoverAuthorization = nativeReviewRecoverAuthorization({
			predecessorLineage: String(input.predecessorLineage),
			expectedPredecessorRevision: String(input.expectedPredecessorRevision),
			targetIdentity: status.targetIdentity,
			actor: String(input.actor),
			reason: String(input.reason),
		});
		if (context?.hasUI !== true) throw new Error("Review controller RECOVER requires fresh explicit authorization through the interactive Pi UI; headless execution fails closed");
		const approved = await context.ui.confirm(
			"Authorize destructive review authority RECOVER?",
			[
				"Operation: RECOVER",
				`Provider-selected disposition: ${status.actionDisposition}`,
				"Exact published authorization binding:",
				recoverAuthorization,
				`The native command creates one auditable successor authority (${String(input.successorLineage)}) for this exact predecessor and target identity; the predecessor stays untouched.`,
			].join("\n"),
		);
		if (!approved) throw new Error("Review controller RECOVER was not explicitly authorized");
		// Time-of-check to time-of-use: the human deliberates for an unbounded
		// interval, and the authority can advance, be recovered by someone else, or
		// stop being recovery-eligible while they do. The approval and the derived
		// binding are pinned to the pre-approval read, so the authority is read once
		// more and must still match it exactly before anything mutates.
		let confirmedStatus: ReviewStatusV3;
		try {
			confirmedStatus = await nativeReviewCli.targetStatus(statusRequest);
		} catch (error) {
			return nativeStatusFailed(parameters.operation, error);
		}
		if (!pinnedRecoveryStatus(confirmedStatus)) {
			return {
				operation: parameters.operation,
				status: "blocked",
				outcome: "native-recovery-authority-changed",
				native_operation: "review recover",
				mutation_performed: false,
				mutation_outcome: "none",
				result: confirmedStatus.raw,
				next_action: "reinspect-and-reauthorize-recovery",
			};
		}
		return await executeNativeRecoveryRoute(parameters.operation, "recover", { ...input, disposition: status.actionDisposition, maintainerAuthorization: recoverAuthorization }, defaultCwd, nativeReviewCli, signal);
	}
	if (parameters.operation === REVIEW_CONTROLLER_OPERATION.RESET) {
		const input = parseControllerJson(requiredControllerString(parameters, "input"), parameters.operation);
		return await executeNativeRecoveryRoute(parameters.operation, "reclaim", input, defaultCwd, nativeReviewCli, signal);
	}
	if (parameters.operation === REVIEW_CONTROLLER_OPERATION.REPAIR) {
		if (nativeReviewCli?.targetStatus === undefined) return nativeStatusUnsupported(parameters.operation);
		const frozenTarget = parameters.lineageId === undefined || !candidateViews?.hasProjection(parameters.lineageId, defaultCwd) ? undefined : candidateViews.resolveProjection(parameters.lineageId, defaultCwd);
		let status: ReviewStatusV3;
		try {
			status = await nativeReviewCli.targetStatus({ cwd: defaultCwd, ...(parameters.lineageId === undefined ? {} : { lineageId: parameters.lineageId }), ...(frozenTarget?.committedOnly === true ? { baseRef: frozenTarget.baseCommit, committedOnly: true } : {}), ...(signal === undefined ? {} : { signal }) });
		} catch (error) {
			return nativeStatusFailed(parameters.operation, error);
		}
		clearRetainedNativeStatusSelectionsOnTerminal(retainedUntrackedSelections, defaultCwd, status.authority?.lineageId, status.authority?.state); retainNativeCaptureRoutes(retainedUntrackedSelections, defaultCwd, status, frozenTarget?.committedOnly === true ? frozenTarget.baseCommit : undefined);
		if (status.authority?.version === "compact-v2") return { operation: parameters.operation, repaired: false, compact_authority: "immutable-untouched", status: mapNativeTargetStatus(parameters.operation, status, parameters.lineageId) };
		if (status.authority?.version !== "legacy-v1") return mapNativeTargetStatus(parameters.operation, status, parameters.lineageId);
		const store = ReviewTransactionStore.forRepository(defaultCwd);
		store.repairCurrentAuthority();
		return { operation: parameters.operation, repaired: true };
	}
	if (parameters.operation === REVIEW_CONTROLLER_OPERATION.ACKNOWLEDGE_APPROVED) {
		const controllerOnlyInput = ["changeName", "idempotencyKey", "transition", "input", "outputPath", "inputPath", "operationId", "lineageIds", "acknowledgeUntrustedBundleSource"]
			.find((key) => parameters[key as keyof ReviewControllerParameters] !== undefined);
		if (controllerOnlyInput !== undefined || !isCanonicalProcessString(parameters.lineageId)) {
			return {
				operation: parameters.operation,
				status: "blocked",
				outcome: "native-approved-acknowledgement-input-invalid",
				reason: controllerOnlyInput === undefined ? "lineage-invalid" : "controller-only-input",
				...(controllerOnlyInput === undefined ? {} : { field: controllerOnlyInput }),
				mutation_performed: false,
				mutation_outcome: "none",
				next_action: "resubmit-the-exact-lineage-without-controller-only-input",
			};
		}
		const acknowledgementCli = nativeReviewCli as NativeReviewAcknowledgementCli | null;
		if (acknowledgementCli?.targetStatus === undefined) return nativeStatusUnsupported(parameters.operation);
		if (acknowledgementCli.acknowledgeApproved === undefined) {
			return {
				operation: parameters.operation,
				status: "blocked",
				outcome: "native-approved-acknowledgement-unsupported",
				mutation_performed: false,
				mutation_outcome: "none",
				next_action: "install-native-acknowledge-approved-support",
			};
		}
		const frozenTarget = candidateViews?.hasProjection(parameters.lineageId, defaultCwd)
			? candidateViews.resolveProjection(parameters.lineageId, defaultCwd)
			: undefined;
		const target = {
			cwd: defaultCwd,
			lineageId: parameters.lineageId,
			...(frozenTarget?.committedOnly === true ? { baseRef: frozenTarget.baseCommit, committedOnly: true } : {}),
			...readRetainedNativeUntrackedSelection(retainedUntrackedSelections, defaultCwd, parameters.lineageId),
			...(signal === undefined ? {} : { signal }),
		};
		let status: ReviewStatusV3;
		try {
			status = await acknowledgementCli.targetStatus(target);
		} catch (error) {
			return nativeStatusFailed(parameters.operation, error);
		}
		const execute = status.nextTransition?.kind === "execute" ? status.nextTransition.execute : undefined;
		if (
			status.applicability !== "current_target" ||
			status.authority?.lineageId !== parameters.lineageId ||
			status.authority.state !== "approved" ||
			execute?.operation !== "review.acknowledge-approved"
		) {
			return {
				operation: parameters.operation,
				status: "blocked",
				outcome: "native-approved-acknowledgement-not-current",
				result: status.raw,
				mutation_performed: false,
				mutation_outcome: "none",
				next_action: "follow-provider-target-status",
			};
		}
		let argumentTokens: readonly string[];
		try {
			argumentTokens = assertReviewApprovedAcknowledgementExecuteV1(execute, {
				cwd: defaultCwd,
				lineageId: parameters.lineageId,
				targetIdentity: status.targetIdentity,
				revision: status.authority.revision,
			});
		} catch (error) {
			return nativeOperationFailure(parameters.operation, error);
		}
		let acknowledged: NativeReviewAcknowledgeApprovedOutcome | void;
		try {
			// gentle-ai #3947: the burn answers with one review-acknowledged/v1
			// envelope bound to exactly this lineage, target, and revision, and
			// the burn is reported from that envelope, never from a later
			// STATUS. Every published release up to v2.5.0-rc.3 still burns in
			// silence, and that result stays byte-identical.
			acknowledged = await acknowledgementCli.acknowledgeApproved({
				argumentTokens,
				cwd: defaultCwd,
				binding: { lineageId: parameters.lineageId, targetIdentity: status.targetIdentity, revision: status.authority.revision },
				...(signal === undefined ? {} : { signal }),
			});
		} catch (error) {
			if (!nativeMutationRequiresStatus(error)) return nativeOperationFailure(parameters.operation, error);
			return await reconcileNativeMutationFailure(parameters.operation, error, acknowledgementCli, target, retainedUntrackedSelections);
		}
		// gentle-ai#4003: from here the native burn is the committed authority
		// outcome. Both Pi-side teardown steps run outside the mutation-result
		// try/catch and each one is guarded on its own, so a cleanup failure is
		// reported as deferred cleanup and never as a failed acknowledgement
		// that would invite a replay of a burned operation.
		const retainedSelectionCleanup = deferredPostBurnCleanup(POST_BURN_CLEANUP.retainedSelection, () => clearRetainedNativeUntrackedSelection(retainedUntrackedSelections, defaultCwd, parameters.lineageId));
		// The registry owns restoring writability of its 0555 views before
		// removal; a terminal approved cleanup keeps the lineage projection.
		const candidateViewCleanup = deferredPostBurnCleanup(POST_BURN_CLEANUP.candidateView, () => candidateViews?.cleanupTerminal(parameters.lineageId, "approved", defaultCwd));
		// gentle-pi#668: `closed` is never auto-derived or recorded here --
		// a parent that wants the on-path passes nativeReviewOutcome:
		// "closed" explicitly on its next assess call for this candidate.
		return {
			operation: parameters.operation,
			status: "closed",
			outcome: "native-approved-acknowledgement-completed",
			lineage_id: parameters.lineageId,
			target_identity: status.targetIdentity,
			...(acknowledged === undefined ? {} : { consumed_revision: acknowledged.consumedRevision }),
			authority: "burned",
			...(acknowledged === undefined ? {} : { burn_evidence: acknowledged.schema }),
			delivery: "ordinary-repository-policy",
			mutation_performed: true,
			mutation_outcome: "committed",
			...(retainedSelectionCleanup === undefined ? {} : { retained_selection_cleanup: retainedSelectionCleanup }),
			...(candidateViewCleanup === undefined ? {} : { candidate_view_cleanup: candidateViewCleanup }),
		};
	}
	if (parameters.operation === REVIEW_CONTROLLER_OPERATION.ANSWER_CONSENT) {
		const input = parseControllerJson(requiredControllerString(parameters, "input"), parameters.operation);
		if (Object.keys(input).some((key) => key !== "consentBinding" && key !== "answer") || Object.keys(input).length !== 2) throw new Error("Review controller answer-consent input must contain exactly consentBinding and answer");
		if (typeof input.consentBinding !== "string" || input.consentBinding.length === 0) throw new Error("Review controller answer-consent requires an opaque consentBinding");
		if (input.answer !== "granted" && input.answer !== "declined") throw new Error("Review controller answer-consent answer must be granted or declined");
		// gentle-pi#455: resolve the binding by its opaque id alone, so a
		// binding one active Pi session's START created is answerable from any
		// active session presenting it -- not only the session that created it.
		const resolved = pendingReviewConsentRegistry.resolve(input.consentBinding);
		const pending = resolved?.pending;
		const owningSession = resolved?.sessionKey ?? pendingReviewConsentSession;
		if (pending === undefined || pending.expiresAt <= reviewConsentNow()) {
			const disposition = pending === undefined
				? pendingReviewConsentRegistry.staleDisposition(input.consentBinding)
				: PENDING_REVIEW_CONSENT_DISPOSITION.EXPIRED;
			const stale = staleConsentBindingDiagnostics(input.consentBinding, disposition);
			if (pending !== undefined) expirePendingReviewConsent(pending, pendingReviewConsentRegistry, owningSession);
			if (nativeReviewCli?.targetStatus === undefined) return nativeStatusUnsupported(parameters.operation);
			try {
				const negotiated = await negotiatedStatusForHostTransport(nativeReviewCli, {
					cwd: defaultCwd,
					...(signal === undefined ? {} : { signal }),
				}, retainedUntrackedSelections, defaultCwd);
				if (negotiated.transport !== undefined) return hostTransportUnavailable(parameters.operation, negotiated.transport);
				return staleConsentBindingOutcome(parameters.operation, input.consentBinding, stale, negotiated.status!);
			} catch (error) {
				return nativeStatusFailed(parameters.operation, error);
			}
		}
		const answeringRepositoryCwd = realpathSync(defaultCwd);
		if (answeringRepositoryCwd !== pending.repositoryCwd) return consentBindingRepositoryMismatchOutcome(parameters.operation, input.consentBinding, pending.repositoryCwd, answeringRepositoryCwd);
		if (reviewConsentDigest(pending.consent) !== pending.consentDigest) throw new Error("Review controller consent envelope binding changed");
		pending.verifyCandidate();
		if (nativeReviewCli?.answerConsent === undefined) throw new Error("Native review consent follow-up is unavailable");
		if (!consumePendingReviewConsent(pending, pendingReviewConsentRegistry, owningSession)) {
			const stale = staleConsentBindingDiagnostics(
				input.consentBinding,
				pendingReviewConsentRegistry.staleDisposition(input.consentBinding),
			);
			if (nativeReviewCli.targetStatus === undefined) return nativeStatusUnsupported(parameters.operation);
			try {
				const negotiated = await negotiatedStatusForHostTransport(nativeReviewCli, {
					cwd: defaultCwd,
					...(signal === undefined ? {} : { signal }),
				}, retainedUntrackedSelections, defaultCwd);
				if (negotiated.transport !== undefined) return hostTransportUnavailable(parameters.operation, negotiated.transport);
				return staleConsentBindingOutcome(parameters.operation, input.consentBinding, stale, negotiated.status!);
			} catch (error) {
				return nativeStatusFailed(parameters.operation, error);
			}
		}
		try {
			const gated = await resolveReviewModeGate(nativeReviewCli, parameters.operation, defaultCwd, signal);
			if (gated !== undefined) {
				// gentle-pi#668: mode disabled for this exact candidate -- keyed by
				// its targetIdentity, never by repository alone.
				recordNativeReviewOutcome(pending.authorityCwd, pending.consent.targetIdentity, NATIVE_REVIEW_OUTCOME.UNAVAILABLE);
				cleanupPendingReviewConsent(pending, pendingReviewConsentRegistry, owningSession);
				return gated;
			}
		} catch (error) {
			cleanupPendingReviewConsent(pending, pendingReviewConsentRegistry, owningSession);
			return nativeOperationFailure(parameters.operation, error);
		}
		// The one-shot binding is consumed before the first answer-path await. Any
		// ambiguous provider result reconciles through STATUS and can never be replayed.
		let completed: Record<string, unknown>;
		try {
			const answered = await nativeReviewCli.answerConsent({
				cwd: pending.authorityCwd,
				consent: pending.consent,
				answer: input.answer,
				...(signal === undefined ? {} : { signal }),
			});
			if (answered.kind === "declined") {
				// gentle-pi#668: candidate-scoped decline, keyed by this exact
				// candidate's targetIdentity, never by repository alone.
				recordNativeReviewOutcome(pending.authorityCwd, pending.consent.targetIdentity, NATIVE_REVIEW_OUTCOME.DECLINED);
				pending.cleanupCandidate();
				return {
					operation: parameters.operation,
					status: "skipped",
					outcome: "consent-declined-this-candidate",
					consent: answered.raw,
					...nativeStartPreAuthorityRejection(),
				};
			}
			retainNativeUntrackedSelection(retainedUntrackedSelections, pending.authorityCwd, answered.start.lineageId, pending.untrackedSelection);
			// gentle-pi#706: a START completed through answer-consent consumed the
			// adopted pre-lineage selection too; clear it like the direct path.
			clearRetainedNativeUntrackedSelection(retainedUntrackedSelections, pending.authorityCwd, "");
			completed = completeNativeStart(parameters.operation, answered.start, pending.repositoryCwd, pending.candidateView, pending.candidateViews);
		} catch (error) {
			const value = error as { mutationOutcome?: unknown };
			if (value.mutationOutcome === "none") pending.cleanupCandidate();
			return await reconcileNativeMutationFailure(parameters.operation, error, nativeReviewCli, {
				cwd: pending.authorityCwd,
				...(pending.candidateView.committedOnly ? { baseRef: pending.candidateView.baseCommit, committedOnly: true } : {}),
				projection: "workspace",
			}, retainedUntrackedSelections);
		}
		return completed;
	}
	if (parameters.operation === REVIEW_CONTROLLER_OPERATION.SELECT_INTENDED_UNTRACKED) {
		if (nativeReviewCli?.targetStatus === undefined || nativeReviewCli.start === undefined) return nativeStatusUnsupported(parameters.operation);
		const canonicalBinding = parseCanonicalReviewCaptureBinding(parameters.selectionBinding!);
		let status: ReviewStatusV3;
		try {
			const negotiated = await negotiatedStatusForHostTransport(nativeReviewCli, { cwd: defaultCwd, ...(signal === undefined ? {} : { signal }) }, retainedUntrackedSelections, defaultCwd);
			if (negotiated.transport !== undefined) return hostTransportUnavailable(parameters.operation, negotiated.transport);
			status = negotiated.status!;
		} catch (error) { return nativeStatusFailed(parameters.operation, error); }
		const input = reviewIntendedUntrackedInput(status), eligibleJson = input === undefined ? undefined : exactCollectArgument(input, "eligible_paths_json"), inventory = input === undefined ? undefined : exactCollectArgument(input, "expected_untracked_inventory");
		let eligible: unknown;
		try { eligible = JSON.parse(eligibleJson ?? ""); } catch { eligible = undefined; }
		const scope = parameters.intendedUntracked!.length === 0 ? NATIVE_START_UNTRACKED_SCOPE.EXCLUDE : NATIVE_START_UNTRACKED_SCOPE.SELECT;
		const selected = validateNativeStartUntrackedSelection({ untrackedScope: scope, expectedUntrackedInventory: inventory, intendedUntracked: parameters.intendedUntracked });
		const rejected = input === undefined || canonicalReviewCaptureBinding(input) !== canonicalBinding || exactCollectArgument(input, "target_identity") !== status.targetIdentity || exactCollectArgument(input, "projection") !== status.projection.projection || exactCollectArgument(input, "base_tree") !== status.projection.baseTree || exactCollectArgument(input, "candidate_tree") !== status.projection.currentCandidateTree || !Array.isArray(eligible) || selected.reason !== undefined || selected.intendedUntracked!.some((path) => !eligible.includes(path));
		if (rejected) return { operation: parameters.operation, status: "blocked", outcome: "intended-untracked-selection-binding-rejected", mutation_performed: false, mutation_outcome: "none" };
		const submission = { argumentTokens: input.submission!.argumentTokens, value: JSON.stringify({ schema: "gentle-ai.review-intended-untracked-selection/v1", untracked_scope: scope, expected_untracked_inventory: inventory, intended_untracked: selected.intendedUntracked }) };
		const result = await executeReviewControllerOperation({ operation: REVIEW_CONTROLLER_OPERATION.START, ...(parameters.workspaceRoot === undefined ? {} : { workspaceRoot: parameters.workspaceRoot }), input: JSON.stringify({ mode: REVIEW_MODE.ORDINARY, untrackedScope: scope, expectedUntrackedInventory: inventory, intendedUntracked: selected.intendedUntracked }) }, sessionCwd, nativeReviewCli, signal, candidateViews, context, retainedUntrackedSelections, pendingReviewConsentRegistry, pendingReviewConsentFallbackKey, reviewConsentNow, reviewConsentScheduleTimer, submission);
		return { ...result, operation: parameters.operation };
	}
	if (parameters.operation === REVIEW_CONTROLLER_OPERATION.START) {
		const rawStart = parseControllerJson(
			requiredControllerString(parameters, "input"),
			REVIEW_CONTROLLER_OPERATION.START,
		);
		if (rawStart.mode === REVIEW_MODE.ORDINARY) {
			if ("policyHash" in rawStart) return nativeStartRejection("legacy-policy-hash-unsupported");
			const unknownField = Object.keys(rawStart).find((field) => !["mode", "baseRef", "committedOnly", "policyPath", "focus", "untrackedScope", "expectedUntrackedInventory", "intendedUntracked"].includes(field));
			if (unknownField !== undefined) return nativeStartRejection("unknown-field", unknownField);
			const focus = rawStart.focus;
			if (focus !== undefined && !isNativeStartFocus(focus)) return nativeStartRejection("focus-invalid");
			const policy: NativeStartPolicyValidation = rawStart.policyPath === undefined
				? {}
				: validateNativeStartPolicyPath(defaultCwd, rawStart.policyPath);
			if (policy.reason !== undefined) return nativeStartRejection(policy.reason);
			const baseRef = rawStart.baseRef;
			if (baseRef !== undefined && !isCanonicalProcessString(baseRef)) return nativeStartRejection("base-ref-invalid");
			if (baseRef !== undefined && rawStart.committedOnly !== true) return nativeStartRejection("committed-only-required");
			if (baseRef === undefined && "committedOnly" in rawStart) return nativeStartRejection("committed-only-invalid");
			const explicitUntrackedSelection =
				validateNativeStartUntrackedSelection(rawStart);
			if (explicitUntrackedSelection.reason !== undefined)
				return nativeStartRejection(explicitUntrackedSelection.reason);
			// gentle-pi#706: a plain START adopts the selection an inspect
			// untrackedScope round trip retained pre-lineage; explicit input or a
			// carried submission always wins over the retained entry.
			const retainedPreLineageSelection =
				explicitUntrackedSelection.untrackedScope === undefined &&
				intendedUntrackedSelection === undefined
					? readRetainedPreLineageNativeUntrackedSelection(
							retainedUntrackedSelections,
							defaultCwd,
						)
					: undefined;
			const untrackedSelection: NativeStartUntrackedSelection =
				retainedPreLineageSelection === undefined
					? explicitUntrackedSelection
					: {
							untrackedScope: retainedPreLineageSelection.untrackedScope,
							expectedUntrackedInventory:
								retainedPreLineageSelection.expectedUntrackedInventory,
							intendedUntracked: [...retainedPreLineageSelection.intendedUntracked],
						};
			const untrackedSubmission =
				intendedUntrackedSelection ?? retainedPreLineageSelection?.submission;
			const retainedUntrackedSelection =
				retainedPreLineageSelection ??
				cloneRetainedNativeUntrackedSelection(explicitUntrackedSelection);
			let canonicalBaseRef: string | undefined;
			if (baseRef !== undefined) {
				try {
					canonicalBaseRef = resolveCanonicalCandidateBase(defaultCwd, baseRef).commit;
				} catch (error) {
					if (error instanceof CandidateViewError && error.diagnostics !== undefined) return nativeOperationFailure(parameters.operation, Object.assign(error, { candidateViewPreNative: true }));
					if (error instanceof CandidateViewError && (error.reason === "base-ref-ambiguous" || error.reason === "base-ref-unresolvable" || error.reason === "base-ref-moved")) return nativeStartRejection(error.reason);
					return nativeStartRejection("base-ref-unresolvable");
				}
			}
			try {
				const gated = await resolveReviewModeGate(nativeReviewCli, parameters.operation, defaultCwd, signal);
				if (gated !== undefined) return gated;
			} catch (error) {
				return nativeOperationFailure(parameters.operation, error);
			}
			if (nativeReviewCli?.targetStatus === undefined) return nativeStatusUnsupported(parameters.operation);
			let target: ReviewStatusV3;
			try {
				const negotiated = await negotiatedStatusForHostTransport(nativeReviewCli, {
					cwd: defaultCwd,
					...(parameters.lineageId === undefined ? {} : { lineageId: parameters.lineageId }),
					...(canonicalBaseRef === undefined ? {} : { baseRef: canonicalBaseRef, committedOnly: true }),
					...(untrackedSelection.untrackedScope === undefined ? {} : untrackedSelection),
					...(untrackedSubmission === undefined ? {} : { intendedUntrackedSelection: untrackedSubmission }),
					...(signal === undefined ? {} : { signal }),
				}, retainedUntrackedSelections, defaultCwd);
				if (negotiated.transport !== undefined) return hostTransportUnavailable(parameters.operation, negotiated.transport);
				target = negotiated.status!;
				// gentle-pi#874: the STATUS this START already fetched can itself
				// offer the committed-range START for an empty workspace candidate.
				// Adopt its own base commit *here*, before the candidate view and the
				// native START are resolved, and re-derive the target for that range,
				// so all three agree on one base-diff identity. Adopting the offer
				// later left the workspace target and the base-diff candidate view
				// disagreeing, and START failed with identity-mismatch. Both an
				// explicit caller baseRef and any START with an untracked selection in
				// play keep today's single-STATUS flow; only an adopted offer pays the
				// second read-only STATUS.
				if (canonicalBaseRef === undefined && untrackedSelection.untrackedScope === undefined && untrackedSubmission === undefined) {
					const offeredBaseRef = offeredCommittedRangeBaseRef(target);
					if (offeredBaseRef !== undefined) {
						const renegotiated = await negotiatedStatusForHostTransport(nativeReviewCli, {
							cwd: defaultCwd,
							...(parameters.lineageId === undefined ? {} : { lineageId: parameters.lineageId }),
							baseRef: offeredBaseRef,
							committedOnly: true,
							...(signal === undefined ? {} : { signal }),
						}, retainedUntrackedSelections, defaultCwd);
						if (renegotiated.transport !== undefined) return hostTransportUnavailable(parameters.operation, renegotiated.transport);
						canonicalBaseRef = offeredBaseRef;
						target = renegotiated.status!;
					}
				}
				if (
					retainedPreLineageSelection !== undefined &&
					!sameNativePreLineageCandidate(retainedPreLineageSelection, target)
				) {
					clearRetainedNativeUntrackedSelection(retainedUntrackedSelections, defaultCwd, "");
					return {
						operation: parameters.operation,
						status: "blocked",
						outcome: "native-start-retained-selection-candidate-mismatch",
						mutation_performed: false,
						mutation_outcome: "none",
						next_action: "inspect-and-resolve-the-current-intended-untracked-selection",
					};
				}
				if (target.nextTransition?.kind === "collect" || target.applicability !== "unrelated" || target.action !== "start") return mapNativeTargetStatus(parameters.operation, target, parameters.lineageId);
			} catch (error) {
				return nativeOperationFailure(parameters.operation, error);
			}
			// gentle-pi#323: the replay key must fold in the current candidate
			// content identity. Without it, a second START with identical
			// {cwd, lineageId, input, inputPath} reuses a still-live (never
			// lineage-bound) frozen candidate view from within the consent TTL
			// window even after the live candidate content changed underneath
			// it, and dead-ends at candidate-target-projection-drift with no
			// recovery. Folding in currentCandidateTree makes a content change
			// mint a fresh replay key -- and therefore a fresh candidate view --
			// instead of reusing the stale one.
			const replayKey = JSON.stringify({ cwd: defaultCwd, lineageId: parameters.lineageId ?? null, input: parameters.input ?? null, inputPath: parameters.inputPath ?? null, candidateTree: target.projection.currentCandidateTree });
			// Synchronously drop any binding whose TTL has already elapsed
			// before reusing its retained candidate view, so a fresh-candidate
			// retry cannot reuse a view tied to an expired binding and trip
			// candidate-target-projection-drift. Timer order must not decide
			// correctness: the queued cleanup macrotask may not have fired yet.
			pruneExpiredReviewConsents(pendingReviewConsentRegistry, pendingReviewConsentSession, reviewConsentNow);
			const candidateIntendedUntracked = target.projection.intendedUntracked;
			let candidateView: ReturnType<CandidateViewRegistry["create"]> | undefined;
			let nativeStartAttempted = false;
			try {
				const candidateRequest = { contributorRoot: defaultCwd, replayKey, ...(canonicalBaseRef === undefined ? {} : { baseRef: canonicalBaseRef, committedOnly: true }) };
				candidateView = candidateViews?.createOrReuse({ ...candidateRequest, ...(candidateIntendedUntracked.length === 0 ? {} : { intendedUntracked: candidateIntendedUntracked }) });
				if (candidateView !== undefined && candidateIntendedUntracked.length === 0 && candidateView.candidateTree !== target.projection.currentCandidateTree) {
					candidateView.cleanup();
					candidateView = candidateViews?.createOrReuse({ ...candidateRequest, intendedUntracked: [] });
				}
				if (candidateView !== undefined) assertNativeStartCandidateBinding(candidateView, target);
				let result: NativeStartResult;
				try {
					nativeStartAttempted = true;
					result = await nativeReviewCli.start({
						cwd: defaultCwd,
						...(canonicalBaseRef === undefined
							? {}
							: { baseRef: candidateView?.baseCommit ?? canonicalBaseRef, committedOnly: true }),
						targetIdentity: target.targetIdentity,
						projection: target.projection.projection,
						...(untrackedSelection.untrackedScope === undefined ? {} : untrackedSelection),
						...(untrackedSubmission === undefined ? {} : { intendedUntrackedSelection: untrackedSubmission }),
						...(parameters.lineageId === undefined ? {} : { lineageId: parameters.lineageId }),
						...(policy.policyPath === undefined ? {} : { policyPath: policy.policyPath }),
						...(focus === undefined ? {} : { focus }),
						...(signal === undefined ? {} : { signal }),
					});
				} catch (error) {
					if (!(error instanceof NativeReviewConsentRequiredError)) throw error;
					if (candidateView === undefined) throw new CandidateViewError("native consent requires a frozen candidate view");
					const consentCandidateView = candidateView;
					const repositoryCwd = realpathSync(defaultCwd);
					const consentDigest = reviewConsentDigest(error.consent);
					const pendingReviewConsents = pendingReviewConsentRegistry.get(pendingReviewConsentSession);
					const existing = [...(pendingReviewConsents?.values() ?? [])].find((pending) => pending.repositoryCwd === repositoryCwd && pending.candidateView.token === consentCandidateView.token && pending.consentDigest === consentDigest && pending.expiresAt > reviewConsentNow());
					if (existing === undefined) {
						for (const pending of [...(pendingReviewConsents?.values() ?? [])]) {
							if (pending.candidateView.token === consentCandidateView.token) {
								discardPendingReviewConsent(pending, pendingReviewConsentRegistry, pendingReviewConsentSession);
							}
						}
					}
					const id = existing?.id ?? randomUUID();
					if (existing === undefined) {
						let candidateCleaned = false;
						const pending: PendingReviewConsent = {
							id,
							repositoryCwd,
							authorityCwd: defaultCwd,
							candidateView: consentCandidateView,
							candidateViews,
							verifyCandidate: () => consentCandidateView.verify(),
							cleanupCandidate: () => {
								if (candidateCleaned) return;
								candidateCleaned = true;
								try { consentCandidateView.cleanup(); } catch { /* Failed ownership proof preserves the view; consent expiry/teardown still completes. */ }
							},
							...(retainedUntrackedSelection === undefined ? {} : { untrackedSelection: retainedUntrackedSelection }),
							consent: error.consent,
							consentDigest,
							expiresAt: reviewConsentNow() + PENDING_REVIEW_CONSENT_TTL_MS,
						};
						pendingReviewConsentRegistry.add(pendingReviewConsentSession, pending);
						pending.expiry = reviewConsentScheduleTimer(
							() => expirePendingReviewConsent(pending, pendingReviewConsentRegistry, pendingReviewConsentSession),
							PENDING_REVIEW_CONSENT_TTL_MS,
						);
						pending.expiry.unref();
					}
					return {
						operation: parameters.operation,
						status: "blocked",
						outcome: "native-review-consent-required",
						consent: error.consent.raw,
						consent_binding: id,
						...nativeStartPreAuthorityRejection(),
					};
				}
				retainNativeUntrackedSelection(retainedUntrackedSelections, defaultCwd, result.lineageId, retainedUntrackedSelection);
				// gentle-pi#706: the adopted pre-lineage selection dies with the START
				// that consumed it; it must never leak to the next candidate.
				clearRetainedNativeUntrackedSelection(retainedUntrackedSelections, defaultCwd, "");
				return completeNativeStart(parameters.operation, result, defaultCwd, candidateView, candidateViews);
			} catch (error) {
				if (!nativeStartAttempted && error instanceof CandidateViewError && error.diagnostics !== undefined) return nativeOperationFailure(parameters.operation, Object.assign(error, { candidateViewPreNative: true }));
				if (error instanceof CandidateViewError && (error.reason === "base-ref-ambiguous" || error.reason === "base-ref-unresolvable" || error.reason === "base-ref-moved")) return nativeStartRejection(error.reason);
				const value = error as { mutationOutcome?: unknown; nextAction?: unknown };
				const provenNoMutation = value.mutationOutcome === "none";
				const preNativeFailure = !nativeStartAttempted;
				if (candidateView && candidateViews && (provenNoMutation || preNativeFailure)) candidateViews.cleanup(candidateView.token);
				const nativeCliError = asNativeReviewCliError(error);
				const failure = provenNoMutation
					? error
					: preNativeFailure
						? error instanceof CandidateViewError ? Object.assign(error, { candidateViewPreNative: true }) : error
						: Object.assign(
							error instanceof Error
								? error
								: nativeCliError === undefined
									? new Error(String(error))
									: { name: "NativeReviewCliError", code: nativeCliError.code, diagnostics: nativeCliError.diagnostics },
							{ mutationOutcome: "unknown", nextAction: "review.status" },
						);
				return reconcileNativeMutationFailure(parameters.operation, failure, nativeReviewCli, {
					cwd: defaultCwd,
					...(parameters.lineageId === undefined ? {} : { lineageId: parameters.lineageId }),
					...(canonicalBaseRef === undefined ? {} : { baseRef: candidateView?.baseCommit ?? canonicalBaseRef, committedOnly: true }),
					...(untrackedSelection.untrackedScope === undefined ? {} : untrackedSelection),
					projection: "workspace",
				}, retainedUntrackedSelections);
			}
		}
		if (rawStart.mode === REVIEW_MODE.ORDINARY) {
			return nativeStatusUnsupported(parameters.operation);
		}
		const idempotencyKey = requiredControllerString(parameters, "idempotencyKey");
		if (typeof parameters.lineageId !== "string" || parameters.lineageId.trim().length === 0) {
			throw new Error("Judgment Day graph-v1 START requires lineageId");
		}
		const input = parseStartInput(rawStart);
		const snapshot = captureReviewSnapshot({
			cwd: defaultCwd,
			mode: input.mode,
			projection: input.projection,
			policyHash: input.policyHash,
		});
		const stateInput = {
			lineageId: parameters.lineageId,
			mode: input.mode,
			snapshot,
			evidenceHash: input.evidenceHash,
			budget: input.budget,
		};
		const state = createReviewState(
			input.parentLineageId === undefined
				? stateInput
				: { ...stateInput, parentLineageId: input.parentLineageId },
		);
		const store = ReviewTransactionStore.forRepository(defaultCwd);
		let result: StartOperationResultV1;
		try {
			result = store.create(state, idempotencyKey);
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "Graph lineage already exists") throw error;
			const current = store.read(parameters.lineageId!);
			const existing = current.request_journal.find((entry) => entry.idempotency_key === idempotencyKey);
			if (
				existing?.operation !== REVIEW_OPERATION.START ||
				existing.request_hash !== canonicalHash(state) ||
				existing.status !== JOURNAL_STATUS.COMPLETED
			) {
				throw new Error("Idempotency key was reused with a different START request; replay requires the same lineageId, idempotencyKey, and exact request");
			}
			result = existing.canonical_result as StartOperationResultV1;
		}
		return { operation: parameters.operation, result, state };
	}
	if (parameters.operation === REVIEW_CONTROLLER_OPERATION.ADVANCE) {
		const idempotencyKey = requiredControllerString(parameters, "idempotencyKey");
		const transitionValue = requiredControllerString(parameters, "transition");
		if (!isReviewTransition(transitionValue)) {
			throw new Error(`Review controller transition is unsupported: ${transitionValue}`);
		}
		const hasInput = parameters.input !== undefined;
		const hasInputPath = parameters.inputPath !== undefined;
		if (hasInput === hasInputPath) {
			throw new Error("Review controller advance requires exactly one of input or inputPath");
		}
		const rawInput = parseControllerJson(
			hasInput
				? requiredControllerString(parameters, "input")
				: readRepositoryControllerInput(requiredControllerString(parameters, "inputPath"), defaultCwd),
			REVIEW_CONTROLLER_OPERATION.ADVANCE,
		);
		const store = ReviewTransactionStore.forRepository(defaultCwd);
		if (store.read(parameters.lineageId!).mode === REVIEW_MODE.ORDINARY) {
			throw new Error(GRAPH_V1_ORDINARY_READ_ONLY);
		}
		const result = store.runReducerOperation({
			lineageId: parameters.lineageId,
			transition: transitionValue,
			idempotencyKey,
			input: rawInput as unknown as ReviewReducerInput,
		});
		return {
			operation: parameters.operation,
			result,
			state: store.read(parameters.lineageId),
		};
	}
	if (parameters.operation === REVIEW_CONTROLLER_OPERATION.STATUS) {
		const rawStatus = parameters.input === undefined
			? undefined
			: parseControllerJson(parameters.input, REVIEW_CONTROLLER_OPERATION.STATUS);
		const unknownField = rawStatus === undefined
			? undefined
			: Object.keys(rawStatus).find((field) => !["baseRef", "committedOnly", "untrackedScope", "expectedUntrackedInventory", "intendedUntracked"].includes(field));
		if (unknownField !== undefined) return nativeStatusInputRejection("unknown-field", unknownField);
		const baseRef = rawStatus?.baseRef;
		if (baseRef !== undefined && !isCanonicalProcessString(baseRef)) return nativeStatusInputRejection("base-ref-invalid");
		if (baseRef !== undefined && rawStatus?.committedOnly !== true) return nativeStatusInputRejection("committed-only-required");
		if (baseRef === undefined && rawStatus !== undefined && "committedOnly" in rawStatus) return nativeStatusInputRejection("committed-only-invalid");
		const untrackedSelection = rawStatus === undefined ? {} : validateNativeStartUntrackedSelection(rawStatus);
		if (
			rawStatus !== undefined &&
			(untrackedSelection.reason !== undefined || (baseRef === undefined && untrackedSelection.untrackedScope === undefined))
		) return nativeStatusInputRejection(untrackedSelection.reason ?? "untracked-selection-invalid");
		const retainedUntrackedSelection = cloneRetainedNativeUntrackedSelection(untrackedSelection);
		const effectiveUntrackedSelection = rawStatus === undefined && parameters.lineageId !== undefined
			? readRetainedNativeUntrackedSelection(retainedUntrackedSelections, defaultCwd, parameters.lineageId)
			: untrackedSelection;
		const retainedCommittedTarget = rawStatus === undefined && parameters.lineageId !== undefined && candidateViews?.hasProjection(parameters.lineageId, defaultCwd)
			? candidateViews.resolveProjection(parameters.lineageId, defaultCwd)
			: undefined;
		const effectiveBaseRef = baseRef ?? (retainedCommittedTarget?.committedOnly === true ? retainedCommittedTarget.baseCommit : undefined);
		if (nativeReviewCli?.targetStatus !== undefined) {
			try {
				const negotiated = await negotiatedStatusForHostTransport(nativeReviewCli, {
					cwd: defaultCwd,
					...(parameters.lineageId === undefined ? {} : { lineageId: parameters.lineageId }),
					...(effectiveBaseRef === undefined ? {} : { baseRef: effectiveBaseRef, committedOnly: true }),
					...(effectiveUntrackedSelection.untrackedScope === undefined ? {} : effectiveUntrackedSelection),
					...(signal === undefined ? {} : { signal }),
				}, retainedUntrackedSelections, defaultCwd);
				if (negotiated.transport !== undefined) {
					return {
						...hostTransportUnavailable(parameters.operation, negotiated.transport),
						...(includeWorkspaceRoot ? { workspace_root: defaultCwd } : {}),
					};
				}
				const status = negotiated.status!;
				if (
					retainedUntrackedSelection !== undefined &&
					parameters.lineageId !== undefined &&
					status.applicability === "current_target" &&
					status.authority?.lineageId === parameters.lineageId
				) retainNativeUntrackedSelection(retainedUntrackedSelections, defaultCwd, parameters.lineageId, retainedUntrackedSelection);
				clearRetainedNativeStatusSelectionsOnTerminal(retainedUntrackedSelections, defaultCwd, status.authority?.lineageId, status.authority?.state);
				hydrateDispatchBindingFromStatus(candidateViews, defaultCwd, status);
				return { ...mapNativeTargetStatus(parameters.operation, status, parameters.lineageId), ...(includeWorkspaceRoot ? { workspace_root: defaultCwd } : {}) };
			} catch (error) {
				return nativeOperationFailure(parameters.operation, error);
			}
		}
		return nativeStatusUnsupported(parameters.operation);
	}
	throw new Error(`Review controller operation is unsupported: ${parameters.operation}`);
}

/** @internal */
export const __testing = {
	resolveReviewModeGate,
	readEffectiveModelConfig,
	readEffectiveModelConfigAsync,
	listAgentsFromDir,
	listAgentsFromDirAsync,
	listDiscoverableAgents,
	orderDiscoverableAgents,
	classifyGuardedCommand,
	evaluateGuardedCommand,
	guardedCommandPreview,
	guardedCommandTitle,
	loadRuntimeGuardrailsConfig,
	buildGentlePrompt,
	nativeStatusUnsupported,
	executeReviewControllerOperation,
	executeReviewCaptureOperation,
	executeReviewCaptureGroupOperation,
	setReviewHostRelayRunnerForTesting,
	setReviewHostRelayGroupRunnersForTesting,
	clearReviewTransportProbeForTesting,
	renderSddModelPanel: renderSddModelPanelForTesting,
	getOrchestratorPrompt,
	renderOrchestratorPrompt,
	loadReviewContractPromptFragment,
	readMirroredReviewContractFragment,
	loadBackgroundSubagentsPolicy,
	resolveBackgroundSubagentsPolicy,
	renderBackgroundSubagentsReport,
	writeGlobalBackgroundSubagentsPolicy,
	parseBackgroundSubagentsPolicyFile,
	resolveBackgroundSubagentsCapability,
	readActiveToolNames,
	renderBackgroundSubagentsStatusLine,
	renderRddStatusLine,
	isValidRddModeStatus,
	resolveRddModeStatus,
	resolveRddStatusLine,
	RDD_STATUS_TIMEOUT_MS,
	RDD_STATUS_MEMO_TTL_MS,
	clearRddStatusMemoForTesting,
	readNativeReviewOutcome,
	recordNativeReviewOutcome,
	clearNativeReviewOutcomeMemoForTesting,
	resolveSelectedNativeSddChangeStartup,
	readSddChangeFlag,
	resetTelemetryTriggerGuardForTesting,
	createGentleAiExtension: createGentleAiExtensionForTesting,
};

export interface GentleAiRuntimeDependencies {
	nativeReviewCli?: NativeReviewCli | null;
	candidateViews?: CandidateViewRegistry | null;
	// An injected registry gives tests and host integrations explicit ownership;
	// normal package registrations share the module-local process-memory registry.
	pendingReviewConsentRegistry?: PendingReviewConsentRegistry;
	// Deterministic test seam for the consent-binding TTL clock. Production
	// leaves both undefined so the consent path observes real wall-clock time;
	// tests inject a fake clock so expiry is observable without a 10-minute
	// sleep and without relying on the queued cleanup macrotask firing.
	now?: () => number;
	scheduleTimer?: (callback: () => void, delayMs: number) => { unref: () => void };
	// The environment the session's child processes inherit; tests inject a
	// plain object so the handshake declaration is observable without
	// touching the test runner's own process.env.
	processEnv?: NodeJS.ProcessEnv;
	// Package-owned children use this parent-bound channel only to ask whether
	// their own pending ordinary START may replay a grant locally.
	childStandingReviewPermissionClient?: Pick<ChildStandingReviewPermissionClient, "requestAuthorization" | "close">;
	// gentle-pi#677: test-only seams for the telemetry trigger. Production
	// leaves both undefined: the real package-local resolveGentleAiBinary()
	// and the real detached child_process spawn run.
	resolveTelemetryTriggerBinary?: () => string;
	telemetryTriggerSpawn?: TelemetryTriggerSpawn;
	// Test-only seam for the foreground `/gentle:telemetry` slash command's
	// bounded exec; production leaves this undefined and uses the real node
	// exec-file adapter shared with the rest of the extension.
	telemetryExecFileAdapter?: ExecFileAdapter;
}

export function createGentleAiExtension(dependencies: GentleAiRuntimeDependencies = {}): (pi: ExtensionAPI) => void {
	return createGentleAiExtensionForTesting(dependencies);
}

function createGentleAiExtensionForTesting(
	dependencies: GentleAiRuntimeDependencies = {},
): (pi: ExtensionAPI) => void {
	const nativeReviewCli = dependencies.nativeReviewCli === undefined ? createNativeReviewCli() : dependencies.nativeReviewCli;
	const childStandingReviewPermissionLease = dependencies.childStandingReviewPermissionClient === undefined
		? acquireChildStandingReviewPermissionClient(dependencies.processEnv ?? process.env)
		: undefined;
	const childStandingReviewPermission = dependencies.childStandingReviewPermissionClient ?? childStandingReviewPermissionLease?.client;
	const reviewConsentNow = dependencies.now ?? (() => Date.now());
	const reviewConsentScheduleTimer = dependencies.scheduleTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
	const pendingReviewConsentRegistry = dependencies.pendingReviewConsentRegistry ?? processPendingReviewConsentRegistry;
	const resolveTelemetryTriggerBinary = dependencies.resolveTelemetryTriggerBinary ?? resolveGentleAiBinary;
	const telemetryExecFileAdapter = dependencies.telemetryExecFileAdapter ?? createNodeExecFileAdapter();
	return function gentleAi(pi: ExtensionAPI): void {
		const flags = pi as unknown as { registerFlag?: (name: string, definition: { description: string; type: "string"; default?: string }) => void };
		flags.registerFlag?.(SDD_CHANGE_FLAG, {
			description: "Internal launch-local selected SDD change identity for package-owned child agents.",
			type: "string",
		});
	declareReviewRelayHandshake(dependencies.processEnv ?? process.env);
	const pendingReviewConsentFallbackKey = Symbol("pending-review-consent-fallback");
	const candidateViews = dependencies.candidateViews === undefined ? new CandidateViewRegistry() : dependencies.candidateViews;
	const herdrLifecycle = createHerdrConfirmationLifecycle(pi.events);
	const permissionEnvironment = dependencies.processEnv ?? process.env;

	const setReviewSessionPermissionStatus = (context: ExtensionContext, active: boolean): void => {
		try {
			(context.ui as unknown as { setStatus?: (key: string, text?: string) => void }).setStatus?.(
				REVIEW_SESSION_PERMISSION_STATUS_KEY,
				active ? REVIEW_SESSION_PERMISSION_STATUS_TEXT : undefined,
			);
		} catch { /* Status is nonblocking and never permission authority. */ }
	};
	const capturePermissionIdentity = (context: ExtensionContext, cwd: string = context.cwd): Promise<ReviewSessionIdentity | undefined> =>
		captureReviewSessionIdentity({ ...context, cwd }, permissionEnvironment);
	const refreshReviewSessionPermissionStatus = async (context: ExtensionContext): Promise<ReviewSessionIdentity | undefined> => {
		const identity = await capturePermissionIdentity(context);
		setReviewSessionPermissionStatus(context, identity !== undefined && hasReviewSessionPermission(identity));
		return identity;
	};
	const revokeCurrentReviewSessionPermission = (context: ExtensionContext): boolean => {
		const coordinates = reviewSessionManagerAndId(context);
		const revoked = coordinates === undefined ? false : revokeReviewSessionPermissionsForSession(coordinates.manager, coordinates.sessionId);
		setReviewSessionPermissionStatus(context, false);
		return revoked;
	};
	const revokeCurrentRepositoryReviewSessionPermission = async (context: ExtensionContext): Promise<boolean> => {
		const identity = await capturePermissionIdentity(context);
		const revoked = identity === undefined ? false : revokeReviewSessionPermission(identity);
		setReviewSessionPermissionStatus(context, false);
		return revoked;
	};

	let reminderSessionActive = true;
	let reminderEpoch = 0;
	pi.on("session_shutdown", (event, context) => {
		reminderSessionActive = false;
		reminderEpoch += 1;
		// Pi tears down this registry on reload as well as session replacement/quit.
		try { candidateViews?.cleanupAll(); } catch { /* Preserve failed owned views for later recovery. */ }
		const reason = (event as { reason?: unknown }).reason;
		if (reason !== "reload") {
			if (childStandingReviewPermissionLease !== undefined) childStandingReviewPermissionLease.closeIfCurrent();
			else childStandingReviewPermission?.close();
			revokeCurrentReviewSessionPermission(context);
		}
		const sessionKey = pendingReviewConsentSessionKey(context, pendingReviewConsentFallbackKey);
		cleanupAllPendingReviewConsents(pendingReviewConsentRegistry, sessionKey);
		processRetainedNativeStatusSelections.delete(sessionKey);
		processAgentEndSubagentDepth.delete(sessionKey);
	});

	pi.registerTool({
		name: "gentle_review_scope",
		renderShell: "self",
		label: "Gentle Review Scope",
		description: "Read one bounded, integrity-checked page of the controller-owned frozen changed scope. This read-only tool never inspects the ambient or candidate tree.",
		parameters: REVIEW_SCOPE_PARAMETERS,
		executionMode: "parallel",
		renderCall(_args, theme, context) {
			return renderGentleAiLifecycleCall(
				"review scope",
				theme,
				context as GentleAiRenderContext | undefined,
			);
		},
		renderResult(result, options, theme, context) {
			return renderGentleAiResult(result, options, theme, context as GentleAiRenderContext | undefined);
		},
		async execute(_toolCallId, parameters) {
			const input = parameters as ReviewScopeParameters;
			const details = readCandidateContextManifestPage(input.manifest, input.sha256, input.cursor ?? 0);
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
	});

	// The lens a reviewer capture runs is inside its collect binding, so the
	// card can say "review capture · risk" instead of a bare operation name.
	const lensLabel = (lens: unknown): string | undefined =>
		typeof lens === "string" && lens.length > 0 ? lens.replace(/^review-/, "") : undefined;
	const collectBindingLens = (binding: unknown): string | undefined => {
		if (typeof binding !== "string") return undefined;
		try {
			const parsed = JSON.parse(binding) as Record<string, unknown>;
			const subject = (parsed.artifactSubject ?? parsed.artifact_subject) as Record<string, unknown> | undefined;
			return lensLabel(subject?.lens);
		} catch {
			return undefined;
		}
	};
	const withLenses = (operation: string, lenses: readonly (string | undefined)[]): string => {
		const named = lenses.filter((lens): lens is string => lens !== undefined);
		return named.length === 0 ? operation : `${operation} · ${named.join(" · ")}`;
	};

	pi.registerTool({
		name: "gentle_review_capture_group",
		renderShell: "self",
		label: "Gentle Review Capture Group",
		description: "Capture one complete provider-issued materialize reviewer group. It validates the exact ordered current collect set, forecasts its bounded model cost, runs reviewers concurrently, and admits outputs one at a time in provider order.",
		promptSnippet: "Use one complete exact current STATUS materialize reviewer group; acknowledge its forecast before the grouped run.",
		promptGuidelines: [
			"Pass only lineageId, the complete ordered collectBindings array from one current STATUS result, and reviewerRunAcknowledged after its forecast. Never mix, reorder, duplicate, or partially select bindings.",
			"The group materializes and runs independent reviewers concurrently, but rechecks STATUS before every provider-ordered submission. It stops on a closure, correction, drift, or uncertain capture outcome; it never follows another transition or replays a prepared output.",
		],
		parameters: REVIEW_CAPTURE_GROUP_PARAMETERS,
		executionMode: "sequential",
		renderCall(args, theme, context) {
			const bindings = (args as { collectBindings?: unknown }).collectBindings;
			const lenses = Array.isArray(bindings) ? bindings.map(collectBindingLens) : [];
			return renderGentleAiLifecycleCall(withLenses("review capture group", lenses), theme, context as GentleAiRenderContext | undefined);
		},
		renderResult(result, options, theme, context) {
			return renderGentleAiResult(result, options, theme, context as GentleAiRenderContext | undefined);
		},
		async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Review capture group was cancelled");
			const details = await executeReviewCaptureGroupOperation(
				parameters,
				ctx.cwd,
				nativeReviewCli,
				signal,
				candidateViews,
				((sessionKey: PendingReviewConsentSessionKey) => processRetainedNativeStatusSelections.get(sessionKey) ?? processRetainedNativeStatusSelections.set(sessionKey, new Map()).get(sessionKey)!)(pendingReviewConsentSessionKey(ctx, pendingReviewConsentFallbackKey)),
				true,
			);
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
	});

	pi.registerTool({
		name: "gentle_review_capture",
		renderShell: "self",
		label: "Gentle Review Capture",
		description: "Capture exactly one provider-issued ordinary native review collect slot. This is not a controller operation: it validates one opaque collect binding against current target-scoped STATUS, executes at most one capture, and never follows a transition.",
		promptSnippet: "Use one exact current STATUS collectBinding for one ordinary native capture; call fresh STATUS before every additional capture.",
		promptGuidelines: [
			"Pass only lineageId, the JSON-serialized exact collectBinding from current STATUS, and the route-specific optional acknowledgement or correctionLines value. Never compose provider argument tokens, prompts, results, verdicts, or lens arrays.",
			"A materialize reviewer slot first forecasts one model run; re-submit that same exact binding with reviewerRunAcknowledged: true to authorize one host relay. Correction-plan slots require correctionLines inside the provider-issued bounds, counted in diff lines (one replaced source line is one deletion plus one addition) — a different unit from the frozen logical correction budget. Refuter and validation vectors execute exactly once as provider-rendered.",
			"A native terminal closure or nonterminal capture returns directly. Do not expect automatic STATUS, FINALIZE, receipt, delivery, or another capture; call fresh STATUS before any next capture.",
		],
		parameters: REVIEW_CAPTURE_PARAMETERS,
		executionMode: "sequential",
		renderCall(args, theme, context) {
			return renderGentleAiLifecycleCall(
				withLenses("review capture", [collectBindingLens((args as { collectBinding?: unknown }).collectBinding)]),
				theme,
				context as GentleAiRenderContext | undefined,
			);
		},
		renderResult(result, options, theme, context) {
			return renderGentleAiResult(result, options, theme, context as GentleAiRenderContext | undefined);
		},
		async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Review capture was cancelled");
			const details = await executeReviewCaptureOperation(
				parameters,
				ctx.cwd,
				nativeReviewCli,
				signal,
				candidateViews,
				((sessionKey: PendingReviewConsentSessionKey) => processRetainedNativeStatusSelections.get(sessionKey) ?? processRetainedNativeStatusSelections.set(sessionKey, new Map()).get(sessionKey)!)(pendingReviewConsentSessionKey(ctx, pendingReviewConsentFallbackKey)),
				true,
			);
			return {
				content: [{ type: "text", text: JSON.stringify(details) }],
				details,
			};
		},
	});

	pi.registerTool({
		name: "gentle_review",
		renderShell: "self",
		label: "Gentle Review Controller",
		description:
			"Inspect and recover review authority and start native ordinary review. Ordinary capture is available only through the separate gentle_review_capture tool. Review outcomes never authorize delivery: commit, push, pull-request, and release commands follow ordinary repository policy. RESET/RECOVER remain destructive and are executed by the audited native CLI.",
		promptSnippet: "Inspect authority, then start native ordinary review; use gentle_review_capture for one current collect slot",
		promptGuidelines: [
			'Call {"operation":"inspect"} before START. New native ordinary START uses a JSON string such as "{\\"mode\\":\\"ordinary\\"}"; an explicit baseRef must be paired with committedOnly: true to request a committed range, while policyPath remains repository-local. policyHash is legacy compact-only. The controller derives lineage, Git/untracked scope, tier, lenses, authored lines, and budget; the frozen correction budget counts logical corrections, while correction-plan correctionLines count diff lines (one replaced source line is one deletion plus one addition).',
			'An inspect blocked on the intended-untracked selection returns nextStep naming the exact continuation: call select-intended-untracked with the returned selectionBinding, or call inspect again with top-level untrackedScope ("exclude", or "select" with intendedUntracked) to resolve the round trip in one call; the retained selection is adopted by the next plain START.',
			"Use RECONCILE_AUTHORITY only to quarantine one invalid native recovery successor. Supply exact predecessorLineage, expectedPredecessorRevision, successorLineage, expectedSuccessorRevision, actor, and reason values; Pi derives and displays the seven-line native authorization binding for fresh UI approval. The predecessor stays untouched, native returns the durable audit record, and Pi never falls back to RESET or RECOVER.",
			"Use ABANDON or QUARANTINE_LEGACY only after an explicit user decision and with exact native inputs. ABANDON needs lineage, expectedRevision, snapshotIdentity, capturedLensResults, findingsPresent, actor, and reason; QUARANTINE_LEGACY accepts only the published malformed freeze-findings diagnostic/disposition. A dual reconciliation may supply only anomalies `unchanged_target,malformed_recovery_authorization` in that exact order. Use REPAIR_LEGACY_ALIAS only with lineage, actor, and reason: Pi freshly reads native inventory and derives repository, revision, diagnostic, disposition, and the exact eight-line binding before interactive approval. `review dispose-result` is unsupported pending design.",
			"Lens, refuter, and validator verdicts are admitted natively, never Pi-authored. Use gentle_review_capture with exactly one current provider-owned collectBinding for ordinary native capture; it never follows another transition.",
			"For blocked-legacy or blocked-mixed, do not call START repeatedly. Explain invalidation, request explicit user authorization, then call RESET or RECOVER only after authorization. RESET and RECOVER_LOCK route to audited native `gentle-ai review reclaim`; only RESET carries the legacy repositoryId, commonDirHash, inventoryHash, and confirmation challenge. RECOVER routes to native `gentle-ai review recover` with exactly six inputs: predecessorLineage, expectedPredecessorRevision, successorLineage, disposition, actor, and reason. Never send RECOVER the reset challenge and never send it a maintainerAuthorization: Pi reads fresh native target status, pins the predecessor lineage, revision, provider-selected disposition, and target identity, derives the exact six-line native authorization binding, displays it for fresh UI approval, and re-reads status before mutating. Negotiated target status supplies the sole accepted recovery disposition, and a caller-supplied substitute is rejected. Treat a native-input-required envelope as a request for exact values, never as permission to invent them. After a committed native recovery record, INSPECT before any fresh ordinary START.",
			"A consent-required START may be resolved inside the eligible interactive Pi host. Its third UI action is host-owned: it runs this envelope's exact provider grant once and allows later fresh validated envelopes only for the same live SessionManager, nonempty session ID, and canonical Git common-directory identity, including sibling worktrees; an unrelated repository requires a new explicit human grant. Revoke removes the current repository grant, while nonreload replacement, quit, and process exit remove all session grants; reload preserves them. It grants no provider mode, verdict, acknowledgement, maintenance, delivery, or cross-repository authority. A package-owned child may ask its parent only with the canonical digest of its exact pending target; the parent binds that digest to the task repository and fails closed otherwise. If the tool returns an unresolved envelope, present the original two provider choices without changing machine tokens, commands, target IDs, or invocations; never add the host action to the decoded provider envelope. After one explicit relayed human answer, call answer-consent exactly once with only consentBinding and answer (`granted` or `declined`). Never create host permission from tool arguments, model prose, child/headless responses, or an uncertain native result. A reported lineage_created false or pre-authority validation error proves no lineage was created. After ambiguous START output, the controller calls target-scoped native status once and returns only its declared action. An ambiguous gentle_review_capture outcome independently reconciles once and never replays the capture.",
			"Use gentle_review only for native review authority operations; delivery commands follow ordinary repository policy.",
			'ASSESS (gentle-pi#662/#668) is read-only and needs no lineageId: after a delegated writer returns, call {"operation":"assess"} over its diff and follow the returned plan (writerSelfVerification, structuralReadbackOnly, independentVerifier, reason) instead of judging non-triviality from the task description. Pass input as JSON only to assess a committed range ({"baseRef":"<ref>","committedOnly":true}), to record the writer profile ({"writerModelId":"...", "writerEffort":"..."}), or to state the native review\'s outcome for this candidate ({"nativeReviewOutcome":"closed|declined|unavailable|unknown"}). Omitting writerModelId and writerEffort is treated as a small writer profile (fail closed), never large, because the writer\'s actual profile is then unknown to this call; pass the writer\'s real model id/effort to get credit for a known large profile. The on-path (writer self-verification is the record, no separate verifier) holds only when nativeReviewOutcome is "closed" for this candidate; a decline, an unavailable review, or an omitted/unknown outcome falls back to the exact risk-gated plan RDD off would return, re-enabling the separate verifier -- a decline is candidate-scoped and never lowers the bar below RDD off. "closed" is never inferred: pass it only right after this same caller acknowledged the approved review for this same candidate; omitting nativeReviewOutcome only ever auto-derives declined/unavailable, bound to that exact candidate\'s own target identity, never to a different candidate or to bare repository state. The result\'s outcome_source (explicit|derived|unknown) states which. A failed or unavailable native assessment reports risk "unassessable", verified exactly like "high". This never mutates review authority state.',
		],
		parameters: REVIEW_CONTROLLER_PARAMETERS,
		executionMode: "sequential",
		renderCall(args, theme, context) {
			return renderGentleAiLifecycleCall(
				reviewToolOperationPath(args),
				theme,
				context as GentleAiRenderContext | undefined,
			);
		},
		renderResult(result, options, theme, context) {
			return renderGentleAiResult(result, options, theme, context as GentleAiRenderContext | undefined);
		},
		async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Review controller operation was cancelled");
			await authorizeDestructiveReviewOperation(parameters, ctx);
			const sessionKey = pendingReviewConsentSessionKey(ctx, pendingReviewConsentFallbackKey);
			const retainedSelections = processRetainedNativeStatusSelections.get(sessionKey)
				?? processRetainedNativeStatusSelections.set(sessionKey, new Map()).get(sessionKey)!;
			// Snapshot before native awaits: a concurrent own write is a new generation.
			const acknowledgementEpoch = reminderEpoch;
			let acknowledgementRoot: string | undefined;
			let acknowledgementMutation: string | undefined;
			try {
				const parsed = parseReviewControllerParameters(parameters);
				if (parsed.operation === REVIEW_CONTROLLER_OPERATION.ACKNOWLEDGE_APPROVED) {
					acknowledgementRoot = resolveReviewControllerWorkspaceRoot(parsed.workspaceRoot, ctx.cwd, candidateViews, parsed.lineageId);
					acknowledgementMutation = pendingReviewMutation(ctx.sessionManager, acknowledgementRoot);
				}
			} catch { /* Controller validation owns invalid parameters and unavailable roots. */ }
			let details = await executeReviewControllerOperation(
				parameters,
				ctx.cwd,
				nativeReviewCli,
				signal,
				candidateViews,
				ctx,
				retainedSelections,
				pendingReviewConsentRegistry,
				pendingReviewConsentFallbackKey,
				reviewConsentNow,
				reviewConsentScheduleTimer,
			);
			if (details.operation === REVIEW_CONTROLLER_OPERATION.ACKNOWLEDGE_APPROVED &&
				details.outcome === "native-approved-acknowledgement-completed" &&
				details.status === "closed" && details.authority === "burned" &&
				typeof details.target_identity === "string") {
				try {
					if (reminderSessionActive && acknowledgementEpoch === reminderEpoch && acknowledgementRoot && pendingReviewConsentSessionKey(ctx, pendingReviewConsentFallbackKey) === sessionKey) {
						consumeReviewMutation(pi, ctx.sessionManager, acknowledgementRoot, acknowledgementMutation, "acknowledged", details.target_identity);
					}
				} catch { /* Bookkeeping cannot hide a confirmed native burn. */ }
			}
			if (
				isHostReviewConsentEligibleOperation(parameters) &&
				details.outcome === "native-review-consent-required" &&
				typeof details.consent_binding === "string"
			) {
				const resolved = pendingReviewConsentRegistry.resolve(details.consent_binding);
				const pending = resolved?.pending;
				const eligiblePending = pending !== undefined && isPiConsentV3(pending.consent)
					? pending
					: undefined;
				const answerPendingConsent = async (answer: "granted" | "declined") => executeReviewControllerOperation(
					{
						operation: REVIEW_CONTROLLER_OPERATION.ANSWER_CONSENT,
						input: JSON.stringify({ consentBinding: eligiblePending!.id, answer }),
						workspaceRoot: eligiblePending!.authorityCwd,
					},
					ctx.cwd,
					nativeReviewCli,
					signal,
					candidateViews,
					ctx,
					retainedSelections,
					pendingReviewConsentRegistry,
					pendingReviewConsentFallbackKey,
					reviewConsentNow,
					reviewConsentScheduleTimer,
				);
				let permissionWorkspaceRoot: string | undefined;
				try {
					const parsed = parseReviewControllerParameters(parameters);
					permissionWorkspaceRoot = resolveReviewControllerWorkspaceRoot(parsed.workspaceRoot, ctx.cwd, candidateViews, parsed.lineageId);
				} catch {
					// The successful native operation above remains authoritative; an
					// unresolvable local binding simply cannot consume host permission.
				}
				const initialIdentity = permissionWorkspaceRoot === undefined
					? undefined
					: await capturePermissionIdentity(ctx, permissionWorkspaceRoot);
				if (eligiblePending !== undefined && initialIdentity === undefined) {
					// A package child has no local standing grant. It may ask its
					// inherited parent only for the canonical repository identity of
					// this exact pending target, then replay this local binding once.
					const repositoryIdentity = permissionWorkspaceRoot === undefined
						? undefined
						: await resolveCanonicalGitRepositoryIdentity(permissionWorkspaceRoot);
					if (repositoryIdentity !== undefined && await childStandingReviewPermission?.requestAuthorization(repositoryIdentity) === true) details = await answerPendingConsent("granted");
				} else if (eligiblePending !== undefined && initialIdentity !== undefined) {
					const initialEpoch = reviewSessionPermissionEpoch(initialIdentity);
					const permissionAlreadyActive = hasReviewSessionPermission(initialIdentity);
					const selection = initialEpoch === undefined
						? undefined
						: permissionAlreadyActive
							? { kind: "host-session" as const }
							: await presentReviewConsentUi(ctx, eligiblePending.consent);
					if (selection !== undefined) {
						const confirmedIdentity = await capturePermissionIdentity(ctx, permissionWorkspaceRoot);
						if (initialEpoch !== undefined && confirmedIdentity !== undefined && sameReviewSessionIdentity(initialIdentity, confirmedIdentity) && reviewSessionPermissionEpoch(confirmedIdentity) === initialEpoch) {
							const answer = selection.kind === "provider" ? selection.answer : "granted";
							details = await answerPendingConsent(answer);
							if (!permissionAlreadyActive && selection.kind === "host-session" && completedGrantedReviewConsent(details)) {
								if (grantReviewSessionPermission(confirmedIdentity, initialEpoch)) {
									setReviewSessionPermissionStatus(ctx, true);
									try { ctx.ui.notify("Reviews are allowed for this Pi session and this Git repository.", "info"); } catch { /* Nonblocking indication only. */ }
								} else {
									try { ctx.ui.notify("This review started, but the in-memory session permission registry was incompatible, so later candidates will ask again.", "warning"); } catch { /* Best effort. */ }
								}
							}
						}
					}
				}
			}
			return {
				content: [{ type: "text", text: JSON.stringify(details) }],
				details,
			};
		},
	});

	function runSddPreflight(ctx: ExtensionContext, promptFields: readonly SddPreflightField[] = []): Promise<SddPreflightPreferences> {
		return ensureSddPreflight(ctx, { pi, installAssets: (cwd) => installPackageAssets(cwd, true, ["sdd"]), applyModelConfig: async () => applySavedModelConfig(ctx) }, { promptFields });
	}

	pi.on("session_start", async (event, ctx) => {
		reminderSessionActive = true;
		reminderEpoch += 1;
		try { candidateViews?.sweepOrphans(ctx.cwd); } catch { /* Ownership sweeping must not block startup. */ }
		const reason = (event as { reason?: unknown }).reason;
		if (reason !== "reload") revokeCurrentReviewSessionPermission(ctx);
		await refreshReviewSessionPermissionStatus(ctx);
		// Loud, every session: an active dev-binary override means this session
		// runs an unpinned gentle-ai. Announce which one before anything else.
		try {
			const devBinary = await describeDevBinaryOverride();
			if (ctx.hasUI && devBinary.state === "active") ctx.ui.notify(devBinary.line, "warning");
			if (ctx.hasUI && devBinary.state === "invalid") ctx.ui.notify(devBinary.line, "error");
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Gentle AI dev binary override check failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		try {
			const installResult = installPackageAssets(ctx.cwd, true, ["delegation", "review"]);
			migrateLegacyProjectModelOverrides(ctx.cwd);
			const modelResult = await applySavedModelConfig(ctx);
			if (ctx.hasUI && modelResult.invalidPath) {
				ctx.ui.notify(
					`el Gentleman skipped model config because ${modelResult.invalidPath} is invalid JSON or not an object. Fix or remove the file, then run /gentle:models again.`,
					"warning",
				);
				return;
			}
			if (ctx.hasUI && modelResult.updated > 0) {
				ctx.ui.notify(
					`el Gentleman applied saved model config to ${modelResult.updated} agent(s). Global delegation/review assets ready: ${installResult.agents} new agent(s), ${installResult.chains} new chain(s), ${installResult.support} new support file(s).`,
					"info",
				);
			}
		} catch (error) {
			if (ctx.hasUI) {
				const message =
					error instanceof Error ? error.message : String(error);
				ctx.ui.notify(
					`el Gentleman model config sweep failed: ${message}`,
					"warning",
				);
			}
		}
		// Keep the startup transport negotiation, but do not treat its target as
		// an ownership baseline: reload may have outstanding durable receipts.
		try {
			const sessionKey = pendingReviewConsentSessionKey(ctx, pendingReviewConsentFallbackKey);
			await resolveNegotiatedReviewStatusForSession(nativeReviewCli, ctx, sessionKey);
		} catch {
			// Startup negotiation is best-effort only; never surface or throw.
		}
	});

	pi.on("input", async (event, ctx) => {
		if (typeof event.text !== "string" || !isSddPreflightTrigger(event.text)) {
			return { action: "continue" };
		}
		// An RPC child consumes the parent-rendered preflight block transported in
		// its task context; it never originates preflight. Re-entering the
		// parent-only resolver here would reject, and consuming the rejection
		// would swallow the delegated prompt before the agent ever starts.
		if (ctx.mode === "rpc") return { action: "continue" };
		try { await runSddPreflight(ctx); }
		catch (error) {
			if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			return { action: "handled" };
		}
		return { action: "continue" };
	});

	let nativeSddStartupBlock: string | undefined;
	pi.on("before_agent_start", async (event, ctx) => {
		nativeSddStartupBlock = undefined;
		const retiredSync = readAgentStartNames(event).includes("sdd-sync") || /\bSDD sync executor\b/i.test(event.systemPrompt ?? "");
		const isSddAgent = retiredSync || isSddAgentStartEvent(event);
		const isNamedAgent = isNamedAgentStartEvent(event);
		const subagentDepthKey = pendingReviewConsentSessionKey(ctx, pendingReviewConsentFallbackKey);
		if (isSddAgent || isNamedAgent) {
			processAgentEndSubagentDepth.set(subagentDepthKey, (processAgentEndSubagentDepth.get(subagentDepthKey) ?? 0) + 1);
		} else {
			processAgentEndSubagentDepth.set(subagentDepthKey, 0);
		}
		// gentle-pi#677: nudge gentle-ai's own telemetry trigger for a primary
		// session only, reusing the exact isNamedAgent/isSddAgent predicate that
		// decides the orchestrator prompt below. At most one attempt per
		// process regardless of how many primary-session before_agent_start
		// events this process observes; a missing/old binary or a spawn error
		// must never affect activation, so every failure is swallowed silently.
		if (!isNamedAgent && !isSddAgent && !processTelemetryTriggerAttempted) {
			processTelemetryTriggerAttempted = true;
			try {
				const executable = resolveTelemetryTriggerBinary();
				spawnTelemetryTrigger({
					executable,
					cwd: ctx.cwd,
					env: dependencies.processEnv ?? process.env,
					spawn: dependencies.telemetryTriggerSpawn,
				});
			} catch {
				// Best-effort only; never surfaced and never affects activation.
			}
		}
		try {
			if (isSddAgent && !getSddPreflightPreferences(ctx) && ctx.mode !== "rpc") {
				await runSddPreflight(ctx);
			}
		} catch (error) {
			// Pi logs thrown before_agent_start errors and continues. Return an
			// unresolved gate instead of silently losing the preflight instructions.
			return { systemPrompt: `${event.systemPrompt}\n\nSDD preflight unresolved: ${error instanceof Error ? error.message : String(error)}\nSTOP: Do not initialize the project, launch phases, write artifacts, or infer consent. Request session preflight confirmation before continuing.` };
		}
		const prefs = getSddPreflightPreferences(ctx);
		// RPC children never resolve or persist defaults. The parent dispatch gate
		// transports the rendered block in the existing task context, and Gentle
		// Agents refuses a missing/malformed payload before spawning the child.
		const sddPrompt =
			prefs && (!isNamedAgent || isSddAgent)
				? `\n\n${renderSddPreflightPrompt(prefs)}`
				: "";
		const phase = isSddAgent ? sddPhaseFromAgentStartEvent(event) : undefined;
		const launchSddChange = readSddChangeFlag(pi);
		if (retiredSync) nativeSddStartupBlock = "Standalone sync is retired. Return to the parent for native archive selection; archive composes applicable specs.";
		else if (launchSddChange !== undefined && !phase) nativeSddStartupBlock = "Receiving agent has no recognized SDD phase";
		const nativeStatusPrompt = phase
			? await (async () => {
				try {
					if (launchSddChange === undefined) {
						const { status } = await readCommandSddStatus("", ctx);
						if (status.changeName === null) throw new Error(`Native SDD discovery cannot run ${phase}.`);
						assertNativeSddPhaseReady(status, phase);
						return `\n\n${renderNativeSddPhasePrompt(status, phase)}`;
					}
					const agentName = `sdd-${phase}`;
					const startup = await resolveSelectedNativeSddChangeStartup(
						launchSddChange,
						ctx.cwd,
						agentName,
						nativeReviewCli,
					);
					return `\n\n${renderNativeSddPhasePrompt(startup.status, phase)}`;
				} catch (error) {
					nativeSddStartupBlock = error instanceof Error ? error.message : String(error);
					return `\n\n## Native SDD Status Engine\nSDD selection blocked: ${nativeSddStartupBlock}\nDo not run phase work; return this blocker to the parent.`;
				}
			})()
			: nativeSddStartupBlock === undefined
				? ""
				: `\n\n## Native SDD Status Engine\nSDD selection blocked: ${nativeSddStartupBlock}\nDo not run phase work; return this blocker to the parent.`;
		// gentle-pi#661: the RDD status line (and the rest of the gentle prompt)
		// is built only for the primary session, mirrored on the
		// reviewContractPrompt condition below -- named/SDD agents never reach
		// this branch, so no line is resolved or computed for them.
		// resolveRddStatusLine never throws and never hangs past
		// RDD_STATUS_TIMEOUT_MS: an absent/timed-out/aborted/failing native
		// binary renders the fail-closed "unknown" line instead.
		const gentlePrompt = isNamedAgent || isSddAgent
			? ""
			: `\n\n${buildGentlePrompt(
					readPersonaMode(ctx.cwd),
					ctx.cwd,
					readActiveToolNames(pi),
					await resolveRddStatusLine(nativeReviewCli, ctx.cwd, AbortSignal.timeout(RDD_STATUS_TIMEOUT_MS), undefined, ctx),
				)}`;
		// gentle-pi#560 / gentle-ai#4056, #4057: inject the mirrored provider
		// contract bundle's review execution contract for the primary session
		// only, and only when a native review CLI is actually present.
		const reviewContractPrompt =
			!isNamedAgent && !isSddAgent && nativeReviewCli !== null
				? (() => {
					const fragment = loadReviewContractPromptFragment(ctx);
					return fragment === null ? "" : `\n\n${fragment}`;
				})()
				: "";
		return {
			systemPrompt: `${event.systemPrompt}${gentlePrompt}${sddPrompt}${nativeStatusPrompt}${reviewContractPrompt}${!isNamedAgent && !isSddAgent ? `\n\n${renderResearchCapabilities(resolveResearchCapabilities(pi))}` : ""}`,
		};
	});

	// gentle-pi#556 / gentle-ai#4051: with RDD enabled, the agent could finish
	// an authorized implementation and report completion without ever running
	// the review STATUS preflight or offering the consent question. This
	// handler is read-only and idempotent: it never runs START, never answers
	// consent, or chooses a partial candidate. Durable own-mutation receipts
	// gate STATUS and consume only the generation captured before that await.
	pi.on("agent_end", async (_event, ctx) => {
		if (nativeReviewCli?.reviewMode === undefined || nativeReviewCli.targetStatus === undefined) return;
		if (ctx.hasUI !== true || !reminderSessionActive) return;
		const sessionKey = pendingReviewConsentSessionKey(ctx, pendingReviewConsentFallbackKey);
		const subagentDepth = processAgentEndSubagentDepth.get(sessionKey) ?? 0;
		if (subagentDepth > 0) {
			processAgentEndSubagentDepth.set(sessionKey, subagentDepth - 1);
			return;
		}
		const root = resolveSessionWorktree(ctx.cwd, ctx.cwd)?.root;
		if (!root) return;
		let mutation: string | undefined;
		try { mutation = pendingReviewMutation(ctx.sessionManager, root); }
		catch { return; }
		if (!mutation) return;
		const epoch = reminderEpoch;
		const status = await resolveNegotiatedReviewStatusForSession(nativeReviewCli, ctx, sessionKey);
		if (status === undefined || !reminderSessionActive || epoch !== reminderEpoch || pendingReviewConsentSessionKey(ctx, pendingReviewConsentFallbackKey) !== sessionKey) return;
		// Another concurrent end or ACK may already have consumed this prefix.
		if (!pendingReviewMutation(ctx.sessionManager, root, mutation)) return;
		if (status.nextTransition?.kind !== "execute" || status.nextTransition.execute.operation !== "review.start") return;
		const targetIdentity = status.targetIdentity;
		pi.sendMessage(
			{
				customType: "gentle-pi.review-preflight",
				content: renderAgentEndReviewPreflightMessage(targetIdentity),
				display: true,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		consumeReviewMutation(pi, ctx.sessionManager, root, mutation, "nudged", targetIdentity);
	});

	pi.on("tool_result", (event, ctx) => {
		if (!reminderSessionActive || event.isError !== false || (event.toolName !== "write" && event.toolName !== "edit")) return;
		if (!isRecord(event.input) || typeof event.input.path !== "string" || !event.input.path.trim()) return;
		try {
			const root = resolveSessionWorktree(event.input.path, ctx.cwd)?.root;
			if (root) recordReviewMutation(pi, ctx.sessionManager, root, { source: "direct", toolName: event.toolName, toolCallId: event.toolCallId });
		} catch { /* Receipt persistence must not change a successful tool result. */ }
	});

	pi.on("tool_call", async (event, ctx) => {
		if (nativeSddStartupBlock && event.toolName !== "subagent_parent_message") return { block: true, reason: `SDD selection blocked: ${nativeSddStartupBlock}` };
		const sensitivePathDenied = evaluateSensitivePathTool(
			event.toolName,
			event.input,
		);
		if (sensitivePathDenied) return sensitivePathDenied;
		if (event.toolName === "subagent_run") {
			const sddAgent = sddDispatchAgentName(event.input);
			if (sddAgent === "invalid") {
				return { block: true, reason: "SDD dispatch requires exactly one shipped SDD agent name." };
			}
			if (sddAgent !== undefined) {
				// An RPC child is a delegated actor, never an authority originator. It
				// must receive the already-confirmed block from its interactive parent.
				if (ctx.mode === "rpc") {
					return { block: true, reason: "SDD dispatch refused: an RPC child cannot originate or persist SDD preflight defaults." };
				}
				try {
					const prefs = getSddPreflightPreferences(ctx) ?? await runSddPreflight(ctx);
					const rendered = renderSddPreflightPrompt(prefs);
					if (!prefs.prompted && ctx.hasUI) {
						return { block: true, reason: "SDD dispatch refused: interactive parent preflight lacks current-session confirmation." };
					}
					if (!isRecord(event.input)) {
						return { block: true, reason: "SDD dispatch refused: child input is malformed." };
					}
					if (event.input.context !== undefined && typeof event.input.context !== "string") {
						return { block: true, reason: "SDD dispatch refused: child context must be text." };
					}
					// The existing context payload is the sole parent-to-child transport.
					// Refuse a caller-authored lookalike so the child receives one exact,
					// parent-rendered authority block rather than an ambiguous mixture.
					const context = typeof event.input.context === "string" ? event.input.context.trim() : "";
					if (/^## SDD Session Preflight[ \t]*$/m.test(context)) {
						return { block: true, reason: "SDD dispatch refused: child context already contains an untrusted preflight block." };
					}
					event.input.context = context.length === 0
						? rendered
						: `${rendered}\n\n${context}`;
					if (!isParentConfirmedSddPreflightContext(event.input.context)) {
						return { block: true, reason: "SDD dispatch refused: rendered preflight transport is malformed." };
					}
				} catch (error) {
					return {
						block: true,
						reason: `SDD dispatch refused before child launch: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
			}
			const judgmentDayFixDenied = rejectInvalidJudgmentDayFixDispatch(event.input);
			if (judgmentDayFixDenied) return judgmentDayFixDenied;
			const writerScopeDenied = rejectUnscopedBoundedWriterDispatch(event.input);
			if (writerScopeDenied) return writerScopeDenied;
			try {
				injectReviewCandidateView(event.input, candidateViews);
				return undefined;
			} catch (error) {
				return {
					block: true,
					reason: error instanceof Error ? error.message : "review subagent dispatch is invalid",
				};
			}
		}
		if (event.toolName !== "bash") return undefined;
		if (!isRecord(event.input) || typeof event.input.command !== "string") {
			return undefined;
		}
		return await confirmCommand(event.input.command, ctx, pi.events, herdrLifecycle);
	});

	for (const owner of ["delegation", "review", "sdd"] as const) {
		const label = owner === "sdd" ? "SDD" : owner;
		pi.registerCommand(`gentle:install-${owner}`, {
			description: `Repair or refresh only global Gentle AI ${label} assets.`,
			handler: async (args, ctx) => {
				const force = args.includes("--force");
				const result = installPackageAssets(ctx.cwd, force, [owner]);
				ctx.ui.notify(
					`Global Gentle AI ${label} assets installed: ${result.agents} agent(s), ${result.chains} chain(s), ${result.support} support file(s), ${result.skipped} already present.`,
					"info",
				);
			},
		});
	}

	pi.registerCommand("gentle:sdd-preflight", {
		description:
			"Run or reuse session SDD preflight; use --edit to change preferences.",
		handler: async (args, ctx) => {
			if (args.trim() !== "" && args.trim() !== "--edit") {
				ctx.ui.notify("Usage: /gentle:sdd-preflight [--edit]", "warning");
				return;
			}
			try {
				await runSddPreflight(ctx, args.trim() === "--edit" ? SDD_PREFLIGHT_FIELDS : []);
			} catch (error) {
				ctx.ui?.notify(error instanceof Error ? error.message : String(error), "warning");
			}
		},
	});

	const readCommandSddStatus = async (args: string, ctx: ExtensionContext) => {
		const parsed = parseSddStatusCommandArgs(args);
		const request = { changeName: parsed.changeName, workspaceRoot: realpathSync(ctx.cwd) };
		if (!nativeReviewCli?.sddStatus) throw new Error("Native SDD status capability unavailable; no local fallback.");
		const status = decodeNativeSddStatusV2(await nativeReviewCli.sddStatus(request), request);
		return { parsed, request, status };
	};
	const showCommandSddStatus = (status: NativeSddStatusV2, json: boolean, ctx: ExtensionContext) => {
		ctx.ui?.notify(json ? JSON.stringify(status, null, 2) : renderNativeSddPhasePrompt(status), "info");
	};
	const handleSddStatusCommand = async (args: string, ctx: ExtensionContext) => {
		const { parsed, status } = await readCommandSddStatus(args, ctx);
		showCommandSddStatus(status, parsed.json, ctx);
	};

	pi.registerCommand("gentle-sdd-status", {
		description: "Show deterministic SDD change status and instructions.",
		handler: async (args, ctx) => {
			await handleSddStatusCommand(args, ctx);
		},
	});

	const handleSddContinueCommand = async (args: string, ctx: ExtensionContext) => {
		const { parsed, request, status } = await readCommandSddStatus(args, ctx);
		const planning = status.planningHome;
		const changeRoot = status.changeRoot;
		// Native context is an upper bound, never the human's per-call grant.
		if (status.changeName === null || !ctx.hasUI || typeof ctx.ui?.confirm !== "function" || !nativeReviewCli?.sddContinue) {
			showCommandSddStatus(status, parsed.json, ctx);
			return;
		}
		if (typeof planning !== "object" || planning === null || !("path" in planning) || typeof planning.path !== "string" || typeof changeRoot !== "string") throw new Error("Native SDD continuation lacks an exact planning path.");
		if (!["openspec", "both"].includes(String(status.artifactStore)) || !["repo-local", "workspace-planning"].includes(String(status.actionContext.mode))) throw new Error("Native SDD continuation has unsupported planning context.");
		const marker = join(changeRoot, ".gentle-ai-instance");
		const checkMarker = () => {
			try {
				if (!lstatSync(marker).isFile() || realpathSync(marker) !== marker) throw new Error("Native SDD marker is not a canonical regular file.");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		};
		checkMarker();
		if (realpathSync(changeRoot) !== changeRoot || realpathSync(planning.path) !== planning.path || changeRoot !== join(planning.path, "changes", status.changeName) || !isStrictDescendantPath(request.workspaceRoot, marker)) throw new Error("Native SDD continuation workspace or planning path mismatch.");
		if (await ctx.ui.confirm("Prepare SDD marker?", `Authorize only continuation-time preparation of ${marker}? This grants no source roots and no persistent authority.`) !== true) {
			showCommandSddStatus(status, parsed.json, ctx);
			return;
		}
		if (realpathSync(ctx.cwd) !== request.workspaceRoot || realpathSync(changeRoot) !== changeRoot) throw new Error("Native SDD continuation workspace changed during confirmation.");
		checkMarker();
		const selected = { ...request, changeName: status.changeName };
		showCommandSddStatus(decodeNativeSddStatusV2(await nativeReviewCli.sddContinue(selected), selected), parsed.json, ctx);
	};

	pi.registerCommand("gentle-sdd-continue", {
		description: "Resolve SDD status and route the next phase deterministically.",
		handler: async (args, ctx) => {
			await handleSddContinueCommand(args, ctx);
		},
	});

	pi.registerCommand("gentle:models", {
		description: "Configure global per-agent models for el Gentleman.",
		handler: async (_args, ctx) => {
			await handleModelsCommand(ctx);
		},
	});

	pi.registerCommand("gentle:profiles", {
		description: "Create, switch, and manage global agent-model profiles for el Gentleman.",
		handler: async (_args, ctx) => {
			await handleProfilesCommand(ctx);
		},
	});

	pi.registerCommand("gentle:persona", {
		description: "Switch el Gentleman persona between gentleman and neutral.",
		handler: async (_args, ctx) => {
			await handlePersonaCommand(ctx);
		},
	});

	// Dev-binary override surfacing (unpinned field-test mode). While the
	// override is active every diagnostic surface names the exact binary, its
	// live version, and its fresh content digest, so the maintainer always
	// knows which gentle-ai actually answered. An invalid override surfaces as
	// a failure — it is never silently ignored, because the native resolver
	// refuses to fall back to the pin while an override is declared.
	const describeDevBinaryOverride = async (): Promise<
		| { state: "inactive" }
		| { state: "active"; line: string; override: GentleAiDevBinaryOverride }
		| { state: "invalid"; line: string }
	> => {
		let override: GentleAiDevBinaryOverride | undefined;
		try {
			override = resolveGentleAiDevBinaryOverride();
		} catch (error) {
			if (error instanceof GentleAiDevBinaryOverrideError) return { state: "invalid", line: `Gentle AI dev binary override invalid — ${error.message}` };
			throw error;
		}
		if (override === undefined) return { state: "inactive" };
		let version = "version unavailable";
		try {
			const adapter = createNodeExecFileAdapter();
			const result = await adapter({ file: override.path, arguments: ["version"], cwd: dirname(override.path), timeoutMs: 10_000, maxBufferBytes: 1024 * 1024 });
			const banner = result.stdout.trim();
			if (result.exitCode === 0 && banner.startsWith("gentle-ai ")) version = banner.slice("gentle-ai ".length);
		} catch {
			// The doctor line still names the binary; the version stays unavailable.
		}
		return {
			state: "active",
			override,
			line: `Gentle AI dev binary override active (unpinned, field-test only): ${override.path} ${version} sha256:${override.sha256.slice(0, 16)}`,
		};
	};

	pi.registerCommand("gentle:dev-binary", {
		description: "Register, inspect, or clear the persistent Gentle AI dev-binary override (status | <absolute path> | off). Unpinned, field-test only.",
		handler: async (args, ctx) => {
			const argument = args.trim();
			try {
				if (argument === "off") {
					const removed = unregisterGentleAiDevBinary();
					ctx.ui.notify(removed ? "Gentle AI dev binary registration removed; the pinned binary is active again." : "No dev binary registration to remove.", "info");
					return;
				}
				if (argument === "" || argument === "status") {
					const described = await describeDevBinaryOverride();
					if (described.state === "inactive") ctx.ui.notify("No dev binary override; the pinned Gentle AI binary is active.", "info");
					else ctx.ui.notify(described.line, described.state === "active" ? "warning" : "error");
					return;
				}
				registerGentleAiDevBinary(argument);
				const described = await describeDevBinaryOverride();
				ctx.ui.notify(described.state === "inactive" ? "Dev binary registration written." : described.line, "warning");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("gentle:doctor", {
		description: "Run read-only Gentle AI diagnostics for this Pi workspace.",
		handler: async (_args, ctx) => {
			const assetLines = packageAssetDiagnosticLines(ctx.cwd);
			const openspecConfigured = existsSync(
				join(ctx.cwd, "openspec", "config.yaml"),
			);
			const skillRegistryPresent = existsSync(
				join(ctx.cwd, ".atl", "skill-registry.md"),
			);
			const modelConfig = await readSavedModelConfigAsync(ctx.cwd);
			const engramActive = hasWritableEngramTool(pi);
			const devBinary = await describeDevBinaryOverride();
			const lines = [
				"el Gentleman doctor",
				...assetLines,
				`${openspecConfigured ? "pass" : "warn"}: OpenSpec config ${openspecConfigured ? "present" : "missing"}`,
				`${skillRegistryPresent ? "pass" : "warn"}: Skill registry ${skillRegistryPresent ? "present" : "missing"}`,
				`${modelConfig.status === "invalid" ? "fail" : "pass"}: Global model config ${modelConfig.status}`,
				"pass: Sensitive-path guard active for read/write/edit tools",
				`${engramActive ? "pass" : "warn"}: Engram memory tools ${engramActive ? "active" : "not active in this session"}`,
				...(devBinary.state === "active" ? [`warn: ${devBinary.line}`] : []),
				...(devBinary.state === "invalid" ? [`fail: ${devBinary.line}`, "remedy: fix the dev binary override or clear it with /gentle:dev-binary off (or unset GENTLE_PI_GENTLE_AI_DEV_BINARY)"] : []),
			];
			if (modelConfig.status === "invalid") {
				lines.push(`remedy: fix or remove ${modelConfig.path}`);
			}
			ctx.ui.notify(
				lines.join("\n"),
				lines.some((line) => line.startsWith("fail:")) || assetLines.some((line) => line.startsWith("warn:")) ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("gentle:review-session-permission", {
		description: "Show or revoke the process-memory review permission for this exact Pi session and Git repository (status|revoke).",
		handler: async (args, ctx) => {
			const subAction = args.trim().length === 0 ? "status" : args.trim();
			if (subAction !== "status" && subAction !== "revoke") {
				ctx.ui.notify(`Unknown /gentle:review-session-permission sub-action "${subAction}". Use status or revoke.`, "warning");
				return;
			}
			if (subAction === "revoke") {
				const revoked = await revokeCurrentRepositoryReviewSessionPermission(ctx);
				ctx.ui.notify(revoked ? "Review permission revoked for this Git repository in this Pi session. Provider review mode and authority were not changed." : "No review permission is active for this Git repository in this Pi session. Provider review mode and authority were not changed.", "info");
				return;
			}
			const identity = await refreshReviewSessionPermissionStatus(ctx);
			if (identity === undefined) {
				ctx.ui.notify("Review session permission is unavailable: it requires the interactive Pi TUI, a non-child session, a nonempty session ID, and a canonical Git worktree.", "info");
				return;
			}
			ctx.ui.notify(hasReviewSessionPermission(identity)
				? "Reviews are allowed for this Pi session and Git repository. Use /gentle:review-session-permission revoke to ask again."
				: "Reviews are not pre-authorized for this Pi session; each medium- or high-risk candidate asks normally.", "info");
		},
	});

	pi.registerCommand("gentle:review-mode", {
		description: "Show or set the Gentle AI receipt-driven development kill switch (status|enable|disable). Every sub-action is user-initiated only; Pi automation never toggles it.",
		handler: async (args, ctx) => {
			const subAction = args.trim().length === 0 ? NATIVE_REVIEW_MODE_OPERATION.STATUS : args.trim();
			if (subAction !== NATIVE_REVIEW_MODE_OPERATION.STATUS && subAction !== NATIVE_REVIEW_MODE_OPERATION.ENABLE && subAction !== NATIVE_REVIEW_MODE_OPERATION.DISABLE) {
				ctx.ui.notify(`Unknown /gentle:review-mode sub-action "${subAction}". Use status, disable, or enable.`, "warning");
				return;
			}
			if (nativeReviewCli?.reviewMode === undefined) {
				ctx.ui.notify("Gentle AI review mode is not available with the currently negotiated native version.", "info");
				return;
			}
			try {
				const result = await nativeReviewCli.reviewMode({ cwd: ctx.cwd, operation: subAction as NativeReviewModeOperation });
				if (subAction === NATIVE_REVIEW_MODE_OPERATION.DISABLE && result.status.effective === "off") {
					cleanupAllPendingReviewConsents(
						pendingReviewConsentRegistry,
						pendingReviewConsentSessionKey(ctx, pendingReviewConsentFallbackKey),
					);
				}
				const report = `receipt-driven development: ${result.status.effective} (decided by ${result.status.source})`;
				// A mutating sub-action that left the effective mode unchanged did
				// not do what the user asked, and reporting only the resulting
				// status reads as if it had. This is reachable for exactly one
				// shape: `enable` against a global off. Pi always passes
				// `--scope clone` (Design Decision #7), which only clears a
				// clone-local override and cannot enable global RDD. The native call
				// exits 0, reports operation "enable", and changes nothing. Say
				// that, and name the global-scope command that resolves it.
				const requested = subAction === NATIVE_REVIEW_MODE_OPERATION.ENABLE ? "on" : subAction === NATIVE_REVIEW_MODE_OPERATION.DISABLE ? "off" : result.status.effective;
				if (result.status.effective !== requested) {
					ctx.ui.notify(`${report}\nThat did not turn reviews back on: /gentle:review-mode enable only clears a clone-local override, which cannot override a global off. Run \`gentle-ai review mode enable --scope=global\` to turn them back on.`, "warning");
					return;
				}
				ctx.ui.notify(report, "info");
			} catch (error) {
				if (asNativeReviewCliError(error)?.code === NATIVE_REVIEW_ERROR_CODE.VERSION_INCOMPATIBLE) {
					ctx.ui.notify("Gentle AI review mode is not available with the currently negotiated native version.", "info");
					return;
				}
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	// gentle-pi#677: gentle-ai owns telemetry end to end (status, the opt-out
	// switches, and rate limiting); this command only runs the corresponding
	// `gentle-ai telemetry <op> --json` in the foreground and relays its
	// output, so a Pi user never has to leave Pi to check or change it.
	pi.registerCommand("gentle:telemetry", {
		description: "Show or change the local Gentle AI telemetry trigger (status|enable|disable|preview); gentle-ai owns the data and the opt-out.",
		handler: async (args, ctx) => {
			const subAction = args.trim().length === 0 ? "status" : args.trim();
			if (subAction !== "status" && subAction !== "enable" && subAction !== "disable" && subAction !== "preview") {
				ctx.ui.notify(`Unknown /gentle:telemetry sub-action "${subAction}". Use status, enable, disable, or preview.`, "warning");
				return;
			}
			let executable: string;
			try {
				executable = resolveTelemetryTriggerBinary();
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			let result: ExecFileResult;
			try {
				result = await telemetryExecFileAdapter({
					file: executable,
					arguments: ["telemetry", subAction, "--json"],
					cwd: ctx.cwd,
					timeoutMs: 5_000,
					maxBufferBytes: 1024 * 1024,
				});
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			if (result.exitCode !== 0) {
				ctx.ui.notify(`gentle-ai telemetry ${subAction} failed (exit ${result.exitCode}): ${(result.stderr || result.stdout || "no output").trim()}`, "error");
				return;
			}
			let relayed: string;
			try {
				relayed = JSON.stringify(JSON.parse(result.stdout), null, 2);
			} catch {
				relayed = result.stdout.trim();
			}
			if (subAction === "disable") {
				ctx.ui.notify("Gentle AI telemetry disabled.", "info");
				return;
			}
			ctx.ui.notify(relayed, "info");
		},
	});

	// Mirrors gentle:review-mode: a user-owned switch, never an automated one.
	// It matters more here than there, because this policy governs whether
	// background subagents may be launched at all, so nothing in Pi may write
	// it. The only writer is this handler, reached only by explicit invocation.
	pi.registerCommand("gentle:background-subagents", {
		description: "Show or set the managed background-subagents policy (status|enable|disable). Every sub-action is user-initiated only; Pi automation never toggles it.",
		handler: async (args, ctx) => {
			const subAction = args.trim().length === 0 ? "status" : args.trim();
			if (subAction !== "status" && subAction !== "enable" && subAction !== "disable") {
				ctx.ui.notify(`Unknown /gentle:background-subagents sub-action "${subAction}". Use status, enable, or disable.`, "warning");
				return;
			}
			try {
				const wrote: BackgroundSubagentsPolicy | undefined = subAction === "enable" ? "on" : subAction === "disable" ? "off" : undefined;
				if (wrote !== undefined) writeGlobalBackgroundSubagentsPolicy(wrote);
				const resolution = resolveBackgroundSubagentsPolicy(ctx.cwd);
				const capability = resolveBackgroundSubagentsCapability(ctx.cwd, readActiveToolNames(pi));
				const report = renderBackgroundSubagentsReport(resolution, capability, wrote);
				ctx.ui.notify(report.message, report.type);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("gentle:status", {
		description: "Show Gentle AI package status for this project.",
		handler: async (_args, ctx) => {
			const assetLines = packageAssetDiagnosticLines(ctx.cwd);
			const openspecConfigured = existsSync(
				join(ctx.cwd, "openspec", "config.yaml"),
			);
			const savedConfig = await readModelRoutingAuthorityAsync(
				modelConfigPath(ctx.cwd),
				legacyProjectModelConfigPath(ctx.cwd),
			);
			const devBinary = await describeDevBinaryOverride();
			ctx.ui.notify(
				[
					"el Gentleman package is active.",
					...(devBinary.state === "inactive" ? [] : [devBinary.line]),
					`Persona: ${readPersonaMode(ctx.cwd)}`,
					...assetLines,
					`OpenSpec config: ${openspecConfigured ? "present" : "missing"}`,
					`Global model config: ${existsSync(modelConfigPath(ctx.cwd)) ? "present" : "missing"}`,
					`Saved model routing: ${savedConfig.status}${savedConfig.status === "invalid" ? ` (${savedConfig.path})` : ""}`,
					...(savedConfig.status === "invalid" ? [] : describeModelConfig(ctx.cwd, savedConfig.status === "valid" ? savedConfig.config : {})),
				].join("\n"),
				savedConfig.status === "invalid" || assetLines.some((line) => line.startsWith("warn:")) || devBinary.state !== "inactive" ? "warning" : "info",
			);
		},
	});
	};
}

export default function gentleAi(pi: ExtensionAPI): void {
	return createGentleAiExtension()(pi);
}
