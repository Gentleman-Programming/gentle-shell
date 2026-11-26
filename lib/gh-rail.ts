// Gentle Shell GitHub section: the rail's one-glance view of what is open.
// It renders from the store's snapshot and never fetches, so a repaint here is
// free and the section keeps the last good rows when a refresh fails.

import { ghCounts, ghDigest, type GhSnapshot } from "./gh-state.ts";
import { renderPanelHeader, renderPanelRow, type PanelSummary, type PanelTheme } from "./shell-panel.ts";
import type { SidebarRail } from "./shell-sidebar.ts";

export const GITHUB_COMMAND = "/gentle:gh";
export const GITHUB_SECTION_KEY = "github";
export const GITHUB_SECTION_TITLE = "Github";
const PR_GLYPH = "⇄";
const ISSUE_GLYPH = "◇";
const NONE_OPEN = "none open";
const LOADING = "loading…";
const UNAVAILABLE = "gh unavailable";

export interface GithubRailDeps {
	theme: PanelTheme;
	snapshot(): GhSnapshot;
	now(): number;
	open?(): void;
}

export class GithubRail implements SidebarRail {
	readonly surface = "panel" as const;
	open?: () => void;
	private readonly deps: GithubRailDeps;

	constructor(deps: GithubRailDeps) {
		this.deps = deps;
		if (deps.open) this.open = deps.open;
	}

	render(width: number): string[] {
		const snapshot = this.deps.snapshot();
		const counts = ghCounts(snapshot);
		const theme = this.deps.theme;
		const rows = [
			renderPanelHeader(theme, width, {
				title: GITHUB_SECTION_TITLE,
				count: `${counts.pullRequests} · ${counts.issues}`,
				open: true,
			}),
		];

		// One row per group: the rail is a digest, and the overlay is where the
		// rest of the list lives.
		const topPull = snapshot.pullRequests[0];
		const topIssue = snapshot.issues[0];
		if (topPull) rows.push(renderPanelRow(width, `${PR_GLYPH} #${topPull.number} ${topPull.title}`));
		if (topIssue) rows.push(renderPanelRow(width, `${ISSUE_GLYPH} #${topIssue.number} ${topIssue.title}`));

		const reason = snapshot.status === "error" ? (snapshot.error ?? UNAVAILABLE) : null;
		if (!topPull && !topIssue) rows.push(renderPanelRow(width, reason ?? (snapshot.status === "ready" ? NONE_OPEN : LOADING)));
		else if (reason) rows.push(renderPanelRow(width, reason));

		rows.push(renderPanelRow(width, GITHUB_COMMAND));
		return rows;
	}

	digest(): string {
		return ghDigest(this.deps.snapshot(), this.deps.now());
	}

	summary(): PanelSummary | undefined {
		const counts = ghCounts(this.deps.snapshot());
		const right = `${counts.pullRequests}·${counts.issues}`;
		return { left: GITHUB_SECTION_TITLE.toLowerCase(), right, rightLabel: "open", priority: 0 };
	}

	invalidate(): void {}

	dispose(): void {}
}
