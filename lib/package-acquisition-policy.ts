// Recognizes model-initiated npm/pnpm package acquisitions and judges their
// specs (gentle-pi#405 S2). Like the destructive-command guard this is lexical,
// not a shell interpreter or a sandbox: anything it cannot determine asks.
import { headCursor, tokenize, type Token } from "./destructive-command-guard.ts";

type Manager = "npm" | "pnpm";
export interface PackageAcquisition {
	manager: Manager;
	form: "install" | "exec" | "dlx";
	global: boolean;
	specs: string[];
	/** Words whose meaning could not be determined (unknown option value). */
	undetermined: string[];
	triggerIndex: number;
}
export interface PackageAcquisitionVerdict {
	action: "pass" | "confirm";
	/** Specs or words that forced the confirmation, in command order. */
	offending: string[];
	triggerIndex: number;
}

const SEMVER_NUMBER = String.raw`(?:0|[1-9]\d*)`;
const PRERELEASE_OR_BUILD = String.raw`[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*`;
// `name@X.Y.Z` or `@scope/name@X.Y.Z`: an exact registry version, nothing else.
const EXACT_SPEC_RE = new RegExp(String.raw`^(?:@[a-z0-9][\w.-]*/)?[a-z0-9][\w.-]*@${SEMVER_NUMBER}\.${SEMVER_NUMBER}\.${SEMVER_NUMBER}(?:-${PRERELEASE_OR_BUILD})?(?:\+${PRERELEASE_OR_BUILD})?$`);

const FORMS: Record<Manager, Record<string, PackageAcquisition["form"]>> = {
	npm: {
		...Object.fromEntries(
			["install", "i", "add", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "it", "install-test"].map(
				(alias) => [alias, "install" as const],
			),
		),
		exec: "exec",
		x: "exec",
	},
	pnpm: { add: "install", install: "install", i: "install", dlx: "dlx" },
};
const BOOLEAN_OPTIONS = new Set([
	"-g", "--global", "-D", "--save-dev", "-S", "--save", "-O", "--save-optional", "-E", "--save-exact", "-P", "--save-prod",
	"--no-save", "--no-audit", "--no-fund", "--no-optional", "--no-progress", "--legacy-peer-deps", "--force", "-f",
	"--ignore-scripts", "--prefer-offline", "--offline", "--silent", "-s", "--quiet", "-q", "--verbose", "-y", "--yes",
	"--dry-run", "--workspaces", "-r", "--recursive", "--prod", "--production", "--frozen-lockfile", "--ignore-workspace",
]);
// pnpm's `-w` is `--workspace-root` and takes no value; npm's `-w` is `--workspace <name>`.
const MANAGER_BOOLEAN_OPTIONS: Record<Manager, ReadonlySet<string>> = {
	npm: new Set(),
	pnpm: new Set(["-w", "--workspace-root"]),
};
const VALUE_OPTIONS: Record<Manager, ReadonlySet<string>> = {
	npm: new Set(["--prefix", "--registry", "-w", "--workspace", "--cache", "--tag", "--loglevel", "--userconfig", "--otp", "--omit", "--include", "--install-strategy"]),
	pnpm: new Set(["--filter", "-F", "--dir", "-C", "--registry", "--reporter", "--loglevel", "--store-dir", "--virtual-store-dir"]),
};
// `npm exec`/`npx`/`pnpm dlx`: these options name the packages to fetch. Elsewhere `-p` is
// npm's boolean `--parseable`, so it must not swallow an install spec.
const PACKAGE_OPTIONS = new Set(["-p", "--package"]);

function subcommandAhead(manager: Manager, args: readonly Token[], from: number): boolean {
	for (let index = from; index < args.length && !args[index].operator; index++) {
		if (FORMS[manager][args[index].value] !== undefined) return true;
	}
	return false;
}

function parseSegment(manager: Manager, form: PackageAcquisition["form"] | undefined, args: readonly Token[]): Omit<PackageAcquisition, "triggerIndex"> | undefined {
	const specs: string[] = [];
	const packages: string[] = [];
	const undetermined: string[] = [];
	let global = false;
	let optionsEnded = false;
	let target: string | undefined;
	let unknownBeforeForm: string | undefined;
	// `--package` before the subcommand counts once the subcommand turns out to be exec/dlx.
	const packagesBeforeForm: Array<{ option: string; named: string; glued: boolean }> = [];
	const isBoolean = (name: string) => BOOLEAN_OPTIONS.has(name) || MANAGER_BOOLEAN_OPTIONS[manager].has(name);
	// npx hands every word after the command to it; plain `npm exec` keeps parsing its own options until `--`.
	const npxForm = form !== undefined;
	for (let index = 0; index < args.length; index++) {
		const { value } = args[index];
		if (target !== undefined) {
			// Past the command of a plain `npm exec`, only `--package` still names what npm fetches;
			// there `-p` is the boolean `--parseable`.
			if (value === "--") break;
			const equals = value.startsWith("--") ? value.indexOf("=") : -1;
			const name = equals < 0 ? value : value.slice(0, equals);
			if (name === "--package") {
				const named = equals >= 0 ? value.slice(equals + 1) : args[++index]?.value;
				if (named === undefined) undetermined.push(name);
				else packages.push(named);
			}
			continue;
		}
		if (!optionsEnded && value === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && value.startsWith("-") && value.length > 1) {
			// npx strips every leading dash and rewrites a `p` key, keeping any attached value, to
			// `--package`: `-p=<spec>`, `--p <spec>` and `--p=<spec>` all name a fetched package.
			const npxPackage = npxForm && /^-+p(=|$)/.test(value);
			const equals = value.startsWith("--") || npxPackage ? value.indexOf("=") : -1;
			const name = npxPackage ? "--package" : equals < 0 ? value : value.slice(0, equals);
			if (/^-[A-Za-z]*g[A-Za-z]*$/.test(value) || name === "--global") global = true;
			if (PACKAGE_OPTIONS.has(name) && (form === "exec" || form === "dlx")) {
				const named = equals >= 0 ? value.slice(equals + 1) : args[++index]?.value;
				if (named === undefined) undetermined.push(name);
				else packages.push(named);
			} else if (PACKAGE_OPTIONS.has(name) && form === undefined && (equals >= 0 || (FORMS[manager][args[index + 1]?.value ?? ""] === undefined && !(args[index + 1]?.value ?? "").startsWith("-")))) {
				// Followed by a subcommand or another option, a bare `-p`/`--package` is npm's boolean
				// `--parseable` or valueless: it never takes that option, so a later `--package` still counts.
				const named = equals >= 0 ? value.slice(equals + 1) : args[++index]?.value;
				if (named !== undefined) packagesBeforeForm.push({ option: name, named, glued: equals >= 0 });
			} else if (VALUE_OPTIONS[manager].has(name)) {
				if (equals < 0) index++;
			} else if (form === undefined) {
				// Before the subcommand an unknown option must not swallow it; a value it
				// does take is caught below when the word after that value is a subcommand.
				if (!isBoolean(name) && equals < 0) unknownBeforeForm = value;
			} else if (!isBoolean(name) && !PACKAGE_OPTIONS.has(name) && equals < 0 && !/^-[gDSOEPfsqyr]{2,}$/.test(value)) {
				// An unknown option may take the next word as its value.
				const next = args[index + 1];
				if (next !== undefined && !next.operator && !next.value.startsWith("-")) undetermined.push(`${value} ${args[++index].value}`);
			}
			continue;
		}
		if (form === undefined) {
			form = FORMS[manager][value];
			// After an unknown option, any word ahead of a later subcommand may be one of
			// its values: keep looking for the subcommand and record the word as undetermined.
			if (form === undefined && unknownBeforeForm !== undefined && subcommandAhead(manager, args, index + 1)) {
				undetermined.push(`${unknownBeforeForm} ${value}`);
				continue;
			}
			if (form === undefined) return undefined;
		} else if (form === "install") specs.push(value);
		else {
			// The first operand of exec/dlx is the package or command; the rest belongs to it,
			// except the options a plain `npm exec` still reads before any `--`.
			target = value;
			if (npxForm || manager !== "npm" || form !== "exec" || optionsEnded) break;
		}
	}
	if (form === undefined) return undefined;
	if (form === "exec" || form === "dlx") packages.unshift(...packagesBeforeForm.map((item) => item.named));
	// Elsewhere the option is no package option, and a word it took may be what the shell meant.
	else for (const item of packagesBeforeForm) if (!item.glued) undetermined.push(`${item.option} ${item.named}`);
	if (form !== "install") specs.push(...(packages.length > 0 ? packages : target === undefined ? [] : [target]));
	return { manager, form, global, specs, undetermined };
}

/** Every npm/pnpm acquisition (specs present or undeterminable) in the command; lockfile installs are not included. */
export function recognizePackageAcquisitions(command: string): PackageAcquisition[] {
	const tokens = tokenize(command);
	const found: PackageAcquisition[] = [];
	let start = 0;
	for (let end = 0; end <= tokens.length; end++) {
		if (end < tokens.length && !tokens[end].operator) continue;
		const segment = tokens.slice(start, end);
		start = end + 1;
		const cursor = headCursor(segment);
		const head = segment[cursor];
		if (head === undefined) continue;
		const name = head.value.split("/").at(-1) ?? head.value;
		const args = segment.slice(cursor + 1);
		const manager = name === "npx" ? "npm" : name === "npm" || name === "pnpm" ? name : undefined;
		const parsed = manager === undefined ? undefined : parseSegment(manager, name === "npx" ? "exec" : undefined, args);
		if (parsed !== undefined && (parsed.specs.length > 0 || parsed.undetermined.length > 0)) found.push({ ...parsed, triggerIndex: head.index });
	}
	return found;
}

/** pass: every spec is an exact registry version. confirm: any other spec, or one that cannot be determined. */
export function packageAcquisitionVerdict(command: string): PackageAcquisitionVerdict {
	const offending: string[] = [];
	let triggerIndex = 0;
	for (const acquisition of recognizePackageAcquisitions(command)) {
		const bad = [...acquisition.specs.filter((spec) => !EXACT_SPEC_RE.test(spec)), ...acquisition.undetermined];
		if (bad.length === 0) continue;
		if (offending.length === 0) triggerIndex = acquisition.triggerIndex;
		offending.push(...bad);
	}
	return { action: offending.length > 0 ? "confirm" : "pass", offending, triggerIndex };
}
