// Gentle Shell GitHub state: what was fetched, when, and whether it failed.
// The rail and the overlay both read this one snapshot, so a keystroke repaint
// never reaches the network and a cached rail frame cannot outlive its data.

import { GITHUB_HOST, type GithubRepo, type IssueSummary, type PullRequestSummary } from "./gh-client.ts";

export type GhStatus = "idle" | "loading" | "ready" | "error";

export interface GhSnapshot {
	repo: GithubRepo | null;
	pullRequests: PullRequestSummary[];
	issues: IssueSummary[];
	status: GhStatus;
	error: string | null;
	loadedAt: number | null;
	/** Bumped by every applied result, including a failure: the rail digest reads it. */
	version: number;
}

export interface GhDeps {
	now(): number;
	resolveRepo(): GithubRepo | null;
	loadPullRequests(repo: GithubRepo): Promise<PullRequestSummary[]>;
	loadIssues(repo: GithubRepo): Promise<IssueSummary[]>;
	onChange(): void;
}

// GitHub changes when somebody else acts, so a refresh per minute is already
// generous; anything faster spends the API budget on a screen nobody is reading.
export const GH_TTL_MS = 60_000;
export const NO_REMOTE_ERROR = "No git remote here: nothing to ask GitHub about.";
export const NOT_GITHUB_ERROR = "Only github.com is supported; this remote points elsewhere.";

export class GhStore {
	private readonly deps: GhDeps;
	private state: GhSnapshot;
	private inFlight: Promise<GhSnapshot> | null = null;
	private disposed = false;

	constructor(deps: GhDeps) {
		this.deps = deps;
		this.state = {
			repo: deps.resolveRepo(),
			pullRequests: [],
			issues: [],
			status: "idle",
			error: null,
			loadedAt: null,
			version: 0,
		};
	}

	snapshot(): GhSnapshot {
		return this.state;
	}

	isStale(): boolean {
		return this.state.loadedAt === null || this.deps.now() - this.state.loadedAt >= GH_TTL_MS;
	}

	async refresh(force = false): Promise<GhSnapshot> {
		if (this.disposed) return this.state;
		if (this.inFlight) return this.inFlight;
		if (!force && !this.isStale()) return this.state;

		const repo = this.deps.resolveRepo();
		if (!repo) {
			this.fail(repo, NO_REMOTE_ERROR);
			return this.state;
		}
		if (repo.host !== GITHUB_HOST) {
			this.fail(repo, NOT_GITHUB_ERROR);
			return this.state;
		}

		this.state = { ...this.state, repo, status: "loading", error: null };
		this.emit();
		this.inFlight = this.load(repo);
		return this.inFlight;
	}

	dispose(): void {
		this.disposed = true;
		this.inFlight = null;
	}

	private async load(repo: GithubRepo): Promise<GhSnapshot> {
		try {
			const [pullRequests, issues] = await Promise.all([this.deps.loadPullRequests(repo), this.deps.loadIssues(repo)]);
			if (this.disposed) return this.state;
			this.state = {
				repo,
				pullRequests,
				issues,
				status: "ready",
				error: null,
				loadedAt: this.deps.now(),
				version: this.state.version + 1,
			};
		} catch (error) {
			if (this.disposed) return this.state;
			// A failed refresh keeps the last good rows: a stale list is more use
			// than an empty one, and the error line says so.
			this.state = {
				...this.state,
				repo,
				status: "error",
				error: error instanceof Error ? error.message : String(error),
				version: this.state.version + 1,
			};
		} finally {
			this.inFlight = null;
		}
		this.emit();
		return this.state;
	}

	private fail(repo: GithubRepo | null, message: string): void {
		this.state = { ...this.state, repo, status: "error", error: message, version: this.state.version + 1 };
		this.emit();
	}

	private emit(): void {
		if (!this.disposed) this.deps.onChange();
	}
}

export function ghCounts(snapshot: GhSnapshot): { pullRequests: number; issues: number } {
	return { pullRequests: snapshot.pullRequests.length, issues: snapshot.issues.length };
}

// The rail memoizes each part by its digest, so the digest has to change when
// the data changes and when that data ages past one TTL, or the rail keeps
// serving a frame painted from a snapshot that is no longer what we would load.
export function ghDigest(snapshot: GhSnapshot, now: number): string {
	const age = snapshot.loadedAt === null ? "none" : String(Math.floor(Math.max(0, now - snapshot.loadedAt) / GH_TTL_MS));
	return `${snapshot.version}:${age}`;
}
